/**
 * Tool presentation utilities for the chat UI.
 *
 * Ported from Paperclip's ui/src/lib/transcriptPresentation.ts with
 * MCP-aware name normalization for plugin tools (mcp__paperclip__*).
 */

export interface ToolInputDetail {
  label: string;
  value: string;
  tone?: "default" | "code";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}...` : value;
}

function humanizeLabel(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function stripWrappedShell(command: string): string {
  const trimmed = compactWhitespace(command);
  const shellWrapped = trimmed.match(
    /^(?:(?:\/bin\/)?(?:zsh|bash|sh)|cmd(?:\.exe)?(?:\s+\/d)?(?:\s+\/s)?(?:\s+\/c)?)\s+(?:-lc|\/c)\s+(.+)$/i,
  );
  const inner = shellWrapped?.[1] ?? trimmed;
  const quoted = inner.match(/^(['"])([\s\S]*)\1$/);
  return compactWhitespace(quoted?.[2] ?? inner);
}

function formatUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function summarizeRecord(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return truncate(compactWhitespace(value), 120);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// MCP-aware name normalization
// ---------------------------------------------------------------------------

/** Known plugin display names by plugin key */
const PLUGIN_DISPLAY_NAMES: Record<string, string> = {
  "paperclip-plugin-linear": "Linear",
  "paperclip-plugin-market-data": "Market Data",
  "paperclip-plugin-research": "Research",
  "paperclip-plugin-chat": "Chat",
};

/**
 * Normalize MCP tool names into human-readable display names.
 *
 * MCP tools from plugins appear as:
 *   `mcp__paperclip__paperclip-plugin-linear__search-issues`
 *
 * This normalizes to: "Search Issues (Linear)"
 */
export function normalizeMcpToolName(name: string): { displayName: string; pluginLabel: string | null } {
  // Strip mcp__paperclip__ prefix
  const mcpMatch = name.match(/^mcp__paperclip__(.+?)__(.+)$/);
  if (mcpMatch) {
    const pluginKey = mcpMatch[1];
    const toolName = mcpMatch[2];
    const pluginLabel = PLUGIN_DISPLAY_NAMES[pluginKey] ?? humanizeLabel(pluginKey);
    return { displayName: humanizeLabel(toolName), pluginLabel };
  }

  // Other MCP prefixes (mcp__notion__, mcp__linear-hosted__, etc.)
  const otherMcp = name.match(/^mcp__(.+?)__(.+)$/);
  if (otherMcp) {
    const serverName = otherMcp[1];
    const toolName = otherMcp[2];
    return { displayName: humanizeLabel(toolName), pluginLabel: humanizeLabel(serverName) };
  }

  return { displayName: humanizeLabel(name), pluginLabel: null };
}

/** Returns true if this is a Paperclip plugin MCP tool. */
export function isPluginTool(name: string): boolean {
  return name.startsWith("mcp__paperclip__");
}

/** Returns the plugin key from an MCP tool name, or null. */
export function getPluginKey(name: string): string | null {
  const match = name.match(/^mcp__paperclip__(.+?)__/);
  return match?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Core presentation functions
// ---------------------------------------------------------------------------

export function isCommandTool(name: string, input: unknown): boolean {
  if (name === "command_execution" || name === "shell" || name === "shellToolCall" || name === "bash" || name === "Bash") {
    return true;
  }
  if (typeof input === "string") {
    return /\b(?:bash|zsh|sh|cmd|powershell)\b/i.test(input);
  }
  const record = asRecord(input);
  return Boolean(record && (typeof record.command === "string" || typeof record.cmd === "string"));
}

export function displayToolName(name: string, input?: unknown): string {
  if (isCommandTool(name, input)) return "Executing command";
  const { displayName, pluginLabel } = normalizeMcpToolName(name);
  return pluginLabel ? `${displayName} (${pluginLabel})` : displayName;
}

export function summarizeToolInput(name: string, input: unknown): string {
  const max = 120;
  if (typeof input === "string") {
    const normalized = isCommandTool(name, input) ? stripWrappedShell(input) : compactWhitespace(input);
    return truncate(normalized, max);
  }
  const record = asRecord(input);
  if (!record) {
    const serialized = compactWhitespace(formatUnknown(input));
    return serialized ? truncate(serialized, max) : `Inspect ${name} input`;
  }

  const command =
    typeof record.command === "string"
      ? record.command
      : typeof record.cmd === "string"
        ? record.cmd
        : null;
  const humanDescription =
    summarizeRecord(record, ["description", "summary", "reason", "goal", "intent", "action", "task"]) ?? null;
  if (humanDescription) return truncate(humanDescription, max);
  if (command && isCommandTool(name, record)) return truncate(stripWrappedShell(command), max);

  const direct =
    summarizeRecord(record, ["path", "filePath", "file_path", "query", "url", "prompt", "message"]) ??
    summarizeRecord(record, ["pattern", "name", "title", "target", "tool", "command", "cmd"]) ??
    null;
  if (direct) return truncate(direct, max);

  const keys = Object.keys(record);
  if (keys.length === 0) return `No ${name} input`;
  if (keys.length === 1) return truncate(`${keys[0]} payload`, max);
  return truncate(`${keys.length} fields: ${keys.slice(0, 3).join(", ")}`, max);
}

export function describeToolInput(name: string, input: unknown): ToolInputDetail[] {
  if (typeof input === "string") {
    const summary = compactWhitespace(isCommandTool(name, input) ? stripWrappedShell(input) : input);
    return summary
      ? [{ label: isCommandTool(name, input) ? "Command" : "Input", value: truncate(summary, 200), tone: "code" as const }]
      : [];
  }

  const record = asRecord(input);
  if (!record) return [];

  const details: ToolInputDetail[] = [];
  const seen = new Set<string>();
  const pushDetail = (label: string, value: string | null, tone: ToolInputDetail["tone"] = "default") => {
    if (!value) return;
    const key = `${label}:${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    details.push({ label, value, tone });
  };

  pushDetail("Intent", summarizeRecord(record, ["description", "summary", "reason", "goal", "intent", "action", "task"]));
  pushDetail(
    "Path",
    readToolDetailValue(record.path) ?? readToolDetailValue(record.filePath) ?? readToolDetailValue(record.file_path),
  );
  pushDetail("Directory", readToolDetailValue(record.cwd));
  pushDetail("Query", readToolDetailValue(record.query));
  pushDetail("Target", readToolDetailValue(record.url) ?? readToolDetailValue(record.target));
  pushDetail("Prompt", readToolDetailValue(record.prompt) ?? readToolDetailValue(record.message));
  pushDetail("Pattern", readToolDetailValue(record.pattern));
  pushDetail("Name", readToolDetailValue(record.name) ?? readToolDetailValue(record.title));

  const command =
    typeof record.command === "string"
      ? record.command
      : typeof record.cmd === "string"
        ? record.cmd
        : null;
  if (command && isCommandTool(name, record) && !details.some((d) => d.label === "Intent")) {
    pushDetail("Command", truncate(stripWrappedShell(command), 200), "code");
  }

  return details;
}

function readToolDetailValue(value: unknown, max = 200): string | null {
  if (typeof value === "string") {
    const normalized = compactWhitespace(value);
    return normalized ? truncate(normalized, max) : null;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

export function summarizeToolResult(result: string | undefined, isError: boolean | undefined): string {
  if (!result) return isError ? "Tool failed" : "Waiting for result";
  const lines = result
    .split(/\r?\n/)
    .map((line) => compactWhitespace(line))
    .filter(Boolean);
  const firstLine = lines[0] ?? result;
  return truncate(firstLine, 140);
}

export function formatToolPayload(value: unknown): string {
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  return formatUnknown(value);
}
