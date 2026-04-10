/**
 * Claude Code permission rule engine.
 *
 * Mirrors the rule format documented at https://code.claude.com/docs/en/permissions
 * so chat threads behave like regular Claude Code sessions.
 *
 * Rule format (string):
 *   Tool                          — any use of this tool
 *   Tool(pattern)                 — specific usage, matched via the tool-specific semantics below
 *
 * Bash:
 *   Bash(git status)              — exact match
 *   Bash(git status *)            — prefix, word-boundary: "git status" then any args (NOT `git statuses`)
 *   Bash(npm *)                   — any `npm <args>`
 *   Bash(ls*)                     — no space = substring: matches `ls` and `lsof`
 *   Compound awareness: `Bash(git status *)` does NOT authorize `git status && rm -rf`.
 *
 * Read/Edit/Write:
 *   Read                          — all reads
 *   Read(**)                      — all reads (explicit)
 *   Edit(src/**)                  — project-relative
 *   Read(//Users/alice/secret)    — absolute fs root (double slash)
 *   Read(~/scratch/*)             — home-relative
 *
 * MCP:
 *   mcp__puppeteer                — any tool from puppeteer server
 *   mcp__puppeteer__*             — same, explicit wildcard
 *   mcp__puppeteer__navigate      — specific tool
 *
 * WebFetch:
 *   WebFetch(domain:example.com)
 *
 * Agent:
 *   Agent(Explore)
 *
 * Precedence: deny > ask > allow (first matching rule wins within each bucket).
 */

export type PermissionDecision = "allow" | "deny" | "ask";

export interface PermissionRuleSet {
  allow: string[];
  deny: string[];
  ask: string[];
}

/**
 * Default allow rules, modeled on Claude Code's out-of-the-box defaults:
 *
 * - "Read-only" tools (Read/Glob/Grep/WebSearch/WebFetch/TodoWrite/Agent)
 *   are auto-allowed by category — Claude Code's default tier.
 * - A curated list of read-only Bash commands covers the overwhelming
 *   majority of investigation the model does via shell. Anything not on
 *   this list will prompt (e.g. `rm`, `git commit`, `curl -X POST`,
 *   `npm install`, `mv`, `cp`).
 * - Read operations from every MCP server we ship (paperclip core reads,
 *   Kalshi reads, Linear search, Notion reads).
 *
 * Everything NOT in these rules requires a board approval.
 */
export const DEFAULT_ALLOW_RULES: string[] = [
  // ── Read-only built-in tools (Claude Code default tier) ──
  "Read",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch",
  "TodoWrite",
  "Agent",

  // ── Read-only Bash commands ──
  "Bash(ls *)",
  "Bash(ls)",
  "Bash(cat *)",
  "Bash(head *)",
  "Bash(tail *)",
  "Bash(less *)",
  "Bash(more *)",
  "Bash(file *)",
  "Bash(stat *)",
  "Bash(du *)",
  "Bash(df *)",
  "Bash(wc *)",
  "Bash(find *)",
  "Bash(tree *)",
  "Bash(grep *)",
  "Bash(rg *)",
  "Bash(pwd)",
  "Bash(which *)",
  "Bash(whoami)",
  "Bash(hostname)",
  "Bash(uname *)",
  "Bash(uname)",
  "Bash(date)",
  "Bash(date *)",
  "Bash(env)",
  "Bash(printenv *)",
  "Bash(printenv)",
  "Bash(echo *)",
  "Bash(printf *)",
  "Bash(basename *)",
  "Bash(dirname *)",
  "Bash(realpath *)",
  "Bash(readlink *)",
  // Git read commands
  "Bash(git status)",
  "Bash(git status *)",
  "Bash(git log)",
  "Bash(git log *)",
  "Bash(git diff)",
  "Bash(git diff *)",
  "Bash(git show)",
  "Bash(git show *)",
  "Bash(git blame *)",
  "Bash(git branch)",
  "Bash(git branch *)",
  "Bash(git tag)",
  "Bash(git tag *)",
  "Bash(git remote *)",
  "Bash(git remote)",
  "Bash(git rev-parse *)",
  "Bash(git describe *)",
  "Bash(git ls-files *)",
  "Bash(git config --get *)",
  "Bash(git config --list *)",
  "Bash(git config --list)",
  "Bash(git stash list)",
  "Bash(git stash list *)",
  "Bash(git worktree list)",
  "Bash(git worktree list *)",
  // GitHub CLI read commands
  "Bash(gh pr list *)",
  "Bash(gh pr list)",
  "Bash(gh pr view *)",
  "Bash(gh issue list *)",
  "Bash(gh issue list)",
  "Bash(gh issue view *)",
  "Bash(gh run list *)",
  "Bash(gh run list)",
  "Bash(gh run view *)",
  "Bash(gh repo view *)",
  "Bash(gh repo view)",
  "Bash(gh api *)",
  // Node / pnpm / npm read commands
  "Bash(node --version)",
  "Bash(node -v)",
  "Bash(python --version)",
  "Bash(python3 --version)",
  "Bash(npm ls *)",
  "Bash(npm ls)",
  "Bash(npm view *)",
  "Bash(npm outdated *)",
  "Bash(npm outdated)",
  "Bash(pnpm ls *)",
  "Bash(pnpm ls)",
  "Bash(pnpm list *)",
  "Bash(pnpm list)",
  "Bash(pnpm outdated *)",
  "Bash(pnpm why *)",

  // ── Read-only MCP tools ──
  // Paperclip core reads
  "mcp__paperclip__paperclip-list-companies",
  "mcp__paperclip__paperclip-list-agents",
  "mcp__paperclip__paperclip-get-agent",
  "mcp__paperclip__paperclip-list-issues",
  "mcp__paperclip__paperclip-get-issue",
  "mcp__paperclip__paperclip-list-projects",
  "mcp__paperclip__paperclip-list-issue-comments",
  // Kalshi reads
  "mcp__paperclip__paperclip-plugin-kalshi__kalshi-markets-list",
  "mcp__paperclip__paperclip-plugin-kalshi__kalshi-markets-get",
  "mcp__paperclip__paperclip-plugin-kalshi__kalshi-markets-history",
  "mcp__paperclip__paperclip-plugin-kalshi__kalshi-events-list",
  "mcp__paperclip__paperclip-plugin-kalshi__kalshi-portfolio-balance",
  "mcp__paperclip__paperclip-plugin-kalshi__kalshi-portfolio-positions",
  "mcp__paperclip__paperclip-plugin-kalshi__kalshi-portfolio-orders",
  "mcp__paperclip__paperclip-plugin-kalshi__kalshi-portfolio-fills",
  // Linear search (not create/update/delete)
  "mcp__paperclip__paperclip-plugin-linear__search-linear-issues",
  // Notion reads
  "mcp__notion__notion-search",
  "mcp__notion__notion-fetch",
  "mcp__notion__notion-get-comments",
  "mcp__notion__notion-get-teams",
  "mcp__notion__notion-get-users",
];

