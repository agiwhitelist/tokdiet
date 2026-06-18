# Works with your agent

tokdiet has **no per-tool integration** and no plugins to install. It's a local proxy that sits on the wire, so the only thing that matters is:

> **Does your tool let you override the model API base URL, and does it speak Anthropic Messages, OpenAI Chat Completions, or Gemini?**
> If yes + yes → it works with tokdiet, zero tokdiet-specific code.

Point the tool at one of these and run it as usual:

| Format | Set the base URL to |
|---|---|
| **OpenAI** Chat Completions | `http://localhost:7787/v1`  *(include the `/v1`)* |
| **Anthropic** Messages | `http://localhost:7787`  *(no `/v1`)* |
| **Gemini** | point the Gemini SDK base URL at `http://localhost:7787` |

Three things that trip people up, true for almost every tool below:

- **The `/v1` suffix** belongs on OpenAI-format base URLs, *not* on Anthropic ones. A few tools append the path themselves — those are flagged.
- **A non-empty (dummy) API key** is usually required even though tokdiet only forwards it upstream. Use any placeholder like `sk-dummy`.
- **Subscription / OAuth logins** (Claude Pro/Max, ChatGPT, vendor cloud) are a *different* auth path locked to the vendor's host. There are no per-token charges to cut, so that's **metering only, $0 saved** — and usually not a clean proxy target. Use a **pay-per-token API key** to actually save.

By default tokdiet forwards to the real provider. To route an OpenAI/Anthropic-compatible client at a **non-default upstream** (e.g. MiniMax), set `TOKDIET_OPENAI_UPSTREAM` / `TOKDIET_ANTHROPIC_UPSTREAM` / `TOKDIET_GEMINI_UPSTREAM` **on the `tokdiet start` process**.

---

## ✅ Confirmed

### opencode (sst/opencode)
Config file `opencode.json`, key `provider.<id>.options.baseURL`.
```jsonc
// ~/.config/opencode/opencode.json  (or ./opencode.json)
{ "$schema": "https://opencode.ai/config.json",
  "provider": { "tokdiet": { "npm": "@ai-sdk/openai-compatible", "name": "tokdiet",
    "options": { "baseURL": "http://localhost:7787/v1", "apiKey": "sk-dummy" },
    "models": { "gpt-4o": { "name": "gpt-4o" } } } } }
// Anthropic instead: "provider": { "anthropic": { "options": { "baseURL": "http://localhost:7787" } } }
```
`options.baseURL` must include `/v1` for the OpenAI-compatible upstream; for the Anthropic override use the bare host (the SDK appends `/v1/messages`). Non-empty `apiKey` required. opencode caches provider config until restart.
*Verified: https://opencode.ai/docs/providers/*

### Aider
Env vars (passed through to LiteLLM). Prefix the model with `openai/` or `anthropic/` so LiteLLM routes to your custom base.
```bash
# OpenAI-compatible via tokdiet
export OPENAI_API_BASE=http://localhost:7787/v1
export OPENAI_API_KEY=sk-dummy
aider --model openai/gpt-4o
# --- OR Anthropic via tokdiet ---
export ANTHROPIC_API_BASE=http://localhost:7787    # no /v1; LiteLLM appends the path
export ANTHROPIC_API_KEY=sk-dummy
aider --model anthropic/claude-sonnet-4-5
```
`OPENAI_API_BASE` needs `/v1`; `ANTHROPIC_API_BASE` is the bare host. Non-empty key required.
*Verified: https://aider.chat/docs/llms/openai-compat.html*

### Continue.dev (IDE + `cn` CLI)
`~/.continue/config.yaml`, per-model `apiBase` with `provider: openai`.
```yaml
models:
  - name: tokdiet-gpt4o
    provider: openai
    model: gpt-4o
    apiBase: http://localhost:7787/v1
    apiKey: sk-dummy
```
`apiBase` must include `/v1`. Use `provider: openai` (the generic OpenAI-compatible adapter) — its Anthropic block exposes base-URL less consistently. Same config serves the VS Code/JetBrains extension and the CLI.
*Verified: https://docs.continue.dev/customize/model-providers/top-level/openai*

