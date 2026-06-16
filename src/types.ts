// src/types.ts — shared contracts for tokdiet. SINGLE SOURCE OF TRUTH.
//
// Every other module implements or consumes these interfaces. Do not redefine
// these shapes elsewhere — import from here.
//
// IMPORTANT (NodeNext ESM): all RELATIVE imports across this project must end in
// ".js" (e.g. `import { x } from "./pricing.js"`), even though the source file is
// ".ts". This is required for the compiled output to run under `node`.

// ─────────────────────────────────────────────────────────────────────────────
// Providers & wire shapes
// ─────────────────────────────────────────────────────────────────────────────

export type ProviderId = 'anthropic' | 'openai' | 'gemini';

/** Metadata about an inbound proxied HTTP request, used for provider detection. */
export interface RequestMeta {
  method: string;
  /** Path with query stripped, e.g. "/v1/messages" or "/v1/chat/completions". */
  path: string;
  /** Lower-cased header map. */
  headers: Record<string, string>;
}

/** Raw token counts for one request/response cycle. */
export interface UsageCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** USD cost broken down by token class. */
export interface CostBreakdown {
  inputUSD: number;
  outputUSD: number;
  cacheReadUSD: number;
  cacheWriteUSD: number;
  totalUSD: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pricing (pricing.json) — values are USD per 1,000,000 tokens.
// ─────────────────────────────────────────────────────────────────────────────

export interface ModelPrice {
  /** USD per 1e6 input tokens. */
  input: number;
  /** USD per 1e6 output tokens. */
  output: number;
  /** USD per 1e6 cache-read tokens (optional). */
  cacheRead?: number;
  /** USD per 1e6 cache-write tokens (optional). */
  cacheWrite?: number;
}

export interface PricingTable {
  /** ISO date string, e.g. "2026-06-16". */
  version: string;
  models: Record<ProviderId, Record<string, ModelPrice>>;
}

/** Resolves model prices and computes cost. Implemented in pricing.ts. */
export interface Pricing {
  readonly version: string;
  /** Exact match first, then longest-prefix match; undefined if unknown. */
  priceFor(provider: ProviderId, model: string | undefined): ModelPrice | undefined;
  /** Compute cost; unknown models cost 0 (and should be surfaced as a warning upstream). */
  cost(provider: ProviderId, model: string | undefined, usage: UsageCounts): CostBreakdown;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tokenizing
// ─────────────────────────────────────────────────────────────────────────────

export interface TokenCounter {
  /** Count tokens for a plain string under a given provider/model. */
  count(text: string, provider: ProviderId, model?: string): number;
  /** Count approximate input tokens for a full request body (messages + system + tools). */
  countRequest(body: unknown, provider: ProviderId, model?: string): number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider adapters — detect, route, parse, and expose editable refs for compaction.
//
// Refs MUST mutate the underlying body in place via their closures so that
// unknown/extra fields survive the round-trip untouched (critical for fail-open
// fidelity). Adapters never reconstruct a body from scratch.
// ─────────────────────────────────────────────────────────────────────────────

/** Editable handle on a single tool-result's text (for elision). */
export interface ToolResultRef {
  messageIndex: number;
  /** Approx token size of this tool result's text content. */
  tokens: number;
  /** Current concatenated text content. */
  text: string;
  /** Replace the text content of this tool result in place. */
  replace(newText: string): void;
}

/** Editable handle on a large text chunk (for dedup). */
export interface TextChunkRef {
  messageIndex: number;
  role: string;
  tokens: number;
  text: string;
  replace(newText: string): void;
}

/** Editable handle on a whole message (for mid-history summarization & pinning). */
export interface MessageRef {
  index: number;
  role: 'user' | 'assistant' | 'system' | 'tool';
  tokens: number;
  /** Flattened text content of the message, for summarization input. */
  text: string;
  /** True if marked do-not-compact (pinned). */
  pinned: boolean;
  replaceText(newText: string): void;
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  /** True if this adapter should handle the given request. */
  matches(meta: RequestMeta, body: unknown): boolean;
  /** Upstream origin to forward to (no trailing slash), honoring env overrides. */
  upstreamBaseUrl(env: NodeJS.ProcessEnv): string;
  /** Model id. For Gemini the model lives in the URL path, hence optional `meta`. */
  getModel(body: unknown, meta?: RequestMeta): string | undefined;
  isStreaming(body: unknown): boolean;
  getSystemText(body: unknown): string;
  /** Total approximate input tokens (messages + system + tools). */
  countInputTokens(body: unknown, counter: TokenCounter): number;
  /** Tool results eligible for elision, oldest-first. */
  listToolResults(body: unknown, counter: TokenCounter): ToolResultRef[];
  /** Large text chunks (file dumps etc.) in document order, for dedup. */
  listTextChunks(body: unknown, counter: TokenCounter): TextChunkRef[];
  /** All messages as editable refs (oldest-first). */
  listMessages(body: unknown, counter: TokenCounter): MessageRef[];
  /** Parse usage from a complete non-streaming JSON response body. */
  parseUsageFromResponse(json: unknown): UsageCounts | undefined;
  /** Accumulate usage from a single parsed SSE event into `acc`. */
  parseUsageFromStreamEvent(eventName: string | undefined, data: unknown, acc: UsageCounts): void;
  /**
   * Extract the assistant's incremental answer text from a single parsed SSE
   * event (content_block_delta / choices[].delta / candidates parts). Returns
   * '' when the event carries no answer text. Used to reassemble the streamed
   * answer for shadow-eval so the quality signal works for streaming traffic.
   */
  extractStreamDeltaText(eventName: string | undefined, data: unknown): string;
  /** Extract the assistant's text answer from a full response body (for shadow-eval). */
  extractAnswerText(json: unknown): string;
  /**
   * Index of the last message covered by a provider cache breakpoint (Anthropic
   * `cache_control`); -1 if none. Messages at or before this index are immutable —
   * compacting them would invalidate the prompt cache and can make a request COST
   * MORE (cached input is ~10% of normal). Providers without explicit breakpoints
   * return -1.
   */
  cacheBoundaryIndex(body: unknown): number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration (tokdiet.config.json)
// ─────────────────────────────────────────────────────────────────────────────

export interface BudgetConfig {
  perSessionUSD: number | null;
  perDayUSD: number | null;
  perRepoMonthlyUSD: number | null;
}

export type OnBudgetExceeded = 'warn' | 'compact' | 'block';

export interface QualityBudget {
  /** Max acceptable measured degradation, percent (0..100). */
  maxDegradationPct: number;
}

export interface ShadowEvalConfig {
  enabled: boolean;
  /** Fraction (0..1) of compacted requests to shadow-check. */
  sampleRate: number;
  judge: 'embedding' | 'llm' | 'heuristic';
  /** Cheap model id for llm-judge / mid-summarization. */
  judgeModel?: string;
}

export interface CompactionConfig {
  enabled: boolean;
  strategies: {
    elision: boolean;
    dedup: boolean;
    midSummarize: boolean;
  };
  /** Keep this many most-recent tool results untouched. */
  keepRecentToolResults: number;
  /** Only elide tool results larger than this many tokens. */
  minToolResultTokens: number;
  /** When paging out a tool result, keep this many leading chars as a preview. */
  elisionPreviewChars: number;
  /** Max "salient" lines (errors, ids, numbers, KEY=VALUE, urls, paths) to retain from a paged-out block. */
  elisionSalientLines: number;
  /** Protect blocks lexically relevant to the latest user question from compaction. */
  relevanceProtect: boolean;
  /** Persist full paged-out content locally so it is recoverable/auditable (context virtual memory). */
  recoverable: boolean;
  /** Never compact content covered by a provider cache breakpoint (Anthropic cache_control). */
  protectCachedPrefix: boolean;
  /** Enable near-duplicate (fuzzy) collapsing in addition to exact line-run dedup. */
  semanticDedup: boolean;
}

export interface GovernorConfig {
  proxyPort: number;
  dashboardPort: number;
  dashboardEnabled: boolean;
  /** Window size for utilization %, or 'auto' to infer from model. */
  contextWindowTokens: number | 'auto';
  /** Utilization fraction (0..1) above which compaction triggers. */
  contextUtilizationThreshold: number;
  onBudgetExceeded: OnBudgetExceeded;
  budgets: BudgetConfig;
  compaction: CompactionConfig;
  qualityBudget: QualityBudget;
  shadowEval: ShadowEvalConfig;
  safeMode: boolean;
  /** Absolute path to the data directory (default ~/.tokdiet). */
  dataDir: string;
  /** Absolute path override for pricing.json, or null to use the bundled file. */
  pricingPath: string | null;
  /** Page-fault recovery: when the model can't answer because content was paged out, re-inject it and retry. */
  pageFault: { enabled: boolean; maxReinjections: number };
}

// ─────────────────────────────────────────────────────────────────────────────
// Telemetry store (SQLite)
// ─────────────────────────────────────────────────────────────────────────────

export interface RequestEvent {
  id?: number;
  /** epoch ms */
  ts: number;
  sessionId: string;
  provider: ProviderId;
  model: string;
  /** Originating tool (derived from user-agent / x-source header). */
  source: string;
  /** Repo / working-dir identifier, for per-repo budgets. */
  repo: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUSD: number;
  compacted: boolean;
  /** Tokens saved by compaction on this request. */
  tokensSaved: number;
  /** USD saved by compaction on this request. */
  costSavedUSD: number;
  /** CSV of applied strategies, e.g. "elision,dedup". */
  strategies: string;
  /** Window utilization at request time, 0..1. */
  utilization: number;
  /** Degradation pct if shadow-evaluated this request, else null. */
  qualityScore: number | null;
  status: 'ok' | 'error' | 'blocked';
  durationMs: number;
  /** Milliseconds of latency added by the governor itself (excludes upstream round-trip). */
  proxyOverheadMs: number;
}

export interface ShadowEvalEvent {
  id?: number;
  ts: number;
  sessionId: string;
  requestEventId?: number;
  strategy: string;
  /** 0..100, higher = worse. */
  degradationPct: number;
  method: 'embedding' | 'llm' | 'heuristic';
  baselineTokens: number;
  compactedTokens: number;
}

export interface ReportSummary {
  totalCostUSD: number;
  totalTokensSaved: number;
  estSavedUSD: number;
  /** Cost spent on shadow-eval baseline requests (the "cost of the quality guarantee"). */
  shadowCostUSD: number;
  avgDegradationPct: number | null;
  requestCount: number;
  byProvider: Array<{ provider: string; costUSD: number; requests: number }>;
  bySource: Array<{ source: string; costUSD: number; requests: number }>;
  byStrategy: Array<{ strategy: string; uses: number; tokensSaved: number; avgDegradationPct: number | null }>;
}

/** A paged-out ("elided") block kept locally so its full content can be recovered/audited. */
export interface ElidedBlob {
  id: string;
  sessionId: string;
  ts: number;
  tokens: number;
  content: string;
}

export interface Store {
  recordRequest(e: RequestEvent): number;
  recordShadowEval(e: ShadowEvalEvent): number;
  /**
   * Backfill the measured degradation pct onto the originating request row once
   * a shadow eval has scored it, so reports/dashboard (which read
   * requests.qualityScore) reflect the captured quality signal. No-op when the
   * row id is unknown.
   */
  updateRequestQualityScore(requestEventId: number, degradationPct: number): void;
  /** Mark a shadow request's own upstream cost so it can be reported separately. */
  recordShadowCost(sessionId: string, costUSD: number): void;
  sessionCostUSD(sessionId: string): number;
  dayCostUSD(dayEpochStart: number): number;
  repoMonthCostUSD(repo: string, monthEpochStart: number): number;
  /** Average degradation pct over the last N shadow evals (null if none). */
  rollingDegradationPct(windowN: number): number | null;
  recentRequests(limit: number): RequestEvent[];
  summary(opts?: { since?: number }): ReportSummary;
  /** Persist a paged-out block for later recovery/audit (context virtual memory). */
  recordElidedBlob(blob: ElidedBlob): void;
  /** Retrieve a previously paged-out block by id (page-fault recovery / dashboard). */
  getElidedBlob(id: string): string | undefined;
  close(): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// In-process event bus (drives the live dashboard via SSE)
// ─────────────────────────────────────────────────────────────────────────────

export type GovernorEvent =
  | { type: 'request'; payload: RequestEvent }
  | { type: 'shadow'; payload: ShadowEvalEvent }
  | { type: 'budget'; payload: { scope: string; limitUSD: number; spentUSD: number; action: OnBudgetExceeded } }
  | { type: 'safe-mode'; payload: { enabled: boolean; reason: string } }
  | { type: 'compaction'; payload: { sessionId: string; strategies: string[]; tokensSaved: number; utilization: number } }
  | { type: 'log'; payload: { level: 'info' | 'warn' | 'error'; message: string } };

export interface EventBus {
  emit(e: GovernorEvent): void;
  /** Subscribe; returns an unsubscribe function. */
  subscribe(fn: (e: GovernorEvent) => void): () => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Compaction
// ─────────────────────────────────────────────────────────────────────────────

/** Summarizes text to <= maxTokens using a cheap upstream model. Provided by the proxy. */
export type SummarizeFn = (text: string, maxTokens: number) => Promise<string>;

export interface CompactionResult {
  /** Possibly-mutated request body (may be the same reference). */
  body: unknown;
  applied: string[];
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
  changed: boolean;
}

export interface CompactionInput {
  body: unknown;
  adapter: ProviderAdapter;
  counter: TokenCounter;
  config: GovernorConfig;
  /** Rolling measured degradation pct (null if unmeasured). Gates aggressive strategies. */
  rollingDegradationPct: number | null;
  utilization: number;
  /** Force compaction regardless of utilization threshold (e.g. budget=compact). */
  force?: boolean;
  summarize?: SummarizeFn;
  /** Local store for recoverable paging (set when config.compaction.recoverable). */
  store?: Store;
  /** Per-strategy gate from the quality guard; a strategy is skipped when this returns false. */
  strategyAllowed?: (strategy: string) => boolean;
  /** Latest user question text, used by relevance-protection to shield on-topic blocks. */
  latestQuestion?: string;
}

export interface Compactor {
  maybeCompact(input: CompactionInput): Promise<CompactionResult>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Quality guard
// ─────────────────────────────────────────────────────────────────────────────

/** Returns degradation pct (0..100); 0 = identical, 100 = unrelated. */
export type JudgeFn = (baseline: string, compacted: string) => Promise<number>;

export interface ShadowEvalInput {
  sessionId: string;
  requestEventId?: number;
  strategy: string;
  baselineText: string;
  compactedText: string;
  baselineTokens: number;
  compactedTokens: number;
}

export interface QualityGuard {
  /** Whether compaction is currently allowed (false when safe-mode tripped). */
  isCompactionAllowed(): boolean;
  /** Whether this request should be shadow-evaluated (sampling + enabled gate). */
  shouldShadowEval(): boolean;
  /** Score baseline vs compacted, record it, update rolling stats + safe-mode. */
  evaluate(input: ShadowEvalInput): Promise<ShadowEvalEvent>;
  /** Per-strategy gate: false when that specific strategy has tripped its degradation budget. */
  isStrategyAllowed(strategy: string): boolean;
  currentSafeMode(): { enabled: boolean; reason: string };
}

// ─────────────────────────────────────────────────────────────────────────────
// Session identity
// ─────────────────────────────────────────────────────────────────────────────

export interface SessionTracker {
  /** Stable id for the agent session this request belongs to. */
  idFor(meta: RequestMeta, body: unknown): string;
  /** Repo / working-dir identifier for per-repo budgets. */
  repoFor(meta: RequestMeta, body: unknown): string;
  /** Originating tool label (claude-code, cursor, codex, ...). */
  sourceFor(meta: RequestMeta): string;
}
