// tests/providers.test.ts — unit tests for provider adapters.
import { describe, it, expect } from 'vitest';
import {
  adapters,
  anthropic,
  openai,
  gemini,
  detectProvider,
  AnthropicAdapter,
  OpenAIAdapter,
  GeminiAdapter,
} from '../src/providers.js';
import type { RequestMeta, TokenCounter, UsageCounts } from '../src/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Test doubles
// ─────────────────────────────────────────────────────────────────────────────

/** Deterministic counter: ~1 token per 4 chars (cheap stand-in for a tokenizer). */
const counter: TokenCounter = {
  count: (text) => Math.ceil((typeof text === 'string' ? text.length : 0) / 4),
  countRequest: (body) => {
    let chars = 0;
    const walk = (v: unknown): void => {
      if (typeof v === 'string') chars += v.length;
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(body);
    return Math.ceil(chars / 4);
  },
};

function meta(path: string, headers: Record<string, string> = {}): RequestMeta {
  return { method: 'POST', path, headers };
}

const BIG = 'X'.repeat(4000); // ~1000 tokens under the stub counter

// ─────────────────────────────────────────────────────────────────────────────
// Sample bodies
// ─────────────────────────────────────────────────────────────────────────────

function anthropicBody() {
  return {
    model: 'claude-opus-4-8',
    stream: false,
    system: 'You are helpful.',
    _unknown_field: { keep: 'me' }, // must survive round-trips
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hello' },
          {
            type: 'tool_result',
            tool_use_id: 'tu_1',
            content: BIG, // string form
            _extra: 'preserve',
          },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'world' }],
      },
    ],
  };
}

function openaiBody() {
  return {
    model: 'gpt-4o-mini',
    stream: false,
    extra_top_level: 'keep',
    messages: [
      { role: 'system', content: 'sys prompt' },
      { role: 'user', content: 'question?' },
      { role: 'assistant', content: 'thinking', tool_calls: [{ id: 'c1' }] },
      { role: 'tool', tool_call_id: 'c1', content: BIG },
    ],
  };
}

