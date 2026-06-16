// src/providers.ts — provider adapters for Anthropic, OpenAI, and Gemini.
//
// Each adapter detects/routes requests, parses usage, and exposes editable refs
// (ToolResultRef / TextChunkRef / MessageRef) for compaction. Refs MUST mutate
// the underlying body IN PLACE via closures so unknown/extra fields survive a
// round-trip untouched. Adapters never rebuild a body from scratch.
//
// Every method is robust to malformed input: missing/wrong-typed fields yield
// safe defaults ([], '', undefined) rather than throwing.

import type {
  ProviderAdapter,
  ProviderId,
  RequestMeta,
  TokenCounter,
  ToolResultRef,
  TextChunkRef,
  MessageRef,
  UsageCounts,
} from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers — all defensive against unknown/malformed shapes.
// ─────────────────────────────────────────────────────────────────────────────

/** Sentinel comment that pins a message against compaction. */
const PIN_SENTINEL = '<!--ctxgov:pin-->';

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Strip a single trailing slash so base URLs concatenate cleanly. */
function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/**
 * Join the `text` of an array of content blocks shaped like
 * `{ type: 'text', text: string }`. Non-text / malformed blocks are ignored.
 * Signed / extended-thinking blocks are skipped (see `isSignedOrThinkingBlock`):
 * Anthropic requires those blocks be returned VERBATIM, so they must never be
 * surfaced as flattened, replaceable text.
 */
function joinTextBlocks(blocks: unknown): string {
  const parts: string[] = [];
  for (const block of asArray(blocks)) {
    if (isObject(block)) {
      if (isSignedOrThinkingBlock(block)) continue;
      const t = block.text;
      if (typeof t === 'string') parts.push(t);
    }
  }
  return parts.join('');
}

/**
 * Flatten a "content" field that may be a plain string, or an array of blocks
 * (Anthropic/OpenAI style with `{ type:'text', text }` or `{ text }`).
 */
function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content;
  return joinTextBlocks(content);
}

/**
 * True if a content block is an extended-thinking block or otherwise carries a
 * cryptographic `signature` that Anthropic requires returned VERBATIM. Mutating
 * or surfacing such blocks => API 400. Defensive: we treat ANY block carrying a
 * `signature` field as untouchable, even from non-Anthropic providers.
 */
function isSignedOrThinkingBlock(block: Record<string, unknown>): boolean {
  const type = block.type;
  if (type === 'thinking' || type === 'redacted_thinking') return true;
  if ('signature' in block && block.signature !== undefined && block.signature !== null) return true;
  return false;
}

/** True if a block/entry carries a non-empty Anthropic `cache_control` field. */
function hasCacheControl(v: unknown): boolean {
  return isObject(v) && isObject(v.cache_control);
}

// ─────────────────────────────────────────────────────────────────────────────
// AnthropicAdapter
// ─────────────────────────────────────────────────────────────────────────────

export class AnthropicAdapter implements ProviderAdapter {
  readonly id: ProviderId = 'anthropic';

  matches(meta: RequestMeta, body: unknown): boolean {
    const path = meta.path ?? '';
    // Never claim an OpenAI chat path.
    if (path.endsWith('/chat/completions')) return false;
    if (path.endsWith('/v1/messages')) return true;
    // Heuristic: messages + model in body and an x-api-key header present.
    const hasApiKey = isObject(meta.headers) && typeof meta.headers['x-api-key'] === 'string';
    if (hasApiKey && isObject(body) && 'messages' in body && 'model' in body) return true;
    return false;
  }

  upstreamBaseUrl(env: NodeJS.ProcessEnv): string {
    return stripTrailingSlash(
      env.TOKDIET_ANTHROPIC_UPSTREAM || env.CTXGOV_ANTHROPIC_UPSTREAM || 'https://api.anthropic.com',
    );
  }

  getModel(body: unknown): string | undefined {
    if (isObject(body) && typeof body.model === 'string') return body.model;
    return undefined;
  }

  isStreaming(body: unknown): boolean {
    return isObject(body) && body.stream === true;
  }

  getSystemText(body: unknown): string {
    if (!isObject(body)) return '';
    const sys = body.system;
    if (typeof sys === 'string') return sys;
    return joinTextBlocks(sys);
  }

  countInputTokens(body: unknown, counter: TokenCounter): number {
    return counter.countRequest(body, 'anthropic', this.getModel(body));
  }

