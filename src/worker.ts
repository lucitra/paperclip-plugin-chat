import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type {
  ChatThread,
  ChatMessage,
  ChatStreamEvent,
  ChatAdapterInfo,
} from "./types.js";
import {
  DEFAULT_ALLOW_RULES,
  evaluateRules,
  synthesizeAlwaysRule,
  type PermissionRuleSet,
} from "./permissions.js";
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

    // ── Data: pending tool-use approvals for a chat thread ─────────
    // Hydrates the inline approval cards when the user switches back
    // to a thread (React state was lost on unmount). Calls the central
    // approvals API, filters by type=tool_use + status=pending, and
    // matches on the threadId embedded in the payload.
    ctx.data.register(
      "pendingApprovals",
      async (params: Record<string, unknown>) => {
        const companyId = params.companyId as string;
        const threadId = params.threadId as string | undefined;
        if (!companyId) return [];
        const apiUrl =
          process.env.PAPERCLIP_API_URL
          ?? `http://127.0.0.1:${process.env.PAPERCLIP_LISTEN_PORT ?? process.env.PORT ?? "3100"}`;
        try {
          const res = await fetch(
            `${apiUrl}/api/companies/${encodeURIComponent(companyId)}/approvals?status=pending`,
            { signal: AbortSignal.timeout(5000) },
          );
          if (!res.ok) return [];
          const all = (await res.json()) as Array<{
            id: string;
            type: string;
            status: string;
            payload?: Record<string, unknown> | null;
            createdAt?: string;
          }>;
          return all
            .filter((a) => a.type === "tool_use" && a.status === "pending")
            .filter((a) => {
              if (!threadId) return true;
              const payloadThreadId = (a.payload as Record<string, unknown> | null)?.threadId;
              return payloadThreadId === threadId;
            })
            .map((a) => ({
              approvalId: a.id,
              name: (a.payload as Record<string, unknown> | null)?.tool as string | undefined ?? "tool",
              input: (a.payload as Record<string, unknown> | null)?.input,
              requestedAt: a.createdAt ? Date.parse(a.createdAt) : Date.now(),
            }));
        } catch {
          return [];
        }
      },
    );

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

    // ── Action: resolve a tool-use approval inline from the chat UI ──
    // Tool-use approvals flow through the central paperclip approvals
    // API (POST /api/companies/:id/approvals with type "tool_use"). The
    // chat UI surfaces them as inline cards via the permission_request
    // stream event and uses this action to approve/reject without the
    // user having to navigate to the approvals dashboard.
    //
    // This is a thin proxy — it calls the central approvals API on
    // behalf of the UI. Same endpoints the board dashboard uses, same
    // audit trail, same rule-synthesis path on the worker side
    // (decisionNote contains "remember" → chat worker remembers).
    ctx.actions.register(
      "resolveBoardApproval",
      async (params: Record<string, unknown>) => {
        const approvalId = params.approvalId as string;
        const decision = params.decision as "approve" | "reject";
        const decisionNote = (params.decisionNote as string | undefined) ?? "";
        if (!approvalId) throw new Error("approvalId required");
        if (decision !== "approve" && decision !== "reject") {
          throw new Error("decision must be 'approve' or 'reject'");
        }
        const apiUrl =
          process.env.PAPERCLIP_API_URL
          ?? `http://127.0.0.1:${process.env.PAPERCLIP_LISTEN_PORT ?? process.env.PORT ?? "3100"}`;
        const res = await fetch(
          `${apiUrl}/api/approvals/${encodeURIComponent(approvalId)}/${decision}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ decisionNote, decidedByUserId: "board" }),
          },
        );
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`Approval ${decision} failed (${res.status}): ${text.slice(0, 300)}`);
        }
        return { ok: true };
      },
    );

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

          // ── Permission rule engine ────────────────────────────────
          // Mirrors Claude Code's permissions system (see permissions.ts).
          //
          // On every tool call, canUseTool:
          //   1. Evaluates the rule set (deny > ask > allow precedence)
          //   2. If matched by an allow rule → runs the tool
          //   3. If matched by a deny rule → hard-deny
          //   4. If no rule matches OR matched "ask" → creates an approval
          //      in the central paperclip approvals inbox and waits
          //   5. If the board approves with "remember" in the decisionNote,
          //      synthesizes a reusable rule and appends it to
          //      thread.allowedTools — persists for the life of the thread
          //
          // The rule set is:
          //   allow = DEFAULT_ALLOW_RULES + thread.allowedTools (persisted per-thread)
          //   deny  = (empty — no hard blocks; user can approve anything)
          //   ask   = (empty — anything unmatched falls through to approval)
          const buildRuleSet = (): PermissionRuleSet => ({
            allow: [
              ...DEFAULT_ALLOW_RULES,
              ...(thread.allowedTools ?? []),
            ],
            deny: [],
            ask: [],
          });

          // ── Approval polling helper ──────────────────────────────
          // Creates a `tool_use` approval via the paperclip approvals
          // plugin (POST /api/companies/:id/approvals), emits a
          // permission_request event on the chat stream, and polls
          // GET /api/approvals/:id until resolved or timed out. The
          // approval shows up in the same board approvals inbox as
          // hire_agent / budget_override / approve_ceo_strategy
          // requests — single unified surface.
          const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
          const APPROVAL_POLL_MS = 1500;
          function approvalHeaders(): Record<string, string> {
            const h: Record<string, string> = {
              "Content-Type": "application/json",
            };
            if (authToken) h.Authorization = `Bearer ${authToken}`;
            return h;
          }
          function summarizeToolCall(
            toolName: string,
            toolInput: unknown,
          ): string {
            // Keep the dashboard summary tight — 120 char cap.
            const head = toolName.startsWith("mcp__")
              ? toolName.split("__").slice(-1)[0] ?? toolName
              : toolName;
            try {
              const json = JSON.stringify(toolInput ?? {});
              const short = json.length > 80 ? json.slice(0, 77) + "..." : json;
              return `${head} ${short}`.slice(0, 120);
            } catch {
              return head.slice(0, 120);
            }
          }
          interface ApprovalOutcome {
            status: "approved" | "denied" | "timeout";
            decisionNote?: string | null;
          }
          async function requestToolApproval(
            toolName: string,
            toolInput: unknown,
          ): Promise<ApprovalOutcome> {
            // Create the approval record via the paperclip approvals API.
            let approvalId: string | null = null;
            try {
              const createRes = await fetch(
                `${paperclipApiUrl}/api/companies/${encodeURIComponent(companyId)}/approvals`,
                {
                  method: "POST",
                  headers: approvalHeaders(),
                  body: JSON.stringify({
                    type: "tool_use",
                    payload: {
                      tool: toolName,
                      input: toolInput,
                      threadId,
                      summary: summarizeToolCall(toolName, toolInput),
                      requestedAt: new Date().toISOString(),
                    },
                    requestedByAgentId: ceoAgent?.id ?? null,
                  }),
                  signal: AbortSignal.timeout(10_000),
                },
              );
              if (!createRes.ok) {
                const errText = await createRes.text();
                ctx.logger.warn(
                  `[chat] approval create failed (${createRes.status}): ${errText.slice(0, 300)}`,
                );
                return { status: "denied" }; // fail closed
              }
              const created = (await createRes.json()) as { id?: string };
              approvalId = created.id ?? null;
            } catch (err) {
              ctx.logger.warn(
                `[chat] approval create threw: ${err instanceof Error ? err.message : String(err)}`,
              );
              return { status: "denied" };
            }

            if (!approvalId) return { status: "denied" };

            // Stream the permission_request event to the chat UI so
            // it can render an inline approve/deny card.
            ctx.streams.emit(streamChannel, {
              type: "permission_request",
              approvalId,
              name: toolName,
              input: toolInput,
            } as unknown as ChatStreamEvent);

            ctx.logger.info(
              `[chat] approval created id=${approvalId} tool=${toolName}`,
            );

            // Poll the central approvals API until resolved or timeout.
            // Status values: pending | approved | rejected | revision_requested
            const deadline = Date.now() + APPROVAL_TIMEOUT_MS;
            while (Date.now() < deadline) {
              await new Promise((r) => setTimeout(r, APPROVAL_POLL_MS));
              try {
                const res = await fetch(
                  `${paperclipApiUrl}/api/approvals/${encodeURIComponent(approvalId)}`,
                  {
                    headers: approvalHeaders(),
                    signal: AbortSignal.timeout(5000),
                  },
                );
                if (!res.ok) continue;
                const approval = (await res.json()) as {
                  status?: string;
                  decisionNote?: string | null;
                };
                if (approval.status === "approved") {
                  return {
                    status: "approved",
                    decisionNote: approval.decisionNote ?? null,
                  };
                }
                if (approval.status === "rejected") {
                  return {
                    status: "denied",
                    decisionNote: approval.decisionNote ?? null,
                  };
                }
              } catch {
                /* transient — try again */
              }
            }
            return { status: "timeout" };
          }

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
              // Board-in-the-loop: default permission mode + canUseTool
              // callback below gates every mutation. Read-only tools
              // pass through; everything else creates an approval record
              // and waits for a board decision.
              permissionMode: "default",
              canUseTool: async (toolName, input) => {
                // Evaluate the rule set (deny > ask > allow precedence).
                const decision = evaluateRules(
                  buildRuleSet(),
                  toolName,
                  input,
                );
                if (decision === "allow") {
                  return {
                    behavior: "allow" as const,
                    updatedInput: input as Record<string, unknown>,
                  };
                }
                if (decision === "deny") {
                  return {
                    behavior: "deny" as const,
                    message:
                      `This action is blocked by a deny rule. Do not retry ${toolName} with the same arguments.`,
                  };
                }

                // No rule matched (or matched "ask") → create an approval
                // in the central paperclip inbox and wait for the board.
                ctx.logger.info(
                  `[chat] permission request tool=${toolName}`,
                );
                const outcome = await requestToolApproval(toolName, input);

                if (outcome.status === "approved") {
                  // "Approve always": if the decisionNote contains
                  // "remember" (case-insensitive), synthesize a reusable
                  // rule and persist it on the thread. Next time a tool
                  // call matching the rule runs, it skips the approval.
                  const note = (outcome.decisionNote ?? "").toLowerCase();
                  if (note.includes("remember") || note.includes("always")) {
                    const newRule = synthesizeAlwaysRule(toolName, input);
                    if (newRule) {
                      thread.allowedTools = Array.from(
                        new Set([...(thread.allowedTools ?? []), newRule]),
                      );
                      thread.updatedAt = new Date().toISOString();
                      await saveThread(ctx, thread);
                      ctx.logger.info(
                        `[chat] remembered approval rule: ${newRule}`,
                      );
                    }
                  }
                  return {
                    behavior: "allow" as const,
                    updatedInput: input as Record<string, unknown>,
                  };
                }

                const reasonMap: Record<string, string> = {
                  denied: `The board denied this action. Do not retry ${toolName} with the same arguments. Describe what you were trying to accomplish and ask the user for an alternative approach.`,
                  timeout: `Approval request for ${toolName} timed out after 5 minutes with no board decision. Treat as denied; do not retry in this turn. Report back to the user and ask them to approve via the dashboard before trying again.`,
                };
                ctx.logger.info(
                  `[chat] permission ${outcome.status} tool=${toolName}`,
                );
                return {
                  behavior: "deny" as const,
                  message:
                    reasonMap[outcome.status] ?? "Action denied by board policy.",
                };
              },
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
                // ── Claude Code tuning for background/embedded use ──
                // Opt out of telemetry, autoupdater, feedback command.
                CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
                // Strip Anthropic/cloud creds from Bash subprocess env
                // to contain prompt-injection blast radius.
                CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
                // Resume mid-turn if the previous run died (worker crash).
                CLAUDE_CODE_RESUME_INTERRUPTED_TURN: "1",
                // Kill stalled API streams before they wedge the worker.
                CLAUDE_ENABLE_STREAM_WATCHDOG: "1",
                CLAUDE_STREAM_IDLE_TIMEOUT_MS: "120000",
                // Prevent duplicate tool execution if a stream fails mid-flight.
                CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: "1",
                // Cap parallel tool use — default 10 can overwhelm a host
                // running multiple agents side-by-side.
                CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY: "4",
                // Bash bounds — explicit so runaway shells don't stall.
                BASH_DEFAULT_TIMEOUT_MS: "120000",
                BASH_MAX_TIMEOUT_MS: "600000",
                BASH_MAX_OUTPUT_LENGTH: "200000",
                // Give SessionEnd hooks room for audit/cleanup.
                CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS: "5000",
                // We enforce maxBudgetUsd — suppress the nag warnings.
                DISABLE_COST_WARNINGS: "1",
                // Route spawned subagents (code-reviewer, architect, etc.)
                // to Haiku by default — 5x cheaper, fast enough for the
                // narrow scopes each subagent handles.
                CLAUDE_CODE_SUBAGENT_MODEL: "claude-haiku-4-5",
                // Paperclip plugin workers can't manage long-lived child
                // processes cleanly; disable Bash `run_in_background`.
                CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
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

              // ── Native subagent roles ──────────────────────────────
              // The chat lead (opus 4.6) can invoke the built-in Agent
              // tool to spawn any of these on demand. Each runs in its
              // own context window with its own tool allowlist, so heavy
              // specialist work doesn't pollute the main conversation.
              // Keep the prompts terse — full skill docs live in
              // ~/.claude/skills and are auto-discovered via settingSources.
              agents: {
                "code-reviewer": {
                  description:
                    "Expert code reviewer. Multi-axis review with severity labels (blocker / major / minor / nit). Use for pre-merge quality checks, security audits, and API design reviews.",
                  prompt:
                    "You are a senior code reviewer. Read the files under review, analyze across multiple axes (correctness, security, performance, readability, testability), and report findings with severity labels. Cite file:line. Be terse and specific — do not restate code back to the user.",
                  tools: ["Read", "Glob", "Grep"],
                },
                architect: {
                  description:
                    "System design and implementation planning. Use for PRD → Architecture → Stories workflows, refactor proposals, and scoping decisions.",
                  prompt:
                    "You are a senior software architect. Before proposing any change, read the relevant code to understand existing patterns. Produce an implementation plan with: goals, non-goals, architecture sketch, phased stories, rollout risk. Prefer small composable increments over big-bang rewrites.",
                  tools: ["Read", "Glob", "Grep"],
                },
                debugger: {
                  description:
                    "Systematic bug reproduction and root-cause analysis. Use when a test is failing, a behavior is wrong, or logs show an error.",
                  prompt:
                    "You are a debugging specialist. Follow the discipline: reproduce first, isolate the minimal failing case, form a hypothesis, test it, report the root cause and fix. Never guess — each claim must be backed by an observation from the code, logs, or a shell command.",
                  tools: ["Read", "Glob", "Grep", "Bash"],
                },
                researcher: {
                  description:
                    "Open-ended exploration of a codebase or external docs. Use when the user needs a survey across many files or wants the latest info from the web.",
                  prompt:
                    "You are a research agent. Cast a wide net via Glob, Grep, WebSearch, and WebFetch. Take notes as you go. Produce a synthesized report with direct citations (file:line for code, URL for web). Do not modify anything.",
                  tools: ["Read", "Glob", "Grep", "WebSearch", "WebFetch"],
                },
              },

              // ── Cost cap ───────────────────────────────────────────
              // Hard ceiling per chat turn. Opus 4.6 burns through
              // tokens quickly on deep investigations; $5 gives the
              // agent room to iterate on a medium task without running
              // away. User can raise this per-thread later if needed.
              maxBudgetUsd: 5,

              // ── Audit hook ──────────────────────────────────────
              // Mutations are gated by canUseTool above (board approval
              // required). The only hook kept is a PostToolUse audit
              // logger so every executed tool call shows up in the
              // server log regardless of source.
              hooks: {
                PostToolUse: [
                  {
                    matcher: ".*",
                    hooks: [
                      async (input) => {
                        const toolName = (input as { tool_name?: string }).tool_name ?? "unknown";
                        const agentType = (input as { agent_type?: string }).agent_type;
                        ctx.logger.info(
                          `[chat] tool_use ${toolName}${agentType ? ` [subagent:${agentType}]` : ""}`,
                        );
                        return {};
                      },
                    ],
                  },
                ],
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
