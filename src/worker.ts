import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type {
  ChatThread,
  ChatMessage,
  ChatStreamEvent,
  ChatAdapterInfo,
} from "./types.js";
import { createHmac, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as os from "node:os";

const PLUGIN_NAME = "paperclip-chat";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Skills directory — mount Paperclip skills for Claude CLI discovery
// ---------------------------------------------------------------------------

const SKILLS_TO_MOUNT = ["paperclip", "paperclip-create-agent"];

/**
 * Create a tmpdir with `.claude/skills/` containing symlinks to Paperclip
 * skills, so `--add-dir` makes Claude Code discover them as registered skills.
 * Same pattern as adapter-claude-local/src/server/execute.ts.
 */
async function buildSkillsDir(): Promise<string | null> {
  // Resolve skills root: from dist/worker.js → ../../paperclip/skills
  const skillsRoot = path.resolve(__dirname, "../../paperclip/skills");
  try {
    await fs.access(skillsRoot);
  } catch {
    return null;
  }

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-chat-skills-"));
  const target = path.join(tmp, ".claude", "skills");
  await fs.mkdir(target, { recursive: true });

  for (const name of SKILLS_TO_MOUNT) {
    const source = path.join(skillsRoot, name);
    try {
      await fs.access(source);
      await fs.symlink(source, path.join(target, name));
    } catch {
      // Skill not found — skip silently
    }
  }

  return tmp;
}

// ---------------------------------------------------------------------------
// JWT minting — create a short-lived token for Paperclip API access
// ---------------------------------------------------------------------------

/**
 * Mint a short-lived JWT for the chat plugin to authenticate with the
 * Paperclip API. Uses the same HMAC-SHA256 mechanism as the server's
 * `createLocalAgentJwt`. The `sub` must be a real agent ID (the auth
 * middleware validates it against the agents table).
 */
function mintChatToken(agentId: string, companyId: string): string | null {
  const secret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  if (!secret) return null;

  const now = Math.floor(Date.now() / 1000);
  const header = JSON.stringify({ alg: "HS256", typ: "JWT" });
  const claims = JSON.stringify({
    sub: agentId,
    company_id: companyId,
    adapter_type: "chat_plugin",
    run_id: randomUUID(),
    iat: now,
    exp: now + 3600, // 1 hour
    iss: process.env.PAPERCLIP_AGENT_JWT_ISSUER ?? "paperclip",
    aud: process.env.PAPERCLIP_AGENT_JWT_AUDIENCE ?? "paperclip-api",
  });

  const encode = (s: string) => Buffer.from(s, "utf8").toString("base64url");
  const signingInput = `${encode(header)}.${encode(claims)}`;
  const signature = createHmac("sha256", secret).update(signingInput).digest("base64url");
  return `${signingInput}.${signature}`;
}

// ---------------------------------------------------------------------------
// Claude stream-json parser
// ---------------------------------------------------------------------------

/**
 * Buffers raw stdout chunks and emits parsed ChatStreamEvents for each
 * complete JSON line from Claude CLI's `--output-format stream-json`.
 */
function createStreamJsonParser(emit: (event: ChatStreamEvent) => void) {
  let buffer = "";
  return {
    push(chunk: string) {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      // Keep the last (possibly incomplete) line in the buffer
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed) as Record<string, unknown>;
          const type = obj.type as string | undefined;

          // ── Claude CLI stream-json format ──────────────────────────
          // The CLI emits: system (init), assistant (full message),
          // user (tool_result), and result (final summary).
          if (type === "assistant") {
            const message = obj.message as Record<string, unknown> | undefined;
            const content = Array.isArray(message?.content) ? message!.content : [];
            for (const blockRaw of content) {
              if (typeof blockRaw !== "object" || blockRaw === null || Array.isArray(blockRaw)) continue;
              const block = blockRaw as Record<string, unknown>;
              const blockType = block.type as string | undefined;
              if (blockType === "text" && typeof block.text === "string") {
                emit({ type: "text", text: block.text });
              } else if (blockType === "thinking" && typeof block.thinking === "string") {
                emit({ type: "thinking", text: block.thinking });
              } else if (blockType === "tool_use") {
                emit({
                  type: "tool_use",
                  name: (block.name as string) ?? "tool",
                  input: block.input,
                });
              }
            }
          } else if (type === "user") {
            // Tool results come back as user messages with tool_result blocks
            const message = obj.message as Record<string, unknown> | undefined;
            const content = Array.isArray(message?.content) ? message!.content : [];
            for (const blockRaw of content) {
              if (typeof blockRaw !== "object" || blockRaw === null || Array.isArray(blockRaw)) continue;
              const block = blockRaw as Record<string, unknown>;
              if ((block.type as string) === "tool_result") {
                let resultContent = "";
                if (typeof block.content === "string") {
                  resultContent = block.content;
                } else if (Array.isArray(block.content)) {
                  resultContent = block.content
                    .map((p: unknown) => {
                      if (typeof p === "string") return p;
                      if (typeof p === "object" && p !== null && (p as Record<string, unknown>).type === "text") {
                        return (p as Record<string, unknown>).text as string;
                      }
                      return "";
                    })
                    .filter(Boolean)
                    .join("\n");
                }
                emit({
                  type: "tool_result",
                  content: resultContent,
                  isError: block.is_error === true,
                });
              }
            }
          } else if (type === "system" && obj.subtype === "init") {
            if (typeof obj.session_id === "string") {
              emit({ type: "session_init", sessionId: obj.session_id });
            }
          } else if (type === "result") {
            const usage = obj.usage as Record<string, unknown> | undefined;
            emit({
              type: "result",
              usage: usage ? {
                input_tokens: (usage.input_tokens as number) ?? 0,
                output_tokens: (usage.output_tokens as number) ?? 0,
              } : undefined,
              costUsd: typeof obj.total_cost_usd === "number" ? obj.total_cost_usd
                : typeof obj.cost_usd === "number" ? obj.cost_usd
                : undefined,
            });
          }

          // ── Anthropic API streaming format (fallback) ──────────────
          // In case the adapter emits raw API events instead of CLI format.
          if (type === "content_block_delta") {
            const delta = obj.delta as Record<string, unknown> | undefined;
            if (delta?.type === "text_delta" && typeof delta.text === "string") {
              emit({ type: "text", text: delta.text });
            }
            if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
              emit({ type: "thinking", text: delta.thinking });
            }
          }
        } catch {
          // Not valid JSON — skip
        }
      }
    },
    /** Flush any remaining buffer content */
    flush() {
      if (buffer.trim()) {
        this.push("\n");
      }
    },
  };
}