  listToolResults(body: unknown, counter: TokenCounter): ToolResultRef[] {
    const refs: ToolResultRef[] = [];
    if (!isObject(body)) return refs;
    const model = this.getModel(body);
    const messages = asArray(body.messages);
    messages.forEach((msg, messageIndex) => {
      if (!isObject(msg) || msg.role !== 'user') return;
      const content = msg.content;
      if (!Array.isArray(content)) return;
      content.forEach((block) => {
        if (!isObject(block)) return;
        // Never surface signed / extended-thinking blocks as compactable refs.
        if (isSignedOrThinkingBlock(block)) return;
        if (block.type !== 'tool_result') return;
        const raw = block.content;
        const text = typeof raw === 'string' ? raw : joinTextBlocks(raw);
        const wasString = typeof raw === 'string';
        refs.push({
          messageIndex,
          tokens: counter.count(text, 'anthropic', model),
          text,
          // Mutate the tool_result block in place. Preserve the string-vs-array
          // shape so other (unknown) sibling fields are not disturbed.
          replace(newText: string): void {
            if (wasString) {
              block.content = newText;
            } else {
              block.content = [{ type: 'text', text: newText }];
            }
          },
        });
      });
    });
    return refs; // already oldest-first (message order, then block order)
  }

  listTextChunks(body: unknown, counter: TokenCounter): TextChunkRef[] {
    const refs: TextChunkRef[] = [];
    if (!isObject(body)) return refs;
    const model = this.getModel(body);
    const messages = asArray(body.messages);
    messages.forEach((msg, messageIndex) => {
      if (!isObject(msg)) return;
      const role = asString(msg.role) || 'user';
      const content = msg.content;
      if (typeof content === 'string') {
        const text = content;
        refs.push({
          messageIndex,
          role,
          tokens: counter.count(text, 'anthropic', model),
          text,
          replace(newText: string): void {
            msg.content = newText;
          },
        });
        return;
      }
      if (!Array.isArray(content)) return;
      content.forEach((block) => {
        if (!isObject(block)) return;
        // Never surface signed / extended-thinking blocks as compactable refs.
        if (isSignedOrThinkingBlock(block)) return;
        // Plain text blocks.
        if (block.type === 'text' && typeof block.text === 'string') {
          const text = block.text;
          refs.push({
            messageIndex,
            role,
            tokens: counter.count(text, 'anthropic', model),
            text,
            replace(newText: string): void {
              block.text = newText;
            },
          });
          return;
        }
        // Tool-result text blocks.
        if (block.type === 'tool_result') {
          const raw = block.content;
          const text = typeof raw === 'string' ? raw : joinTextBlocks(raw);
          const wasString = typeof raw === 'string';
          refs.push({
            messageIndex,
            role,
            tokens: counter.count(text, 'anthropic', model),
            text,
            replace(newText: string): void {
              if (wasString) {
                block.content = newText;
              } else {
                block.content = [{ type: 'text', text: newText }];
              }
            },
          });
        }
      });
    });
    return refs;
  }

  listMessages(body: unknown, counter: TokenCounter): MessageRef[] {
    const refs: MessageRef[] = [];
    if (!isObject(body)) return refs;
    const model = this.getModel(body);
    const messages = asArray(body.messages);
    messages.forEach((msg, index) => {
      if (!isObject(msg)) return;
      const rawRole = asString(msg.role);
      const role: MessageRef['role'] = rawRole === 'assistant' ? 'assistant' : 'user';
      const text = flattenContent(msg.content);
      const pinned = msg._ctxgov_pin === true || text.includes(PIN_SENTINEL);
      refs.push({
        index,
        role,
        tokens: counter.count(text, 'anthropic', model),
        text,
        pinned,
        replaceText(newText: string): void {
          msg.content = newText;
        },
      });
    });
    return refs;
  }

  parseUsageFromResponse(json: unknown): UsageCounts | undefined {
    if (!isObject(json)) return undefined;
    const usage = json.usage;
    if (!isObject(usage)) return undefined;
    return {
      inputTokens: numberOr(usage.input_tokens, 0),
      outputTokens: numberOr(usage.output_tokens, 0),
      cacheReadTokens: optionalNumber(usage.cache_read_input_tokens),
      cacheWriteTokens: optionalNumber(usage.cache_creation_input_tokens),
    };
  }

