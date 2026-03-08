import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export default function ({ db, Router, sql, createLocalAgentJwt }: { db: any; Router: any; sql: any; createLocalAgentJwt: (agentId: string, companyId: string, adapterType: string, runId: string | null) => string | null }) {
  const router = Router();

  // Track active Claude processes per thread for stop functionality
  const activeProcesses = new Map<string, ReturnType<typeof spawn>>();

  function getRows(result: any): any[] {
    return Array.isArray(result) ? result : (result.rows ?? []);
  }

  // List threads for a company
  router.get("/threads", async (req: any, res: any) => {
    const companyId = req.query.companyId as string;
    if (!companyId) {
      res.status(400).json({ error: "companyId is required" });
      return;
    }
    const result = await db.execute(
      sql`SELECT * FROM plugin_chat_ui_threads WHERE company_id = ${companyId} ORDER BY updated_at DESC`,
    );
    res.json(getRows(result));
  });

  // Create thread
  router.post("/threads", async (req: any, res: any) => {
    const { companyId, title } = req.body;
    if (!companyId) {
      res.status(400).json({ error: "companyId is required" });
      return;
    }
    const result = await db.execute(
      sql`INSERT INTO plugin_chat_ui_threads (company_id, title, created_by) VALUES (${companyId}, ${title ?? "New Chat"}, ${req.actor?.userId ?? null}) RETURNING *`,
    );
    res.status(201).json(getRows(result)[0] ?? null);
  });

  // Delete thread
  router.delete("/threads/:threadId", async (req: any, res: any) => {
    const { threadId } = req.params;
    await db.execute(
      sql`DELETE FROM plugin_chat_ui_threads WHERE id = ${threadId}`,
    );
    res.json({ ok: true });
  });

  // List messages in a thread
  router.get("/threads/:threadId/messages", async (req: any, res: any) => {
    const { threadId } = req.params;
    const result = await db.execute(
      sql`SELECT * FROM plugin_chat_ui_messages WHERE thread_id = ${threadId} ORDER BY created_at ASC`,
    );
    res.json(getRows(result));
  });

  // Post a message (direct, non-AI)
  router.post("/threads/:threadId/messages", async (req: any, res: any) => {
    const { threadId } = req.params;
    const { role, content } = req.body;
    if (!content) {
      res.status(400).json({ error: "content is required" });
      return;
    }
    const result = await db.execute(
      sql`INSERT INTO plugin_chat_ui_messages (thread_id, role, content) VALUES (${threadId}, ${role ?? "user"}, ${content}) RETURNING *`,
    );
    await db.execute(
      sql`UPDATE plugin_chat_ui_threads SET updated_at = NOW() WHERE id = ${threadId}`,
    );
    res.status(201).json(getRows(result)[0] ?? null);
  });

  // Update thread title
  router.patch("/threads/:threadId", async (req: any, res: any) => {
    const { threadId } = req.params;
    const { title } = req.body;
    if (!title) {
      res.status(400).json({ error: "title is required" });
      return;
    }
    const result = await db.execute(
      sql`UPDATE plugin_chat_ui_threads SET title = ${title}, updated_at = NOW() WHERE id = ${threadId} RETURNING *`,
    );
    res.json(getRows(result)[0] ?? null);
  });

  // Stop a running response
  router.post("/threads/:threadId/stop", async (req: any, res: any) => {
    const { threadId } = req.params;
    const proc = activeProcesses.get(threadId);
    if (proc && !proc.killed) {
      proc.kill("SIGTERM");
      res.json({ ok: true, stopped: true });
    } else {
      res.json({ ok: true, stopped: false });
    }
  });

  // ---- Chat endpoint: spawn claude CLI, stream response via SSE ----
  router.post("/threads/:threadId/chat", async (req: any, res: any) => {
    const { threadId } = req.params;
    const { message, displayMessage, model } = req.body;
    if (!message) {
      res.status(400).json({ error: "message is required" });
      return;
    }

    // Get thread to check for existing session
    const threadResult = await db.execute(
      sql`SELECT * FROM plugin_chat_ui_threads WHERE id = ${threadId}`,
    );
    const thread = getRows(threadResult)[0];
    if (!thread) {
      res.status(404).json({ error: "thread not found" });
      return;
    }

    // Save user message (use displayMessage if provided, otherwise message)
    const storedMessage = displayMessage || message;
    await db.execute(
      sql`INSERT INTO plugin_chat_ui_messages (thread_id, role, content) VALUES (${threadId}, 'user', ${storedMessage})`,
    );

    // Set up SSE
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    // Auto-generate title from first user message immediately (don't wait for process close)
    if (thread.title === "New Chat") {
      const titleSource = storedMessage;
      const shortTitle = titleSource.length > 60
        ? titleSource.slice(0, 57).replace(/\s+\S*$/, "") + "…"
        : titleSource;
      const titleLine = shortTitle.split("\n")[0];
      if (titleLine) {
        await db.execute(
          sql`UPDATE plugin_chat_ui_threads SET title = ${titleLine} WHERE id = ${threadId} AND title = 'New Chat'`,
        );
        res.write(`data: ${JSON.stringify({ type: "title_updated", title: titleLine })}\n\n`);
      }
    }

    // Build claude args — load system prompt + skills
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const systemPromptPath = resolve(__dirname, "system-prompt.md");
    let systemPrompt = readFileSync(systemPromptPath, "utf-8");

    // Load all skill files from skills/ directory
    const skillsDir = resolve(__dirname, "skills");
    try {
      const skillFiles = readdirSync(skillsDir).filter((f: string) => f.endsWith(".md")).sort();
      for (const file of skillFiles) {
        const skillContent = readFileSync(resolve(skillsDir, file), "utf-8");
        systemPrompt += `\n\n---\n\n${skillContent}`;
      }
    } catch {
      // skills/ directory may not exist yet — that's fine
    }

    const args = [
      "--print", "-",
      "--output-format", "stream-json",
      "--verbose",
    ];

    args.push("--dangerously-skip-permissions");
    args.push("--append-system-prompt", systemPrompt);

    if (model) {
      args.push("--model", model);
    }

    if (thread.session_id) {
      args.push("--resume", thread.session_id);
    }

    // Build Paperclip env vars so Claude can interact with the Paperclip API
    const companyId = thread.company_id;
    const chatAgentId = `chat-ui-${companyId}`;
    const resolveHost = (raw: string): string => {
      const h = raw.trim();
      if (!h || h === "0.0.0.0" || h === "::") return "localhost";
      return h;
    };
    const runtimeHost = resolveHost(process.env.PAPERCLIP_LISTEN_HOST ?? process.env.HOST ?? "localhost");
    const runtimePort = process.env.PAPERCLIP_LISTEN_PORT ?? process.env.PORT ?? "3100";
    const apiUrl = process.env.PAPERCLIP_API_URL ?? `http://${runtimeHost}:${runtimePort}`;

    const paperclipEnv: Record<string, string> = {
      PAPERCLIP_AGENT_ID: chatAgentId,
      PAPERCLIP_COMPANY_ID: companyId,
      PAPERCLIP_API_URL: apiUrl,
    };

    // Generate JWT if secret is configured
    const jwt = createLocalAgentJwt(chatAgentId, companyId, "claude_local", null);
    if (jwt) {
      paperclipEnv.PAPERCLIP_API_KEY = jwt;
    }

    const proc = spawn("claude", args, {
      cwd: process.cwd(),
      env: { ...process.env, ...paperclipEnv },
      stdio: ["pipe", "pipe", "pipe"],
    });

    activeProcesses.set(threadId, proc);

    // Send prompt via stdin
    proc.stdin.write(message);
    proc.stdin.end();

    let sessionId: string | null = thread.session_id;
    let fullResponse = "";
    let stdoutBuffer = "";
    const segments: any[] = []; // Collect segments for metadata storage

    proc.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split("\n");
      // Keep the last incomplete line in the buffer
      stdoutBuffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);

          // Capture session ID from init event
          if (event.type === "system" && event.subtype === "init" && event.session_id) {
            sessionId = event.session_id;
            res.write(`data: ${JSON.stringify({ type: "session", sessionId })}\n\n`);
          }

          // Stream assistant text, thinking, and tool use
          if (event.type === "assistant" && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === "thinking" && block.thinking) {
                // Append to last thinking segment or create new
                const last = segments[segments.length - 1];
                if (last && last.kind === "thinking") {
                  last.content += block.thinking;
                } else {
                  segments.push({ kind: "thinking", content: block.thinking });
                }
                res.write(`data: ${JSON.stringify({ type: "thinking", text: block.thinking })}\n\n`);
              }
              if (block.type === "text" && block.text) {
                fullResponse += block.text;
                // Append to last text segment or create new
                const last = segments[segments.length - 1];
                if (last && last.kind === "text") {
                  last.content += block.text;
                } else {
                  segments.push({ kind: "text", content: block.text });
                }
                res.write(`data: ${JSON.stringify({ type: "text", text: block.text })}\n\n`);
              }
              if (block.type === "tool_use") {
                segments.push({ kind: "tool", name: block.name, input: block.input });
                res.write(`data: ${JSON.stringify({ type: "tool_use", name: block.name, input: block.input })}\n\n`);
              }
            }
          }

          // Stream tool results
          if (event.type === "user" && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === "tool_result") {
                const resultContent = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
                const isError = block.is_error ?? false;
                // Find last tool segment without a result
                for (let i = segments.length - 1; i >= 0; i--) {
                  if (segments[i].kind === "tool" && segments[i].result === undefined) {
                    segments[i].result = resultContent;
                    segments[i].isError = isError;
                    break;
                  }
                }
                res.write(`data: ${JSON.stringify({
                  type: "tool_result",
                  toolUseId: block.tool_use_id,
                  content: resultContent,
                  isError,
                })}\n\n`);
              }
            }
          }

          // Final result
          if (event.type === "result") {
            if (event.session_id) sessionId = event.session_id;
            res.write(`data: ${JSON.stringify({
              type: "result",
              usage: event.usage ?? null,
              costUsd: event.total_cost_usd ?? null,
              isError: event.is_error ?? false,
            })}\n\n`);
          }
        } catch {
          // Non-JSON line, ignore
        }
      }
    });

    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("close", async (code: number | null) => {
      activeProcesses.delete(threadId);
      // Process any remaining buffer
      if (stdoutBuffer.trim()) {
        try {
          const event = JSON.parse(stdoutBuffer);
          if (event.type === "result" && event.session_id) {
            sessionId = event.session_id;
          }
        } catch {}
      }

      // Save assistant response with segment metadata
      if (fullResponse || segments.length > 0) {
        const metadataJson = JSON.stringify({ segments });
        await db.execute(
          sql`INSERT INTO plugin_chat_ui_messages (thread_id, role, content, metadata) VALUES (${threadId}, 'assistant', ${fullResponse || ""}, ${metadataJson}::jsonb)`,
        );
      }

      // Update thread session_id and updated_at
      if (sessionId) {
        await db.execute(
          sql`UPDATE plugin_chat_ui_threads SET session_id = ${sessionId}, updated_at = NOW() WHERE id = ${threadId}`,
        );
      } else {
        await db.execute(
          sql`UPDATE plugin_chat_ui_threads SET updated_at = NOW() WHERE id = ${threadId}`,
        );
      }

      if (code !== 0 && !fullResponse) {
        res.write(`data: ${JSON.stringify({ type: "error", error: stderr || `claude exited with code ${code}` })}\n\n`);
      }

      res.write("data: [DONE]\n\n");
      res.end();
    });

    // Handle client disconnect
    req.on("close", () => {
      if (!proc.killed) {
        proc.kill("SIGTERM");
      }
    });
  });

  return router;
}
