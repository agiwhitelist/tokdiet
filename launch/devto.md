---
title: "I cut an AI agent's input tokens by 71% and quality held — here's the 66-task benchmark"
published: false
tags: opensource, ai, typescript, showdev
cover_image: https://TODO-replace-with-your-1000x420-png-or-jpg-cover-url
canonical_url: https://github.com/agiwhitelist/tokdiet
---

I cut a coding agent's input tokens by **71%** — from 5.07M down to 1.46M across a 66-task run — and quality stayed within model noise (63 vs 64 of 66 tasks solved).

This post is the benchmark, the failures, the honesty caveats, and the code. No "revolutionary." Just numbers you can reproduce.

## TL;DR

- **What it is:** `tokdiet` — a local streaming reverse proxy that sits between your agent tools (Claude Code, Cursor, Codex, custom scripts) and the model APIs (Anthropic, OpenAI, Gemini, MiniMax, anything OpenAI/Anthropic-compatible).
- **The headline number:** input tokens **5.07M → 1.46M = -71%**; quality **63/66 vs 64/66** baseline ≈ parity. 198 paired runs. LLM-judge reports 92% similarity. Confirmed on a 2nd model at -72%.
- **Install:** `npx tokdiet start` — proxy on `:7787`, live dashboard on `:7878`, loopback only.
- **Repo:** https://github.com/agiwhitelist/tokdiet — MIT, TypeScript, Node 20+.
- **Honesty up front:** this is **not lossless**. It's "within model noise." Only the dedup pass is loss-free; the rest is *recoverable*, not deleted. And the dollar savings apply to **pay-per-token API keys** — on a flat Claude subscription there's no per-token bill to cut.

{% github agiwhitelist/tokdiet %}

## The problem: agent loops re-send the same junk forever

If you've watched a long agent session, you've seen it. The model reads a file. Three turns later it reads the same file again, and the full dump rides along in context *every single turn* after that. Stale tool output from step 2 is still being re-transmitted at step 40.

The transcript grows monotonically. Every turn you pay to re-send the entire history, and most of that history is dead weight — re-pasted files and tool results nobody will look at again.

`ccusage` is great at showing you this. It tells you the bill is climbing. It does not shrink the bill. I wanted the thing that shrinks it — without quietly making the agent dumber.

> The frame I kept coming back to: **ccusage that shrinks the bill — without losing quality.**

## Why I didn't just summarize the conversation

The obvious fix is mid-conversation summarization: when context gets big, ask the model to compress the old turns into a paragraph and throw the originals away.

This is the graveyard everyone walks into. It's lossy by construction. The summary drops the exact error string, the exact id, the exact line number — and then three turns later the model needs precisely the thing you threw away, and it can't get it back because it's gone.

