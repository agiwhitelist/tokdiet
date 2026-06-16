// src/tokenizer.ts — token counting for request bodies and plain strings.
//
// Implements the `TokenCounter` contract from ./types.js. Counting must be
// synchronous and fail-open: any unexpected input shape, missing optional
// dependency, or encoder error degrades gracefully to a length-based heuristic
// rather than throwing.
import { createRequire } from 'node:module';
import type { ProviderId, TokenCounter } from './types.js';

/**
 * Length-based token estimate. ~4 chars per token is a decent cross-model
 * approximation and is fully deterministic. Never negative.
 */
export function approxTokens(text: string): number {
  if (typeof text !== 'string' || text.length === 0) return 0;
  return Math.max(0, Math.ceil(text.length / 4));
}

// `require` shim so we can synchronously load CJS deps (tiktoken / the optional
// anthropic tokenizer) from within an ESM module without an async import.
const requireCjs = createRequire(import.meta.url);

/** Minimal structural type for the tiktoken encoder we actually use. */
interface TiktokenLike {
  encode(text: string): Uint32Array | number[];
}

// Module-level singletons. We cache the encoder instance for the lifetime of
// the process and never free it per-call (freeing would invalidate the cache
// and leak native WASM handles on the next call).
let openaiEncoder: TiktokenLike | null = null;
let openaiEncoderTried = false;

/** Lazily create & cache one tiktoken encoder. Returns null if unavailable. */
function getOpenAIEncoder(): TiktokenLike | null {
  if (openaiEncoderTried) return openaiEncoder;
  openaiEncoderTried = true;
  try {
    const mod = requireCjs('tiktoken') as {
      get_encoding?: (name: string) => TiktokenLike;
    };
    if (typeof mod.get_encoding === 'function') {
      try {
        openaiEncoder = mod.get_encoding('o200k_base');
      } catch {
        // Fall back to the older cl100k_base if o200k_base is unavailable.
        openaiEncoder = mod.get_encoding('cl100k_base');
      }
    }
  } catch {
    openaiEncoder = null;
  }
  return openaiEncoder;
}

/** Signature of the optional `@anthropic-ai/tokenizer` countTokens export. */
type AnthropicCountFn = (text: string) => number;

let anthropicCount: AnthropicCountFn | null = null;
let anthropicTried = false;

/** Lazily resolve the optional anthropic tokenizer's countTokens. */
function getAnthropicCounter(): AnthropicCountFn | null {
  if (anthropicTried) return anthropicCount;
  anthropicTried = true;
  try {
    const mod = requireCjs('@anthropic-ai/tokenizer') as {
      countTokens?: unknown;
    };
    if (typeof mod.countTokens === 'function') {
      anthropicCount = mod.countTokens as AnthropicCountFn;
    }
  } catch {
    anthropicCount = null;
  }
  return anthropicCount;
}

/** Count tokens using the cached tiktoken encoder, falling back to heuristic. */
function countOpenAI(text: string): number {
  const enc = getOpenAIEncoder();
  if (!enc) return approxTokens(text);
  try {
    return enc.encode(text).length;
  } catch {
    return approxTokens(text);
  }
}

/** Coerce arbitrary values to a string for counting; objects become JSON. */
function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Default token counter. Routes by provider to a real tokenizer when available
 * and degrades to the length heuristic otherwise. All public methods are total
 * (never throw) and clamp to non-negative integers.
 */
export class DefaultTokenCounter implements TokenCounter {
  count(text: string, provider: ProviderId, _model?: string): number {
    if (typeof text !== 'string' || text.length === 0) return 0;
    switch (provider) {
      case 'openai':
        return countOpenAI(text);
      case 'anthropic': {
        const fn = getAnthropicCounter();
        if (fn) {
          try {
            const n = fn(text);
            if (typeof n === 'number' && Number.isFinite(n) && n >= 0) return n;
          } catch {
            // fall through to heuristic
          }
        }
        return approxTokens(text);
      }
      case 'gemini':
        // No dedicated tokenizer; reuse the openai encoder as an approximation.
        return countOpenAI(text);
      default:
        return approxTokens(text);
    }
  }

  countRequest(body: unknown, provider: ProviderId, model?: string): number {
    try {
      switch (provider) {
        case 'anthropic':
          return this.countAnthropicRequest(body, model);
        case 'openai':
          return this.countOpenAIRequest(body, model);
        case 'gemini':
          return this.countGeminiRequest(body, model);
        default:
          return this.count(asText(body), provider, model);
      }
    } catch {
      // Absolute fail-open: never throw out of token counting.
      return approxTokens(asText(body));
    }
  }

  /** Sum count() over a flattened text string. */
  private c(text: string, provider: ProviderId, model?: string): number {
    return this.count(text, provider, model);
  }