/** Parse a rule string into { tool, pattern? }. Returns null if malformed. */
interface ParsedRule {
  tool: string;
  pattern: string | null;
}
function parseRule(rule: string): ParsedRule | null {
  const m = /^([A-Za-z0-9_]+)(?:\((.*)\))?$/.exec(rule.trim());
  if (!m) return null;
  return { tool: m[1], pattern: m[2] ?? null };
}

/**
 * Claude Code's "word-boundary" glob match for Bash commands.
 *
 * Pattern grammar:
 *   literal *       — matches any chars (including none)
 *   space before *  — enforces a word-boundary: `ls *` matches `ls -la` but NOT `lsof`
 *   no space        — substring: `ls*` matches both `ls` and `lsof`
 *
 * We keep a compound-awareness check: if the command contains ` && `, ` || `,
 * or `; ` to chain a different head command, the rule does NOT authorize
 * the chained command. We only authorize the first command in the chain.
 */
function bashCommandMatches(pattern: string, command: string): boolean {
  // Compound-awareness: only consider the first command in a chain.
  // Split on top-level shell operators, take the first segment. This is a
  // best-effort parse — matches Claude Code's documented behavior: approving
  // `git status *` does not authorize `git status && rm -rf`.
  const firstSegment = command.split(/\s*(?:&&|\|\||;)\s*/)[0] ?? command;
  const head = firstSegment.trim();

  // Convert the Claude Code pattern into a RegExp. `*` → `.*`.
  // All other regex metachars are escaped.
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  // Anchor both ends — the pattern should match the entire first segment.
  const re = new RegExp(`^${escaped}$`);
  return re.test(head);
}

/**
 * Match an MCP tool reference against a rule pattern.
 *
 * MCP tool names always look like `mcp__<server>__<rest>` (the server name
 * is the first segment after `mcp__`). Rule forms:
 *   mcp__server                  — any tool from that server
 *   mcp__server__*               — same
 *   mcp__server__tool            — specific tool (exact match)
 *   mcp__server__tool-prefix-*   — wildcard within a server
 */
function mcpToolMatches(rule: string, toolName: string): boolean {
  if (!toolName.startsWith("mcp__")) return false;
  // Rule "mcp__server" → rewrite to "mcp__server__*" for consistent matching.
  let normalized = rule;
  if (/^mcp__[^_]+$/.test(rule)) {
    normalized = `${rule}__*`;
  }
  const escaped = normalized.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(toolName);
}

/**
 * Check whether a tool call matches a single rule.
 */