### Cline (VS Code)
GUI settings (not env vars). Two routes:
```
OpenAI route:    API Provider = "OpenAI Compatible"
                 Base URL     = http://localhost:7787/v1   (include /v1)
                 API Key      = any non-empty dummy ; set Model ID
Anthropic route: API Provider = "Anthropic" → tick "Use custom base URL"
                 URL = http://localhost:7787 , API Key = dummy
```
Cline's separate "Claude Code"/subscription login is OAuth, locked to Anthropic's host — not a proxy target.
*Verified: https://docs.cline.bot/provider-config/openai-compatible*

### Roo Code
Same two GUI routes as Cline (Roo is a Cline fork).
```
OpenAI route:    API Provider = "OpenAI Compatible" , Base URL = http://localhost:7787/v1 , Key = dummy
Anthropic route: API Provider = "Anthropic" → "Use custom base URL" = http://localhost:7787 , Key = dummy
```
Note (issue #8488): the Anthropic custom-base-URL model list is restricted to `claude-*` ids — matters if you route a non-Claude upstream via `TOKDIET_ANTHROPIC_UPSTREAM`.
*Verified: https://docs.roocode.com/providers/openai-compatible*

### Kilo Code
GUI settings (Roo fork). `Settings → Providers → "OpenAI Compatible"`, Base URL `http://localhost:7787/v1`, dummy key, set Model ID. Accepts either the `/v1` base or a full `.../v1/chat/completions` URL.
*Verified: https://kilo.ai/docs/ai-providers/openai-compatible*

### Goose (Block / codename goose)
Env vars / `~/.config/goose/config.yaml`. **Goose's `OPENAI_HOST` is a host root — do NOT put `/v1` on it** (Goose appends the path itself).
```bash
export GOOSE_PROVIDER=openai
export OPENAI_HOST=http://localhost:7787      # host root, NO /v1
export OPENAI_API_KEY=dummy
export GOOSE_MODEL=<model>
# Anthropic alternative: GOOSE_PROVIDER=anthropic , ANTHROPIC_HOST=http://localhost:7787 , ANTHROPIC_API_KEY=dummy
```
No documented custom-Gemini host var was found (only `GOOGLE_API_KEY`), so Gemini-via-proxy on Goose is unconfirmed.
*Verified: https://block.github.io/goose/docs/getting-started/providers/*

### Zed (editor AI)
`settings.json`, `language_models.openai_compatible.<name>.api_url` (include `/v1`, no trailing slash). The key goes in the Agent Panel UI or an env var named after the provider id — **not** in settings.json.
```jsonc
"language_models": { "openai_compatible": { "tokdiet": {
  "api_url": "http://localhost:7787/v1",
  "available_models": [ { "name": "gpt-4o", "max_tokens": 128000 } ] } } }
// provider id "tokdiet" → set env var TOKDIET_API_KEY=sk-anything
```
*Verified: https://zed.dev/docs/ai/use-api-access*

### JetBrains AI Assistant
`Settings | Tools | AI Assistant | Providers & API keys → Third-party AI providers`. Pick the OpenAI-compatible (LM Studio / LiteLLM-style) option, set the URL to `http://localhost:7787/v1`, click **Test Connection**. Key not mandated for local providers (dummy works if a field exists). Note: local models don't support MCP tool calls in AI Assistant, and default context window is 64k (adjustable).
*Verified: https://www.jetbrains.com/help/ai-assistant/use-custom-models.html*

### Open Interpreter
CLI flag `--api_base` (or `interpreter.llm.api_base` in Python), via LiteLLM.
```bash
interpreter --api_base http://localhost:7787/v1 --api_key dummy --model gpt-4o
```
OpenAI Chat Completions path; include `/v1` yourself. LiteLLM requires a non-empty `--api_key` placeholder. (Flags belong to the 0.x CLI; the newer rewrite may differ.)
*Verified: https://docs.openinterpreter.com/language-models/local-models/custom-endpoint*

### llm (Simon Willison's CLI)
`api_base` in an `extra-openai-models.yaml` entry (in the dir from `dirname "$(llm logs path)"`).
```yaml
# extra-openai-models.yaml
- model_id: tokdiet-gpt4o
  model_name: gpt-4o
  api_base: "http://localhost:7787/v1"
# then: llm -m tokdiet-gpt4o 'hello'
```
When `api_base` is set, the OpenAI key is not sent by default → no dummy key needed unless your endpoint demands one. (For Anthropic you'd use the separate `llm-anthropic` plugin + `ANTHROPIC_BASE_URL`.)
*Verified: https://llm.datasette.io/en/stable/other-models.html*

### Crush (Charm)
`providers.<id>.base_url` in `crush.json`. Handles **both** protocols via `type`.
```jsonc
// ~/.config/crush/crush.json
{ "$schema": "https://charm.land/crush.json",
  "providers": { "tokdiet": {
    "type": "openai-compat", "base_url": "http://localhost:7787/v1",
    "api_key": "dummy", "models": [ { "id": "gpt-4o", "name": "gpt-4o" } ] } } }
// Anthropic-format: "type":"anthropic","base_url":"http://localhost:7787"
```
Use `openai-compat` (not `openai`) for third-party/proxied OpenAI traffic. `base_url` supports `$VAR` expansion. Non-empty `api_key` required by schema.
*Verified: https://github.com/charmbracelet/crush*

### pi (earendil-works/pi — the BYOK coding-agent CLI)
> Not Inflection's consumer "Pi". This is `@earendil-works/pi-coding-agent` (formerly badlogic/pi-mono).

Base URL is set per-provider in `~/.pi/agent/models.json` (no global env var). You can override a built-in provider by re-declaring its name.
```jsonc
// ~/.pi/agent/models.json — Anthropic-format route
{ "providers": { "anthropic": {
    "baseUrl": "http://localhost:7787", "api": "anthropic-messages", "apiKey": "$ANTHROPIC_API_KEY" } } }
// OpenAI route: "baseUrl":"http://localhost:7787/v1", "api":"openai-completions"
```
`openai-completions` needs `/v1`; `anthropic-messages` uses the bare host. `apiKey` is required (any value for keyless local endpoints).
*Verified: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md*

### oh-my-pi / omp (can1357/oh-my-pi)
A separate "pi" coding agent. `~/.omp/agent/models.yml`, `providers.<id>.baseUrl`. Lets you override the built-in `openai`/`anthropic` provider in place.
```yaml
# ~/.omp/agent/models.yml
providers:
  openai:
    baseUrl: http://localhost:7787/v1
    apiKey: dummy        # resolved as an env-var NAME first, else a literal token
# Anthropic: providers.anthropic.baseUrl: http://localhost:7787 , api: anthropic-messages
```
`openai-completions` baseUrl needs `/v1`; `anthropic-messages` uses the bare host. For truly keyless endpoints set `auth: none`.
*Verified: https://github.com/can1357/oh-my-pi/blob/main/docs/models.md*

### Hermes Agent (NousResearch/hermes-agent)
`~/.hermes/config.yaml` `model: { provider: custom, base_url, api_key }`, or run `hermes model` → "Custom endpoint". The `custom` path is **OpenAI-compatible**.
```yaml
# ~/.hermes/config.yaml
model:
  provider: custom
  base_url: "http://localhost:7787/v1"
  api_key: "dummy"
```
Anthropic-format goes through Hermes's named Anthropic provider (target `http://localhost:7787`), not the generic `custom` path.
*Verified: https://github.com/NousResearch/hermes-agent*

---

## ⚠️ Partial / read the caveat

### Cursor
Settings → Models → **OpenAI API Key** → enable **"Override OpenAI Base URL"** → `http://localhost:7787/v1` → paste a dummy key → Verify.
**Big limits (from Cursor's own docs):** (1) requests still route through Cursor's servers for prompt building; (2) **custom keys only work with chat models** — Composer/agent/inline-edit/apply/tab-completion stay on Cursor's backend and won't hit tokdiet. So you only meter/save on the Chat-Plan panel, a small slice of usage.
*Verified: https://cursor.com/help/models-and-usage/api-keys*

### Codex CLI (OpenAI)
`~/.codex/config.toml` (user-level only; project config is ignored for these keys).
```toml
model = "gpt-5.4"
model_provider = "tokdiet"
[model_providers.tokdiet]
name = "tokdiet proxy"
base_url = "http://localhost:7787/v1"
wire_api = "responses"          # the only accepted value now
env_key = "OPENAI_API_KEY"      # export OPENAI_API_KEY=sk-dummy
```
**Critical:** as of Feb 2026 Codex speaks **only** the OpenAI **Responses** API (`/v1/responses`); `wire_api="chat"` was removed. Codex is a clean tokdiet target **only if tokdiet passes the Responses surface through** — tokdiet's compaction targets Chat Completions, so Codex traffic may flow through unmetered/uncompacted, or you'd need a translating gateway (LiteLLM/OpenRouter) in between. Treat as experimental.
*Verified: https://developers.openai.com/codex/config-reference*

### gptme
OpenAI path only: `OPENAI_BASE_URL` env (or `[env]` in `~/.config/gptme/config.toml`), model prefixed `local/` or `openai/`.
```bash
OPENAI_BASE_URL="http://localhost:7787/v1" OPENAI_API_KEY=dummy gptme 'hello' -m local/gpt-4o
```
No documented `ANTHROPIC_BASE_URL` knob — route Anthropic-format through tokdiet is unconfirmed. `/v1` required (not auto-appended).
*Verified: https://gptme.org/docs/providers.html*

### openclaw
openclaw is a real project (the "lobster" personal AI assistant; `openclaw-code-agent` adds coding via Claude Code / Codex / OpenCode backends) — but it has **no first-class base-URL config of its own**. It delegates to whichever backend you pick, so support reduces to that backend's knob:
```bash
export ANTHROPIC_BASE_URL=http://localhost:7787      # if backend = Claude Code
export OPENAI_BASE_URL=http://localhost:7787/v1      # if backend = Codex
```
Could not confirm an openclaw-specific base-URL key from docs; the vars above are the backends' own. Vendor-OAuth backends = metering only.
*Source (unconfirmed): https://github.com/openclaw/openclaw*

---

## ❌ Not a fit (today)

### Windsurf (Codeium / Devin Desktop)
BYOK lets you paste an Anthropic key but exposes **no editable base URL**, so you can't point native Windsurf at a loopback proxy. Non-BYOK usage is vendor-cloud metered (locked host) = $0 saved. Third-party "OpenAI-compatible URL" claims aren't in Windsurf's docs.
*Verified: https://windsurf.com/subscription/provider-api-keys*

### Inflection Pi (pi.ai / heypi.com)
The consumer chatbot, **not** a coding agent. No public API with an overridable base URL → not a tokdiet target. (If someone says "pi" as a coding agent, they mean **earendil-works/pi** or **oh-my-pi**, both ✅ above.)
*Verified: https://pi.ai/*

---

## The 10-second test for anything not listed

Search the tool's docs/config for any of:
`baseURL` · `base_url` · `apiBase` · `api_base` · `OPENAI_BASE_URL` · `OPENAI_API_BASE` · `ANTHROPIC_BASE_URL` · `OPENAI_HOST` · `endpoint` · `custom provider`

Found one → set it to `http://localhost:7787/v1` (OpenAI) or `http://localhost:7787` (Anthropic), add a dummy key, run the tool, and watch the dashboard at **http://localhost:7878**. Traffic shows up = supported.

> Notes were verified against each tool's official docs/repo on 2026-06-18. Tools move fast — if a flag changed, please open an issue or PR.
