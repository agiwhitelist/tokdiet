// tests/cc-compat.test.ts — Claude Code safety proofs (no network).
//
// Two Claude-Code landmines this suite proves the governor never trips:
//
//   1. PROMPT CACHING. Claude Code sets Anthropic `cache_control` breakpoints;
//      cached input costs ~10% of normal. Because caching is a PREFIX MATCH, any
//      byte change at or before the breakpoint invalidates the cache and can make
//      the request cost MORE. So everything at/before adapter.cacheBoundaryIndex
//      must be BYTE-IDENTICAL after compaction.
//
//   2. THINKING BLOCKS. CC sends extended-thinking blocks carrying a cryptographic
//      `signature` Anthropic requires returned VERBATIM; mutating a
//      thinking/redacted_thinking/signed block => API 400. So such blocks must be
//      BYTE-IDENTICAL after compaction.
//
// Strategy: build a synthetic body shaped like a real Claude Code /v1/messages
// request — a system array with cache_control, several turns, a cache_control
// breakpoint on a MID message, a large repeated tool_result AFTER the breakpoint,
// and an assistant turn whose content mixes a signed `thinking` block with a `text`
// block. Snapshot the cached prefix and the thinking block by exact JSON bytes,
// force compaction, and assert the snapshots are unchanged while the uncached,
// non-thinking bloat was still compacted (or, if everything compactable was
// protected, that nothing changed at all — never a partial/corrupt mutation).
import { describe, it, expect } from 'vitest';
import { DefaultCompactor } from '../src/compactor/index.js';
import { AnthropicAdapter } from '../src/providers.js';
import { DefaultTokenCounter } from '../src/tokenizer.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import {
  detectPageFault,
  elidedIdsIn,
  restoreElidedBlobs,
} from '../src/pagefault.js';
import type { GovernorConfig, Store } from '../src/types.js';

const adapter = new AnthropicAdapter();
const counter = new DefaultTokenCounter();
const MODEL = 'claude-opus-4-8';

/** A long, repeated blob big enough to clear minToolResultTokens. */
function bigBlob(label: string, repeat = 300): string {
  let out = `=== ${label} ===\n`;
  for (let i = 0; i < repeat; i++) {
    out += `${label} line ${i}: the quick brown fox jumps over the lazy dog ${i}.\n`;
  }
  return out;
}

function cloneConfig(): GovernorConfig {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as GovernorConfig;
}

/**
 * Build a Claude-Code-shaped Anthropic Messages body.
 *
 * Layout (message indices):
 *   0  user      — opening instruction
 *   1  assistant — text + tool_use (read_file)
 *   2  user      — tool_result for #1, CARRIES cache_control (the breakpoint)
 *   3  assistant — THINKING block (signed) + text  [after the breakpoint]
 *   4  user      — large repeated tool_result      [after the breakpoint — bloat]
 *   5  user      — large repeated tool_result      [after the breakpoint — bloat]
 *   6  user      — final instruction
 *
 * cacheBoundaryIndex therefore resolves to 2 (the last cache-anchored message).
 */
function buildClaudeCodeBody(): {
  body: Record<string, unknown>;
  boundary: number;
  thinkingSignature: string;
} {
  const thinkingSignature =
    'EqQBCkYIARgCKkBxV3' + 'r4n0SAMPLEsigPLEASEretURNverbatim9aZ' + 'kQ==';
  const bloat = bigBlob('TOOLOUT', 300);

  const body: Record<string, unknown> = {
    model: MODEL,
    max_tokens: 1024,
    // System as an array WITH a cache_control breakpoint (Claude Code shape).
    system: [
      {
        type: 'text',
        text: 'You are Claude Code, an agentic coding assistant.',
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      // 0
      { role: 'user', content: 'Investigate the repository and report findings.' },
      // 1
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Reading the first file.' },
          { type: 'tool_use', id: 'toolu_0', name: 'read_file', input: { path: 'a.txt' } },
        ],
      },
      // 2 — the cache breakpoint lives on this message's tool_result block.
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_0',
            content: [{ type: 'text', text: bigBlob('CACHED_FILE', 300) }],
            cache_control: { type: 'ephemeral' },
          },
        ],
      },
      // 3 — assistant turn mixing a SIGNED thinking block with a text block.
      {
        role: 'assistant',
        content: [
          {
            type: 'thinking',
            thinking:
              'The user wants a report. Let me re-read the large files before answering. ' +
              'I must keep this reasoning consistent across turns.',
            signature: thinkingSignature,
          },
          { type: 'text', text: 'Let me re-read the files.' },
          { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'b.txt' } },
        ],
      },
      // 4 — large repeated tool_result AFTER the breakpoint (compactable bloat).
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: bloat }] },
        ],
      },
      // 5 — the SAME large blob again (dedup target), also after the breakpoint.
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_2', content: [{ type: 'text', text: bloat }] },
        ],
      },
      // 6 — final instruction (recent working set).
      { role: 'user', content: 'Now summarize everything you found.' },
    ],
  };

  return { body, boundary: 2, thinkingSignature };
}

