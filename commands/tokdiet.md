---
description: Show how to view tokdiet savings and how to route full traffic through the token-saving proxy.
---

# /tokdiet

You are helping the user get value out of **tokdiet** — a token/cost meter and
context-compaction proxy for LLM traffic.

## What this plugin actually does (be honest about it)

This Claude Code plugin ships **only the lightweight metering hook plus this
guidance**. The hook runs on every `PreToolUse` and `PostToolUse` event and
appends one JSONL record per tool call to `~/.tokdiet/tool-meter.log`
(tool name, event, and UTF-8 byte sizes of the tool input/output). It never
blocks a tool and always exits cleanly.

**The hook does NOT save tokens by itself.** The actual token savings (real
benchmark: about -71% tokens with governed quality on par with baseline) come
from the **tokdiet proxy**, which compacts bloated context in flight. A Claude
Code plugin cannot set environment variables for the Claude Code process, so the
proxy has to be started separately and Claude Code has to be pointed at it.

## Tell the user how to view savings

To see metered tokens, cost, and savings, run:

```bash
npx tokdiet report
```

(Shorthand alias: `npx td report`.) If they want the live dashboard, mention
`npx tokdiet start` also serves it.

## Tell the user how to route FULL traffic through the proxy

The metering hook is passive. To get the actual token-saving compaction, the
user must run the proxy and point Claude Code at it:

```bash
# 1. Start the local proxy (and live dashboard)
npx tokdiet start

# 2. In the SAME shell you launch Claude Code from, route traffic through it
export ANTHROPIC_BASE_URL=http://localhost:7787
```

On Windows PowerShell, step 2 is:

```powershell
$env:ANTHROPIC_BASE_URL = "http://localhost:7787"
```

Then start Claude Code from that shell. Their API key stays local — tokdiet only
forwards it upstream, never logs or stores it, and is fail-open (on any internal
error it falls back to transparent passthrough).

> Note on honesty: on a flat Claude **subscription** there are no per-token
> charges to cut, so the value there is metering, budgets, and the live
> dashboard — not dollars. The dollar-savings story applies to pay-per-token API
> keys (Anthropic API, OpenAI, MiniMax, ...).

Summarize the above for the user clearly: how to view savings (`npx tokdiet
report`) and how to route full traffic (`npx tokdiet start` + set
`ANTHROPIC_BASE_URL=http://localhost:7787`).