// ---------------------------------------------------------------------------
// State key helpers — all chat data lives in plugin.state
// ---------------------------------------------------------------------------

function threadListKey(companyId: string) {
  return `threads:${companyId}`;
}

function threadKey(threadId: string) {
  return `thread:${threadId}`;
}

function messagesKey(threadId: string) {
  return `messages:${threadId}`;
}

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

async function getThread(ctx: PluginContext, threadId: string): Promise<ChatThread | null> {
  const raw = await ctx.state.get({
    scopeKind: "instance",
    scopeId: "global",
    stateKey: threadKey(threadId),
  });
  return (raw as ChatThread) ?? null;
}

async function saveThread(ctx: PluginContext, thread: ChatThread): Promise<void> {
  await ctx.state.set({
    scopeKind: "instance",
    scopeId: "global",
    stateKey: threadKey(thread.id),
  }, thread as unknown);
}

async function getThreadList(ctx: PluginContext, companyId: string): Promise<string[]> {
  const raw = await ctx.state.get({
    scopeKind: "company",
    scopeId: companyId,
    stateKey: threadListKey(companyId),
  });
  return (raw as string[]) ?? [];
}

async function saveThreadList(ctx: PluginContext, companyId: string, ids: string[]): Promise<void> {
  await ctx.state.set({
    scopeKind: "company",
    scopeId: companyId,
    stateKey: threadListKey(companyId),
  }, ids as unknown);
}

