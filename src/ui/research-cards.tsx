/**
 * Rich card renderers for research tool results in the chat.
 *
 * When an agent calls research tools (research-brief, research-equity-quote, etc.),
 * these components render structured cards instead of raw JSON. Self-contained —
 * no imports from the research plugin.
 */

import type { ReactElement } from "react";

/* ── Types ──────────────────────────────────────────────────────────────── */

interface TradeIdea {
  id: string;
  horizon: "intraday" | "swing" | "hold";
  thesis: string;
  instrument: string;
  direction: "long" | "short";
  entry: number;
  target: number;
  stop: number;
  conviction: number;
  rationale: string;
  shares?: number;
  dollarAmount?: number;
  portfolioPct?: number;
  dollarRisk?: number;
}

interface EquitySnapshot {
  symbol: string;
  last?: number;
  dayChangePct?: number;
  weekChangePct?: number;
  monthChangePct?: number;
  volume?: number;
}

interface MacroSnapshot {
  seriesId: string;
  label: string;
  latest?: number;
  change?: number;
}

interface NewsHeadline {
  title: string;
  url: string;
  date?: string;
}

interface ResearchBrief {
  timestamp: string;
  equities: EquitySnapshot[];
  macro: MacroSnapshot[];
  headlines: NewsHeadline[];
  newsSummary?: string;
  tradeIdeas?: TradeIdea[];
  llmTradeIdeas?: TradeIdea[];
  llmTradeIdeasSource?: string;
}

/* ── Constants ──────────────────────────────────────────────────────────── */

const RESEARCH_TOOLS = new Set([
  "research-brief",
  "research-equity-quote",
  "research-equity-history",
  "research-news-search",
  "research-fred-series",
]);

const PCT_SERIES = new Set(["DGS2", "DGS10", "DGS30", "DFF", "UNRATE"]);

/* ── Helpers ────────────────────────────────────────────────────────────── */

