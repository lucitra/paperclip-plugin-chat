import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "../../../ui/src/context/CompanyContext";
import { useParams, useNavigate } from "../../../ui/src/lib/router";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  MessageCircle,
  Plus,
  Send,
  Trash2,
  Loader2,
  Terminal,
  ChevronDown,
  ChevronRight,
  Sparkles,
  User,
  Bot,
  Circle,
  Brain,
  ChevronUp,
  Square,
} from "lucide-react";

const MODELS = [
  { id: "claude-sonnet-4-5-20250929", label: "Sonnet 4.5", short: "Sonnet" },
  { id: "claude-opus-4-6", label: "Opus 4.6", short: "Opus" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", short: "Haiku" },
] as const;

const DEFAULT_MODEL = MODELS[0].id;

// ── Slash Commands ──────────────────────────────────────────────────

interface SlashCommand {
  name: string;
  description: string;
  prompt: string;
  builtin?: boolean;
}

const BUILTIN_COMMANDS: SlashCommand[] = [
  {
    name: "tasks",
    description: "List all active tasks",
    prompt: "Show me all active tasks (todo, in_progress, blocked) in my workspace. Include status, priority, and assignee for each.",
  },
  {
    name: "dashboard",
    description: "Show workspace dashboard",
    prompt: "Show me the company dashboard — health summary, agent status, task counts, and spend.",
  },
  {
    name: "agents",
    description: "List all agents and their status",
    prompt: "List all agents in my workspace with their current status, role, and budget usage.",
  },
  {
    name: "create",
    description: "Create a new task",
    prompt: "Help me create a new task. Ask me for the title, description, priority, and assignee.",
  },
  {
    name: "projects",
    description: "List all projects",
    prompt: "Show me all projects in my workspace with their status and any associated workspaces.",
  },
  {
    name: "costs",
    description: "Show cost breakdown",
    prompt: "Show me the cost summary for my workspace — total spend, breakdown by agent, and by project.",
  },
  {
    name: "activity",
    description: "Show recent activity",
    prompt: "Show me the recent activity log for my workspace.",
  },
  {
    name: "blocked",
    description: "Show blocked tasks",
    prompt: "Show me all blocked tasks and what's blocking them. Include comments explaining the blockers.",
  },
  {
    name: "plan",
    description: "Plan and break down work",
    prompt: "Help me plan work. I'll describe what I need done and you'll help break it into tasks, assign them, and set priorities.",
  },
  {
    name: "handoff",
    description: "Hand off work to an agent",
    prompt: "I want to hand off work to an agent. Which agent should I assign this to, and what's the task? List available agents so I can pick one.",
  },
];

function loadCustomCommands(): SlashCommand[] {
  try {
    const raw = localStorage.getItem("paperclip-chat-custom-commands");
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveCustomCommands(cmds: SlashCommand[]) {
  localStorage.setItem("paperclip-chat-custom-commands", JSON.stringify(cmds));
}

// ── Types ──────────────────────────────────────────────────────────

interface PaperclipAgent {
  id: string;
  name: string;
  role: string;
  title?: string;
  status?: string;
}

interface Thread {
  id: string;
  company_id: string;
  title: string;
  session_id: string | null;
  created_at: string;
  updated_at: string;
}

interface Message {
  id: string;
  thread_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  metadata?: { segments?: StreamSegment[] } | null;
  created_at: string;
}

// Ordered streaming segments — rendered in sequence as they arrive
type StreamSegment =
  | { kind: "text"; content: string }
  | { kind: "thinking"; content: string }
  | { kind: "tool"; name: string; input: unknown; result?: string; isError?: boolean }
  | { kind: "error"; content: string };

interface StreamingChunk {
  type: "text" | "thinking" | "tool_use" | "tool_result" | "result" | "error" | "session" | "title_updated";
  text?: string;
  name?: string;
  input?: unknown;
  toolUseId?: string;
  content?: string;
  isError?: boolean;
  error?: string;
  sessionId?: string;
  title?: string;
  usage?: { input_tokens: number; output_tokens: number };
  costUsd?: number;
}

const API_BASE = "/api/plugins/chat-ui";

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    ...init,
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function truncateStr(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function formatInput(input: unknown, max = 300): string {
  const s = typeof input === "string" ? input : JSON.stringify(input, null, 2);
  return truncateStr(s, max);
}

// ── Styles ─────────────────────────────────────────────────────────

const CHAT_STYLES = `
  .chat-msg-enter {
    animation: chatMsgSlide 380ms cubic-bezier(0.16, 1, 0.3, 1) both;
  }
  @keyframes chatMsgSlide {
    from { opacity: 0; transform: translateY(8px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  .chat-cursor::after {
    content: "▊";
    display: inline;
    animation: cursorBlink 800ms steps(2) infinite;
    color: oklch(0.488 0.243 264.376);
    font-weight: 400;
    margin-left: 1px;
  }
  @keyframes cursorBlink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0; }
  }

  .chat-tool-pulse {
    animation: toolPulse 1.8s ease-in-out infinite;
  }
  @keyframes toolPulse {
    0%, 100% { opacity: 0.4; }
    50% { opacity: 1; }
  }

  .chat-thread-item {
    transition: background-color 120ms ease, border-color 120ms ease;
  }

  .chat-input-glow:focus-within {
    box-shadow: 0 0 0 1px oklch(0.488 0.243 264.376 / 0.3),
                0 0 12px oklch(0.488 0.243 264.376 / 0.08);
  }

  .chat-markdown h1, .chat-markdown h2, .chat-markdown h3 {
    font-weight: 600;
    margin-top: 1em;
    margin-bottom: 0.4em;
    line-height: 1.3;
  }
  .chat-markdown h1 { font-size: 1.15em; }
  .chat-markdown h2 { font-size: 1.05em; }
  .chat-markdown h3 { font-size: 0.95em; }
  .chat-markdown p { margin: 0.4em 0; }
  .chat-markdown ul, .chat-markdown ol { margin: 0.4em 0; padding-left: 1.5em; }
  .chat-markdown ul { list-style-type: disc; }
  .chat-markdown ol { list-style-type: decimal; }
  .chat-markdown li { margin: 0.15em 0; }
  .chat-markdown li::marker { color: oklch(0.6 0 0); }
  .chat-markdown code {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 0.88em;
    padding: 0.15em 0.35em;
    border-radius: 3px;
    background: oklch(0.205 0 0 / 0.6);
  }
  .chat-markdown pre {
    margin: 0.6em 0;
    padding: 0.75em 1em;
    border-radius: 4px;
    overflow-x: auto;
    background: oklch(0.12 0 0) !important;
    border: 1px solid oklch(0.269 0 0);
  }
  .chat-markdown pre code {
    padding: 0;
    background: none;
    font-size: 0.85em;
    line-height: 1.5;
  }
  .chat-markdown a {
    color: oklch(0.488 0.243 264.376);
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .chat-markdown blockquote {
    border-left: 2px solid oklch(0.269 0 0);
    padding-left: 0.75em;
    margin: 0.5em 0;
    color: oklch(0.6 0 0);
  }
  .chat-markdown table {
    border-collapse: collapse;
    margin: 0.5em 0;
    font-size: 0.9em;
  }
  .chat-markdown th, .chat-markdown td {
    border: 1px solid oklch(0.269 0 0);
    padding: 0.35em 0.6em;
    text-align: left;
  }
  .chat-markdown th {
    background: oklch(0.205 0 0 / 0.5);
    font-weight: 600;
  }

  .chat-scroll::-webkit-scrollbar { width: 4px; }
  .chat-scroll::-webkit-scrollbar-track { background: transparent; }
  .chat-scroll::-webkit-scrollbar-thumb {
    background: oklch(0.3 0 0);
    border-radius: 2px;
  }
  .chat-scroll::-webkit-scrollbar-thumb:hover { background: oklch(0.4 0 0); }

  @media (prefers-reduced-motion: reduce) {
    .chat-msg-enter { animation: none; }
    .chat-cursor::after { animation: none; }
    .chat-tool-pulse { animation: none; opacity: 1; }
  }
`;

// ── Segment Grouping ──────────────────────────────────────────────
// Group consecutive tool/thinking segments into activity blocks
// so the UI isn't a wall of individual cards

type GroupedSegment =
  | { type: "text"; content: string; index: number }
  | { type: "error"; content: string; index: number }
  | { type: "activity"; segments: StreamSegment[]; startIndex: number };

function groupSegments(segments: StreamSegment[]): GroupedSegment[] {
  const groups: GroupedSegment[] = [];
  let activityBuf: StreamSegment[] = [];
  let activityStart = 0;

  const flushActivity = () => {
    if (activityBuf.length > 0) {
      groups.push({ type: "activity", segments: [...activityBuf], startIndex: activityStart });
      activityBuf = [];
    }
  };

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.kind === "tool" || seg.kind === "thinking") {
      if (activityBuf.length === 0) activityStart = i;
      activityBuf.push(seg);
    } else if (seg.kind === "text") {
      flushActivity();
      groups.push({ type: "text", content: seg.content, index: i });
    } else if (seg.kind === "error") {
      flushActivity();
      groups.push({ type: "error", content: seg.content, index: i });
    }
  }
  flushActivity();
  return groups;
}

function summarizeTools(segments: StreamSegment[]): string {
  const tools = segments.filter((s) => s.kind === "tool") as Extract<StreamSegment, { kind: "tool" }>[];
  if (tools.length === 0) return "Thinking";
  // Count tool names
  const counts = new Map<string, number>();
  for (const t of tools) {
    counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
  }
  const parts: string[] = [];
  for (const [name, count] of counts) {
    parts.push(count > 1 ? `${name} ×${count}` : name);
  }
  return parts.join(", ");
}

// ── Activity Group (collapsed tool/thinking runs) ─────────────────

function ActivityGroup({
  segments,
  isLive,
}: {
  segments: StreamSegment[];
  isLive: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const toolCount = segments.filter((s) => s.kind === "tool").length;
  const hasErrors = segments.some((s) => s.kind === "tool" && (s as any).isError);
  const allDone = segments
    .filter((s) => s.kind === "tool")
    .every((s) => (s as any).result !== undefined);
  const activeTool = isLive
    ? (segments.filter((s) => s.kind === "tool").reverse().find((s) => (s as any).result === undefined) as Extract<StreamSegment, { kind: "tool" }> | undefined)
    : undefined;

  return (
    <div className="my-0.5 opacity-50 hover:opacity-80 transition-opacity">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 text-[11px] text-muted-foreground/50 hover:text-muted-foreground/70 transition-colors py-0.5"
      >
        {expanded ? (
          <ChevronDown className="h-2.5 w-2.5 shrink-0" />
        ) : (
          <ChevronRight className="h-2.5 w-2.5 shrink-0" />
        )}
        <Terminal className="h-2.5 w-2.5 shrink-0" />
        {isLive && activeTool ? (
          <span>
            Running <span className="font-mono">{activeTool.name}</span>
            {toolCount > 1 && <span className="opacity-60"> · {toolCount} tools</span>}
          </span>
        ) : (
          <span>
            Used {toolCount} tool{toolCount !== 1 ? "s" : ""}
            <span className="opacity-50 ml-1">
              {summarizeTools(segments)}
            </span>
          </span>
        )}
        {isLive && !allDone && (
          <Circle className="h-1.5 w-1.5 fill-amber-400 text-amber-400 chat-tool-pulse shrink-0" />
        )}
        {!isLive && hasErrors && (
          <span className="text-red-400/50 text-[10px]">has errors</span>
        )}
      </button>
      {expanded && (
        <div className="ml-4 mt-0.5 space-y-0.5 border-l border-border/20 pl-2.5">
          {segments.map((seg, i) => {
            if (seg.kind === "tool") {
              return <ToolCallDetail key={i} seg={seg} isLive={isLive} />;
            }
            if (seg.kind === "thinking") {
              return <ThinkingBlock key={i} content={seg.content} isLive={isLive && i === segments.length - 1} />;
            }
            return null;
          })}
        </div>
      )}
    </div>
  );
}

// ── Tool Call Detail (shown inside expanded activity group) ────────

function ToolCallDetail({
  seg,
  isLive,
}: {
  seg: Extract<StreamSegment, { kind: "tool" }>;
  isLive: boolean;
}) {
  const hasResult = seg.result !== undefined;
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="font-mono text-[10px]">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-1.5 py-0.5 text-left hover:text-muted-foreground transition-colors text-muted-foreground/50"
      >
        {expanded ? (
          <ChevronDown className="h-2 w-2 shrink-0" />
        ) : (
          <ChevronRight className="h-2 w-2 shrink-0" />
        )}
        <span className="font-medium">{seg.name}</span>
        {isLive && !hasResult && (
          <Circle className="h-1 w-1 fill-amber-400 text-amber-400 chat-tool-pulse ml-auto shrink-0" />
        )}
        {hasResult && !seg.isError && (
          <span className="ml-auto text-emerald-400/40">done</span>
        )}
        {hasResult && seg.isError && (
          <span className="ml-auto text-red-400/40">error</span>
        )}
      </button>
      {expanded && (
        <div className="ml-3.5 my-0.5 rounded border border-border/30 overflow-hidden">
          <div className="px-2 py-1 text-muted-foreground/40 bg-black/10 whitespace-pre-wrap break-all">
            <span className="text-muted-foreground/20 select-none">{"› "}</span>
            {formatInput(seg.input, 200)}
          </div>
          {hasResult && (
            <div
              className={`px-2 py-1 border-t border-border/20 whitespace-pre-wrap break-all ${
                seg.isError ? "text-red-400/40" : "text-emerald-400/30"
              }`}
            >
              {truncateStr(seg.result!, 300)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Tool Call Card (legacy, kept for single tool display) ──────────

function ToolCallCard({
  seg,
  isLive,
}: {
  seg: Extract<StreamSegment, { kind: "tool" }>;
  isLive: boolean;
}) {
  const hasResult = seg.result !== undefined;
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    if (hasResult) setExpanded(false);
  }, [hasResult]);

  return (
    <div className="chat-msg-enter my-1.5 border border-border rounded bg-card/50 overflow-hidden font-mono text-xs">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-accent/30 transition-colors"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
        )}
        <Terminal className="h-3 w-3 text-muted-foreground shrink-0" />
        <span className="text-foreground font-medium">{seg.name}</span>
        {isLive && !hasResult && (
          <Circle className="h-2 w-2 fill-amber-400 text-amber-400 chat-tool-pulse ml-auto shrink-0" />
        )}
        {hasResult && !seg.isError && (
          <span className="ml-auto text-emerald-400/70">done</span>
        )}
        {hasResult && seg.isError && (
          <span className="ml-auto text-red-400/70">error</span>
        )}
      </button>
      {expanded && (
        <div className="border-t border-border">
          <div className="px-3 py-2 text-muted-foreground/80 bg-black/20 whitespace-pre-wrap break-all">
            <span className="text-muted-foreground/50 select-none">{"› "}</span>
            {formatInput(seg.input)}
          </div>
          {hasResult && (
            <div
              className={`px-3 py-2 border-t border-border/50 whitespace-pre-wrap break-all ${
                seg.isError ? "text-red-400/80" : "text-emerald-400/70"
              }`}
            >
              {truncateStr(seg.result!, 500)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Thinking Block ─────────────────────────────────────────────────

function ThinkingBlock({ content, isLive }: { content: string; isLive: boolean }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="chat-msg-enter my-1.5">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground/60 hover:text-muted-foreground transition-colors"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        <Brain className="h-3 w-3" />
        <span>{isLive ? "Thinking…" : "Thought process"}</span>
        {isLive && <Circle className="h-1.5 w-1.5 fill-sidebar-primary text-sidebar-primary chat-tool-pulse" />}
      </button>
      {expanded && (
        <div className="mt-1 pl-5 text-xs text-muted-foreground/50 leading-relaxed whitespace-pre-wrap border-l border-border/30 ml-1.5">
          {content}
        </div>
      )}
    </div>
  );
}

// ── Message Row ────────────────────────────────────────────────────

function MessageRow({ msg }: { msg: Message }) {
  const isUser = msg.role === "user";
  const storedSegments = msg.metadata?.segments;
  const hasSegments = storedSegments && storedSegments.length > 0;

  return (
    <div className={`chat-msg-enter flex gap-3 px-4 py-3 ${isUser ? "bg-accent/20" : ""}`}>
      <div className="shrink-0 mt-0.5">
        {isUser ? (
          <div className="h-6 w-6 rounded bg-primary flex items-center justify-center">
            <User className="h-3.5 w-3.5 text-primary-foreground" />
          </div>
        ) : (
          <div className="h-6 w-6 rounded bg-sidebar-primary/20 flex items-center justify-center">
            <Sparkles className="h-3.5 w-3.5 text-sidebar-primary" />
          </div>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 mb-1">
          <span className="text-xs font-semibold text-foreground">
            {isUser ? "You" : "Paperclip"}
          </span>
          <span className="text-[10px] text-muted-foreground/60">
            {formatTime(msg.created_at)}
          </span>
        </div>
        <div className="text-sm text-foreground/90 leading-relaxed">
          {isUser ? (
            <p className="whitespace-pre-wrap">{msg.content}</p>
          ) : hasSegments ? (
            /* Render grouped segments — consecutive tool/thinking runs are collapsed */
            groupSegments(storedSegments).map((group, i) => {
              if (group.type === "text") {
                return (
                  <div key={i} className="chat-markdown">
                    <Markdown remarkPlugins={[remarkGfm]}>{group.content}</Markdown>
                  </div>
                );
              }
              if (group.type === "activity") {
                return <ActivityGroup key={i} segments={group.segments} isLive={false} />;
              }
              if (group.type === "error") {
                return (
                  <div key={i} className="my-1 text-sm text-red-400">
                    {group.content}
                  </div>
                );
              }
              return null;
            })
          ) : (
            <div className="chat-markdown">
              <Markdown remarkPlugins={[remarkGfm]}>{msg.content}</Markdown>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Streaming Message (interleaved segments) ───────────────────────

function StreamingMessage({
  segments,
  isActive,
}: {
  segments: StreamSegment[];
  isActive: boolean;
}) {
  // Find the last text segment to show cursor on
  let lastTextIdx = -1;
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i].kind === "text") { lastTextIdx = i; break; }
  }

  const hasAnyContent = segments.length > 0;

  return (
    <div className="flex gap-3 px-4 py-3">
      <div className="shrink-0 mt-0.5">
        <div className="h-6 w-6 rounded bg-sidebar-primary/20 flex items-center justify-center">
          <Sparkles className="h-3.5 w-3.5 text-sidebar-primary" />
        </div>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 mb-1">
          <span className="text-xs font-semibold text-foreground">Paperclip</span>
          <span className="text-[10px] text-muted-foreground/60">now</span>
        </div>
        <div className="text-sm text-foreground/90 leading-relaxed">
          {!hasAnyContent && isActive && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span className="text-xs">Thinking…</span>
            </div>
          )}

          {groupSegments(segments).map((group, gi) => {
            if (group.type === "text") {
              const isLastText = group.index === lastTextIdx && isActive;
              return (
                <div key={gi} className={`chat-markdown ${isLastText ? "chat-cursor" : ""}`}>
                  <Markdown remarkPlugins={[remarkGfm]}>{group.content}</Markdown>
                </div>
              );
            }

            if (group.type === "activity") {
              return <ActivityGroup key={gi} segments={group.segments} isLive={isActive} />;
            }

            if (group.type === "error") {
              return (
                <div key={gi} className="my-1 text-sm text-red-400">
                  {group.content}
                </div>
              );
            }

            return null;
          })}
        </div>
      </div>
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────

export default function ChatPage() {
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const params = useParams<{ "*": string }>();
  const threadIdFromUrl = params["*"] || null;

  const [selectedThreadId, setSelectedThreadIdRaw] = useState<string | null>(threadIdFromUrl);
  const [input, setInput] = useState("");

  // Sync thread selection with URL
  const setSelectedThreadId = useCallback(
    (id: string | null) => {
      setSelectedThreadIdRaw(id);
      if (id) {
        navigate(`/plugins/chat-ui/${id}`, { replace: true });
      } else {
        navigate("/plugins/chat-ui", { replace: true });
      }
    },
    [navigate],
  );

  // Sync from URL on mount / URL change
  useEffect(() => {
    if (threadIdFromUrl && threadIdFromUrl !== selectedThreadId) {
      setSelectedThreadIdRaw(threadIdFromUrl);
    }
  }, [threadIdFromUrl]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [segments, setSegments] = useState<StreamSegment[]>([]);
  const [selectedModel, setSelectedModel] = useState(DEFAULT_MODEL);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const { data: threads = [] } = useQuery<Thread[]>({
    queryKey: ["plugin-chat-threads", selectedCompanyId],
    queryFn: () => fetchJson(`${API_BASE}/threads?companyId=${selectedCompanyId}`),
    enabled: !!selectedCompanyId,
  });

  // Fetch agents for @-mentions
  const { data: agents = [] } = useQuery<PaperclipAgent[]>({
    queryKey: ["plugin-chat-agents", selectedCompanyId],
    queryFn: () =>
      fetchJson<PaperclipAgent[]>(`/api/companies/${selectedCompanyId}/agents`),
    enabled: !!selectedCompanyId,
  });

  const [customCommands, setCustomCommands] = useState<SlashCommand[]>(loadCustomCommands);

  const { data: messages = [] } = useQuery<Message[]>({
    queryKey: ["plugin-chat-messages", selectedThreadId],
    queryFn: () => fetchJson(`${API_BASE}/threads/${selectedThreadId}/messages`),
    enabled: !!selectedThreadId,
  });

  const createThread = useMutation({
    mutationFn: () =>
      fetchJson<Thread>(`${API_BASE}/threads`, {
        method: "POST",
        body: JSON.stringify({ companyId: selectedCompanyId }),
      }),
    onSuccess: (thread) => {
      queryClient.invalidateQueries({ queryKey: ["plugin-chat-threads"] });
      setSelectedThreadId(thread.id);
    },
  });

  const deleteThread = useMutation({
    mutationFn: (threadId: string) =>
      fetchJson(`${API_BASE}/threads/${threadId}`, { method: "DELETE" }),
    onSuccess: (_, threadId) => {
      queryClient.invalidateQueries({ queryKey: ["plugin-chat-threads"] });
      if (selectedThreadId === threadId) setSelectedThreadId(null);
    },
  });

  const renameThread = useMutation({
    mutationFn: ({ threadId, title }: { threadId: string; title: string }) =>
      fetchJson<Thread>(`${API_BASE}/threads/${threadId}`, {
        method: "PATCH",
        body: JSON.stringify({ title }),
      }),
    onSuccess: (updated) => {
      queryClient.setQueryData<Thread[]>(
        ["plugin-chat-threads", selectedCompanyId],
        (old) => old?.map((t) => (t.id === updated.id ? { ...t, title: updated.title } : t)),
      );
    },
  });

  const [editingThreadId, setEditingThreadId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [slashMenuIndex, setSlashMenuIndex] = useState(0);
  const slashMenuRef = useRef<HTMLDivElement>(null);

  // Close model menu on outside click
  useEffect(() => {
    if (!modelMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (modelMenuRef.current && !modelMenuRef.current.contains(e.target as Node)) {
        setModelMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [modelMenuOpen]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, segments]);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 160) + "px";
  }, [input]);

  // Segment helpers — append to last segment of same kind, or create new
  const appendToLastText = useCallback((text: string) => {
    setSegments((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.kind === "text") {
        return [...prev.slice(0, -1), { ...last, content: last.content + text }];
      }
      return [...prev, { kind: "text", content: text }];
    });
  }, []);

  const appendToLastThinking = useCallback((text: string) => {
    setSegments((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.kind === "thinking") {
        return [...prev.slice(0, -1), { ...last, content: last.content + text }];
      }
      return [...prev, { kind: "thinking", content: text }];
    });
  }, []);

  const addToolUse = useCallback((name: string, input: unknown) => {
    setSegments((prev) => [...prev, { kind: "tool", name, input }]);
  }, []);

  const resolveToolResult = useCallback((content: string, isError: boolean) => {
    setSegments((prev) => {
      const updated = [...prev];
      // Find last tool segment without a result
      for (let i = updated.length - 1; i >= 0; i--) {
        const seg = updated[i];
        if (seg.kind === "tool" && seg.result === undefined) {
          updated[i] = { ...seg, result: content, isError };
          break;
        }
      }
      return updated;
    });
  }, []);

  const addError = useCallback((error: string) => {
    setSegments((prev) => [...prev, { kind: "error", content: error }]);
  }, []);

  // Slash command filtering
  const allCommands = [...BUILTIN_COMMANDS.map((c) => ({ ...c, builtin: true })), ...customCommands];
  const slashQuery = input.startsWith("/") ? input.slice(1).toLowerCase() : null;
  const filteredCommands = slashQuery !== null
    ? allCommands.filter(
        (cmd) => cmd.name.includes(slashQuery) || cmd.description.toLowerCase().includes(slashQuery),
      )
    : [];
  const showSlashMenu = slashQuery !== null && filteredCommands.length > 0 && !isStreaming;

  // @-mention filtering — detect @ at word boundary
  const atMatch = input.match(/@(\w*)$/);
  const atQuery = atMatch ? atMatch[1].toLowerCase() : null;
  const filteredAgents = atQuery !== null
    ? agents.filter(
        (a) => a.name.toLowerCase().includes(atQuery) || (a.title ?? "").toLowerCase().includes(atQuery),
      )
    : [];
  const showAtMenu = atQuery !== null && filteredAgents.length > 0 && !isStreaming && !showSlashMenu;

  // Reset index when filter changes
  const activeMenuKey = showSlashMenu ? `slash:${slashQuery}` : showAtMenu ? `at:${atQuery}` : null;
  useEffect(() => {
    setSlashMenuIndex(0);
  }, [activeMenuKey]);

  const selectSlashCommand = useCallback(
    (cmd: SlashCommand) => {
      setInput(cmd.prompt);
      textareaRef.current?.focus();
    },
    [],
  );

  const selectAgent = useCallback(
    (agent: PaperclipAgent) => {
      // Replace the @query with @AgentName
      setInput((prev) => prev.replace(/@\w*$/, `@${agent.name} `));
      textareaRef.current?.focus();
    },
    [],
  );

  const addCustomCommand = useCallback(
    (cmd: SlashCommand) => {
      setCustomCommands((prev) => {
        const next = [...prev.filter((c) => c.name !== cmd.name), cmd];
        saveCustomCommands(next);
        return next;
      });
    },
    [],
  );

  const removeCustomCommand = useCallback(
    (name: string) => {
      setCustomCommands((prev) => {
        const next = prev.filter((c) => c.name !== name);
        saveCustomCommands(next);
        return next;
      });
    },
    [],
  );

  const handleStop = useCallback(async () => {
    if (!selectedThreadId) return;
    try {
      await fetch(`/api/plugins/chat-ui/threads/${selectedThreadId}/stop`, { method: "POST" });
    } catch {}
  }, [selectedThreadId]);

  const handleSend = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || !selectedThreadId || isStreaming) return;

    setInput("");
    setIsStreaming(true);
    setSegments([]);

    // Detect @-mentioned agents and enrich the message with context
    const mentionPattern = /@(\w+)/g;
    const mentions: string[] = [];
    let match;
    while ((match = mentionPattern.exec(trimmed)) !== null) {
      mentions.push(match[1]);
    }
    let enrichedMessage = trimmed;
    if (mentions.length > 0) {
      const mentionedAgents = agents.filter((a) =>
        mentions.some((m) => a.name.toLowerCase() === m.toLowerCase()),
      );
      if (mentionedAgents.length > 0) {
        const agentContext = mentionedAgents
          .map((a) => `- @${a.name} (agent ID: ${a.id}, role: ${a.title || a.role || "agent"})`)
          .join("\n");
        enrichedMessage = `${trimmed}\n\n[SKILL: Agent Handoff — The user @-mentioned agent(s). Use the handoff skill: if the message contains a work request, create a task assigned to the agent. If it's a question, query their status/tasks instead.\n${agentContext}]`;
      }
    }

    // Optimistic user message (show original text, not enriched)
    const optimisticMsg: Message = {
      id: "optimistic-" + Date.now(),
      thread_id: selectedThreadId,
      role: "user",
      content: trimmed,
      created_at: new Date().toISOString(),
    };
    queryClient.setQueryData<Message[]>(
      ["plugin-chat-messages", selectedThreadId],
      (old) => [...(old ?? []), optimisticMsg],
    );

    const controller = new AbortController();
    abortRef.current = controller;
    let gotTitleUpdate: string | null = null;

    try {
      const res = await fetch(`${API_BASE}/threads/${selectedThreadId}/chat`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: enrichedMessage,
          displayMessage: enrichedMessage !== trimmed ? trimmed : undefined,
          model: selectedModel,
        }),
        signal: controller.signal,
      });

      if (!res.ok) throw new Error(`Chat failed: ${res.status}`);

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6);
          if (data === "[DONE]") continue;

          try {
            const chunk: StreamingChunk = JSON.parse(data);

            if (chunk.type === "text" && chunk.text) {
              appendToLastText(chunk.text);
            }

            if (chunk.type === "thinking" && chunk.text) {
              appendToLastThinking(chunk.text);
            }

            if (chunk.type === "tool_use") {
              addToolUse(chunk.name!, chunk.input);
            }

            if (chunk.type === "tool_result") {
              resolveToolResult(chunk.content ?? "", chunk.isError ?? false);
            }

            if (chunk.type === "error") {
              addError(chunk.error ?? "Unknown error");
            }

            if (chunk.type === "title_updated" && chunk.title) {
              // Reactively update thread title in the cache
              gotTitleUpdate = chunk.title;
              queryClient.setQueryData<Thread[]>(
                ["plugin-chat-threads", selectedCompanyId],
                (old) =>
                  old?.map((t) =>
                    t.id === selectedThreadId ? { ...t, title: chunk.title! } : t,
                  ),
              );
            }
          } catch {
            // Ignore parse errors
          }
        }
      }
    } catch (err: any) {
      if (err.name !== "AbortError") {
        addError(err.message);
      }
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
      queryClient.invalidateQueries({ queryKey: ["plugin-chat-messages", selectedThreadId] });
      // If we got a title_updated event, the cache is already correct —
      // don't refetch threads immediately or the stale DB read overwrites it.
      // Instead, update the cache with the title we know is correct, then refetch after a delay.
      if (gotTitleUpdate) {
        queryClient.setQueryData<Thread[]>(
          ["plugin-chat-threads", selectedCompanyId],
          (old) =>
            old?.map((t) =>
              t.id === selectedThreadId
                ? { ...t, title: gotTitleUpdate!, updated_at: new Date().toISOString() }
                : t,
            ),
        );
        // Refetch after DB has had time to commit
        setTimeout(() => {
          queryClient.invalidateQueries({ queryKey: ["plugin-chat-threads"] });
        }, 2000);
      } else {
        queryClient.invalidateQueries({ queryKey: ["plugin-chat-threads"] });
      }
    }
  }, [input, selectedThreadId, isStreaming, selectedModel, selectedCompanyId, agents, queryClient, appendToLastText, appendToLastThinking, addToolUse, resolveToolResult, addError]);

  const selectedThread = threads.find((t) => t.id === selectedThreadId);
  const threadNotFound = !!selectedThreadId && threads.length > 0 && !selectedThread;

  return (
    <>
      <style>{CHAT_STYLES}</style>
      <div className="flex h-[calc(100vh-4rem)]">
        {/* ── Thread Sidebar ── */}
        <div className="w-60 shrink-0 flex flex-col border-r border-border bg-background">
          <div className="flex items-center justify-between px-3 h-11 border-b border-border">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Threads
            </span>
            <button
              onClick={() => createThread.mutate()}
              className="h-6 w-6 rounded flex items-center justify-center hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
              title="New thread"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto chat-scroll py-1">
            {threads.length === 0 && (
              <div className="px-3 py-8 text-center">
                <Bot className="h-8 w-8 mx-auto text-muted-foreground/30 mb-2" />
                <p className="text-xs text-muted-foreground/60">No conversations yet</p>
              </div>
            )}
            {threads.map((thread) => (
              <div
                key={thread.id}
                role="button"
                tabIndex={0}
                onClick={() => setSelectedThreadId(thread.id)}
                onDoubleClick={() => {
                  setEditingThreadId(thread.id);
                  setEditingTitle(thread.title || "");
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setSelectedThreadId(thread.id);
                  }
                }}
                className={`chat-thread-item flex items-center gap-2 mx-1 px-2.5 py-2 rounded cursor-pointer group focus:outline-none focus-visible:ring-1 focus-visible:ring-primary ${
                  selectedThreadId === thread.id
                    ? "bg-accent text-foreground"
                    : "text-foreground/70 hover:bg-accent/40 hover:text-foreground"
                }`}
              >
                <MessageCircle className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
                <div className="flex-1 min-w-0">
                  {editingThreadId === thread.id ? (
                    <input
                      autoFocus
                      value={editingTitle}
                      onChange={(e) => setEditingTitle(e.target.value)}
                      onBlur={() => {
                        const trimmed = editingTitle.trim();
                        if (trimmed && trimmed !== thread.title) {
                          renameThread.mutate({ threadId: thread.id, title: trimmed });
                        }
                        setEditingThreadId(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          (e.target as HTMLInputElement).blur();
                        }
                        if (e.key === "Escape") {
                          setEditingThreadId(null);
                        }
                      }}
                      onClick={(e) => e.stopPropagation()}
                      className="text-sm w-full bg-transparent border border-border rounded px-1 py-0.5 outline-none focus:border-primary"
                    />
                  ) : (
                    <p className="text-sm truncate" title={thread.title || "New Chat"}>{thread.title || "New Chat"}</p>
                  )}
                  <p className="text-[10px] text-muted-foreground/50 mt-0.5">
                    {formatTime(thread.updated_at)}
                  </p>
                </div>
                {confirmDeleteId === thread.id ? (
                  <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                    <button
                      onClick={() => {
                        deleteThread.mutate(thread.id);
                        setConfirmDeleteId(null);
                      }}
                      className="text-[10px] px-1.5 py-0.5 rounded bg-destructive/20 text-destructive hover:bg-destructive/30 transition-colors"
                    >
                      Delete
                    </button>
                    <button
                      onClick={() => setConfirmDeleteId(null)}
                      className="text-[10px] px-1.5 py-0.5 rounded text-muted-foreground hover:bg-accent transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirmDeleteId(thread.id);
                    }}
                    className="opacity-0 group-hover:opacity-100 h-5 w-5 rounded flex items-center justify-center hover:bg-destructive/20 text-muted-foreground hover:text-destructive transition-all"
                    title="Delete thread"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* ── Chat Area ── */}
        <div className="flex-1 flex flex-col bg-background min-w-0">
          {!selectedThreadId ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 px-4">
              <div className="h-12 w-12 rounded-lg bg-sidebar-primary/10 flex items-center justify-center">
                <Sparkles className="h-6 w-6 text-sidebar-primary/60" />
              </div>
              <h2 className="text-lg font-semibold text-foreground">Paperclip Chat</h2>
              <p className="text-sm text-muted-foreground text-center max-w-sm">
                Chat with Claude to manage tasks, create issues, plan work, and interact with your Paperclip workspace.
              </p>
              <button
                onClick={() => createThread.mutate()}
                className="mt-2 inline-flex items-center gap-2 rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
              >
                <Plus className="h-4 w-4" />
                New conversation
              </button>
            </div>
          ) : threadNotFound ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 px-4">
              <div className="h-12 w-12 rounded-lg bg-destructive/10 flex items-center justify-center">
                <MessageCircle className="h-6 w-6 text-destructive/60" />
              </div>
              <h2 className="text-lg font-semibold text-foreground">Thread not found</h2>
              <p className="text-sm text-muted-foreground text-center max-w-sm">
                This conversation doesn't exist or has been deleted.
              </p>
              <button
                onClick={() => setSelectedThreadId(null)}
                className="mt-2 inline-flex items-center gap-2 rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
              >
                Go back
              </button>
            </div>
          ) : (
            <>
              {/* Header */}
              <div className="flex items-center gap-3 px-4 h-11 border-b border-border shrink-0">
                <Sparkles className="h-3.5 w-3.5 text-sidebar-primary" />
                <span className="text-sm font-medium text-foreground truncate" title={selectedThread?.title || "New Chat"}>
                  {selectedThread?.title || "New Chat"}
                </span>
                {isStreaming && (
                  <span className="ml-auto flex items-center gap-1.5 text-[10px] text-sidebar-primary">
                    <Circle className="h-1.5 w-1.5 fill-current chat-tool-pulse" />
                    responding
                  </span>
                )}
              </div>

              {/* Messages */}
              <div className="flex-1 overflow-y-auto chat-scroll">
                {messages.length === 0 && !isStreaming && (
                  <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground/40">
                    <Terminal className="h-8 w-8" />
                    <p className="text-xs">Send a message to get started</p>
                  </div>
                )}

                <div className="divide-y divide-border/40">
                  {messages.map((msg) => (
                    <MessageRow key={msg.id} msg={msg} />
                  ))}
                </div>

                {/* Streaming — interleaved segments */}
                {isStreaming && (
                  <div className="border-t border-border/40">
                    <StreamingMessage segments={segments} isActive={true} />
                  </div>
                )}

                <div ref={messagesEndRef} className="h-4" />
              </div>

              {/* Input */}
              <div className="shrink-0 border-t border-border p-3 relative">
                {/* Slash command menu */}
                {/* Slash command menu */}
                {showSlashMenu && (
                  <div
                    ref={slashMenuRef}
                    className="absolute bottom-full left-3 right-3 mb-1 bg-card border border-border rounded-lg shadow-xl overflow-hidden z-50"
                  >
                    <div className="px-3 py-1.5 border-b border-border flex items-center justify-between">
                      <span className="text-[10px] font-semibold text-muted-foreground/60 uppercase tracking-wider">
                        Commands
                      </span>
                      <span className="text-[10px] text-muted-foreground/30">
                        ↑↓ navigate · Enter select · Esc dismiss
                      </span>
                    </div>
                    <div className="max-h-[240px] overflow-y-auto chat-scroll py-1">
                      {filteredCommands.map((cmd, i) => (
                        <button
                          key={cmd.name}
                          onClick={() => selectSlashCommand(cmd)}
                          onMouseEnter={() => setSlashMenuIndex(i)}
                          className={`w-full text-left px-3 py-2 flex items-start gap-3 transition-colors ${
                            i === slashMenuIndex
                              ? "bg-accent text-foreground"
                              : "text-foreground/70 hover:bg-accent/50"
                          }`}
                        >
                          <span className="text-xs font-mono text-sidebar-primary shrink-0 mt-0.5">
                            /{cmd.name}
                          </span>
                          <span className="text-xs text-muted-foreground truncate">
                            {cmd.description}
                          </span>
                          {!cmd.builtin && (
                            <span
                              onClick={(e) => {
                                e.stopPropagation();
                                removeCustomCommand(cmd.name);
                              }}
                              className="ml-auto text-[10px] text-muted-foreground/40 hover:text-destructive cursor-pointer"
                              title="Remove custom command"
                            >
                              ×
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* @-mention menu */}
                {showAtMenu && (
                  <div className="absolute bottom-full left-3 right-3 mb-1 bg-card border border-border rounded-lg shadow-xl overflow-hidden z-50">
                    <div className="px-3 py-1.5 border-b border-border">
                      <span className="text-[10px] font-semibold text-muted-foreground/60 uppercase tracking-wider">
                        Agents
                      </span>
                    </div>
                    <div className="max-h-[200px] overflow-y-auto chat-scroll py-1">
                      {filteredAgents.map((agent, i) => (
                        <button
                          key={agent.id}
                          onClick={() => selectAgent(agent)}
                          onMouseEnter={() => setSlashMenuIndex(i)}
                          className={`w-full text-left px-3 py-2 flex items-center gap-3 transition-colors ${
                            i === slashMenuIndex
                              ? "bg-accent text-foreground"
                              : "text-foreground/70 hover:bg-accent/50"
                          }`}
                        >
                          <span className="text-xs font-semibold text-sidebar-primary">
                            @{agent.name}
                          </span>
                          <span className="text-xs text-muted-foreground truncate">
                            {agent.title || agent.role}
                          </span>
                          {agent.status && (
                            <span className={`ml-auto text-[10px] px-1.5 py-0.5 rounded-full ${
                              agent.status === "running" ? "bg-green-500/10 text-green-400"
                              : agent.status === "idle" ? "bg-muted text-muted-foreground"
                              : "bg-yellow-500/10 text-yellow-400"
                            }`}>
                              {agent.status}
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <div className="chat-input-glow flex items-center gap-2 rounded border border-border bg-card px-3 py-2.5 transition-all min-h-[42px]">
                  <span className="text-muted-foreground/40 text-sm select-none leading-none">›</span>
                  <textarea
                    ref={textareaRef}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => {
                      const menuActive = showSlashMenu || showAtMenu;
                      const menuLength = showSlashMenu ? filteredCommands.length : filteredAgents.length;
                      if (menuActive) {
                        if (e.key === "ArrowDown") {
                          e.preventDefault();
                          setSlashMenuIndex((i) => Math.min(i + 1, menuLength - 1));
                          return;
                        }
                        if (e.key === "ArrowUp") {
                          e.preventDefault();
                          setSlashMenuIndex((i) => Math.max(i - 1, 0));
                          return;
                        }
                        if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
                          e.preventDefault();
                          if (showSlashMenu) {
                            selectSlashCommand(filteredCommands[slashMenuIndex]);
                          } else {
                            selectAgent(filteredAgents[slashMenuIndex]);
                          }
                          return;
                        }
                        if (e.key === "Escape") {
                          e.preventDefault();
                          if (showSlashMenu) setInput("");
                          // For @-mentions, just let them keep typing
                          return;
                        }
                      }
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        handleSend();
                      }
                    }}
                    placeholder={isStreaming ? "Waiting for response…" : "Ask Paperclip anything…"}
                    rows={1}
                    className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/40 resize-none outline-none disabled:opacity-40 leading-[1.4] self-center"
                    style={{ maxHeight: 160 }}
                  />
                  {isStreaming ? (
                    <button
                      onClick={handleStop}
                      className="shrink-0 h-7 w-7 rounded flex items-center justify-center bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors"
                      title="Stop response"
                    >
                      <Square className="h-3 w-3 fill-current" />
                    </button>
                  ) : (
                    <button
                      onClick={handleSend}
                      disabled={!input.trim()}
                      className="shrink-0 h-7 w-7 rounded flex items-center justify-center bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-30 transition-colors"
                    >
                      <Send className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
                <div className="flex items-center justify-between mt-1.5 px-0.5">
                  {/* Model switcher */}
                  <div className="relative" ref={modelMenuRef}>
                    <button
                      onClick={() => setModelMenuOpen(!modelMenuOpen)}
                      className="flex items-center gap-1 text-[10px] text-muted-foreground/50 hover:text-muted-foreground transition-colors"
                    >
                      {MODELS.find((m) => m.id === selectedModel)?.label ?? "Model"}
                      {modelMenuOpen ? (
                        <ChevronDown className="h-2.5 w-2.5" />
                      ) : (
                        <ChevronUp className="h-2.5 w-2.5" />
                      )}
                    </button>
                    {modelMenuOpen && (
                      <div className="absolute bottom-full left-0 mb-1 bg-card border border-border rounded shadow-lg py-1 min-w-[160px] z-50">
                        {MODELS.map((m) => (
                          <button
                            key={m.id}
                            onClick={() => {
                              setSelectedModel(m.id);
                              setModelMenuOpen(false);
                            }}
                            className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${
                              selectedModel === m.id
                                ? "text-foreground bg-accent"
                                : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
                            }`}
                          >
                            {m.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <p className="text-[10px] text-muted-foreground/30">
                    Shift+Enter for new line
                  </p>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
