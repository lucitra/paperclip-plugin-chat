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

// stream-parser.ts is no longer used — the Agent SDK emits structured
// messages instead of newline-delimited stream-json.

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

      // Fire-and-forget: drive the Claude Agent SDK in the background.
      // This runs in-process — no subprocess spawn, no stream-json parsing,
      // structured tool_use/tool_result events surface directly.
      void (async () => {
        const segments: ChatMessage["metadata"] = { segments: [] };
        let fullResponse = "";
        try {
          const { query } = await import("@anthropic-ai/claude-agent-sdk");

          // Skills are loaded natively by the Agent SDK via `settingSources`
          // below — no need to build a temp dir and symlink them in.

          // Pre-fetch company context for the system prompt
          const [allAgents, allIssues, allProjects, company] = await Promise.all([
            ctx.agents.list({ companyId }),
            ctx.issues.list({ companyId, limit: 200 }).catch(() => [] as Array<{ status: string }>),
            ctx.projects.list({ companyId }).catch(() => [] as Array<Record<string, unknown>>),
            ctx.companies.get(companyId).catch(() => null),
          ]);

          const agentList = allAgents.length > 0
            ? allAgents.map(a => `- ${a.name} (id: ${a.id}, role: ${a.role ?? "general"}, status: ${a.status ?? "unknown"})`).join("\n")
            : "No agents configured";

          // Summarize issue counts by status
          const issueCounts: Record<string, number> = {};
          for (const issue of allIssues) {
            issueCounts[issue.status] = (issueCounts[issue.status] ?? 0) + 1;
          }
          const issueSummary = Object.entries(issueCounts)
            .map(([status, count]) => `  ${status}: ${count}`)
            .join("\n") || "  No issues";

          // Summarize projects with workspace paths
          const projectSummary = allProjects.length > 0
            ? allProjects.map(p => {
                const ws = (p as Record<string, unknown>).primaryWorkspace as Record<string, unknown> | null;
                const cwdInfo = ws?.cwd ? ` (cwd: ${ws.cwd})` : "";
                return `- ${p.name} (status: ${p.status ?? "unknown"})${cwdInfo}`;
              }).join("\n")
            : "No projects";

          // Find primary workspace cwd for Claude's working directory
          const primaryProject = allProjects.find(p => {
            const ws = (p as Record<string, unknown>).primaryWorkspace as Record<string, unknown> | null;
            return ws?.cwd;
          });
          const workspaceCwd = primaryProject
            ? ((primaryProject as Record<string, unknown>).primaryWorkspace as Record<string, unknown>)?.cwd as string | undefined
            : undefined;

          // Find CEO agent for JWT minting (auth middleware requires real agent ID)
          const ceoAgent = allAgents.find(a => a.role === "ceo")
            ?? allAgents.find(a => a.status !== "terminated")
            ?? null;
          const authToken = ceoAgent ? mintChatToken(ceoAgent.id, companyId) : null;

          // Resolve the actual API URL (server sets this at startup)
          const paperclipApiUrl = process.env.PAPERCLIP_API_URL
            ?? `http://127.0.0.1:${process.env.PAPERCLIP_LISTEN_PORT ?? process.env.PORT ?? "3100"}`;

          // Company name for persona
          const companyName = (company as Record<string, unknown> | null)?.name as string | undefined ?? "this company";

          // Terse companion context — NOT a persona override. Claude Code
          // behaves like itself; this just tells it which company/workspace
          // it's looking at and what Paperclip-specific MCP tools are
          // available when relevant.
          const systemPrompt = [
            `## Paperclip workspace context`,
            "",
            `You are running inside a Paperclip chat session for ${companyName} (company ID: \`${companyId}\`).`,
            `Paperclip API: ${paperclipApiUrl}`,
            `Agents: ${allAgents.length} · Issues: ${allIssues.length} · Projects: ${allProjects.length}`,
            workspaceCwd ? `Primary workspace cwd: \`${workspaceCwd}\`` : "",
            "",
            "Paperclip-specific MCP tools are available under the `mcp__paperclip__*` namespace for Linear, Kalshi, and any other plugin in the host. Use them when the user asks about agents, tasks, projects, tickets, or trading data. Otherwise behave exactly as you would in a normal Claude Code session — read/edit files, run shell commands, search the web, etc.",
          ]
            .filter(Boolean)
            .join("\n");

          // Resolve the @lucitra/mcp-paperclip shim. It's a file: dep, so it's
          // always present in node_modules when the plugin installs.
          // Built worker lives at dist/worker.js, so __dirname = dist/.
          // Go one level up to reach the plugin root, then into node_modules.
          const mcpShimPath = path.resolve(
            __dirname,
            "../node_modules/@lucitra/mcp-paperclip/dist/index.js",
          );
          let mcpShimOk = false;
          try {
            await fs.access(mcpShimPath);
            mcpShimOk = true;
            ctx.logger.info(`[chat] mcp shim resolved: ${mcpShimPath}`);
          } catch {
            ctx.logger.warn(`[chat] mcp shim NOT found at ${mcpShimPath}`);
          }

          const home = os.homedir();
          const spawnCwd = workspaceCwd ?? home;

          // Read the Claude Code OAuth token from the macOS Keychain once.
          // The Agent SDK runs Claude Code under the hood; when spawned from
          // the paperclip plugin worker's sandboxed env, it can't reliably
          // reach the keychain itself, so we do it here and pass the token
          // via env. The OAuth access token (sk-ant-oat01-...) is accepted
          // by the API as a bearer, same as a plain API key.
          // Use the REAL OS user for the keychain lookup (os.userInfo()),
          // NOT process.env.USER — we patch that above for the worker env
          // and it would break the `security find-generic-password -a` query.
          const realOsUser = (() => {
            try {
              return os.userInfo().username;
            } catch {
              return process.env.LOGNAME ?? "";
            }
          })();
          async function readClaudeOauthToken(): Promise<string | null> {
            if (process.platform !== "darwin") return null;
            if (!realOsUser) {
              ctx.logger.warn(`[chat] no OS user; skipping keychain read`);
              return null;
            }
            const { execFile } = await import("node:child_process");
            const { promisify } = await import("node:util");
            const execFileP = promisify(execFile);
            try {
              const { stdout } = await execFileP(
                "/usr/bin/security",
                [
                  "find-generic-password",
                  "-s",
                  "Claude Code-credentials",
                  "-a",
                  realOsUser,
                  "-w",
                ],
                { timeout: 3000 },
              );
              const parsed = JSON.parse(stdout.trim()) as {
                claudeAiOauth?: { accessToken?: string };
              };
              const token = parsed.claudeAiOauth?.accessToken ?? null;
              ctx.logger.info(
                `[chat] keychain read ok user=${realOsUser} token_len=${token?.length ?? 0}`,
              );
              return token;
            } catch (err) {
              ctx.logger.warn(
                `[chat] keychain read failed user=${realOsUser}: ${err instanceof Error ? err.message : String(err)}`,
              );
              return null;
            }
          }
          const claudeOauthToken = process.env.ANTHROPIC_API_KEY
            ? process.env.ANTHROPIC_API_KEY
            : await readClaudeOauthToken();

          // The plugin worker runs in a sandboxed env (no HOME, USER, PATH).
          // The Agent SDK in-process needs HOME to locate the Claude Code
          // auth session at ~/.claude/ and a real PATH to resolve subprocess
          // tools (node, git, etc). Patch process.env for this worker.
          if (!process.env.HOME) process.env.HOME = home;
          if (!process.env.USER) process.env.USER = process.env.LOGNAME ?? "paperclip";
          if (!process.env.PATH) {
            process.env.PATH = `${home}/.local/bin:/usr/local/bin:/usr/bin:/bin`;
          }
          ctx.logger.info(
            `[chat] agent-sdk cwd=${spawnCwd} HOME=${process.env.HOME} auth=${!!authToken} oauth=${!!claudeOauthToken}`,
          );

          // Stream helper — emit to SSE and accumulate into segments for persistence.
          const pushEvent = (ev: ChatStreamEvent) => {
            if (ev.type === "text" && ev.text) {
              fullResponse += ev.text;
              const last = segments.segments[segments.segments.length - 1];
              if (last && last.kind === "text") last.content += ev.text;
              else segments.segments.push({ kind: "text", content: ev.text });
            } else if (ev.type === "thinking" && ev.text) {
              const last = segments.segments[segments.segments.length - 1];
              if (last && last.kind === "thinking") last.content += ev.text;
              else segments.segments.push({ kind: "thinking", content: ev.text });
            } else if (ev.type === "tool_use") {
              segments.segments.push({
                kind: "tool",
                name: ev.name ?? "tool",
                input: ev.input,
              });
            } else if (ev.type === "tool_result") {
              for (let i = segments.segments.length - 1; i >= 0; i--) {
                const seg = segments.segments[i];
                if (seg && seg.kind === "tool" && seg.result === undefined) {
                  seg.result = ev.content ?? "";
                  seg.isError = ev.isError ?? false;
                  break;
                }
              }
            } else if (ev.type === "session_init" && ev.sessionId) {
              thread.sessionId = ev.sessionId;
              void saveThread(ctx, thread);
            }
            ctx.streams.emit(streamChannel, ev);
          };

          // Drive the Agent SDK. Built-in tools (Read/Write/Edit/Bash/Glob/Grep/
          // WebSearch/WebFetch) are available via the claude_code preset, and
          // every Paperclip plugin tool (Linear, Kalshi, …) is wired through the
          // `paperclip` MCP server. Claude sees them as native mcp__paperclip__*
          // tools and emits structured tool_use events.
          const sdkMessages = query({
            prompt: message,
            options: {
              model: "claude-opus-4-6",
              cwd: spawnCwd,
              // Load ~/.claude/ (user settings, skills, hooks, CLAUDE.md),
              // project .claude/, and local overrides — same discovery path
              // a regular interactive Claude Code session uses. This is why
              // stock Claude Code "just knows" your conventions and skills.
              settingSources: ["user", "project", "local"],
              systemPrompt: {
                type: "preset",
                preset: "claude_code",
                append: systemPrompt,
              },
              // Adaptive thinking is the default for opus 4.6 in the SDK;
              // no explicit config needed. Output effort defaults to high.
              maxTurns: 50,
              // Chat runs in `bypassPermissions` because the user has already
              // opted into full workspace access by opening a thread. Stock
              // Claude Code does the same under `--dangerously-skip-permissions`.
              permissionMode: "bypassPermissions",
              allowDangerouslySkipPermissions: true,
              resume: thread.sessionId ?? undefined,
              env: {
                HOME: process.env.HOME ?? home,
                USER: process.env.USER ?? "paperclip",
                PATH: process.env.PATH ?? `${home}/.local/bin:/usr/local/bin:/usr/bin:/bin`,
                // OAuth tokens (sk-ant-oat01-...) must go through
                // CLAUDE_CODE_OAUTH_TOKEN, NOT ANTHROPIC_API_KEY — passing
                // an oat token as ANTHROPIC_API_KEY fails with "Invalid API key".
                // Plain API keys (sk-ant-api03-...) go in ANTHROPIC_API_KEY.
                ...(claudeOauthToken
                  ? claudeOauthToken.startsWith("sk-ant-oat")
                    ? { CLAUDE_CODE_OAUTH_TOKEN: claudeOauthToken }
                    : { ANTHROPIC_API_KEY: claudeOauthToken }
                  : {}),
                PAPERCLIP_API_URL: paperclipApiUrl,
                PAPERCLIP_COMPANY_ID: companyId,
                ...(authToken ? { PAPERCLIP_API_KEY: authToken } : {}),
              },
              // MCP servers available inside chat.
              //
              // `paperclip` is the in-workspace shim that bridges to every
              // plugin tool in the host (Linear, Kalshi, …). Attached
              // unconditionally when the shim resolves — it falls back to
              // board-implicit auth on localhost.
              //
              // The remaining entries are external MCP servers that
              // Claude Code already knows how to authenticate against
              // (Notion OAuth, Linear OAuth, gcloud ADC, etc.). They mirror
              // the entries in lucitra-dev/.mcp.json so chat has the same
              // surface area as Claude Code itself. Notion and Linear are
              // HTTP-transport servers — Claude Code handles their OAuth
              // flows and caches tokens per user under ~/.claude/.
              mcpServers: {
                ...(mcpShimOk
                  ? {
                      paperclip: {
                        type: "stdio" as const,
                        command: "node",
                        args: [mcpShimPath],
                        env: {
                          PAPERCLIP_API_URL: paperclipApiUrl,
                          PAPERCLIP_COMPANY_ID: companyId,
                          ...(authToken ? { PAPERCLIP_API_KEY: authToken } : {}),
                        },
                      },
                    }
                  : {}),
                notion: {
                  type: "http" as const,
                  url: "https://mcp.notion.com/mcp",
                },
                "linear-hosted": {
                  type: "http" as const,
                  url: "https://mcp.linear.app/mcp",
                },
                gcloud: {
                  type: "stdio" as const,
                  command: "npx",
                  args: ["-y", "@google-cloud/gcloud-mcp"],
                },
                "gcloud-observability": {
                  type: "stdio" as const,
                  command: "npx",
                  args: ["-y", "@google-cloud/observability-mcp"],
                },
              },
            },
          });

          for await (const sdkMsg of sdkMessages) {
            ctx.logger.info(
              `[chat] sdk msg type=${sdkMsg.type}${(sdkMsg as { subtype?: string }).subtype ? " subtype=" + (sdkMsg as { subtype: string }).subtype : ""}`,
            );
            // Capture the session id on init so we can resume next turn.
            if (sdkMsg.type === "system" && sdkMsg.subtype === "init") {
              const sid = (sdkMsg as { session_id?: string }).session_id;
              if (sid) pushEvent({ type: "session_init", sessionId: sid });
              continue;
            }

            // Assistant turns contain text / thinking / tool_use blocks.
            if (sdkMsg.type === "assistant") {
              const blocks =
                (sdkMsg as unknown as { message?: { content?: Array<Record<string, unknown>> } }).message?.content ?? [];
              for (const block of blocks) {
                const btype = block.type as string | undefined;
                if (btype === "text" && typeof block.text === "string") {
                  pushEvent({ type: "text", text: block.text });
                } else if (btype === "thinking" && typeof block.thinking === "string") {
                  pushEvent({ type: "thinking", text: block.thinking });
                } else if (btype === "tool_use") {
                  pushEvent({
                    type: "tool_use",
                    name: (block.name as string) ?? "tool",
                    input: block.input,
                    toolUseId: block.id as string | undefined,
                  });
                }
              }
              continue;
            }

            // User turns here mean tool_result blocks from the SDK.
            if (sdkMsg.type === "user") {
              const rawContent = (sdkMsg as unknown as { message?: { content?: unknown } }).message?.content;
              const blocks: Array<Record<string, unknown>> = Array.isArray(rawContent)
                ? (rawContent as Array<Record<string, unknown>>)
                : [];
              for (const block of blocks) {
                if (block.type === "tool_result") {
                  const raw = block.content;
                  let content = "";
                  if (typeof raw === "string") content = raw;
                  else if (Array.isArray(raw)) {
                    content = raw
                      .map((b) =>
                        typeof b === "string"
                          ? b
                          : (b as Record<string, unknown>).type === "text"
                            ? String((b as Record<string, unknown>).text ?? "")
                            : "",
                      )
                      .join("");
                  }
                  pushEvent({
                    type: "tool_result",
                    content,
                    isError: Boolean(block.is_error),
                    toolUseId: block.tool_use_id as string | undefined,
                  });
                }
              }
              continue;
            }

            // Terminal result message — carries usage + cost.
            if (sdkMsg.type === "result") {
              const usage = (sdkMsg as { usage?: unknown }).usage;
              const cost = (sdkMsg as { total_cost_usd?: number }).total_cost_usd;
              pushEvent({
                type: "result",
                usage:
                  usage && typeof usage === "object"
                    ? {
                        input_tokens: Number(
                          (usage as Record<string, unknown>).input_tokens ?? 0,
                        ),
                        output_tokens: Number(
                          (usage as Record<string, unknown>).output_tokens ?? 0,
                        ),
                      }
                    : undefined,
                costUsd: typeof cost === "number" ? cost : undefined,
              });
            }
          }
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
        // Skills dir cleanup removed — settingSources loads them natively.

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