  // ── anthropic ──────────────────────────────────────────────────────────────
  private countAnthropicRequest(body: unknown, model?: string): number {
    if (!isObj(body)) return this.c(asText(body), 'anthropic', model);
    let total = 0;
    const p: ProviderId = 'anthropic';

    // system: string OR array of { type:'text', text }.
    const system = body.system;
    if (typeof system === 'string') {
      total += this.c(system, p, model);
    } else if (Array.isArray(system)) {
      for (const block of system) {
        if (isObj(block) && typeof block.text === 'string') total += this.c(block.text, p, model);
        else total += this.c(asText(block), p, model);
      }
    }

    // messages: [{ role, content: string | block[] }].
    if (Array.isArray(body.messages)) {
      for (const msg of body.messages) {
        if (!isObj(msg)) {
          total += this.c(asText(msg), p, model);
          continue;
        }
        const content = msg.content;
        if (typeof content === 'string') {
          total += this.c(content, p, model);
        } else if (Array.isArray(content)) {
          for (const block of content) {
            total += this.countAnthropicBlock(block, model);
          }
        } else if (content != null) {
          total += this.c(asText(content), p, model);
        }
      }
    }

    // tools: definitions counted as serialized JSON.
    if (body.tools != null) total += this.c(asText(body.tools), p, model);

    return total;
  }

  /** Count a single anthropic content block by type. */
  private countAnthropicBlock(block: unknown, model?: string): number {
    const p: ProviderId = 'anthropic';
    if (!isObj(block)) return this.c(asText(block), p, model);
    const type = typeof block.type === 'string' ? block.type : '';
    switch (type) {
      case 'text':
        return this.c(asText(block.text), p, model);
      case 'tool_use':
        return this.c(asText(block.input), p, model);
      case 'tool_result':
        return this.countAnthropicToolResult(block.content, model);
      default:
        return this.c(asText(block), p, model);
    }
  }

  /** tool_result.content: string OR array of blocks (text -> text, else JSON). */
  private countAnthropicToolResult(content: unknown, model?: string): number {
    const p: ProviderId = 'anthropic';
    if (typeof content === 'string') return this.c(content, p, model);
    if (Array.isArray(content)) {
      let sum = 0;
      for (const block of content) {
        if (isObj(block) && typeof block.text === 'string') sum += this.c(block.text, p, model);
        else sum += this.c(asText(block), p, model);
      }
      return sum;
    }
    if (content == null) return 0;
    return this.c(asText(content), p, model);
  }

  // ── openai ───────────────────────────────────────────────────────────────
  private countOpenAIRequest(body: unknown, model?: string): number {
    if (!isObj(body)) return this.c(asText(body), 'openai', model);
    let total = 0;
    const p: ProviderId = 'openai';

    if (Array.isArray(body.messages)) {
      for (const msg of body.messages) {
        if (!isObj(msg)) {
          total += this.c(asText(msg), p, model);
          continue;
        }
        const content = msg.content;
        if (typeof content === 'string') {
          total += this.c(content, p, model);
        } else if (Array.isArray(content)) {
          for (const part of content) {
            if (isObj(part) && typeof part.text === 'string') total += this.c(part.text, p, model);
            else total += this.c(asText(part), p, model);
          }
        } else if (content != null) {
          total += this.c(asText(content), p, model);
        }
        // Assistant tool_calls -> serialized JSON.
        if (msg.tool_calls != null) total += this.c(asText(msg.tool_calls), p, model);
        // Some shapes carry a top-level name/function_call.
        if (typeof msg.name === 'string') total += this.c(msg.name, p, model);
      }
    }

    if (body.tools != null) total += this.c(asText(body.tools), p, model);

    return total;
  }

  // ── gemini ─────────────────────────────────────────────────────────────────
  private countGeminiRequest(body: unknown, model?: string): number {
    if (!isObj(body)) return this.c(asText(body), 'gemini', model);
    let total = 0;
    const p: ProviderId = 'gemini';

    if (Array.isArray(body.contents)) {
      for (const content of body.contents) {
        if (isObj(content) && Array.isArray(content.parts)) {
          for (const part of content.parts) {
            if (isObj(part) && typeof part.text === 'string') total += this.c(part.text, p, model);
            else if (part != null) total += this.c(asText(part), p, model);
          }
        } else if (content != null) {
          total += this.c(asText(content), p, model);
        }
      }
    }

    // systemInstruction.parts[].text
    const sys = body.systemInstruction;
    if (isObj(sys) && Array.isArray(sys.parts)) {
      for (const part of sys.parts) {
        if (isObj(part) && typeof part.text === 'string') total += this.c(part.text, p, model);
        else if (part != null) total += this.c(asText(part), p, model);
      }
    } else if (typeof sys === 'string') {
      total += this.c(sys, p, model);
    }

    if (body.tools != null) total += this.c(asText(body.tools), p, model);

    return total;
  }
}

/** Shared process-wide token counter instance. */
export const tokenCounter = new DefaultTokenCounter();
