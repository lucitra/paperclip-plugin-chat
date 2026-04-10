/** A chat thread stored in plugin state */
export interface ChatThread {
  id: string;
  companyId: string;
  title: string;
  /** Agent session ID for resume */
  sessionId: string | null;
  /** Adapter type locked at creation */
  adapterType: string;
  /** Model used for this thread */
  model: string;
  status: "idle" | "running" | "error";
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * Thread-scoped "approve always" rules in Claude Code's permission
   * format (e.g. `Bash(ls *)`, `Write`, `mcp__paperclip__paperclip-create-issue`).
   * Appended when the board approves a tool call with a "remember" hint
   * in the decisionNote. Checked in canUseTool before creating new
   * approval requests.
   */
  allowedTools?: string[];
}

/** A single chat message */
export interface ChatMessage {
  id: string;
  threadId: string;
  role: "user" | "assistant" | "system";
  content: string;
  metadata: ChatMessageMetadata | null;
  createdAt: string;
}

/** Structured metadata stored with assistant messages */
export interface ChatMessageMetadata {
  segments: ChatSegment[];
}

export type ChatSegment =
  | { kind: "text"; content: string }
  | { kind: "thinking"; content: string }
  | { kind: "tool"; name: string; input: unknown; result?: string; isError?: boolean };

/** Available adapter info returned to the UI */
export interface ChatAdapterInfo {
  type: string;
  label: string;
  available: boolean;
  models: { id: string; label: string }[];
}

/** Stream event pushed from worker to UI via SSE bridge */
export interface ChatStreamEvent {
  type:
    | "text"
    | "thinking"
    | "tool_use"
    | "tool_result"
    | "session_init"
    | "result"
    | "error"
    | "title_updated"
    | "done"
    | "permission_request";
  text?: string;
  name?: string;
  input?: unknown;
  content?: string;
  isError?: boolean;
  sessionId?: string;
  toolUseId?: string;
  usage?: { input_tokens: number; output_tokens: number };
  costUsd?: number;
  title?: string;
  /** Board-approval request — `approvalId` identifies the pending record */
  approvalId?: string;
}