  parseUsageFromStreamEvent(eventName: string | undefined, data: unknown, acc: UsageCounts): void {
    if (!isObject(data)) return;
    if (eventName === 'message_start') {
      const message = data.message;
      if (isObject(message) && isObject(message.usage)) {
        const usage = message.usage;
        acc.inputTokens = numberOr(usage.input_tokens, acc.inputTokens);
        const cr = optionalNumber(usage.cache_read_input_tokens);
        if (cr !== undefined) acc.cacheReadTokens = cr;
        const cw = optionalNumber(usage.cache_creation_input_tokens);
        if (cw !== undefined) acc.cacheWriteTokens = cw;
      }
    } else if (eventName === 'message_delta') {
      const usage = data.usage;
      if (isObject(usage)) {
        acc.outputTokens = numberOr(usage.output_tokens, acc.outputTokens);
      }
    }
  }

  extractStreamDeltaText(eventName: string | undefined, data: unknown): string {
    // Anthropic streams answer text via `content_block_delta` events whose
    // `delta` is `{ type: 'text_delta', text }`. Tolerate a missing event name
    // by also inspecting the payload's own `type` field.
    if (!isObject(data)) return '';
    const type = eventName ?? (typeof data.type === 'string' ? data.type : undefined);
    if (type !== 'content_block_delta') return '';
    const delta = data.delta;
    if (!isObject(delta)) return '';
    if (delta.type === 'text_delta' && typeof delta.text === 'string') return delta.text;
    return '';
  }

  extractAnswerText(json: unknown): string {
    if (!isObject(json)) return '';
    const parts: string[] = [];
    for (const block of asArray(json.content)) {
      if (isObject(block) && block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      }
    }
    return parts.join('');
  }

