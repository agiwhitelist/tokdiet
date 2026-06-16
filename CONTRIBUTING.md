# Contributing to tokdiet

Thanks for your interest in tokdiet! It's a local streaming proxy that meters LLM
tokens and cost, compacts bloated context (near-dup dedup + recoverable salient
elision + relevance protection — "context virtual memory"), and proves quality
didn't drop via shadow-eval and per-strategy safe-mode. Contributions of all
sizes are welcome — bug fixes, provider price entries, new compaction strategies,
docs, and tests.

This guide is meant to be skimmable. If anything here drifts from the code, the
code wins — read the actual files.

## Quick dev setup

Requires Node 20+ (the package is NodeNext ESM).

```bash
git clone https://github.com/agiwhitelist/tokdiet
cd tokdiet
npm ci
npm run build      # tsc -p tsconfig.json + copies assets (pricing.json, dashboard html)
npx vitest run     # 214 tests, all should be green
```

Handy scripts:

- `npm run dev` — `tsc -w` watch build
- `npm run typecheck` — `tsc --noEmit`
- `npm test` / `npm run test:watch` — vitest run / watch
- `node dist/cli.js start` (or the `tokdiet` / `td` bin) — start the proxy + dashboard

The CLI bin is `tokdiet` (alias `td`), wired in `package.json` to `dist/cli.js`,
with commands `start`, `report`, `init`, and `install-claude-plugin`.

## Project layout

Top-level source areas under `src/` (one line each — read the files for detail):

- `proxy.ts` — the streaming HTTP proxy: detects provider, meters usage, runs compaction, shadow-evals.
- `providers.ts` — provider adapters (Anthropic, OpenAI, Gemini) implementing `ProviderAdapter` + `detectProvider`.
- `tokenizer.ts` — token counting (tiktoken / Anthropic tokenizer / approx fallback).
- `pricing.ts` — loads the bundled `pricing.json` price table and computes cost.
- `config.ts` — config loading, defaults (`DEFAULT_CONFIG`), and `normalizeConfig`.
- `store.ts` — SQLite telemetry store (better-sqlite3): requests, usage, ledgers.
- `budget.ts` — per-session / per-day / per-repo budget enforcement.
- `report.ts` — terminal / JSON / CSV usage report rendering.
- `dashboard.ts` + `dashboard/` — the live dashboard server and its HTML.
- `session.ts` — session identity tracking.
- `events.ts` — the in-process event bus.
- `pagefault.ts` — recovery ("page-fault") of elided content from the store.
- `index.ts` — the public API barrel (stable export surface).
- `types.ts` — shared contracts: `ProviderAdapter`, `Compactor`, config types, refs.
- `compactor/` — `index.ts` (orchestrator), `dedup.ts`, `elision.ts`, `midsummarize.ts`, `pin.ts`, `relevance.ts`.
- `quality/` — `guard.ts` (per-strategy safe-mode gate), `similarity.ts` (judges), `ledger.ts` (rolling degradation).
- `plugin/` — `install.ts` (Claude Code plugin install) + `hooks/tool-meter.mjs` (metering hook).

## Adding a provider adapter

Provider support lives in `src/providers.ts`. Implement the `ProviderAdapter`
interface from `src/types.ts` — it covers request matching, upstream URL,
model/streaming detection, token counting, the editable refs compaction needs
(`listToolResults`, `listTextChunks`, `listMessages`), usage parsing for both
non-streaming and SSE responses, answer-text extraction for shadow-eval, and
`cacheBoundaryIndex` (so we never rewrite a cached prompt prefix and accidentally
cost *more*).

Steps:

1. Add a `class FooAdapter implements ProviderAdapter` in `providers.ts`.
2. Export an instance and register it in the `adapters` array (detection runs in
   array order; the first adapter whose `matches()` returns true wins).
3. Re-export it from `src/index.ts` if it's part of the public surface.
4. Add price entries to `pricing.json` for the provider's models.
5. Add tests in `tests/providers.test.ts`.

