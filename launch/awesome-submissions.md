# Awesome-list submission kit

Ready-to-submit entries for 4 live, actively-maintained lists. Each one verified to exist and accept new additions. Order = best fit / highest reach first.

> Honest framing is mandatory — these maintainers reject hype. Never write "lossless" or "zero quality loss." Correct phrasing: "quality held within model noise" / "≈ parity". Only **dedup** is loss-free; elision is **recoverable**.

---

## 1. jqueryscript/awesome-claude-code — ISSUE submission (best fit)

- **URL:** https://github.com/jqueryscript/awesome-claude-code
- **Why #1:** ~425★, pushed yesterday, submissions flowing in. tokdiet is *literally* a local CC proxy + meter — matches both the **🏗️ Infrastructure & Proxies** and **📊 Usage & Observability** sections. Peers `ccglass` and `Context-Gateway` already listed.
- **How:** open a GitHub **Issue** (NOT a PR — they merge via issue + bot). Title `[Submission] <name> (<Section>)`. A brand-new repo gets no popularity emoji and sits at the bottom of the section. Submit to both sections, lead with Infrastructure & Proxies.

**Issue title:**
```
[Submission] tokdiet — local token-metering + context-compacting proxy (Infrastructure & Proxies)
```

**Entry line they'll add:**
```
- [**tokdiet**](https://github.com/agiwhitelist/tokdiet) (0 ⭐) - Local reverse proxy between coding agents and model APIs that meters every token + USD cost and compacts bloated context, with shadow-eval keeping quality within model noise.
```

**Issue body:**
```
## Submission: tokdiet

**Link:** https://github.com/agiwhitelist/tokdiet
**License:** MIT
**Status:** Actively maintained.

**What it is (one line):** tokdiet is a local streaming reverse proxy that sits between coding agents (Claude Code, Cursor, Codex, scripts) and model APIs (Anthropic Messages, OpenAI Chat Completions, Gemini, MiniMax + compatible), metering every token and USD cost and compacting bloated context.

**Why it fits this list / section:** It's a local CC-facing reverse proxy, so it belongs in 🏗️ Infrastructure & Proxies right alongside listed peers like `ccglass` (local proxy + dashboard). You set `ANTHROPIC_BASE_URL=http://localhost:7787` / `OPENAI_BASE_URL=http://localhost:7787/v1` and it intercepts, meters, and compacts the stream (SSE proxied incrementally so tokens still stream live). It is also a natural fit for 📊 Usage & Observability since it meters tokens + cost with a live local dashboard (:7878). Recommend adding to both, leading with Infrastructure & Proxies.

**Honest framing (no hype):** Compaction is dedup (loss-free) + recoverable elision of old tool results; a sampled shadow-eval measures divergence against the uncompacted baseline and a quality budget disables any strategy that drifts. In a 66-task A/B benchmark on MiniMax-M3, input tokens dropped 5.07M → 1.46M (−71%) while quality held at ≈ parity (baseline 64/66 vs governed 63/66; −72% confirmed on a second model). Quality is held *within model noise* — not lossless. Dollar savings apply to pay-per-token API keys; on flat subscriptions the value is metering/budgets/dashboard. Keys are forwarded only (never logged), loopback bind only, fail-open.