So in `tokdiet`, **mid-summarize is OFF by default.** It exists as an opt-in (and it costs money, because it's another model call), but it is never the thing that runs unless you ask for it. The defaults are built around *not* destroying information.

## How it works

It's a streaming reverse proxy. SSE responses are proxied incrementally, so tokens still stream to your agent live — you don't sit and wait for a buffered blob.

```text
request ─► interceptor ─► meter ─► budget ─► compactor ─► quality guard ─► model API
                                                  │
                                                  └─► store (SQLite) + dashboard :7878
```

The mental model is **context as virtual memory.** Hot content — recent turns, pinned blocks, anything relevant to the current question — stays *resident* in the request. Cold content — stale, redundant tool output — gets **paged out** to a local SQLite store as a recoverable stub. It's kept by id, not deleted. (Paging it back in on demand is on the roadmap.)

Two strategies do the real work, safest first:

```ts
// 1. Dedup — LOSS-FREE
// Re-pasted blocks: keep the freshest copy verbatim,
// replace the earlier copies with a marker. Catches
// near-duplicates too, not just byte-identical ones.

// 2. Elision — RECOVERABLE
// Page out the bulk of OLD tool results. Keep a preview +
// the salient lines (errors, ids, KEY=VALUE, URLs, paths,
// numbers). Store the full body for recovery. Recent,
// pinned, and question-relevant results are kept intact.
```

Dedup is the free lunch — if the same file is in context five times, four copies are pure waste and removing them changes nothing. Elision is where the bulk of the savings come from, and it's the part that has to be measured, because "keep the salient lines" is a judgment call.

## The benchmark

I didn't want to ship a vibes claim, so I built an A/B harness.

**Methodology:**

- **66 tasks**, across **6 categories**, on a real model (**MiniMax-M3**).
- Each task is run **twice**: once with full context (baseline), once routed through `tokdiet` (governed).
- Both runs are graded against the **known correct answer**.
- Every task is repeated **×3 and majority-voted** to cancel model nondeterminism.
- That's **198 paired runs** total.
- A separate **LLM judge** scores output similarity between baseline and governed.
- Then re-run on a **second model (MiniMax-M2.5)** to check it wasn't an artifact of one model.

**Results:**

| Metric | Baseline (full context) | Governed (tokdiet) | Delta |
|---|---|---|---|
| Input tokens | 5.07M | 1.46M | **-71%** |
| Tasks solved | 64 / 66 | 63 / 66 | -1 task (≈ parity) |
| Output similarity (LLM judge) | — | — | **92%** |
| 2nd model (MiniMax-M2.5) tokens | — | — | **-72%** |

Reproduce it yourself:

```bash
node bench/run.mjs   # needs an API key in your env
```

## About that 1-task gap — being honest

Baseline solved 64; governed solved 63. I am not going to call that "zero quality loss," because that's not what the data says and overclaiming is how trust dies.

Here's what the gap actually is. Across 198 runs with ×3 majority voting, the difference lands inside model nondeterminism — the same prompt doesn't always produce the same grade. Part of the gap was also the model **declining to echo back a secret value**, which is a behavior change, not a context-loss bug.

The thing I cared most about — the hardest **"needle buried in junk"** adversarial cases, where the one fact you need is hidden in a wall of stale output — those **pass.** That's the test that would have caught elision throwing away something load-bearing, and it didn't.

So: **within model noise. ≈ parity. Quality held.** Not lossless.

## The quality-guarantee mechanism

The reason I'll say "quality held" with a straight face is that there's machinery watching for the opposite, and it can pull the brakes on itself.

- **Shadow-eval** — re-runs a sampled fraction of compacted requests (5% by default) against the uncompacted baseline and scores divergence on a 0 (identical) to 100 (unrelated) scale. This is the measurement, not a guess.
- **Quality budget** — a hard ceiling on measured degradation (default 2%). As it approaches the ceiling, the compactor restricts itself to its safest strategies.
- **Safe-mode** — if rolling degradation exceeds the budget, the offending strategy is disabled, per-strategy.

> **Savings stop before quality does.**

That's the whole design philosophy in one line. Shadow-eval costs money (it's a re-run), which is why it's sampled — that's a real tradeoff, not a free feature.

## A specific note for Claude Code users

This one matters and I've seen it trip people up.

The **proxy** is what saves tokens. You point your agent at it:

```bash
npx tokdiet start
export ANTHROPIC_BASE_URL=http://localhost:7787
export OPENAI_BASE_URL=http://localhost:7787/v1
```

There's also a Claude Code plugin (`/plugin marketplace add agiwhitelist/tokdiet`, then `/plugin install tokdiet`) — **but the plugin is a metering hook only.** It cannot set `ANTHROPIC_BASE_URL` for the Claude Code process, so **the plugin alone does not save tokens.** It gives you metering and the dashboard. If you want the savings, route through the proxy. I'd rather tell you that now than have you install the plugin and wonder why nothing shrank.

The proxy is **cache-aware** (it never rewrites a `cache_control` prefix, so it won't break your prompt cache) and **thinking-safe** (it never mutates signed/thinking blocks, so it won't trigger a 400). Both are regression-tested.

## Where this is and isn't worth it

- **Pay-per-token keys** (MiniMax, Anthropic API, OpenAI): the -71% is a real dollar cut.
- **Flat Claude subscription:** there are no per-token charges to shrink, so the value is the metering, the budgets, and the dashboard — not your bill.
- **Keys** are forwarded only. They are **never** written to SQLite or any log. Loopback bind only. Fail-open: if the proxy hiccups, your request still goes through.
- **Known limits:** the default judge is a heuristic (the LLM judge is opt-in); shadow-eval costs money and is sampled; session inference is heuristic; page-fault recovery is limited for streaming; cost figures are estimates.

## Try it in 60 seconds

```bash
npx tokdiet start
# proxy on :7787, dashboard on :7878 (loopback only)

export ANTHROPIC_BASE_URL=http://localhost:7787
export OPENAI_BASE_URL=http://localhost:7787/v1
```

Run your agent as usual, then open `http://localhost:7878` and watch the tokens and USD tick — including what got deduped vs paged out.

## Break it, please

The benchmark is only as good as the tasks in it. If you have a transcript where elision throws away something the model actually needed — an adversarial "needle in junk" case that fails — that's the most useful bug report I can get. Open an issue with the transcript and I'll add it to the suite.

Repo (stars and issues welcome): https://github.com/agiwhitelist/tokdiet

**One question for the comments:** what's your worst context-bloat offender — re-pasted files, or stale tool output that never ages out?
