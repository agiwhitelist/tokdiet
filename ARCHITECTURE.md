# tokdiet — Architecture

## 1. Overview

tokdiet is a local, loopback-only streaming proxy that sits between an AI agent (Claude Code, Cursor, Codex, an SDK, etc.) and an LLM provider's API (Anthropic, OpenAI, Gemini). For every request it meters tokens and cost, optionally **compacts** bloated context (near-dup dedup → recoverable salient elision → mid-history summarization, with relevance/cache/thinking protection), enforces spend **budgets**, and proves the compaction did not hurt quality via a sampled **shadow-eval** with per-strategy safe-mode. Responses stream straight back to the client unbuffered while a tee parses usage out-of-band; everything is recorded to SQLite for the live dashboard and the `report` CLI. The cardinal rule is **fail-open**: any internal error degrades to a transparent passthrough of the original request bytes, so the proxy can never break the user's workflow.

## 2. Request lifecycle

```
                          ┌─────────────────────── startProxy() (proxy.ts) ───────────────────────┐
  agent / SDK             │                                                                        │
      │  HTTP POST        │  127.0.0.1:<proxyPort>  (loopback bind only)                           │
      ▼                   │                                                                        │
 (1) inbound request ─────┼─► readBody()  buffer body (≤64MB)                                      │
                          │       │                                                                │
 (2) detect provider      │       ├─► tryParseJson(body)                                           │
                          │       │      └─ not JSON / no adapter ──► transparentPassthrough() ────┼──► upstream
                          │       └─► detectProvider(meta, body)  → Anthropic | OpenAI | Gemini    │   (raw bytes,
                          │                                                                        │    identity-encoded)
 (3) meter               │   meteredHandle():                                                      │
                          │       • resolveModel · sessionId · repo · source  (session.ts)         │
                          │       • countInputTokens (tokenizer.ts) → utilization                  │
                          │                                                                        │
 (4) budget gate          │   budget.check(session→day→repo-month)  (budget.ts)                    │
                          │       • action 'block'  → 429 ctxgov_budget_exceeded (recordBlocked)   │
                          │       • action 'compact'→ force compaction                             │
                          │                                                                        │
 (5) compact              │   structuredClone(body) → originalBody  (kept for shadow-eval)         │
                          │   if compaction enabled AND guard.isCompactionAllowed():               │
                          │       compactor.maybeCompact()  (compactor/index.ts)                   │
                          │         dedup → elision(+store) → midSummarize  (in-place mutation)     │
                          │         honoring cache boundary, relevance/durable protect,            │
                          │         per-strategy gate, quality headroom                            │
                          │                                                                        │
 (6) forward upstream ────┼─► undici request(upstreamBaseUrl + path + query, compacted body) ──────┼──► provider API
                          │       (accept-encoding stripped → identity bytes)                      │
                          │                                                                        │
 (7) stream back          │   streaming (text/event-stream):                                       │
                          │       pipe each chunk to client  AND  SseUsageTee parses usage +       │
                          │       reassembles answer text (out-of-band, never buffers the stream)  │
      ◄───────────────────┼───  res.write(chunk) … res.end()                                       │
                          │   non-streaming:                                                       │
                          │       buffer response, parse usage + answer; if compacted+recoverable  │
                          │       and answer signals a page fault → maybePageFaultRecover()         │
                          │       (restore blob(s), re-send ONCE) → send THAT answer                │
                          │                                                                        │
 (8) record               │   finalizeUsage → pricing.cost → store.recordRequest()  (SQLite)       │
                          │       emit 'request' / 'compaction' on the event bus (→ dashboard SSE)  │
                          │                                                                        │
 (9) shadow-eval          │   if compacted AND guard.shouldShadowEval():  (detached, AFTER reply)   │
   (optional, non-block)   │       send UNCOMPACTED originalBody (non-stream) → baseline answer     │
                          │       judge(baseline, compacted) → degradationPct                      │
                          │       record shadow cost + eval; per-repo/per-strategy backoff;        │
                          │       trip safe-mode if rolling avg > quality budget                   │
                          └────────────────────────────────────────────────────────────────────────┘
```

Any throw inside steps (3)–(9) is caught: if nothing has been sent yet the handler retries as a transparent passthrough of the **original** bytes; otherwise it simply ends the response.