Existing adapters (`AnthropicAdapter`, `OpenAIAdapter`, `GeminiAdapter`) are the
best reference. `matches()` and every parse path must be defensive — a throwing
matcher must never break detection (`detectProvider` swallows matcher errors).

## Adding a compaction strategy

Strategies live in `src/compactor/` and are orchestrated by
`src/compactor/index.ts` (`DefaultCompactor.maybeCompact`). The order is
**safest-first**: `dedup` (loss-free) → `elision` (recoverable) →
`midSummarize` (most aggressive), each gated by config, quality headroom, and the
per-strategy quality gate.

Steps:

1. Add `src/compactor/yourStrategy.ts` exporting an `apply…(body, adapter, counter, config, opts)`
   that mutates the body in place via the adapter refs and reports whether it `applied`.
2. Wire it into `DefaultCompactor.maybeCompact` in `compactor/index.ts` at the
   correct safety position, gated by `strategies.<name>`, the `overBudget`
   headroom check, and `gateAllows('<name>')`.
3. Honor the `protect` predicate (relevance + durable facts) for lossy strategies,
   and the `cacheBoundaryIndex` so you never touch a cached prefix.
4. Add the strategy flag to the config types/defaults and re-export the function
   from `compactor/index.ts` (and `src/index.ts` if public).
5. Add tests in `tests/compactor.test.ts`.

Prefer recoverable over lossy: elision writes elided content to the store so it
can be page-faulted back (`pagefault.ts`). If your strategy loses information,
make sure the quality guard can catch regressions.

## Testing bar

- All **214 tests** (12 files in `tests/`) must stay green: `npx vitest run`.
- Any new behavior needs tests. Bug fixes should come with a regression test.
- Run `npm run typecheck` too — strict TS must pass with no errors.

## Bench harness

The A/B benchmark proves savings without quality loss. It is *not* part of
`vitest` and needs a live API key.

- `bench/run.mjs` — for each task in `bench/tasks/`, runs it through a **baseline**
  proxy (compaction off) and a **governed** proxy (compaction on), grades both
  against the known answer, LLM-judges governed-vs-baseline equivalence, and
  measures real metered tokens/$. Writes `bench/results.json`.
  Run: `MINIMAX_API_KEY=... node bench/run.mjs` (set `BENCH_MODEL` / `BENCH_REPEATS`
  to taste; `BENCH_REPEATS>1` enables majority-vote denoising).
- `bench/validate.mjs` — offline sanity check of the task bank (no API calls):
  confirms each task builds, has a question, the grader accepts the expected
  answer and rejects empty, and the context is large enough for compaction to fire.
  Run: `node bench/validate.mjs`.

Build first (`npm run build`) — the bench imports from `dist/`. The published
headline (−71% tokens, governed quality ≈ baseline) comes from this harness.

## Commit & PR conventions

- Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`,
  `fix:`, `docs:`, `test:`, `refactor:`, `chore:`…).
- Keep PRs focused; describe the change and how you verified it.
- CI must pass (build + the full vitest suite + typecheck) before merge.

## Code style

- **Strict TypeScript** — `strict: true`; keep `npm run typecheck` clean.
- **NodeNext ESM** — relative imports use the `.js` extension (e.g.
  `import { applyDedup } from './dedup.js'`) even though the source is `.ts`.
- **Fail-open on the request path** — compaction, detection, and protection logic
  must never throw a user's request to the floor. When in doubt, catch and
  degrade gracefully (pass-through / no protection) rather than erroring.
- **Never log or store API keys** — keys pass through to the upstream and must
  never land in the store, logs, or the dashboard.

## Good first issues

Ideas if you're looking for somewhere to start:

- **Embedding-based quality judge** — add an embedding similarity judge alongside
  the existing heuristic/LLM judges in `src/quality/similarity.ts`.
- **Gemini streaming polish** — tighten SSE usage/answer extraction in
  `GeminiAdapter` (`src/providers.ts`).
- **More provider price entries** — extend `pricing.json` with additional models.
- **Dashboard charts** — richer visualizations in `src/dashboard/`.

Happy hacking!