function fmtPct(v: number | undefined): string {
  if (v == null) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function fmtPrice(v: number | undefined): string {
  if (v == null) return "—";
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function changeColor(v: number | undefined): string {
  if (v == null) return "hsl(var(--muted-foreground))";
  return v >= 0 ? "#22c55e" : "#ef4444";
}

/* ── Public API ─────────────────────────────────────────────────────────── */

/** Returns true if this tool name has a rich card renderer. */
export function isResearchTool(toolName: string): boolean {
  return RESEARCH_TOOLS.has(toolName);
}

/** Try to parse tool result JSON and render a rich card. Returns null if parsing fails. */
export function renderResearchCard(toolName: string, resultStr: string): ReactElement | null {
  let data: unknown;
  try {
    data = JSON.parse(resultStr);
  } catch {
    return null;
  }

  if (toolName === "research-brief") {
    return <ResearchBriefCard brief={data as ResearchBrief} />;
  }
  if (toolName === "research-equity-quote") {
    // Single quote or array
    const quotes = Array.isArray(data) ? data : [data];
    return <EquityQuotesCard quotes={quotes as EquitySnapshot[]} />;
  }
  if (toolName === "research-news-search") {
    const results = (data as { results?: Array<{ title: string; url: string; published_date?: string }> })?.results;
    if (results) return <NewsResultsCard results={results} />;
  }
  if (toolName === "research-fred-series") {
    return <FredSeriesCard data={data as { series_id: string; observations: Array<{ date: string; value: string }> }} />;
  }

  return null;
}

/* ── Card Components ────────────────────────────────────────────────────── */

function ResearchBriefCard({ brief }: { brief: ResearchBrief }) {
  const ideas = brief.llmTradeIdeas ?? brief.tradeIdeas ?? [];
  return (
    <div className="space-y-3 mt-1">
      {/* Research Statement */}
      {brief.newsSummary && (
        <div className="border-l-2 border-primary pl-3 py-2">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
            Research Statement
          </div>
          <div className="text-[13px] leading-relaxed text-foreground whitespace-pre-wrap">
            {brief.newsSummary}
          </div>
        </div>
      )}

      {/* Trade Ideas */}
      {ideas.length > 0 && (
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
            Trade Ideas · {brief.llmTradeIdeas ? (brief.llmTradeIdeasSource ?? "AI") : "rule-based"}
          </div>
          <div className="space-y-2">
            {ideas.map((idea, i) => (
              <TradeIdeaCard key={idea.id ?? i} idea={idea} />
            ))}
          </div>
        </div>
      )}

      {/* Market Snapshot (compact) */}
      {brief.equities.length > 0 && (
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
            Market Snapshot
          </div>
          <div className="flex flex-wrap gap-1.5">
            {brief.equities.slice(0, 12).map((eq) => (
              <MiniQuote key={eq.symbol} eq={eq} />
            ))}
          </div>
        </div>
      )}

      {/* Macro (compact) */}
      {brief.macro.length > 0 && (
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
            Macro
          </div>
          <div className="flex flex-wrap gap-1.5">
            {brief.macro.map((m) => (
              <div key={m.seriesId} className="text-[11px] px-2 py-1 rounded bg-muted border border-border">
                <span className="font-medium">{m.label}</span>{" "}
                <span className="font-mono font-semibold">
                  {m.latest != null ? (PCT_SERIES.has(m.seriesId) ? `${m.latest.toFixed(2)}%` : m.latest.toFixed(1)) : "—"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function TradeIdeaCard({ idea }: { idea: TradeIdea }) {
  const dirColor = idea.direction === "long" ? "#22c55e" : "#ef4444";
  const horizonLabel = idea.horizon === "intraday" ? "Intra-day" : idea.horizon === "swing" ? "Swing" : "Buy & Hold";
  const rr = Math.abs((idea.target - idea.entry) / (idea.entry - idea.stop));

  return (
    <div className="rounded-md border border-border p-3" style={{ borderLeftWidth: 3, borderLeftColor: dirColor }}>
      {/* Header */}
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[10px] font-bold uppercase tracking-wide" style={{ color: dirColor }}>
          {idea.direction}
        </span>
        <span className="text-sm font-bold font-mono">{idea.instrument}</span>
        <span className="text-[9px] px-1.5 py-0.5 rounded bg-muted border border-border text-muted-foreground uppercase tracking-wide font-semibold">
          {horizonLabel}
        </span>
        {idea.conviction != null && (
          <span className="ml-auto text-[10px] text-muted-foreground">
            Conv: <span className="font-semibold text-foreground">{Math.round(idea.conviction * 100)}</span>
          </span>
        )}
      </div>

      {/* Thesis */}
      <div className="text-[12px] font-medium text-foreground mb-2">{idea.thesis}</div>

      {/* Price grid */}
      <div className="grid grid-cols-4 gap-2 text-[11px] bg-muted rounded px-2 py-1.5 mb-2 border border-border">
        <PriceCell label="Entry" value={idea.entry} />
        <PriceCell label="Target" value={idea.target} color="#22c55e" />
        <PriceCell label="Stop" value={idea.stop} color="#ef4444" />
        <div>
          <div className="text-[9px] text-muted-foreground uppercase tracking-wide">R:R</div>
          <div className="font-mono font-semibold">{rr.toFixed(2)}</div>
        </div>
      </div>

      {/* Sizing row */}
      {idea.shares != null && (
        <div className="grid grid-cols-4 gap-2 text-[11px] bg-muted rounded px-2 py-1.5 mb-2 border border-border">
          <div>
            <div className="text-[9px] text-muted-foreground uppercase tracking-wide">Shares</div>
            <div className="font-mono font-semibold">{idea.shares}</div>
          </div>
          <div>
            <div className="text-[9px] text-muted-foreground uppercase tracking-wide">Amount</div>
            <div className="font-mono font-semibold">${idea.dollarAmount?.toLocaleString("en-US", { maximumFractionDigits: 0 }) ?? "—"}</div>
          </div>
          <div>
            <div className="text-[9px] text-muted-foreground uppercase tracking-wide">Portfolio</div>
            <div className="font-mono font-semibold">{idea.portfolioPct != null ? `${(idea.portfolioPct * 100).toFixed(1)}%` : "—"}</div>
          </div>
          <div>
            <div className="text-[9px] text-muted-foreground uppercase tracking-wide">$ Risk</div>
            <div className="font-mono font-semibold" style={{ color: "#ef4444" }}>${idea.dollarRisk?.toLocaleString("en-US", { maximumFractionDigits: 0 }) ?? "—"}</div>
          </div>
        </div>
      )}

      {/* Rationale */}
      <div className="text-[11px] text-muted-foreground leading-relaxed">{idea.rationale}</div>
    </div>
  );
}

function PriceCell({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div>
      <div className="text-[9px] text-muted-foreground uppercase tracking-wide">{label}</div>
      <div className="font-mono font-semibold" style={color ? { color } : undefined}>${value.toFixed(2)}</div>
    </div>
  );
}

function MiniQuote({ eq }: { eq: EquitySnapshot }) {
  return (
    <div className="text-[11px] px-2 py-1 rounded bg-muted border border-border inline-flex items-center gap-1.5">
      <span className="font-semibold">{eq.symbol}</span>
      <span className="font-mono">{fmtPrice(eq.last)}</span>
      <span className="font-mono" style={{ color: changeColor(eq.dayChangePct) }}>
        {fmtPct(eq.dayChangePct)}
      </span>
    </div>
  );
}

function EquityQuotesCard({ quotes }: { quotes: EquitySnapshot[] }) {
  return (
    <div className="mt-1">
      <div className="flex flex-wrap gap-1.5">
        {quotes.map((q) => (
          <div key={q.symbol} className="rounded border border-border bg-muted px-2.5 py-1.5">
            <div className="flex items-center gap-2">
              <span className="text-[12px] font-bold">{q.symbol}</span>
              <span className="text-[11px] font-mono" style={{ color: changeColor(q.dayChangePct) }}>
                {fmtPct(q.dayChangePct)}
              </span>
            </div>
            <div className="text-[14px] font-mono font-semibold mt-0.5">{fmtPrice(q.last)}</div>
            {(q.weekChangePct != null || q.monthChangePct != null) && (
              <div className="flex gap-2 text-[10px] text-muted-foreground mt-0.5">
                {q.weekChangePct != null && <span>1W: <span style={{ color: changeColor(q.weekChangePct) }}>{fmtPct(q.weekChangePct)}</span></span>}
                {q.monthChangePct != null && <span>1M: <span style={{ color: changeColor(q.monthChangePct) }}>{fmtPct(q.monthChangePct)}</span></span>}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function NewsResultsCard({ results }: { results: Array<{ title: string; url: string; published_date?: string }> }) {
  return (
    <div className="mt-1 space-y-1">
      {results.slice(0, 8).map((r, i) => (
        <div key={i} className="text-[12px] py-1 border-b border-border last:border-0">
          <a href={r.url} target="_blank" rel="noopener noreferrer" className="text-foreground hover:text-primary no-underline font-medium">
            {r.title}
          </a>
          {r.published_date && (
            <span className="text-[10px] text-muted-foreground ml-2">{r.published_date}</span>
          )}
        </div>
      ))}
    </div>
  );
}

function FredSeriesCard({ data }: { data: { series_id: string; observations: Array<{ date: string; value: string }> } }) {
  const obs = data.observations?.filter((o) => o.value !== ".").slice(-10) ?? [];
  const isPct = PCT_SERIES.has(data.series_id);
  return (
    <div className="mt-1">
      <div className="text-[11px] font-semibold mb-1">{data.series_id}</div>
      <div className="flex flex-wrap gap-1">
        {obs.map((o) => (
          <div key={o.date} className="text-[10px] px-1.5 py-0.5 rounded bg-muted border border-border font-mono">
            {o.date.slice(5)}: {isPct ? `${parseFloat(o.value).toFixed(2)}%` : o.value}
          </div>
        ))}
      </div>
    </div>
  );
}