## 3. Module map

| File | Responsibility |
| --- | --- |
| `src/proxy.ts` | The interceptor / HTTP server. Buffers inbound, detects provider, runs the budget→compact→forward→record→shadow-eval lifecycle, streams responses unbuffered, performs page-fault recovery, builds the llm-judge and mid-summarize callers, binds loopback-only. Fail-open throughout. |
| `src/providers.ts` | `AnthropicAdapter`, `OpenAIAdapter`, `GeminiAdapter` + `detectProvider`. Each adapter knows its upstream base URL (env-overridable), how to read the model, list/replace editable refs (tool results, text chunks, messages), count input tokens, parse usage + answer from response/stream events, and compute the cache-prefix boundary. Excludes signed/extended-thinking blocks from editable refs. |
| `src/tokenizer.ts` | `DefaultTokenCounter` + `approxTokens`. tiktoken (`o200k_base`, falling back to `cl100k_base`) for OpenAI/Gemini, optional `@anthropic-ai/tokenizer` for Anthropic, heuristic fallback when neither loads. `countRequest` tokenizes a whole request body. |
| `src/pricing.ts` | `PricingImpl` + pricing-table loading. Maps (provider, model, usage) → USD, including cache read/write rates. |
| `src/config.ts` | `DEFAULT_CONFIG`, `loadConfig`/`findConfigPath`/`normalizeConfig`. Deep-merges `tokdiet.config.json` over defaults (prototype-pollution-safe), resolves paths, clamps values. `DEFAULT_CONTEXT_WINDOW = 200_000`. |
| `src/store.ts` | `SqliteStore` (better-sqlite3). Tables: `requests`, `shadow_evals`, `shadow_costs`, `elided_blobs`, `repo_strategy_degradation`. Prepared statements only (no SQL injection). Answers session/day/repo-month cost, rolling degradation, recent requests, full summary; persists + reads elided blobs and per-repo/per-strategy degradation. |
| `src/budget.ts` | `BudgetEnforcer`. Checks spend in fixed precedence session → day → repo-month; on first breach emits a `budget` event and returns the configured action (`warn`/`compact`/`block`). |
| `src/session.ts` | `DefaultSessionTracker`. Derives stable session id (`x-ctxgov-session` wins, else `source:repo` with 30-min idle reset), repo (`x-ctxgov-repo`), and source (from `x-ctxgov-source` or user-agent sniffing). |
| `src/events.ts` | `InProcessEventBus`. Synchronous fan-out bus with fail-isolated delivery; drives the dashboard SSE stream. |
| `src/report.ts` | Report rendering: `formatReport`, `renderTerminalReport`, `toCSV`, money/degradation formatting. |
| `src/dashboard.ts` | `startDashboard`. Serves a self-contained SPA and streams `GovernorEvents` over SSE (`GET /events`, 15s heartbeat) plus an initial snapshot. |
| `src/cli.ts` | `tokdiet` / `td` bin. Commands: `start` (proxy + dashboard), `report` (text/JSON/CSV), `init` (write `tokdiet.config.json`), `install-claude-plugin`. |
| `src/index.ts` | Public API barrel re-exporting the stable surface. |
| `src/types.ts` | Shared contracts: `GovernorConfig`, `ProviderAdapter`, `Store`, `RequestEvent`, `UsageCounts`, ref types, `JudgeFn`, etc. |
| `src/pagefault.ts` | Pure (network-free) page-fault pieces: `elidedIdsIn`, `detectPageFault`, `restoreElidedBlobs`. |
| `src/compactor/index.ts` | `DefaultCompactor.maybeCompact`. Orchestrates strategies safest-first (dedup → elision → midSummarize) behind the trigger, quality-headroom, per-strategy, cache-boundary, and relevance/durable protection gates. Recounts tokens before/after for honest savings. |
| `src/compactor/dedup.ts` | `applyDedup`. Loss-free near-duplicate collapse (Jaccard over normalized line-shingles, optional `semanticDedup`) plus exact dedup: keeps the freshest copy verbatim, replaces older copies with a marker. |
| `src/compactor/elision.ts` | `applyElision`. Recoverable, signal-preserving paging of large older tool results: marker = head preview + salient lines + tail + content-addressed `id=cg-…`; persists the full block to `elided_blobs` when recoverable. |
| `src/compactor/midsummarize.ts` | `applyMidSummarize`. Most aggressive/lossy: summarizes bulky middle-of-history messages with a cheap model (protects first 2 / last 4, skips pinned/short, fails open per-message). |
| `src/compactor/relevance.ts` | Pure helpers: `extractSalientLines`, `queryTerms`/`relevanceScore` (EN/RU tokenization for relevance-protection), `looksDurable`. |
| `src/compactor/pin.ts` | `PIN_SENTINEL` (`<!--ctxgov:pin-->`), `isPinnedText`, `isAutoPinned` (explicit pin OR durable config-like fact). |
| `src/quality/guard.ts` | `DefaultQualityGuard`. Samples requests for shadow-eval, scores via the judge, keeps global + per-strategy `RollingAverage`s, seeds from durable per-repo priors, trips safe-mode (and per-strategy gating) once degradation exceeds the quality budget. |
| `src/quality/similarity.ts` | `heuristicDegradation` (Jaccard + bigram-Dice + length-ratio blend → 0–100), `heuristicJudge`, `makeLlmJudge` (robust JSON-score extraction with heuristic fallback). |
| `src/quality/ledger.ts` | `RollingAverage`: fixed-capacity numeric window, ignores non-finite values. |
| `src/plugin/install.ts` | `installClaudePlugin`. Idempotently wires a metering hook into Claude Code `settings.json`; embeds a byte-synced copy of the hook script to `~/.tokdiet/hooks/tool-meter.mjs`. |
| `src/plugin/hooks/tool-meter.mjs` | Dependency-free Pre/PostToolUse hook: measures tool input/output byte size, appends a JSONL record to `~/.tokdiet/tool-meter.log`, prints `{}`, always exits 0. |