describe('Claude Code compatibility — cached prefix + thinking immutability', () => {
  it('reports the cache boundary at the last cache-anchored message', () => {
    const { body, boundary } = buildClaudeCodeBody();
    expect(adapter.cacheBoundaryIndex(body)).toBe(boundary);
  });

  it('never mutates the cached prefix or the signed thinking block, yet still compacts uncached bloat', async () => {
    const compactor = new DefaultCompactor();
    const config = cloneConfig();
    // Make the uncached bloat eligible: keep nothing "recent", low min size, both
    // safe strategies on. midSummarize stays off (no summarizer here).
    config.compaction.strategies = { elision: true, dedup: true, midSummarize: false };
    config.compaction.keepRecentToolResults = 0;
    config.compaction.minToolResultTokens = 50;
    config.compaction.protectCachedPrefix = true;
    config.compaction.relevanceProtect = false; // isolate the cache/thinking guard
    config.compaction.recoverable = false; // no store needed for this assertion

    const { body, boundary, thinkingSignature } = buildClaudeCodeBody();
    const messages = body.messages as Array<Record<string, unknown>>;

    // Byte-exact snapshots of everything that MUST survive untouched.
    const prefixSnapshots = messages
      .slice(0, boundary + 1)
      .map((m) => JSON.stringify(m));
    // The assistant turn (#3) holds the signed thinking block; snapshot the whole
    // turn AND the thinking block specifically.
    const assistantTurn = messages[3]!;
    const thinkingTurnSnapshot = JSON.stringify(assistantTurn);
    const thinkingBlock = (assistantTurn.content as Array<Record<string, unknown>>)[0]!;
    const thinkingBlockSnapshot = JSON.stringify(thinkingBlock);

    const tokensBefore = adapter.countInputTokens(body, counter);

    const result = await compactor.maybeCompact({
      body,
      adapter,
      counter,
      config,
      rollingDegradationPct: null,
      utilization: 0.99,
      force: true,
    });

    const outMessages = (result.body as { messages: Array<Record<string, unknown>> }).messages;

    // (a) Cached prefix is BYTE-IDENTICAL (every message at/before the boundary).
    for (let i = 0; i <= boundary; i++) {
      expect(JSON.stringify(outMessages[i])).toBe(prefixSnapshots[i]);
    }
    // The cached tool_result's huge text is still present verbatim (not paged out).
    expect(JSON.stringify(outMessages[boundary])).toContain('CACHED_FILE');
    expect(JSON.stringify(outMessages[boundary])).not.toContain('ctxgov: paged out');

    // (b) The signed thinking block is BYTE-IDENTICAL, signature intact.
    expect(JSON.stringify(outMessages[3])).toBe(thinkingTurnSnapshot);
    const outThinking = (outMessages[3]!.content as Array<Record<string, unknown>>)[0]!;
    expect(JSON.stringify(outThinking)).toBe(thinkingBlockSnapshot);
    expect(outThinking.type).toBe('thinking');
    expect(outThinking.signature).toBe(thinkingSignature);

    // (c) Compaction still acted on the uncached, non-thinking bloat — OR, if
    //     everything compactable were protected, it changed NOTHING (never a
    //     partial/corrupt mutation). Here the post-boundary bloat is compactable.
    if (result.changed) {
      expect(result.tokensSaved).toBeGreaterThan(0);
      expect(result.tokensAfter).toBeLessThan(tokensBefore);
      // A marker landed somewhere AFTER the boundary (the uncached region).
      const afterBoundaryJson = JSON.stringify(outMessages.slice(boundary + 1));
      expect(afterBoundaryJson).toMatch(/ctxgov: (paged out|\d+ duplicate lines elided|near-duplicate)/);
    } else {
      // The all-protected fallback: nothing changed at all.
      expect(result.tokensSaved).toBe(0);
      expect(result.applied).toEqual([]);
      expect(result.tokensAfter).toBe(tokensBefore);
    }

    // Structure intact: still an Anthropic body with the same message count.
    expect(outMessages.length).toBe(messages.length);
    expect(JSON.stringify((result.body as { system: unknown }).system)).toContain('cache_control');
  });

  it('protects the cached prefix even when it contains a duplicate of post-boundary bloat (dedup must not rewrite it)', async () => {
    // Make the CACHED tool_result hold the exact same blob as the post-boundary
    // ones. The freshest copy is uncached; dedup keeps it verbatim and would
    // normally collapse the earlier copies — but the earliest copy is in the cached
    // prefix and must be left byte-identical regardless.
    const compactor = new DefaultCompactor();
    const config = cloneConfig();
    config.compaction.strategies = { elision: false, dedup: true, midSummarize: false };
    config.compaction.keepRecentToolResults = 0;
    config.compaction.minToolResultTokens = 50;
    config.compaction.protectCachedPrefix = true;
    config.compaction.relevanceProtect = false;
    config.compaction.recoverable = false;
    config.compaction.semanticDedup = true;

    const shared = bigBlob('SHARED', 300);
    const body: Record<string, unknown> = {
      model: MODEL,
      max_tokens: 1024,
      system: 'sys',
      messages: [
        // 0 — cached copy (breakpoint here).
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't0',
              content: [{ type: 'text', text: shared }],
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
        { role: 'assistant', content: 'ok' }, // 1
        // 2 — uncached duplicate.
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: shared }] }] },
        { role: 'assistant', content: 'ok' }, // 3
        // 4 — uncached duplicate (freshest).
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: shared }] }] },
      ],
    };

    expect(adapter.cacheBoundaryIndex(body)).toBe(0);
    const cachedSnapshot = JSON.stringify((body.messages as unknown[])[0]);

    const result = await compactor.maybeCompact({
      body,
      adapter,
      counter,
      config,
      rollingDegradationPct: null,
      utilization: 0.99,
      force: true,
    });

    const outMessages = (result.body as { messages: Array<Record<string, unknown>> }).messages;
    // The cached copy is byte-identical and still holds the verbatim blob.
    expect(JSON.stringify(outMessages[0])).toBe(cachedSnapshot);
    expect(JSON.stringify(outMessages[0])).not.toContain('ctxgov:');
    expect(JSON.stringify(outMessages[0])).toContain('SHARED');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Page-fault recovery helper (pure, no network).
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal store stub exposing only getElidedBlob (what restoreElidedBlobs needs). */
class StubBlobStore {
  constructor(private readonly blobs: Record<string, string>) {}
  getElidedBlob(id: string): string | undefined {
    return this.blobs[id];
  }
}

