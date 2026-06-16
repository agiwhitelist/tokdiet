# tokdiet

**Your AI agent is paying to send the same file dump five times.** `tokdiet` is a local proxy that sits between your agent and the model API, meters every token, puts your bloated context **on a diet** — and *proves* the answer didn't get worse.

> **ccusage that shrinks the bill — without losing quality.**

![license](https://img.shields.io/badge/license-MIT-blue) ![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen) ![status](https://img.shields.io/badge/tokens-%E2%88%9270%25-success) ![quality](https://img.shields.io/badge/quality-%3D%20baseline-success)

---

## The proof (this is the whole point)

Every "context optimizer" cuts tokens. The scary question is the one they can't answer:

> *"If I cut the context, does the model get dumber?"*

So we measured it. A 24-task A/B benchmark on a **real model** (MiniMax‑M3), each task run **twice** — once with the full context (baseline), once through `tokdiet` — graded against the **known correct answer**, repeated ×3 and majority‑voted to cancel out model noise:

```
                       baseline      tokdiet
  input tokens         680,550   →   202,507     −70.2%
  quality (24 tasks)     24/24        24/24       0 regressions
  ─────────────────────────────────────────────────────────
  72 paired runs · objective grading ~100% · LLM-judge ~90% similarity
```

**−70% tokens. Zero quality loss.** Not a mock — real requests, real grading. The hardest "needle buried in junk" adversarial cases still pass, because `tokdiet` doesn't delete blindly — it pages cold context out *recoverably* and protects anything on‑topic. Reproduce it yourself: `node bench/run.mjs` (needs an API key in env).

---

## Quick start

```bash
# 1. Start the proxy (and live dashboard) — no install needed
npx tokdiet start
```

```bash
# 2. Point your agent at the proxy instead of the real API
export ANTHROPIC_BASE_URL=http://localhost:7787
export OPENAI_BASE_URL=http://localhost:7787/v1
```

Now run your agent (Claude Code, Cursor, Codex, your own script) as usual. Traffic flows through `tokdiet`, gets metered and compacted, and is forwarded upstream unchanged in every way that matters.

**Your API key stays with you.** `tokdiet` reads `x-api-key` / `Authorization` only to forward them upstream. They are **never written to SQLite and never written to any log**. And it's **fail‑open**: if anything inside the governor errors, it falls back to transparent passthrough — the proxy will never break your request or surface its own 5xx.

> Default ports: proxy `7787`, dashboard `7878`. Override with `--port` / `--dashboard-port`.

---

## Works with Claude Code (and it's careful about it)

Claude Code is the flagship use case, and it has two landmines a naive compacting proxy walks straight into. `tokdiet` handles both:

- **Prompt caching.** Claude Code marks a cached prefix with `cache_control`; cached input costs ~10% of normal. Rewriting that prefix invalidates the cache and can make a request cost **more**. `tokdiet` is **cache‑aware** — it never touches content at or before a `cache_control` breakpoint.
- **Extended thinking.** Claude Code sends signed `thinking` blocks that Anthropic requires returned verbatim; touching one is an instant `400`. `tokdiet` is **thinking‑safe** — signed/thinking blocks are never surfaced or mutated.

Both are covered by regression tests (`tests/cc-compat.test.ts`).

> **A note on honesty:** the dollar‑savings story applies to **pay‑per‑token API keys** (MiniMax, Anthropic API, OpenAI, …). On a flat Claude **subscription** there are no per‑token charges to cut, so the value there is metering, budgets, and the live dashboard — not dollars.

---

## How it works

`tokdiet` is a streaming reverse proxy. SSE responses are proxied **incrementally** (never buffered whole), so your agent's tokens still stream in real time.

```
                            tokdiet (localhost:7787)
   agent  ─────────────────────────────────────────────────────────────►  model API
 (Claude  request    ┌───────────┐  ┌───────┐  ┌────────┐  ┌───────────┐   (Anthropic /
  Code,  ──────────► │interceptor│─►│ meter │─►│ budget │─►│ compactor │──►   OpenAI /
  Cursor, raw key    └───────────┘  └───────┘  └────────┘  └─────┬─────┘      Gemini /
  Codex,  forwarded   detect          count      session/        │ dedup / elision /  MiniMax)
  …)                  provider,       tokens     day / repo      │ mid-summarize
                      keep body        & cost     limits          ▼
                      byte-faithful                          ┌───────────────┐
   response                                                  │ quality guard │
 ◄──────────────────────────────────────────────────────────┤ shadow-eval + │
   streamed back, token-for-token                            │  safe-mode    │
                                          ┌──────────────┐   └───────┬───────┘
                                          │ store(SQLite)│◄──────────┘
                                          │ + dashboard  │  telemetry, savings, degradation
                                          └──────────────┘
```

### Context as virtual memory (the idea)

Blind compaction is "delete and pray." `tokdiet` treats your context like **virtual memory**: hot content (recent, pinned, relevant to the current question) stays resident; cold content (stale, redundant) is **paged out** to a local store as a recoverable stub — *not deleted*. The full block is kept in SQLite keyed by an id, so it can be audited and (roadmap) **paged back in on demand** when the model actually needs it.

### The 3 quality mechanisms

| Mechanism | What it does |
|-----------|--------------|
| **Shadow‑eval** | Re‑runs a sampled fraction of compacted requests against the *un‑compacted* baseline and scores the divergence (0 = identical, 100 = unrelated). This is the measurement that answers "did quality drop?" |
| **Quality budget** | A hard ceiling on acceptable measured degradation (`qualityBudget.maxDegradationPct`, default **2%**). As you approach it, the compactor restricts itself to its safest strategies. |
| **Safe‑mode** | If rolling degradation *exceeds* the budget, the offending strategy is disabled (per‑strategy) and a `safe-mode` event fires. **Savings stop before quality does.** |

### Compaction strategies (safest‑first)

1. **Dedup** — *loss‑free.* When the same large block is re‑pasted across a conversation, keep the freshest copy verbatim and replace earlier copies with a pointer marker. Works on near‑duplicates too (a file re‑pasted with a few lines changed), not just byte‑identical ones.
2. **Elision** — *recoverable.* Page out the bulk of *old* tool results (file dumps, command output), keeping a preview **plus the salient lines** (errors, ids, `KEY=VALUE`, URLs, paths, numbers) and storing the full body for recovery. Recent, pinned, and question‑relevant results are kept intact.
3. **Mid‑summarize** *(off by default)* — summarize mid‑history with a cheap model. Opt‑in (it costs money).

---

## Commands

```bash
tokdiet <command> [flags]   # alias: td
```

| Command | What it does | Key flags |
|---------|--------------|-----------|
| `start` | Run the proxy + live dashboard | `--port`, `--dashboard-port`, `--no-dashboard`, `--config <path>` |
| `report` | Print a usage report (or export) | `--since <days>`, `--json`, `--csv <file>`, `--config <path>` |
| `init` | Scaffold `tokdiet.config.json` in the cwd | `--force` |
| `install-claude-plugin` | Install an idempotent Claude Code metering hook | `--settings <path>` |

---

## Configuration

Run `tokdiet init` to create `tokdiet.config.json`, or pass one with `--config`. All fields are optional and merge over sensible defaults.

| Field | Default | Description |
|-------|---------|-------------|
| `proxyPort` / `dashboardPort` | `7787` / `7878` | Ports (both bound to loopback only). |
| `dashboardEnabled` | `true` | Start the dashboard alongside the proxy. |
| `contextWindowTokens` | `"auto"` | Window size for utilization %; `"auto"` infers from the model. |
| `contextUtilizationThreshold` | `0.7` | Compaction triggers once input utilization reaches this fraction. |
| `onBudgetExceeded` | `"warn"` | `"warn"` \| `"compact"` \| `"block"` when a spend budget is hit. |
| `budgets.perSessionUSD` / `perDayUSD` / `perRepoMonthlyUSD` | `5` / `50` / `400` | Spend ceilings (any may be `null`). |
| `compaction.strategies.{elision,dedup,midSummarize}` | `true`/`true`/`false` | Per‑strategy switches. |
| `compaction.keepRecentToolResults` | `4` | Most‑recent tool results always kept intact. |
| `compaction.minToolResultTokens` | `500` | Only elide tool results at least this large. |
| `compaction.elisionPreviewChars` / `elisionSalientLines` | `240` / `12` | How much of a paged‑out block to keep (head + salient lines). |
| `compaction.relevanceProtect` | `true` | Shield blocks lexically on‑topic with the latest question. |
| `compaction.recoverable` | `true` | Persist paged‑out blocks for recovery/audit (virtual memory). |
| `compaction.protectCachedPrefix` | `true` | Never compact a provider cache (`cache_control`) prefix. |
| `compaction.semanticDedup` | `true` | Collapse near‑duplicates, not just exact ones. |
| `qualityBudget.maxDegradationPct` | `2.0` | Max measured degradation before safe‑mode trips. |
| `shadowEval.enabled` / `sampleRate` | `true` / `0.05` | Whether/how often to shadow‑evaluate. |
| `shadowEval.judge` | `"heuristic"` | `"heuristic"` \| `"llm"` (`"embedding"` reserved, falls back to heuristic). |
| `shadowEval.judgeModel` | `"claude-haiku-4"` | Cheap model for the LLM judge / mid‑summarize. |
| `pageFault` | `{ enabled: true, maxReinjections: 1 }` | Re‑inject a paged‑out block if the model can't answer without it. |
| `safeMode` | `true` | Auto‑disable a strategy when it exceeds the quality budget. |
| `dataDir` | `~/.tokdiet` | Where SQLite telemetry lives. |
| `pricingPath` | `null` | Override path for `pricing.json` (null = bundled). |

> **Upstream overrides** (point at a non‑default origin — e.g. MiniMax): `TOKDIET_ANTHROPIC_UPSTREAM`, `TOKDIET_OPENAI_UPSTREAM`, `TOKDIET_GEMINI_UPSTREAM` (legacy `CTXGOV_*_UPSTREAM` still read for back‑compat).

---

## Dashboard

With the proxy running, open **http://localhost:7878** — a single self‑contained page that streams live updates over SSE (loopback only; your cost data never leaves the machine). Five screens: **Live session**, **Savings**, **Quality** (degradation + safe‑mode status), **By tool & repo**, and **Strategy leaderboard**.

---

## See the savings — no API key required

```bash
npm run build && node scripts/demo.mjs
```

Stands up a **mock** Anthropic upstream on loopback, starts the **real** `tokdiet` proxy in front of it, and sends one realistic bloated agent request through the whole pipeline — actual interceptor, tokenizer, compactor, pricing, telemetry, and shadow‑eval. No external network, no real key. It prints a before/after table proving the *input* shrank while the *answer* stayed identical (so shadow‑eval reports ~0% degradation). *(The scenario is synthetic; your real savings depend on how much your own conversations repeat.)*

---

## Supported providers

| Provider | Endpoint detected | Base URL to set |
|----------|-------------------|-----------------|
| **Anthropic** | `/v1/messages` | `ANTHROPIC_BASE_URL=http://localhost:7787` |
| **OpenAI** | `/v1/chat/completions` | `OPENAI_BASE_URL=http://localhost:7787/v1` |
| **Gemini** | `:generateContent` / `/v1beta/…` | point the Gemini SDK base URL at the proxy |
| **MiniMax** (and any OpenAI/Anthropic‑compatible API) | mimics OpenAI `/v1` & Anthropic `/anthropic` | `OPENAI_BASE_URL=http://localhost:7787/v1` + `TOKDIET_OPENAI_UPSTREAM=https://api.minimax.io` |

Prices come from `pricing.json` (**USD per 1,000,000 tokens**, dated, user‑updatable, hot‑reloaded on `start`; exact match then longest‑prefix).

---

## Roadmap

- **Page‑fault auto‑reinjection** — when the model references a paged‑out id or signals it's missing content, restore it and retry automatically *(partially shipped).*
- **Semantic dedup** *(shipped)* — near‑duplicate collapsing.
- **Embedding judge** — local semantic scoring instead of the heuristic.
- **Self‑calibrating policy** — learn safe aggressiveness per repo from shadow‑eval outcomes.
- **Quality ledger** — auditable before/after + measured‑degradation record.

See `docs/DESIGN-context-virtual-memory.md` for the full design.

---

## Limitations & honesty

- **The default judge is a heuristic** (word/char similarity), not a semantic oracle. Switch `shadowEval.judge` to `"llm"` for a model‑graded score. Embedding judge isn't implemented yet.
- **Shadow‑eval costs money** — it's a real extra upstream request, so it's *sampled* (5% default) and its cost is reported separately.
- **Session inference is heuristic** — per‑session/per‑repo attribution is inferred from request metadata.
- **Page‑fault recovery is limited for streaming** responses.
- **Cost figures are estimates** — only as accurate as your `pricing.json`.

---

## License

[MIT](./LICENSE)