function geminiBody() {
  return {
    systemInstruction: { parts: [{ text: 'be terse' }] },
    contents: [
      { role: 'user', parts: [{ text: 'q1' }] },
      {
        role: 'user',
        parts: [{ functionResponse: { name: 'fetch', response: { data: BIG } } }],
      },
      { role: 'model', parts: [{ text: 'a1' }] },
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Registry & detection
// ─────────────────────────────────────────────────────────────────────────────

describe('registry', () => {
  it('exports three adapter instances in order', () => {
    expect(adapters).toEqual([anthropic, openai, gemini]);
    expect(anthropic).toBeInstanceOf(AnthropicAdapter);
    expect(openai).toBeInstanceOf(OpenAIAdapter);
    expect(gemini).toBeInstanceOf(GeminiAdapter);
  });
});

describe('detectProvider', () => {
  it('picks anthropic by /v1/messages path', () => {
    expect(detectProvider(meta('/v1/messages'), anthropicBody())).toBe(anthropic);
  });

  it('picks anthropic by body + x-api-key header when path is generic', () => {
    expect(detectProvider(meta('/proxy', { 'x-api-key': 'sk' }), anthropicBody())).toBe(anthropic);
  });

  it('picks openai by /chat/completions path', () => {
    expect(detectProvider(meta('/v1/chat/completions'), openaiBody())).toBe(openai);
  });

  it('does not let anthropic hijack an openai chat path', () => {
    const m = meta('/v1/chat/completions', { 'x-api-key': 'sk' });
    expect(detectProvider(m, { model: 'x', messages: [] })).toBe(openai);
  });

  it('picks gemini by :generateContent path', () => {
    expect(
      detectProvider(meta('/v1beta/models/gemini-1.5-pro:generateContent'), geminiBody()),
    ).toBe(gemini);
  });

  it('returns undefined for unknown requests', () => {
    expect(detectProvider(meta('/health'), {})).toBeUndefined();
  });

  it('never throws on malformed body', () => {
    expect(() => detectProvider(meta('/v1/messages'), null)).not.toThrow();
    expect(() => detectProvider(meta('/x'), 12345)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Anthropic
// ─────────────────────────────────────────────────────────────────────────────

describe('AnthropicAdapter', () => {
  it('reads model / system / streaming', () => {
    const b = anthropicBody();
    expect(anthropic.getModel(b)).toBe('claude-opus-4-8');
    expect(anthropic.getSystemText(b)).toBe('You are helpful.');
    expect(anthropic.isStreaming(b)).toBe(false);
    expect(anthropic.isStreaming({ ...b, stream: true })).toBe(true);
  });

  it('reads array-form system text', () => {
    const b = { system: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }] };
    expect(anthropic.getSystemText(b)).toBe('AB');
  });

  it('lists the tool result and replace() mutates the original body', () => {
    const b = anthropicBody();
    const trs = anthropic.listToolResults(b, counter);
    expect(trs).toHaveLength(1);
    expect(trs[0].messageIndex).toBe(0);
    expect(trs[0].text).toBe(BIG);
    expect(trs[0].tokens).toBe(1000);

    trs[0].replace('[elided]');
    // Original body mutated in place.
    const block = (b.messages[0].content as any[])[1];
    expect(block.content).toBe('[elided]');
    // Unknown sibling field preserved.
    expect(block._extra).toBe('preserve');
    // Unknown top-level field preserved.
    expect((b as any)._unknown_field).toEqual({ keep: 'me' });
  });

  it('replaces array-form tool_result content as a text block', () => {
    const b = {
      model: 'claude',
      messages: [
        {
          role: 'user',
          content: [{ type: 'tool_result', content: [{ type: 'text', text: 'orig' }] }],
        },
      ],
    };
    const trs = anthropic.listToolResults(b, counter);
    expect(trs[0].text).toBe('orig');
    trs[0].replace('new');
    expect((b.messages[0].content as any[])[0].content).toEqual([{ type: 'text', text: 'new' }]);
  });

  it('lists text chunks for text + tool_result blocks', () => {
    const b = anthropicBody();
    const chunks = anthropic.listTextChunks(b, counter);
    const texts = chunks.map((c) => c.text);
    expect(texts).toContain('hello');
    expect(texts).toContain('world');
    expect(texts).toContain(BIG);
  });

  it('lists messages with pin detection and replaceText mutation', () => {
    const b = anthropicBody();
    const msgs = anthropic.listMessages(b, counter);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe('user');
    expect(msgs[1].role).toBe('assistant');
    expect(msgs[0].pinned).toBe(false);

    msgs[1].replaceText('summary');
    expect(b.messages[1].content).toBe('summary');
  });

  it('detects pins via sentinel and _ctxgov_pin', () => {
    const b = {
      model: 'claude',
      messages: [
        { role: 'user', content: 'keep me <!--ctxgov:pin-->' },
        { role: 'user', content: 'flagged', _ctxgov_pin: true },
        { role: 'user', content: 'normal' },
      ],
    };
    const msgs = anthropic.listMessages(b, counter);
    expect(msgs[0].pinned).toBe(true);
    expect(msgs[1].pinned).toBe(true);
    expect(msgs[2].pinned).toBe(false);
  });

  it('parses usage from a response', () => {
    const usage = anthropic.parseUsageFromResponse({
      content: [{ type: 'text', text: 'answer' }],
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 7,
      },
    });
    expect(usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 5,
      cacheWriteTokens: 7,
    });
  });

  it('accumulates usage from stream events', () => {
    const acc: UsageCounts = { inputTokens: 0, outputTokens: 0 };
    anthropic.parseUsageFromStreamEvent(
      'message_start',
      { message: { usage: { input_tokens: 50, cache_read_input_tokens: 3 } } },
      acc,
    );
    anthropic.parseUsageFromStreamEvent('message_delta', { usage: { output_tokens: 12 } }, acc);
    expect(acc.inputTokens).toBe(50);
    expect(acc.outputTokens).toBe(12);
    expect(acc.cacheReadTokens).toBe(3);
  });

  it('extracts answer text from content blocks', () => {
    expect(
      anthropic.extractAnswerText({
        content: [{ type: 'text', text: 'foo' }, { type: 'tool_use' }, { type: 'text', text: 'bar' }],
      }),
    ).toBe('foobar');
  });

  it('honors CTXGOV_ANTHROPIC_UPSTREAM and strips trailing slash', () => {
    expect(anthropic.upstreamBaseUrl({} as NodeJS.ProcessEnv)).toBe('https://api.anthropic.com');
    expect(
      anthropic.upstreamBaseUrl({ CTXGOV_ANTHROPIC_UPSTREAM: 'http://localhost:9/' } as NodeJS.ProcessEnv),
    ).toBe('http://localhost:9');
  });

  it('is robust to malformed bodies', () => {
    expect(anthropic.getModel(null)).toBeUndefined();
    expect(anthropic.getSystemText(undefined)).toBe('');
    expect(anthropic.listToolResults(null, counter)).toEqual([]);
    expect(anthropic.listMessages(42, counter)).toEqual([]);
    expect(anthropic.parseUsageFromResponse(null)).toBeUndefined();
  });

  // ── Prompt-cache boundary (cache_control) ──────────────────────────────────

  it('cacheBoundaryIndex returns the highest message index carrying cache_control', () => {
    const b = {
      model: 'claude',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'a' }] },
        {
          role: 'user',
          content: [{ type: 'text', text: 'b', cache_control: { type: 'ephemeral' } }],
        },
        { role: 'assistant', content: [{ type: 'text', text: 'c' }] },
      ],
    };
    expect(anthropic.cacheBoundaryIndex(b)).toBe(1);
  });

  it('cacheBoundaryIndex picks the LAST of several message breakpoints', () => {
    const b = {
      model: 'claude',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'a', cache_control: { type: 'ephemeral' } }] },
        { role: 'assistant', content: [{ type: 'text', text: 'b' }] },
        { role: 'user', content: [{ type: 'tool_result', content: 'x', cache_control: { type: 'ephemeral' } }] },
        { role: 'assistant', content: [{ type: 'text', text: 'd' }] },
      ],
    };
    expect(anthropic.cacheBoundaryIndex(b)).toBe(2);
  });

  it('cacheBoundaryIndex honors cache_control on the message object itself', () => {
    const b = {
      model: 'claude',
      messages: [
        { role: 'user', content: 'a' },
        { role: 'user', content: 'b', cache_control: { type: 'ephemeral' } },
      ],
    };
    expect(anthropic.cacheBoundaryIndex(b)).toBe(1);
  });

  it('cacheBoundaryIndex returns -1 when only system/tools are cached (no message breakpoint)', () => {
    const sysOnly = {
      model: 'claude',
      system: [{ type: 'text', text: 'big rules', cache_control: { type: 'ephemeral' } }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'a' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'b' }] },
      ],
    };
    expect(anthropic.cacheBoundaryIndex(sysOnly)).toBe(-1);

    const toolsOnly = {
      model: 'claude',
      tools: [{ name: 'fetch', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }] }],
    };
    expect(anthropic.cacheBoundaryIndex(toolsOnly)).toBe(-1);
  });

  it('cacheBoundaryIndex returns -1 when there are no breakpoints at all', () => {
    expect(anthropic.cacheBoundaryIndex(anthropicBody())).toBe(-1);
  });

  it('cacheBoundaryIndex is robust to malformed bodies', () => {
    expect(anthropic.cacheBoundaryIndex(null)).toBe(-1);
    expect(anthropic.cacheBoundaryIndex(42)).toBe(-1);
    expect(anthropic.cacheBoundaryIndex({})).toBe(-1);
    expect(anthropic.cacheBoundaryIndex({ messages: 'nope', system: 7 })).toBe(-1);
  });

  // ── Extended-thinking / signed-block safety ────────────────────────────────

  it('listTextChunks skips thinking, redacted_thinking and signed blocks', () => {
    const b = {
      model: 'claude',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'secret reasoning', signature: 'SIG_A' },
            { type: 'redacted_thinking', data: 'opaque' },
            { type: 'text', text: 'visible answer', signature: 'SIG_B' }, // signed text -> still skipped
            { type: 'text', text: 'plain answer' },
          ],
        },
      ],
    };
    const chunks = anthropic.listTextChunks(b, counter);
    const texts = chunks.map((c) => c.text);
    expect(texts).toEqual(['plain answer']);
    expect(texts).not.toContain('visible answer');
    expect(texts.join('')).not.toContain('secret reasoning');
  });

  it('listToolResults never exposes a thinking block, only real tool results', () => {
    const b = {
      model: 'claude',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'thinking', thinking: 'do not surface', signature: 'SIG' },
            { type: 'tool_result', tool_use_id: 'tu', content: BIG },
          ],
        },
      ],
    };
    const trs = anthropic.listToolResults(b, counter);
    expect(trs).toHaveLength(1);
    expect(trs[0].text).toBe(BIG);
    expect(trs.map((t) => t.text).join('')).not.toContain('do not surface');
  });

  it('listMessages flattened text excludes thinking/signed blocks', () => {
    const b = {
      model: 'claude',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'hidden chain of thought', signature: 'SIG' },
            { type: 'text', text: 'final reply' },
          ],
        },
      ],
    };
    const msgs = anthropic.listMessages(b, counter);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toBe('final reply');
    expect(msgs[0].text).not.toContain('hidden chain of thought');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI
// ─────────────────────────────────────────────────────────────────────────────

describe('OpenAIAdapter', () => {
  it('reads model / system / streaming', () => {
    const b = openaiBody();
    expect(openai.getModel(b)).toBe('gpt-4o-mini');
    expect(openai.getSystemText(b)).toBe('sys prompt');
    expect(openai.isStreaming(b)).toBe(false);
  });

  it('concatenates system + developer roles for system text', () => {
    const b = {
      messages: [
        { role: 'system', content: 'A' },
        { role: 'developer', content: 'B' },
        { role: 'user', content: 'C' },
      ],
    };
    expect(openai.getSystemText(b)).toBe('AB');
  });

  it('lists the role:tool message and replace() mutates the original body', () => {
    const b = openaiBody();
    const trs = openai.listToolResults(b, counter);
    expect(trs).toHaveLength(1);
    expect(trs[0].messageIndex).toBe(3);
    expect(trs[0].text).toBe(BIG);

    trs[0].replace('[trimmed]');
    expect(b.messages[3].content).toBe('[trimmed]');
    // tool_call_id sibling preserved.
    expect((b.messages[3] as any).tool_call_id).toBe('c1');
    expect((b as any).extra_top_level).toBe('keep');
  });

  it('lists messages with normalized roles', () => {
    const b = openaiBody();
    const msgs = openai.listMessages(b, counter);
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);
    msgs[1].replaceText('shorter');
    expect(b.messages[1].content).toBe('shorter');
  });

  it('parses usage incl. cached prompt tokens', () => {
    const usage = openai.parseUsageFromResponse({
      choices: [{ message: { content: 'hi' } }],
      usage: { prompt_tokens: 80, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 40 } },
    });
    expect(usage).toEqual({ inputTokens: 80, outputTokens: 10, cacheReadTokens: 40 });
  });

  it('accumulates usage from a final stream chunk', () => {
    const acc: UsageCounts = { inputTokens: 0, outputTokens: 0 };
    openai.parseUsageFromStreamEvent(undefined, { usage: { prompt_tokens: 30, completion_tokens: 9 } }, acc);
    expect(acc).toMatchObject({ inputTokens: 30, outputTokens: 9 });
  });

  it('extracts answer text', () => {
    expect(openai.extractAnswerText({ choices: [{ message: { content: 'done' } }] })).toBe('done');
    expect(
      openai.extractAnswerText({ choices: [{ message: { content: [{ type: 'text', text: 'AB' }] } }] }),
    ).toBe('AB');
  });

  it('honors CTXGOV_OPENAI_UPSTREAM', () => {
    expect(openai.upstreamBaseUrl({} as NodeJS.ProcessEnv)).toBe('https://api.openai.com');
    expect(openai.upstreamBaseUrl({ CTXGOV_OPENAI_UPSTREAM: 'http://x/' } as NodeJS.ProcessEnv)).toBe('http://x');
  });

  it('is robust to malformed bodies', () => {
    expect(openai.listToolResults({}, counter)).toEqual([]);
    expect(openai.extractAnswerText({})).toBe('');
    expect(openai.parseUsageFromResponse({ usage: 'nope' })).toBeUndefined();
  });

  it('cacheBoundaryIndex is always -1 (no explicit client breakpoints)', () => {
    expect(openai.cacheBoundaryIndex(openaiBody())).toBe(-1);
    expect(openai.cacheBoundaryIndex(null)).toBe(-1);
    expect(
      openai.cacheBoundaryIndex({
        messages: [{ role: 'user', content: 'x', cache_control: { type: 'ephemeral' } }],
      }),
    ).toBe(-1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Gemini
// ─────────────────────────────────────────────────────────────────────────────

describe('GeminiAdapter', () => {
  it('matches a variety of paths', () => {
    expect(gemini.matches(meta('/v1beta/models/x:generateContent'), {})).toBe(true);
    expect(gemini.matches(meta('/v1/models/x:streamGenerateContent'), {})).toBe(true);
    expect(gemini.matches(meta('/v1beta/anything'), {})).toBe(true);
    expect(gemini.matches(meta('/v1/chat/completions'), {})).toBe(false);
  });

  it('reads model from the URL path, then body fallback', () => {
    expect(
      gemini.getModel(geminiBody(), meta('/v1beta/models/gemini-1.5-pro:generateContent')),
    ).toBe('gemini-1.5-pro');
    expect(gemini.getModel({ model: 'gemini-2.0' })).toBe('gemini-2.0');
  });

  it('reads system instruction text', () => {
    expect(gemini.getSystemText(geminiBody())).toBe('be terse');
  });

  it('lists functionResponse tool results and replace() mutates in place', () => {
    const b = geminiBody();
    const trs = gemini.listToolResults(b, counter);
    expect(trs).toHaveLength(1);
    expect(trs[0].messageIndex).toBe(1);
    expect(trs[0].text).toContain(BIG);

    trs[0].replace('[fn elided]');
    const part = (b.contents[1].parts as any[])[0];
    expect(part.functionResponse).toBeUndefined();
    expect(part.text).toBe('[fn elided]');
  });

  it('lists text chunks and messages with model->assistant mapping', () => {
    const b = geminiBody();
    const chunks = gemini.listTextChunks(b, counter);
    expect(chunks.map((c) => c.text)).toEqual(['q1', 'a1']);

    const msgs = gemini.listMessages(b, counter);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'user', 'assistant']);
    msgs[2].replaceText('shorter');
    expect(b.contents[2].parts).toEqual([{ text: 'shorter' }]);
  });

  it('parses usage from usageMetadata', () => {
    const usage = gemini.parseUsageFromResponse({
      usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 30, cachedContentTokenCount: 12 },
      candidates: [{ content: { parts: [{ text: 'hi' }] } }],
    });
    expect(usage).toEqual({ inputTokens: 200, outputTokens: 30, cacheReadTokens: 12 });
  });

  it('accumulates usage from a stream event', () => {
    const acc: UsageCounts = { inputTokens: 0, outputTokens: 0 };
    gemini.parseUsageFromStreamEvent(undefined, { usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 } }, acc);
    expect(acc).toMatchObject({ inputTokens: 5, outputTokens: 2 });
  });

  it('extracts answer text from candidates', () => {
    expect(
      gemini.extractAnswerText({ candidates: [{ content: { parts: [{ text: 'a' }, { text: 'b' }] } }] }),
    ).toBe('ab');
  });

  it('honors CTXGOV_GEMINI_UPSTREAM', () => {
    expect(gemini.upstreamBaseUrl({} as NodeJS.ProcessEnv)).toBe(
      'https://generativelanguage.googleapis.com',
    );
  });

  it('is robust to malformed bodies', () => {
    expect(gemini.listToolResults({}, counter)).toEqual([]);
    expect(gemini.listTextChunks(null, counter)).toEqual([]);
    expect(gemini.getSystemText({})).toBe('');
    expect(gemini.parseUsageFromResponse({})).toBeUndefined();
  });

  it('cacheBoundaryIndex is always -1 (caching is via cachedContent, not breakpoints)', () => {
    expect(gemini.cacheBoundaryIndex(geminiBody())).toBe(-1);
    expect(gemini.cacheBoundaryIndex(null)).toBe(-1);
  });
});