async function getMessages(ctx: PluginContext, threadId: string): Promise<ChatMessage[]> {
  const raw = await ctx.state.get({
    scopeKind: "instance",
    scopeId: "global",
    stateKey: messagesKey(threadId),
  });
  return (raw as ChatMessage[]) ?? [];
}

async function saveMessages(ctx: PluginContext, threadId: string, msgs: ChatMessage[]): Promise<void> {
  await ctx.state.set({
    scopeKind: "instance",
    scopeId: "global",
    stateKey: messagesKey(threadId),
  }, msgs as unknown);
}

function generateId(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Adapter type → human-readable label
// ---------------------------------------------------------------------------

const ADAPTER_LABELS: Record<string, string> = {
  claude_local: "Claude",
  openai: "OpenAI",
  codex: "Codex",
  opencode: "OpenCode",
};

function adapterTypeLabel(adapterType: string): string {
  return ADAPTER_LABELS[adapterType] ?? adapterType.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info(`${PLUGIN_NAME} plugin setup`);

    // ── Data: list threads ──────────────────────────────────────────
    ctx.data.register("threads", async (params: Record<string, unknown>) => {
      const companyId = params.companyId as string;
      if (!companyId) return [];
      const ids = await getThreadList(ctx, companyId);
      const threads: ChatThread[] = [];
      for (const id of ids) {
        const thread = await getThread(ctx, id);
        if (thread) threads.push(thread);
      }
      // Sort by updatedAt descending
      threads.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return threads;
    });

    // ── Data: get messages for a thread ─────────────────────────────
    ctx.data.register("messages", async (params: Record<string, unknown>) => {
      const threadId = params.threadId as string;
      if (!threadId) return [];
      return getMessages(ctx, threadId);
    });

    // ── Data: list available adapters ───────────────────────────────
    ctx.data.register("adapters", async (params: Record<string, unknown>) => {
      const companyId = params.companyId as string;
      if (!companyId) {
        return [
          { type: "claude_local", label: "Claude", available: true, models: [] },
        ] as ChatAdapterInfo[];
      }
      try {
        const agents = await ctx.agents.list({ companyId });

        // Deduplicate by adapterType — show distinct adapter types, not individual agents
        // Mark available if ANY agent of that type is not terminated
        const adapterMap = new Map<string, ChatAdapterInfo>();
        for (const a of agents) {
          const existing = adapterMap.get(a.adapterType);
          if (existing) {
            // If any agent of this type is available, mark the adapter available
            if (a.status !== "terminated") existing.available = true;
            continue;
          }
          adapterMap.set(a.adapterType, {
            type: a.adapterType,
            label: adapterTypeLabel(a.adapterType),
            available: a.status !== "terminated",
            models: [],
          });
        }
        const adapters = Array.from(adapterMap.values());
        return adapters.length > 0 ? adapters : [
          { type: "claude_local", label: "Claude", available: true, models: [] },
        ];
      } catch {
        return [
          { type: "claude_local", label: "Claude", available: true, models: [] },
        ] as ChatAdapterInfo[];
      }
    });

    // ── Action: create thread ───────────────────────────────────────
    ctx.actions.register("createThread", async (params: Record<string, unknown>) => {
      const companyId = params.companyId as string;
      const adapterType = (params.adapterType as string) ?? "claude_local";
      const model = (params.model as string) ?? "";
      const title = (params.title as string) ?? "New Chat";
      if (!companyId) throw new Error("companyId is required");

      const thread: ChatThread = {
        id: generateId(),
        companyId,
        title,
        sessionId: null,
        adapterType,
        model,
        status: "idle",
        createdBy: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await saveThread(ctx, thread);
      const ids = await getThreadList(ctx, companyId);
      ids.unshift(thread.id);
      await saveThreadList(ctx, companyId, ids);

      return thread;
    });

    // ── Action: delete thread ───────────────────────────────────────
    ctx.actions.register("deleteThread", async (params: Record<string, unknown>) => {
      const threadId = params.threadId as string;
      const companyId = params.companyId as string;
      if (!threadId || !companyId) throw new Error("threadId and companyId required");

      // Remove from thread list
      const ids = await getThreadList(ctx, companyId);
      const filtered = ids.filter((id) => id !== threadId);
      await saveThreadList(ctx, companyId, filtered);

      // Delete thread and messages state
      await ctx.state.delete({
        scopeKind: "instance",
        scopeId: "global",
        stateKey: threadKey(threadId),
      });
      await ctx.state.delete({
        scopeKind: "instance",
        scopeId: "global",
        stateKey: messagesKey(threadId),
      });

      return { ok: true };
    });

    // ── Action: update thread title ─────────────────────────────────
    ctx.actions.register("updateThreadTitle", async (params: Record<string, unknown>) => {
      const threadId = params.threadId as string;
      const title = params.title as string;
      if (!threadId || !title) throw new Error("threadId and title required");

      const thread = await getThread(ctx, threadId);
      if (!thread) throw new Error("Thread not found");

      thread.title = title;
      thread.updatedAt = new Date().toISOString();
      await saveThread(ctx, thread);
      return thread;
    });

    // ── Action: send message (spawns claude CLI directly) ───────────
    ctx.actions.register("sendMessage", async (params: Record<string, unknown>) => {
      const threadId = params.threadId as string;
      const message = params.message as string;
      const companyId = params.companyId as string;
      if (!threadId || !message || !companyId) {
        throw new Error("threadId, message, and companyId required");
      }

      const thread = await getThread(ctx, threadId);
      if (!thread) throw new Error("Thread not found");

      // Save user message
      const msgs = await getMessages(ctx, threadId);
      const userMsg: ChatMessage = {
        id: generateId(),
        threadId,
        role: "user",
        content: message,
        metadata: null,
        createdAt: new Date().toISOString(),
      };
      msgs.push(userMsg);
      await saveMessages(ctx, threadId, msgs);

      // Mark thread as running
      thread.status = "running";
      thread.updatedAt = new Date().toISOString();

      // Auto-generate title from first user message
      if (thread.title === "New Chat") {
        const shortTitle = message.length > 60
          ? message.slice(0, 57).replace(/\s+\S*$/, "") + "..."
          : message;
        const titleLine = shortTitle.split("\n")[0] ?? shortTitle;
        thread.title = titleLine;
      }
      await saveThread(ctx, thread);

      // Open SSE stream channel
      const streamChannel = `chat:${threadId}`;
      ctx.streams.open(streamChannel, companyId);

      if (thread.title !== "New Chat") {
        ctx.streams.emit(streamChannel, { type: "title_updated", title: thread.title });
      }

      // Fire-and-forget: spawn claude CLI directly in the background.
      // This bypasses the agent run queue entirely — no blocking, no heartbeat overhead.
      void (async () => {
        const segments: ChatMessage["metadata"] = { segments: [] };
        let fullResponse = "";
        let skillsDir: string | null = null;

        try {
          const { spawn } = await import("child_process");

          // Build skills directory with Paperclip skills for Claude to discover
          skillsDir = await buildSkillsDir();

          // Build system prompt with company context
          const allAgents = await ctx.agents.list({ companyId });
          const agentList = allAgents.length > 0
            ? allAgents.map(a => `- ${a.name} (id: ${a.id}, role: ${a.role ?? "general"}, status: ${a.status ?? "unknown"})`).join("\n")
            : "No agents configured";

          // Find CEO agent for JWT minting (auth middleware requires real agent ID)
          const ceoAgent = allAgents.find(a => a.role === "ceo")
            ?? allAgents.find(a => a.status !== "terminated")
            ?? null;
          const authToken = ceoAgent ? mintChatToken(ceoAgent.id, companyId) : null;

          const systemPrompt = [
            "You are the board's AI assistant for this Paperclip company.",
            "You help manage agents, tasks, projects, and company operations.",
            "You can take real actions: hire agents, create tasks, list issues, and more.",
            "",
            "## How to interact with Paperclip",
            "",
            skillsDir
              ? "Use the `paperclip` skill to call Paperclip REST API endpoints via curl."
              : "Paperclip skills are not available. Answer conversationally based on context.",
            skillsDir
              ? "Use the `paperclip-create-agent` skill when the user wants to hire a new agent."
              : "",
            "",
            "Environment variables are pre-configured:",
            "- PAPERCLIP_API_URL — base URL for all API calls",
            "- PAPERCLIP_COMPANY_ID — this company's ID",
            authToken
              ? "- PAPERCLIP_API_KEY — auth token for API calls (use as Bearer token)"
              : "- PAPERCLIP_API_KEY — NOT AVAILABLE (no agents exist to mint a token from)",
            "- PAPERCLIP_RUN_ID — unique ID for this chat session",
            "",
            "## Key actions you can take",
            "",
            "- **List agents**: `curl -s -H \"Authorization: Bearer $PAPERCLIP_API_KEY\" \"$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/agents\"`",
            "- **Create a task**: `POST /api/companies/{companyId}/issues` with title, assigneeAgentId, status, priority",
            "- **Hire an agent**: use the `paperclip-create-agent` skill (it walks through the full workflow)",
            "- **List issues**: `GET /api/companies/{companyId}/issues`",
            "- **Get dashboard**: `GET /api/companies/{companyId}/dashboard`",
            "",
            `Company ID: ${companyId}`,
            "",
            "Available agents in this company:",
            agentList,
          ].join("\n");

          // Build claude CLI args — with skills and multi-turn tool use
          const args = [
            "--print", "-",
            "--output-format", "stream-json",
            "--verbose",
            "--model", "claude-sonnet-4-6",
            "--max-turns", "10",
            "--dangerously-skip-permissions",
            "--append-system-prompt", systemPrompt,
          ];

          // Mount Paperclip skills if available
          if (skillsDir) {
            args.push("--add-dir", skillsDir);
          }

          // Resume session if we have one
          if (thread.sessionId) {
            args.push("--resume", thread.sessionId);
          }

          // The plugin worker runs in a sandboxed env (no HOME, USER, etc).
          // Spawn claude through a login shell to get the full user environment.
          const home = os.homedir();
          const paperclipApiUrl = process.env.PAPERCLIP_API_URL
            ?? `http://127.0.0.1:${process.env.PORT ?? "4200"}`;
          const runId = randomUUID();
          const claudeCmd = `${home}/.local/bin/claude ${args.map(a => JSON.stringify(a)).join(" ")}`;

          ctx.logger.info(`[chat] spawning with skills=${!!skillsDir} auth=${!!authToken}: ${claudeCmd.slice(0, 120)}...`);

          const proc = spawn("/bin/zsh", ["-c", claudeCmd], {
            stdio: ["pipe", "pipe", "pipe"],
            env: {
              HOME: home,
              USER: process.env.USER ?? "ibraheem",
              PATH: `${home}/.local/bin:/usr/local/bin:/usr/bin:/bin`,
              TERM: "xterm-256color",
              // Paperclip env vars for skills to use
              PAPERCLIP_API_URL: paperclipApiUrl,
              PAPERCLIP_COMPANY_ID: companyId,
              PAPERCLIP_RUN_ID: runId,
              ...(authToken ? { PAPERCLIP_API_KEY: authToken } : {}),
            },
          });

          // Feed prompt via stdin
          proc.stdin.write(message);
          proc.stdin.end();

          const parser = createStreamJsonParser((chatEvent: ChatStreamEvent) => {
            // Accumulate for persistence
            if (chatEvent.type === "text" && chatEvent.text) {
              fullResponse += chatEvent.text;
              const last = segments.segments[segments.segments.length - 1];
              if (last && last.kind === "text") {
                last.content += chatEvent.text;
              } else {
                segments.segments.push({ kind: "text", content: chatEvent.text });
              }
            }
            if (chatEvent.type === "thinking" && chatEvent.text) {
              const last = segments.segments[segments.segments.length - 1];
              if (last && last.kind === "thinking") {
                last.content += chatEvent.text;
              } else {
                segments.segments.push({ kind: "thinking", content: chatEvent.text });
              }
            }
            if (chatEvent.type === "tool_use") {
              segments.segments.push({ kind: "tool", name: chatEvent.name ?? "tool", input: chatEvent.input });
            }
            if (chatEvent.type === "tool_result") {
              for (let i = segments.segments.length - 1; i >= 0; i--) {
                const seg = segments.segments[i];
                if (seg && seg.kind === "tool" && seg.result === undefined) {
                  seg.result = chatEvent.content ?? "";
                  seg.isError = chatEvent.isError ?? false;
                  break;
                }
              }
            }
            if (chatEvent.type === "session_init" && chatEvent.sessionId) {
              thread.sessionId = chatEvent.sessionId;
              void saveThread(ctx, thread);
            }

            // Push to UI via SSE
            ctx.streams.emit(streamChannel, chatEvent);
          });

          // Stream stdout through our parser
          proc.stdout.on("data", (chunk: Buffer) => {
            const text = chunk.toString();
            ctx.logger.info(`[claude stdout] ${text.slice(0, 300)}`);
            parser.push(text);
          });

          // Log stderr for debugging
          let stderrBuf = "";
          proc.stderr.on("data", (chunk: Buffer) => {
            stderrBuf += chunk.toString();
            ctx.logger.warn(`[claude stderr] ${chunk.toString().trim()}`);
          });

          // Wait for process to exit
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              proc.kill("SIGTERM");
              reject(new Error("Chat timed out after 5 minutes"));
            }, 300_000);

            proc.on("close", (code) => {
              clearTimeout(timer);
              parser.flush();
              if (code !== 0) {
                reject(new Error(`Claude exited with code ${code}: ${stderrBuf.slice(0, 500)}`));
              } else {
                resolve();
              }
            });

            proc.on("error", (err) => {
              clearTimeout(timer);
              reject(err);
            });
          });

          ctx.streams.emit(streamChannel, { type: "result" });
        } catch (err) {
          ctx.logger.error(`Chat error: ${err}`);
          ctx.streams.emit(streamChannel, { type: "error", text: String(err) });
        }

        // Save assistant message
        if (fullResponse || segments.segments.length > 0) {
          const assistantMsg: ChatMessage = {
            id: generateId(),
            threadId,
            role: "assistant",
            content: fullResponse,
            metadata: segments,
            createdAt: new Date().toISOString(),
          };
          const updatedMsgs = await getMessages(ctx, threadId);
          updatedMsgs.push(assistantMsg);
          await saveMessages(ctx, threadId, updatedMsgs);
        }

        // Cleanup temp skills directory
        if (skillsDir) {
          fs.rm(skillsDir, { recursive: true, force: true }).catch(() => {});
        }

        thread.status = "idle";
        thread.updatedAt = new Date().toISOString();
        await saveThread(ctx, thread);

        ctx.streams.emit(streamChannel, { type: "done" });
        ctx.streams.close(streamChannel);
        ctx.logger.info(`Chat completed for thread ${threadId}`);
      })();

      // Return immediately
      return { ok: true, streaming: true };
    });

    // ── Action: stop a running response ─────────────────────────────
    ctx.actions.register("stopThread", async (params: Record<string, unknown>) => {
      const threadId = params.threadId as string;
      const companyId = params.companyId as string;
      if (!threadId || !companyId) throw new Error("threadId and companyId required");

      const thread = await getThread(ctx, threadId);
      if (!thread) return { ok: true, stopped: false };

      // Mark idle — the background process will be killed by its timeout
      thread.status = "idle";
      thread.updatedAt = new Date().toISOString();
      await saveThread(ctx, thread);

      return { ok: true, stopped: true };
    });
  },

  async onHealth() {
    return { status: "ok", message: `${PLUGIN_NAME} ready` };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