## 4. The "context virtual memory" model

Compaction treats context like a paged memory hierarchy:

- **Hot** — recent tool results (the last `keepRecentToolResults`, default 4) and the active message working set (first 2 / last 4 in mid-summarize). Always kept intact; agents most often re-read these.
- **Warm** — durable/pinned/relevant content. Pinned text (`<!--ctxgov:pin-->`), auto-pinned durable config-like facts (`looksDurable`), and blocks lexically on-topic for the latest user question (`relevanceScore ≥ 0.34`) are protected from the **lossy** strategies (elision/midSummarize). Cache-prefix content is also immutable (see §6).
- **Cold** — large, older, unprotected tool results. These are **paged out** by `applyElision` into a compact, signal-preserving marker:

  ```
  [ctxgov: paged out <N> tokens (COMPACTED SUMMARY …) — id=cg-<sha1[0..10]>. head: <preview> | key lines: <l1> ⏎ <l2> … | tail: <…last 80 chars>]
  ```

  The marker keeps the high-information signal (head preview, salient lines — errors/ids/KEY=VALUE/urls/paths/ports/big numbers — and a tail). When `compaction.recoverable` is on, the **full original block** is persisted under its content-addressed id to the `elided_blobs` table.

- **Page fault** (`pagefault.ts`, non-streaming only) — if the model's answer signals it needed paged-out content (it echoes one of the `cg-…` ids actually present in the body, or it complains the content "was elided / is not present / cannot find it"), the proxy treats it like a VM page fault: clone the compacted body, `restoreElidedBlobs` from the store, and re-send the request **once** (bounded by `pageFault.maxReinjections`, default 1). The recovered answer replaces the original for the client. Streaming responses are intentionally left untouched (bytes are already on the wire).

## 5. The quality guard

`DefaultQualityGuard` (`quality/guard.ts`) proves compaction is safe without slowing the user:

- **Shadow-eval** — runs on a sampled fraction (`shadowEval.sampleRate`, default 0.05) of compacted requests, **after** the client has been served and fully detached from the request path. It re-sends the **uncompacted** `originalBody` (forced non-stream; for Gemini it rewrites `:streamGenerateContent`→`:generateContent` and strips `alt=sse`), gets the baseline answer + cost, and scores degradation 0–100 via the judge. The shadow baseline's own cost is recorded as the "cost of the guarantee" (`recordShadowCost`).
- **Judge** — `heuristic` (default; Jaccard + bigram-Dice + length blend), or `llm` (the proxy injects `makeLlmJudge` calling the cheap `shadowEval.judgeModel` via the Anthropic upstream, with heuristic fallback on any failure). `embedding` is not implemented and falls back to heuristic.
- **Quality budget** — `qualityBudget.maxDegradationPct` (default 2.0). A global `RollingAverage` (window 50) tracks recent degradation; the guard also keeps a **per-strategy** rolling average, attributing each measurement to every strategy in the CSV `strategy` field.
- **Safe mode** — when `safeMode` is on and the rolling average exceeds the budget, the guard trips global safe-mode (`isCompactionAllowed()` → false, disabling further compaction) and emits a `safe-mode` event. **Per-strategy safe-mode** (`isStrategyAllowed`) disables only the offending strategy when its own average exceeds the budget, so one bad strategy doesn't shut the others down. Priors are seeded at construction from the store's rolling degradation and from durable per-repo/per-strategy degradation, so a fresh process resumes its backoff state across restarts.

## 6. Key invariants

- **Fail-open** — the governor must never break the workflow. Every detection, compaction, parse, recovery, store, and bus call is wrapped; on any failure the proxy forwards the original bytes transparently or ends cleanly. Adapter/judge/bus failures are isolated.
- **Keys are never stored** — `x-api-key` / `authorization` are forwarded upstream verbatim but never logged or persisted; store strings are user-derived identifiers only, always bound via prepared statements.
- **Cache-aware** — when `protectCachedPrefix` is on, the Anthropic adapter computes the last message index covered by a `cache_control` breakpoint; dedup and elision skip any ref at or before that index, so the cached prefix is never rewritten (rewriting it would invalidate the prompt cache and can make the request cost more). Savings are re-derived from authoritative before/after token counts, so a cache-limited compaction never reports fake savings.
- **Thinking-safe** — adapters exclude signed / extended-thinking blocks (`isSignedOrThinkingBlock`) from the editable refs, so reasoning/signature blocks are never surfaced as compactable; the cache-boundary guard is an independent second layer.
- **In-place body mutation preserving unknown fields** — compaction edits the parsed body through adapter `replace`/`replaceText` refs, preserving the original string-vs-array content shape and leaving sibling/unknown fields untouched; only the targeted text is rewritten.
- **Unbuffered responses** — streamed upstream bytes are piped straight to the client while `SseUsageTee` parses usage and reassembles answer text out-of-band; the proxy strips `accept-encoding` so upstream returns identity bytes (undici's `request()` does not auto-decompress), keeping the stream and metering honest.
- **Loopback-only bind** — the server binds `127.0.0.1` so the local proxy (which forwards the operator's real upstream keys) is never a remotely reachable open relay.
- **Proxy overhead is isolated** — recorded `proxyOverheadMs` subtracts the upstream round-trip (incl. any page-fault re-send) so only the governor's own work counts.

## 7. Extension points

- **New provider** — implement `ProviderAdapter` (matches / upstreamBaseUrl / getModel / listToolResults / listTextChunks / listMessages / countInputTokens / usage + answer parsing / `cacheBoundaryIndex`) and add it to `adapters` in `providers.ts`; `detectProvider` picks it up automatically.
- **New compaction strategy** — add an `applyX` module under `src/compactor/`, wire it into `DefaultCompactor.maybeCompact` with its own config gate, per-strategy gate, and protection rules; the quality guard's per-strategy averaging will track it via the CSV `strategy` field with no further change.
- **New judge** — supply a `JudgeFn` (or extend `selectJudge`/`makeLlmJudge`); the guard consumes any `JudgeFn` injected by the proxy.
- **Upstream redirection** — `TOKDIET_*_UPSTREAM` / `CTXGOV_*_UPSTREAM` env vars override each provider's base URL (used in tests and for proxy chaining).
- **Pricing** — point `config.pricingPath` at a custom pricing table loaded by `loadPricingTable`.
- **Alternate store / bus** — `Store` and `EventBus` are interfaces; the proxy accepts any implementation (e.g. an in-memory test double), with optional per-repo backoff methods detected by capability.
- **Telemetry consumers** — subscribe to the `InProcessEventBus` (`request`, `compaction`, `shadow`, `budget`, `safe-mode`, `log` events); the dashboard SSE stream is one such consumer.