  cacheBoundaryIndex(body: unknown): number {
    if (!isObject(body)) return -1;

    // A cache breakpoint anywhere in `system` or `tools[]` anchors the whole
    // (immutable, never-compacted) prefix but does NOT, by itself, cover any
    // message. Track it so we can honor the "system/tools cached but no message
    // breakpoint => -1" contract.
    let hasPrefixBreakpoint = false;

    // system may be a string (no breakpoint) or an array of blocks, any of which
    // may carry cache_control.
    for (const block of asArray(body.system)) {
      if (hasCacheControl(block)) {
        hasPrefixBreakpoint = true;
        break;
      }
    }

    // tools[] entries may each carry cache_control.
    if (!hasPrefixBreakpoint) {
      for (const tool of asArray(body.tools)) {
        if (hasCacheControl(tool)) {
          hasPrefixBreakpoint = true;
          break;
        }
      }
    }

    // The actual boundary is the HIGHEST message index that is cache-anchored,
    // either because the message object itself carries cache_control, or because
    // one of its content blocks (incl. tool_result) does.
    let lastMessageBreakpoint = -1;
    const messages = asArray(body.messages);
    messages.forEach((msg, index) => {
      if (!isObject(msg)) return;
      let anchored = hasCacheControl(msg);
      if (!anchored) {
        for (const block of asArray(msg.content)) {
          if (hasCacheControl(block)) {
            anchored = true;
            break;
          }
        }
      }
      if (anchored) lastMessageBreakpoint = index;
    });

    if (lastMessageBreakpoint >= 0) return lastMessageBreakpoint;
    // A system/tools breakpoint with no message breakpoint leaves all messages
    // mutable (system/tools aren't compacted anyway) => -1.
    void hasPrefixBreakpoint;
    return -1;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenAIAdapter
// ─────────────────────────────────────────────────────────────────────────────

export class OpenAIAdapter implements ProviderAdapter {
  readonly id: ProviderId = 'openai';

  matches(meta: RequestMeta, _body: unknown): boolean {
    return (meta.path ?? '').endsWith('/chat/completions');
  }

  upstreamBaseUrl(env: NodeJS.ProcessEnv): string {
    return stripTrailingSlash(
      env.TOKDIET_OPENAI_UPSTREAM || env.CTXGOV_OPENAI_UPSTREAM || 'https://api.openai.com',
    );
  }

  getModel(body: unknown): string | undefined {
    if (isObject(body) && typeof body.model === 'string') return body.model;
    return undefined;
  }

  isStreaming(body: unknown): boolean {
    return isObject(body) && body.stream === true;
  }

  getSystemText(body: unknown): string {
    if (!isObject(body)) return '';
    const parts: string[] = [];
    for (const msg of asArray(body.messages)) {
      if (!isObject(msg)) continue;
      if (msg.role === 'system' || msg.role === 'developer') {
        parts.push(flattenContent(msg.content));
      }
    }
    return parts.join('');
  }

  countInputTokens(body: unknown, counter: TokenCounter): number {
    return counter.countRequest(body, 'openai', this.getModel(body));
  }

  listToolResults(body: unknown, counter: TokenCounter): ToolResultRef[] {
    const refs: ToolResultRef[] = [];
    if (!isObject(body)) return refs;
    const model = this.getModel(body);
    const messages = asArray(body.messages);
    messages.forEach((msg, messageIndex) => {
      if (!isObject(msg) || msg.role !== 'tool') return;
      const raw = msg.content;
      const text = typeof raw === 'string' ? raw : joinTextBlocks(raw);
      const wasString = typeof raw === 'string';
      refs.push({
        messageIndex,
        tokens: counter.count(text, 'openai', model),
        text,
        replace(newText: string): void {
          if (wasString) {
            msg.content = newText;
          } else {
            msg.content = [{ type: 'text', text: newText }];
          }
        },
      });
    });
    return refs;
  }

  listTextChunks(body: unknown, counter: TokenCounter): TextChunkRef[] {
    const refs: TextChunkRef[] = [];
    if (!isObject(body)) return refs;
    const model = this.getModel(body);
    const messages = asArray(body.messages);
    messages.forEach((msg, messageIndex) => {
      if (!isObject(msg)) return;
      const role = asString(msg.role) || 'user';
      const content = msg.content;
      if (typeof content === 'string') {
        const text = content;
        refs.push({
          messageIndex,
          role,
          tokens: counter.count(text, 'openai', model),
          text,
          replace(newText: string): void {
            msg.content = newText;
          },
        });
        return;
      }
      if (!Array.isArray(content)) return;
      content.forEach((part) => {
        if (!isObject(part) || typeof part.text !== 'string') return;
        const text = part.text;
        refs.push({
          messageIndex,
          role,
          tokens: counter.count(text, 'openai', model),
          text,
          replace(newText: string): void {
            part.text = newText;
          },
        });
      });
    });
    return refs;
  }

  listMessages(body: unknown, counter: TokenCounter): MessageRef[] {
    const refs: MessageRef[] = [];
    if (!isObject(body)) return refs;
    const model = this.getModel(body);
    const messages = asArray(body.messages);
    messages.forEach((msg, index) => {
      if (!isObject(msg)) return;
      const role = normalizeOpenAiRole(asString(msg.role));
      const text = flattenContent(msg.content);
      const pinned = msg._ctxgov_pin === true || text.includes(PIN_SENTINEL);
      refs.push({
        index,
        role,
        tokens: counter.count(text, 'openai', model),
        text,
        pinned,
        replaceText(newText: string): void {
          msg.content = newText;
        },
      });
    });
    return refs;
  }

  parseUsageFromResponse(json: unknown): UsageCounts | undefined {
    if (!isObject(json)) return undefined;
    const usage = json.usage;
    if (!isObject(usage)) return undefined;
    const details = isObject(usage.prompt_tokens_details) ? usage.prompt_tokens_details : undefined;
    return {
      inputTokens: numberOr(usage.prompt_tokens, 0),
      outputTokens: numberOr(usage.completion_tokens, 0),
      cacheReadTokens: details ? optionalNumber(details.cached_tokens) : undefined,
    };
  }

  parseUsageFromStreamEvent(_eventName: string | undefined, data: unknown, acc: UsageCounts): void {
    if (!isObject(data)) return;
    const usage = data.usage;
    if (!isObject(usage)) return;
    acc.inputTokens = numberOr(usage.prompt_tokens, acc.inputTokens);
    acc.outputTokens = numberOr(usage.completion_tokens, acc.outputTokens);
    const details = isObject(usage.prompt_tokens_details) ? usage.prompt_tokens_details : undefined;
    if (details) {
      const cr = optionalNumber(details.cached_tokens);
      if (cr !== undefined) acc.cacheReadTokens = cr;
    }
  }

  extractStreamDeltaText(_eventName: string | undefined, data: unknown): string {
    // OpenAI streams answer text via chunk objects whose `choices[].delta`
    // carries `{ content }`. Sum across choices (typically just one).
    if (!isObject(data)) return '';
    const parts: string[] = [];
    for (const choice of asArray(data.choices)) {
      if (!isObject(choice)) continue;
      const delta = choice.delta;
      if (!isObject(delta)) continue;
      const content = delta.content;
      if (typeof content === 'string') parts.push(content);
      else if (Array.isArray(content)) parts.push(joinTextBlocks(content));
    }
    return parts.join('');
  }

  extractAnswerText(json: unknown): string {
    if (!isObject(json)) return '';
    const choices = asArray(json.choices);
    const first = choices[0];
    if (!isObject(first)) return '';
    const message = first.message;
    if (!isObject(message)) return '';
    return flattenContent(message.content);
  }

  cacheBoundaryIndex(_body: unknown): number {
    // OpenAI prompt caching is automatic/implicit — there are no explicit client
    // breakpoints to honor, so nothing in the body is treated as immutable here.
    return -1;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GeminiAdapter
// ─────────────────────────────────────────────────────────────────────────────

export class GeminiAdapter implements ProviderAdapter {
  readonly id: ProviderId = 'gemini';

  matches(meta: RequestMeta, _body: unknown): boolean {
    const path = meta.path ?? '';
    return (
      path.includes(':generateContent') ||
      path.includes(':streamGenerateContent') ||
      path.startsWith('/v1beta/') ||
      path.startsWith('/v1/models')
    );
  }

  upstreamBaseUrl(env: NodeJS.ProcessEnv): string {
    return stripTrailingSlash(
      env.TOKDIET_GEMINI_UPSTREAM ||
        env.CTXGOV_GEMINI_UPSTREAM ||
        'https://generativelanguage.googleapis.com',
    );
  }

  getModel(body: unknown, meta?: RequestMeta): string | undefined {
    // The model lives in the URL path: /v1beta/models/gemini-1.5-pro:generateContent
    const path = meta?.path;
    if (typeof path === 'string') {
      const m = path.match(/models\/([^:/]+)/);
      if (m && m[1]) return m[1];
    }
    if (isObject(body) && typeof body.model === 'string') return body.model;
    return undefined;
  }

  isStreaming(body: unknown): boolean {
    // Streaming for Gemini is determined by the path (:streamGenerateContent),
    // which isn't visible here. Fall back to an explicit body.stream flag.
    return isObject(body) && body.stream === true;
  }

  getSystemText(body: unknown): string {
    if (!isObject(body)) return '';
    const si = body.systemInstruction;
    if (!isObject(si)) return '';
    return joinTextBlocks(si.parts);
  }

  countInputTokens(body: unknown, counter: TokenCounter): number {
    return counter.countRequest(body, 'gemini', this.getModel(body));
  }

  listToolResults(body: unknown, counter: TokenCounter): ToolResultRef[] {
    const refs: ToolResultRef[] = [];
    if (!isObject(body)) return refs;
    const model = this.getModel(body);
    const contents = asArray(body.contents);
    contents.forEach((content, messageIndex) => {
      if (!isObject(content)) return;
      const parts = content.parts;
      if (!Array.isArray(parts)) return;
      parts.forEach((part) => {
        if (!isObject(part) || !isObject(part.functionResponse)) return;
        const fr = part.functionResponse;
        let text = '';
        try {
          text = JSON.stringify(fr.response ?? {});
        } catch {
          text = '';
        }
        refs.push({
          messageIndex,
          tokens: counter.count(text, 'gemini', model),
          text,
          // Replace the function-response part with a simple text part in place.
          replace(newText: string): void {
            delete part.functionResponse;
            part.text = newText;
          },
        });
      });
    });
    return refs;
  }

  listTextChunks(body: unknown, counter: TokenCounter): TextChunkRef[] {
    const refs: TextChunkRef[] = [];
    if (!isObject(body)) return refs;
    const model = this.getModel(body);
    const contents = asArray(body.contents);
    contents.forEach((content, messageIndex) => {
      if (!isObject(content)) return;
      const role = mapGeminiRole(asString(content.role));
      const parts = content.parts;
      if (!Array.isArray(parts)) return;
      parts.forEach((part) => {
        if (!isObject(part) || typeof part.text !== 'string') return;
        const text = part.text;
        refs.push({
          messageIndex,
          role,
          tokens: counter.count(text, 'gemini', model),
          text,
          replace(newText: string): void {
            part.text = newText;
          },
        });
      });
    });
    return refs;
  }

  listMessages(body: unknown, counter: TokenCounter): MessageRef[] {
    const refs: MessageRef[] = [];
    if (!isObject(body)) return refs;
    const model = this.getModel(body);
    const contents = asArray(body.contents);
    contents.forEach((content, index) => {
      if (!isObject(content)) return;
      const role = mapGeminiRole(asString(content.role));
      const text = joinTextBlocks(content.parts);
      const pinned = content._ctxgov_pin === true || text.includes(PIN_SENTINEL);
      refs.push({
        index,
        role,
        tokens: counter.count(text, 'gemini', model),
        text,
        pinned,
        // Replace all parts with a single text part in place.
        replaceText(newText: string): void {
          content.parts = [{ text: newText }];
        },
      });
    });
    return refs;
  }

  parseUsageFromResponse(json: unknown): UsageCounts | undefined {
    if (!isObject(json)) return undefined;
    const meta = json.usageMetadata;
    if (!isObject(meta)) return undefined;
    return {
      inputTokens: numberOr(meta.promptTokenCount, 0),
      outputTokens: numberOr(meta.candidatesTokenCount, 0),
      cacheReadTokens: optionalNumber(meta.cachedContentTokenCount),
    };
  }

  parseUsageFromStreamEvent(_eventName: string | undefined, data: unknown, acc: UsageCounts): void {
    if (!isObject(data)) return;
    const meta = data.usageMetadata;
    if (!isObject(meta)) return;
    acc.inputTokens = numberOr(meta.promptTokenCount, acc.inputTokens);
    acc.outputTokens = numberOr(meta.candidatesTokenCount, acc.outputTokens);
    const cr = optionalNumber(meta.cachedContentTokenCount);
    if (cr !== undefined) acc.cacheReadTokens = cr;
  }

  extractStreamDeltaText(_eventName: string | undefined, data: unknown): string {
    // Gemini's streamGenerateContent (alt=sse) emits chunk objects shaped like a
    // GenerateContentResponse: `candidates[].content.parts[].text`.
    if (!isObject(data)) return '';
    const parts: string[] = [];
    for (const candidate of asArray(data.candidates)) {
      if (!isObject(candidate)) continue;
      const content = candidate.content;
      if (!isObject(content)) continue;
      const t = joinTextBlocks(content.parts);
      if (t) parts.push(t);
    }
    return parts.join('');
  }

  extractAnswerText(json: unknown): string {
    if (!isObject(json)) return '';
    const candidates = asArray(json.candidates);
    const first = candidates[0];
    if (!isObject(first)) return '';
    const content = first.content;
    if (!isObject(content)) return '';
    return joinTextBlocks(content.parts);
  }

  cacheBoundaryIndex(_body: unknown): number {
    // Gemini context caching is keyed by an explicit cachedContent resource, not
    // by per-request breakpoints in the message body, so nothing here is treated
    // as immutable.
    return -1;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Local numeric/role helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Coerce to a finite number, else fall back. */
function numberOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Return a finite number or undefined (for optional usage fields). */
function optionalNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function normalizeOpenAiRole(role: string): MessageRef['role'] {
  switch (role) {
    case 'system':
    case 'developer':
      return 'system';
    case 'assistant':
      return 'assistant';
    case 'tool':
      return 'tool';
    default:
      return 'user';
  }
}

/** Gemini uses 'model' for the assistant turn. */
function mapGeminiRole(role: string): MessageRef['role'] {
  return role === 'model' ? 'assistant' : 'user';
}

// ─────────────────────────────────────────────────────────────────────────────
// Registry & detection
// ─────────────────────────────────────────────────────────────────────────────

export const anthropic = new AnthropicAdapter();
export const openai = new OpenAIAdapter();
export const gemini = new GeminiAdapter();

/** All adapters in detection priority order. */
export const adapters: ProviderAdapter[] = [anthropic, openai, gemini];

/** Return the first adapter whose `matches()` accepts the request, else undefined. */
export function detectProvider(meta: RequestMeta, body: unknown): ProviderAdapter | undefined {
  for (const adapter of adapters) {
    try {
      if (adapter.matches(meta, body)) return adapter;
    } catch {
      // A misbehaving matcher must never break detection.
    }
  }
  return undefined;
}