export function ruleMatches(
  rule: string,
  toolName: string,
  toolInput: unknown,
): boolean {
  // MCP tools have their own namespace — rules starting with `mcp__` are
  // always MCP rules, and tool names starting with `mcp__` are always MCP
  // tools.
  if (rule.startsWith("mcp__")) {
    return mcpToolMatches(rule, toolName);
  }
  if (toolName.startsWith("mcp__")) {
    // A non-MCP rule never matches an MCP tool.
    return false;
  }

  const parsed = parseRule(rule);
  if (!parsed) return false;
  if (parsed.tool !== toolName) return false;
  // Bare `Tool` rule matches everything with that name.
  if (parsed.pattern === null) return true;

  // Tool-specific pattern semantics.
  if (parsed.tool === "Bash") {
    const cmd = (toolInput as { command?: string } | undefined)?.command ?? "";
    return bashCommandMatches(parsed.pattern, cmd);
  }

  if (parsed.tool === "WebFetch") {
    // WebFetch(domain:example.com) form.
    const domainMatch = /^domain:(.+)$/.exec(parsed.pattern);
    if (domainMatch) {
      const url = (toolInput as { url?: string } | undefined)?.url ?? "";
      try {
        const host = new URL(url).hostname;
        return host === domainMatch[1] || host.endsWith(`.${domainMatch[1]}`);
      } catch {
        return false;
      }
    }
    return false;
  }

  if (parsed.tool === "Agent") {
    // Agent(<subagent-name>) — exact match on the agent_type input field.
    const agentName = (toolInput as { subagent_type?: string; agent_type?: string } | undefined);
    const name = agentName?.subagent_type ?? agentName?.agent_type ?? "";
    return name === parsed.pattern;
  }

  // Read/Write/Edit path patterns — best-effort glob. Full gitignore-style
  // matching (absolute `//`, home `~/`, project `/`) is a follow-up. For
  // now we support: bare `Read` (matches all), exact path, `*` wildcards.
  if (parsed.tool === "Read" || parsed.tool === "Write" || parsed.tool === "Edit") {
    const path = (toolInput as { file_path?: string; path?: string } | undefined);
    const p = path?.file_path ?? path?.path ?? "";
    const escaped = parsed.pattern
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, ".+")
      .replace(/\*/g, "[^/]*");
    return new RegExp(`^${escaped}$`).test(p);
  }

  // Unknown tool with a pattern — bail out (no match).
  return false;
}

/**
 * Walk the rule set and return a decision.
 * Precedence (matches Claude Code): deny > ask > allow.
 */
export function evaluateRules(
  rules: PermissionRuleSet,
  toolName: string,
  toolInput: unknown,
): PermissionDecision | null {
  for (const r of rules.deny) {
    if (ruleMatches(r, toolName, toolInput)) return "deny";
  }
  for (const r of rules.ask) {
    if (ruleMatches(r, toolName, toolInput)) return "ask";
  }
  for (const r of rules.allow) {
    if (ruleMatches(r, toolName, toolInput)) return "allow";
  }
  return null; // no rule matched
}

/**
 * Build a reusable "approve always" rule from a single tool call.
 *
 * For Bash, synthesizes a prefix pattern based on the first two command
 * tokens (so `git status -sb` → `Bash(git status *)`). Falls back to the
 * exact command if it's a single word (`Bash(pwd)`).
 *
 * For MCP tools, pins the full tool name.
 *
 * For Read/Write/Edit, pins the exact file path.
 *
 * Returns null if we can't synthesize a safe rule (better to keep asking).
 */
export function synthesizeAlwaysRule(
  toolName: string,
  toolInput: unknown,
): string | null {
  if (toolName === "Bash") {
    const cmd = (toolInput as { command?: string } | undefined)?.command ?? "";
    const first = cmd.trim().split(/\s*(?:&&|\|\||;)\s*/)[0] ?? "";
    const tokens = first.trim().split(/\s+/);
    if (tokens.length === 0 || !tokens[0]) return null;
    if (tokens.length === 1) return `Bash(${tokens[0]})`;
    // Two-token head (e.g. `git status`, `npm run`), then wildcard.
    if (/^(git|gh|npm|pnpm|yarn|cargo|docker|kubectl|brew|apt|apt-get|poetry|uv|pip|pipx|go|rustup)$/.test(tokens[0])) {
      return `Bash(${tokens[0]} ${tokens[1]} *)`;
    }
    return `Bash(${tokens[0]} *)`;
  }

  if (toolName.startsWith("mcp__")) {
    return toolName;
  }

  if (toolName === "Read" || toolName === "Write" || toolName === "Edit") {
    const path = (toolInput as { file_path?: string; path?: string } | undefined);
    const p = path?.file_path ?? path?.path;
    if (!p) return toolName;
    return `${toolName}(${p})`;
  }

  // Built-in tool without a meaningful pattern — allow by bare name.
  return toolName;
}