describe('page-fault recovery helper', () => {
  it('extracts paged-out ids from elision markers', () => {
    const marker =
      '[ctxgov: paged out 1234 tokens — id=cg-ab12cd34ef. head: foo | tail: bar]';
    expect([...elidedIdsIn(marker)]).toEqual(['cg-ab12cd34ef']);
    expect([...elidedIdsIn('no id here')]).toEqual([]);
  });

  it('detects a fault when the answer complains the content was elided', () => {
    const bodyIds = new Set(['cg-deadbeef01']);
    expect(detectPageFault('Sorry, that content was elided so I cannot find it.', bodyIds)).toBe(true);
    // No fault when the body holds no paged-out ids.
    expect(detectPageFault('content was elided', new Set())).toBe(false);
    // No fault when the answer is a clean, complete reply.
    expect(detectPageFault('Here is the summary: all good.', bodyIds)).toBe(false);
  });

  it('detects a fault when the answer echoes one of our paged-out ids', () => {
    const bodyIds = new Set(['cg-deadbeef01']);
    expect(detectPageFault('I see a reference to id=cg-deadbeef01 but no content.', bodyIds)).toBe(true);
    // An unrelated id the body does not contain is NOT a fault on its own.
    expect(detectPageFault('id=cg-999999 is mentioned', bodyIds)).toBe(false);
  });

  it('restores a paged-out block in an Anthropic body when the id resolves in the store', () => {
    const originalContent = bigBlob('RESTORED_FILE', 200);
    const id = 'cg-restore0001';
    const marker =
      `[ctxgov: paged out 4321 tokens — id=${id}. head: RESTORED_FILE === | tail: dog 199.]`;

    // A compacted body whose tool_result is the elision marker.
    const compactedBody = {
      model: MODEL,
      messages: [
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: marker }],
        },
        { role: 'user', content: 'and now answer' },
      ],
    };

    // The answer signals a page fault (echoes the id).
    const ids = (() => {
      const s = new Set<string>();
      for (const ref of adapter.listToolResults(compactedBody, counter)) {
        for (const x of elidedIdsIn(ref.text)) s.add(x);
      }
      return s;
    })();
    expect(ids.has(id)).toBe(true);
    expect(detectPageFault(`The content for id=${id} was elided.`, ids)).toBe(true);

    const store = new StubBlobStore({ [id]: originalContent }) as unknown as Pick<Store, 'getElidedBlob'>;
    const restored = restoreElidedBlobs(compactedBody, adapter, counter, store);
    expect(restored).toBe(1);

    // The marker was replaced by the original content verbatim.
    const serialized = JSON.stringify(compactedBody);
    expect(serialized).toContain('RESTORED_FILE');
    expect(serialized).not.toContain('ctxgov: paged out');
    expect(serialized).not.toContain(id);
  });

  it('restores nothing when the id does not resolve in the store (keeps the marker)', () => {
    const id = 'cg-missing0001';
    const marker = `[ctxgov: paged out 10 tokens — id=${id}. head: x]`;
    const body = {
      model: MODEL,
      messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: marker }] }],
    };
    const store = new StubBlobStore({}) as unknown as Pick<Store, 'getElidedBlob'>;
    const restored = restoreElidedBlobs(body, adapter, counter, store);
    expect(restored).toBe(0);
    expect(JSON.stringify(body)).toContain(id); // marker untouched
  });
});