**Install:** `npx tokdiet start`
```

---

## 2. InftyAI/Awesome-LLMOps — PULL REQUEST

- **URL:** https://github.com/InftyAI/Awesome-LLMOps
- **Why:** ~239★, merging "Add X to Section" PRs as of 2026-06-16. Fits **Inference › AI Gateway** (peers: agentgateway, Envoy AI Gateway, Higress, Kong). Also reasonable under **Inference › Middleware** (LMCache, kvcached).
- **How:** PR adding ONE row, **alphabetical** within the subsection, with the standard shields.io badges. Title `Add tokdiet to Inference/AI Gateway`.

**Entry line (alphabetical placement, with badges — mimic existing rows):**
```
* **[tokdiet](https://github.com/agiwhitelist/tokdiet)**: A local streaming reverse proxy that meters token + USD cost and compacts context for OpenAI/Anthropic/Gemini-compatible APIs. ![Stars](https://img.shields.io/github/stars/agiwhitelist/tokdiet.svg?style=flat&color=green) ![Contributors](https://img.shields.io/github/contributors/agiwhitelist/tokdiet?color=green) ![LastCommit](https://img.shields.io/github/last-commit/agiwhitelist/tokdiet?color=green)
```

**PR title:** `Add tokdiet to Inference/AI Gateway`

**PR body:**
```
## Add tokdiet to Inference/AI Gateway

Adds one row under `### AI Gateway` in the Inference section for tokdiet, a local streaming reverse proxy that sits between agent tools and model APIs (Anthropic Messages, OpenAI Chat Completions, Gemini, MiniMax + any OpenAI/Anthropic-compatible API).

**Why it fits AI Gateway:** like the existing entries here (agentgateway, Envoy AI Gateway, Higress, Kong), tokdiet is a gateway/proxy that brokers traffic from clients to GenAI services. It additionally meters token + USD cost per request and compacts bloated context on the way through (SSE proxied incrementally so streaming is preserved), backed by SQLite + a local dashboard. (If you'd prefer it under `### Middleware` alongside LMCache/kvcached, that's also reasonable — it's a streaming middleware on the request path.)

**Format:** entry is placed alphabetically within the subsection and carries the standard stars / contributors / last-commit shields.io badges, matching the existing rows exactly.

**Honest scope (no inflated claims):** dedup is loss-free; old tool results are elided into recoverable stubs; a sampled shadow-eval measures divergence vs the uncompacted baseline and a quality budget disables any drifting strategy. Benchmark on MiniMax-M3: input 5.07M → 1.46M tokens (−71%) at ≈ parity quality (64/66 vs 63/66). Quality is held within model noise — not lossless. Dollar savings apply to pay-per-token keys; on a flat subscription the value is metering/budgets/dashboard. Loopback bind only; API keys forwarded, never logged.

- License: MIT
- Stack: TypeScript, Node 20+
- Status: actively maintained
```

---

## 3. hesreallyhim/awesome-claude-code — WEB FORM ONLY (highest reach, ~46.7k★)

- **URL:** https://github.com/hesreallyhim/awesome-claude-code
- **⚠️ Do NOT open a PR or use the CLI — the docs say it "risks being banned."** Submit only via the web issue form.
- **Form:** https://github.com/hesreallyhim/awesome-claude-code/issues/new?template=recommend-resource.yml
- **Note:** list is mid-reconstruction with a big backlog — submit and be patient. Biggest audience by far.

**Form fields:**
```
Resource name: tokdiet
Primary link:  https://github.com/agiwhitelist/tokdiet
Author:        agiwhitelist
Author link:   https://github.com/agiwhitelist
Category:      Tooling
License:       MIT

Description:
A local streaming reverse proxy for Claude Code (and Cursor/Codex/scripts) that meters every token + USD cost and compacts bloated context. Point Claude Code at it with ANTHROPIC_BASE_URL=http://localhost:7787; it intercepts the stream, meters, compacts, and stores results in SQLite with a local dashboard. Cache-aware (never rewrites a cache_control prefix, so it won't break the prompt cache) and thinking-safe (never mutates signed thinking blocks, so it won't trigger a 400).

Evidence / validation:
66-task A/B benchmark on MiniMax-M3, each task run twice (full context vs through tokdiet), graded against the known answer, x3 majority-voted to cancel model noise: input tokens 5.07M → 1.46M (−71%) with quality ≈ parity (baseline 64/66 vs governed 63/66; 198 paired runs, LLM-judge 92% similarity). Confirmed on a second model (MiniMax-M2.5): −72% tokens. Reproduce: node bench/run.mjs (needs an API key in env). I'm not claiming lossless or zero quality loss — only dedup is loss-free; elision is recoverable. Per-token dollar savings apply to pay-per-token API keys; on a flat Claude subscription the value is metering/budgets/dashboard. Keys forwarded only and never logged; loopback bind only; fail-open.
```

---

## 4. rohitg00/awesome-claude-code-toolkit — PULL REQUEST

- **URL:** https://github.com/rohitg00/awesome-claude-code-toolkit
- **Why:** ~2,094★, merged "feat: add llm-prices" (a cost CLI) on 2026-05-12 → cost/usage tools accepted. Peer `ccusage` already listed. Lower per-entry visibility (big toolkit).
- **How:** PR adding a Markdown table row under the **Ecosystem** category (alphabetical). Title mirrors the merged `feat: add llm-prices` PR.

**Entry line (table row):**
```
| [tokdiet](https://github.com/agiwhitelist/tokdiet) | new | Local streaming reverse proxy between coding agents and model APIs (Anthropic, OpenAI, Gemini, MiniMax). Meters every token + USD cost, compacts bloated context, and proves quality held via shadow-eval; SQLite store + live dashboard. Ships a CC metering plugin too, but the proxy is what saves tokens. `npx tokdiet start`. MIT |
```

**PR title:** `feat: add tokdiet — local token-metering proxy + context compactor`

**PR body:**
```
## feat: add tokdiet — local token-metering proxy + context compactor

Adds one row to the Ecosystem table for tokdiet, a local streaming reverse proxy that sits between coding agents (Claude Code, Cursor, Codex, scripts) and model APIs (Anthropic Messages, OpenAI Chat Completions, Gemini, MiniMax + compatible).

**Why it fits Ecosystem:** it's a cost/usage ecosystem tool in the same lane as the already-listed `ccusage` and the recently-merged `llm-prices` cost CLI — but instead of only reading local JSONL or quoting prices, tokdiet sits on the request path, meters every token + USD cost live, and compacts bloated context (SSE proxied incrementally so streaming is preserved), storing results in SQLite with a local dashboard.

**Accurate scope (not a 'plugin that saves tokens'):** tokdiet also ships a Claude Code plugin (/plugin marketplace add agiwhitelist/tokdiet), but that plugin is only a metering hook — it can't set ANTHROPIC_BASE_URL for the CC process, so the proxy is what actually saves tokens. The description is written as 'proxy + CC metering plugin' for that reason.

**Honest numbers:** 66-task A/B benchmark on MiniMax-M3: input 5.07M → 1.46M tokens (−71%) at ≈ parity quality (64/66 vs 63/66). Quality is held within model noise — not lossless (only dedup is loss-free; elision is recoverable). Dollar savings apply to pay-per-token keys; on a flat subscription the value is metering/budgets/dashboard.

- License: MIT
- Stack: TypeScript, Node 20+
- Status: actively maintained
```

---

## GitHub repo About + topics (set via web UI or `gh` once authed to the org)

**Description (≤350 chars):**
```
Local streaming reverse proxy between AI coding agents (Claude Code, Cursor, Codex) and model APIs (Anthropic, OpenAI, Gemini, MiniMax). Meters every token + USD cost, compacts bloated context to cut pay-per-token API spend, and runs shadow-eval to prove quality held. ccusage-style metering + live local dashboard. TypeScript, SQLite, loopback-only, keys never logged.
```

**Topics:**
```
claude-code llm token-counter cost-tracking llm-proxy ai-gateway llm-gateway reverse-proxy openai-proxy anthropic openai gemini context-engineering context-compression tiktoken cli observability cost-optimization ccusage typescript
```

**`gh` one-liner (run when authed as an account with write to agiwhitelist/tokdiet):**
```bash
gh repo edit agiwhitelist/tokdiet \
  --description "Local streaming reverse proxy between AI coding agents (Claude Code, Cursor, Codex) and model APIs (Anthropic, OpenAI, Gemini, MiniMax). Meters every token + USD cost, compacts bloated context to cut pay-per-token API spend, and runs shadow-eval to prove quality held. ccusage-style metering + live local dashboard. TypeScript, SQLite, loopback-only, keys never logged." \
  --add-topic claude-code,llm,token-counter,cost-tracking,llm-proxy,ai-gateway,llm-gateway,reverse-proxy,openai-proxy,anthropic,openai,gemini,context-engineering,context-compression,tiktoken,cli,observability,cost-optimization,ccusage,typescript
```
