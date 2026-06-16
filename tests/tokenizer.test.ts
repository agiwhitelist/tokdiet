// tests/tokenizer.test.ts — behaviour of the token counter & heuristics.
import { describe, it, expect } from 'vitest';
import { DefaultTokenCounter, approxTokens, tokenCounter } from '../src/tokenizer.js';

describe('approxTokens', () => {
  it('is deterministic and uses the ceil(len/4) heuristic', () => {
    expect(approxTokens('hello world')).toBe(Math.ceil('hello world'.length / 4));
    // Stable across calls.
    expect(approxTokens('hello world')).toBe(approxTokens('hello world'));
  });

  it('returns 0 for empty / non-string input', () => {
    expect(approxTokens('')).toBe(0);
    // @ts-expect-error exercising malformed input at runtime
    expect(approxTokens(null)).toBe(0);
    // @ts-expect-error exercising malformed input at runtime
    expect(approxTokens(undefined)).toBe(0);
  });

  it('is never negative', () => {
    expect(approxTokens('a')).toBeGreaterThanOrEqual(0);
  });
});

describe('DefaultTokenCounter.count', () => {
  it('returns a positive count for non-empty text on every provider', () => {
    for (const provider of ['anthropic', 'openai', 'gemini'] as const) {
      expect(tokenCounter.count('hello world', provider)).toBeGreaterThan(0);
    }
  });

  it('returns 0 for empty or non-string text', () => {
    expect(tokenCounter.count('', 'openai')).toBe(0);
    // @ts-expect-error malformed runtime input
    expect(tokenCounter.count(null, 'openai')).toBe(0);
    // @ts-expect-error malformed runtime input
    expect(tokenCounter.count(123, 'anthropic')).toBe(0);
  });

  it('scales monotonically with text length', () => {
    const short = tokenCounter.count('hi', 'openai');
    const long = tokenCounter.count('hi '.repeat(200), 'openai');
    expect(long).toBeGreaterThan(short);
  });
});

describe('DefaultTokenCounter.countRequest — anthropic', () => {
  it('sums system (string), messages, and tools', () => {
    const counter = new DefaultTokenCounter();
    const body = {
      model: 'claude-opus-4',
      system: 'You are a helpful assistant that explains things clearly.',
      messages: [
        { role: 'user', content: 'What is the capital of France?' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me look that up for you.' },
            { type: 'tool_use', id: 't1', name: 'search', input: { q: 'capital of France' } },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't1',
              content: [{ type: 'text', text: 'Paris is the capital of France.' }],
            },
          ],
        },
      ],
      tools: [{ name: 'search', description: 'Search the web', input_schema: { type: 'object' } }],
    };
    const n = counter.countRequest(body, 'anthropic', 'claude-opus-4');
    expect(n).toBeGreaterThan(0);
  });

  it('handles system as an array of text blocks', () => {
    const counter = new DefaultTokenCounter();
    const body = {
      system: [
        { type: 'text', text: 'System rule one.' },
        { type: 'text', text: 'System rule two.' },
      ],
      messages: [{ role: 'user', content: 'hi' }],
    };
    expect(counter.countRequest(body, 'anthropic')).toBeGreaterThan(0);
  });

  it('handles tool_result with string content', () => {
    const counter = new DefaultTokenCounter();
    const body = {
      messages: [
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'plain string result' }],
        },
      ],
    };
    expect(counter.countRequest(body, 'anthropic')).toBeGreaterThan(0);
  });
});

describe('DefaultTokenCounter.countRequest — openai', () => {
  it('sums string + array content, tool_calls and tools', () => {
    const counter = new DefaultTokenCounter();
    const body = {
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'You are concise.' },
        { role: 'user', content: 'Summarize the news.' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Here is an image-like part with text.' },
            { type: 'image_url', image_url: { url: 'data:...' } },
          ],
        },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'c1', type: 'function', function: { name: 'get_news', arguments: '{"topic":"tech"}' } },
          ],
        },
      ],
      tools: [{ type: 'function', function: { name: 'get_news', description: 'Fetch news' } }],
    };
    const n = counter.countRequest(body, 'openai', 'gpt-4o');
    expect(n).toBeGreaterThan(0);
  });
});

describe('DefaultTokenCounter.countRequest — gemini', () => {
  it('sums contents.parts[].text, systemInstruction and tools', () => {
    const counter = new DefaultTokenCounter();
    const body = {
      systemInstruction: { parts: [{ text: 'Be brief.' }] },
      contents: [
        { role: 'user', parts: [{ text: 'Hello there general assistant.' }] },
        { role: 'model', parts: [{ text: 'Hi! How can I help?' }] },
      ],
      tools: [{ functionDeclarations: [{ name: 'lookup' }] }],
    };
    expect(counter.countRequest(body, 'gemini', 'gemini-2.0-flash')).toBeGreaterThan(0);
  });
});

describe('DefaultTokenCounter.countRequest — robustness', () => {
  it('returns >= 0 without throwing for null / {} / arrays / primitives', () => {
    const counter = new DefaultTokenCounter();
    for (const provider of ['anthropic', 'openai', 'gemini'] as const) {
      expect(counter.countRequest(null, provider)).toBeGreaterThanOrEqual(0);
      expect(counter.countRequest({}, provider)).toBeGreaterThanOrEqual(0);
      expect(counter.countRequest([], provider)).toBeGreaterThanOrEqual(0);
      expect(counter.countRequest(42, provider)).toBeGreaterThanOrEqual(0);
      expect(counter.countRequest('a raw string body', provider)).toBeGreaterThanOrEqual(0);
    }
  });

  it('does not throw on deeply malformed message shapes', () => {
    const counter = new DefaultTokenCounter();
    const body = {
      system: { unexpected: 'object' },
      messages: [
        null,
        42,
        { role: 'user' }, // no content
        { role: 'user', content: { weird: true } },
        { role: 'assistant', content: [null, 7, { type: 'text' }, { type: 'tool_use' }] },
      ],
      tools: 'not-an-array',
    };
    expect(() => counter.countRequest(body, 'anthropic')).not.toThrow();
    expect(counter.countRequest(body, 'anthropic')).toBeGreaterThanOrEqual(0);
  });

  it('falls back to JSON-stringify counting for unknown providers', () => {
    const counter = new DefaultTokenCounter();
    // @ts-expect-error exercising an out-of-contract provider value
    const n = counter.countRequest({ foo: 'bar baz qux' }, 'mystery');
    expect(n).toBeGreaterThanOrEqual(0);
  });
});

describe('module singleton', () => {
  it('exports a shared tokenCounter instance', () => {
    expect(tokenCounter).toBeInstanceOf(DefaultTokenCounter);
  });
});
