// tests/compactor.test.ts — DefaultCompactor against the real AnthropicAdapter + DefaultTokenCounter.
import { describe, it, expect } from 'vitest';
import { DefaultCompactor, applyDedup } from '../src/compactor/index.js';
import { PIN_SENTINEL, isPinnedText } from '../src/compactor/pin.js';
import { AnthropicAdapter, OpenAIAdapter } from '../src/providers.js';
import { DefaultTokenCounter } from '../src/tokenizer.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import type { GovernorConfig } from '../src/types.js';

const adapter = new AnthropicAdapter();
const counter = new DefaultTokenCounter();
const MODEL = 'claude-sonnet-4-20260101';

/** A long blob of distinct text, big enough to clear minToolResultTokens. */
function bigText(label: string, repeat = 400): string {
  // Vary the line so chunks don't accidentally dedup against each other.
  let out = `=== ${label} ===\n`;
  for (let i = 0; i < repeat; i++) {
    out += `${label} line ${i}: the quick brown fox jumps over the lazy dog ${i}.\n`;
  }
  return out;
}

/** Build a canonical Anthropic Messages body with N large tool_result blocks. */
function buildAnthropicBody(opts: { toolResults: number } = { toolResults: 8 }): {
  model: string;
  max_tokens: number;
  system: string;
  messages: Array<Record<string, unknown>>;
} {
  const messages: Array<Record<string, unknown>> = [];

  // Opening user turn.
  messages.push({ role: 'user', content: 'Please investigate the repository and report findings.' });

  // A series of assistant tool_use + user tool_result pairs, each result large.
  for (let i = 0; i < opts.toolResults; i++) {
    const toolUseId = `toolu_${i}`;
    messages.push({
      role: 'assistant',
      content: [
        { type: 'text', text: `Reading file number ${i}.` },
        { type: 'tool_use', id: toolUseId, name: 'read_file', input: { path: `file_${i}.txt` } },
      ],
    });
    messages.push({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: [{ type: 'text', text: bigText(`FILE_${i}`) }],
        },
      ],
    });
  }

  // Final user instruction (recent working set).
  messages.push({ role: 'user', content: 'Summarize what you found.' });

  return {
    model: MODEL,
    max_tokens: 1024,
    system: 'You are a careful software engineering assistant.',
    messages,
  };
}

function cloneConfig(): GovernorConfig {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as GovernorConfig;
}

describe('pin', () => {
  it('detects the pin sentinel', () => {
    expect(isPinnedText(`keep this ${PIN_SENTINEL} forever`)).toBe(true);
    expect(isPinnedText('ordinary text')).toBe(false);
    // Robust to non-string input.
    expect(isPinnedText(undefined as unknown as string)).toBe(false);
  });
});

describe('DefaultCompactor.maybeCompact', () => {
  it('applies elision when utilization is above threshold and shrinks the body', async () => {
    const compactor = new DefaultCompactor();
    const config = cloneConfig();
    // Isolate elision for a deterministic assertion.
    config.compaction.strategies = { elision: true, dedup: false, midSummarize: false };

    const body = buildAnthropicBody({ toolResults: 8 });
    const tokensBefore = adapter.countInputTokens(body, counter);

    const result = await compactor.maybeCompact({
      body,
      adapter,
      counter,
      config,
      rollingDegradationPct: null,
      utilization: 0.95,
      force: false,
    });

    expect(result.applied).toContain('elision');
    expect(result.changed).toBe(true);
    expect(result.tokensBefore).toBe(tokensBefore);
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
    expect(result.tokensSaved).toBeGreaterThan(0);

    // Structure intact: still an Anthropic body with a messages array.
    const out = result.body as { messages: unknown[]; system: unknown };
    expect(Array.isArray(out.messages)).toBe(true);
    expect(out.messages.length).toBe(body.messages.length);
    expect(out.system).toBe('You are a careful software engineering assistant.');

    // At least one elision marker is present in the serialized body (new marker).
    expect(JSON.stringify(out)).toContain('ctxgov: paged out');
  });

  it('keeps the most-recent tool results untouched', async () => {
    const compactor = new DefaultCompactor();
    const config = cloneConfig();
    config.compaction.strategies = { elision: true, dedup: false, midSummarize: false };
    config.compaction.keepRecentToolResults = 4;

    const body = buildAnthropicBody({ toolResults: 8 });
    await compactor.maybeCompact({
      body,
      adapter,
      counter,
      config,
      rollingDegradationPct: null,
      utilization: 0.95,
      force: true,
    });

    // The remaining (kept) tool results still hold their original payload.
    const refs = adapter.listToolResults(body, counter);
    const kept = refs.slice(refs.length - config.compaction.keepRecentToolResults);
    for (const ref of kept) {
      expect(ref.text).not.toContain('ctxgov: paged out');
    }
  });

  it('returns unchanged when compaction.enabled is false', async () => {
    const compactor = new DefaultCompactor();
    const config = cloneConfig();
    config.compaction.enabled = false;

    const body = buildAnthropicBody({ toolResults: 8 });
    const before = adapter.countInputTokens(body, counter);

    const result = await compactor.maybeCompact({
      body,
      adapter,
      counter,
      config,
      rollingDegradationPct: null,
      utilization: 0.99,
      force: true,
    });

    expect(result.changed).toBe(false);
    expect(result.applied).toEqual([]);
    expect(result.tokensSaved).toBe(0);
    expect(result.tokensBefore).toBe(before);
    expect(result.tokensAfter).toBe(before);
  });

  it('returns unchanged when utilization is below threshold and force=false', async () => {
    const compactor = new DefaultCompactor();
    const config = cloneConfig();

    const body = buildAnthropicBody({ toolResults: 8 });
    const before = adapter.countInputTokens(body, counter);

    const result = await compactor.maybeCompact({
      body,
      adapter,
      counter,
      config,
      rollingDegradationPct: null,
      utilization: 0.1, // below default threshold (0.7)
      force: false,
    });

    expect(result.changed).toBe(false);
    expect(result.applied).toEqual([]);
    expect(result.tokensAfter).toBe(before);
  });

  it('restricts to elision only when rolling degradation has reached the budget', async () => {
    const compactor = new DefaultCompactor();
    const config = cloneConfig();
    // Enable all strategies; provide a summarize fn so midSummarize would otherwise run.
    config.compaction.strategies = { elision: true, dedup: true, midSummarize: true };
    config.qualityBudget.maxDegradationPct = 2.0;

    const body = buildAnthropicBody({ toolResults: 8 });
    let summarizeCalls = 0;

    const result = await compactor.maybeCompact({
      body,
      adapter,
      counter,
      config,
      rollingDegradationPct: 5.0, // over budget -> only elision allowed
      utilization: 0.95,
      force: true,
      summarize: async (_text, _max) => {
        summarizeCalls += 1;
        return 'summary';
      },
    });

    expect(summarizeCalls).toBe(0);
    expect(result.applied).not.toContain('midSummarize');
    expect(result.applied).not.toContain('dedup');
  });
});

describe('applyDedup recency protection', () => {
  it('keeps the LAST occurrence verbatim and marks earlier duplicates', () => {
    const config = cloneConfig();
    // The same large block pasted three times as plain user-message text.
    const blob = bigText('DUP', 200);
    const body = {
      model: MODEL,
      messages: [
        { role: 'user', content: blob }, // index 0 — older duplicate
        { role: 'assistant', content: 'working on it' },
        { role: 'user', content: blob }, // index 2 — older duplicate
        { role: 'assistant', content: 'still working' },
        { role: 'user', content: blob }, // index 4 — freshest copy, must be KEPT
      ],
    };

    const res = applyDedup(body, adapter, counter, config);
    expect(res.applied).toBe(true);
    // Two earlier copies replaced; the freshest one kept.
    expect(res.count).toBe(2);
    expect(res.saved).toBeGreaterThan(0);

    const msgs = body.messages as Array<{ role: string; content: string }>;
    // The most-recent copy (the active working set) is preserved verbatim.
    expect(msgs[4]!.content).toBe(blob);
    // The earlier copies are collapsed to the duplicate marker.
    expect(msgs[0]!.content).toContain('duplicate lines elided');
    expect(msgs[2]!.content).toContain('duplicate lines elided');
  });

  it('does not touch a single unique occurrence', () => {
    const config = cloneConfig();
    const body = {
      model: MODEL,
      messages: [{ role: 'user', content: bigText('SOLO', 200) }],
    };
    const res = applyDedup(body, adapter, counter, config);
    expect(res.applied).toBe(false);
    expect(res.count).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Near-duplicate (fuzzy) collapsing — gated by config.compaction.semanticDedup.
//
// Real agents re-paste a file after editing it: the second copy is HIGHLY similar
// but not byte-identical, so the exact line-run dedup leaves the bulk in place.
// The near-dup pass collapses the earlier near-copy into a diff-aware marker while
// keeping the freshest copy verbatim. It must NOT fire when semanticDedup=false,
// and must never collapse unrelated (low-Jaccard) chunks.
// ─────────────────────────────────────────────────────────────────────────────

/** A copy of `bigText` with `changes` of its body lines mutated (≈ high Jaccard). */
function bigTextWithEdits(label: string, repeat: number, changes: number): string {
  let out = `=== ${label} ===\n`;
  for (let i = 0; i < repeat; i++) {
    if (i < changes) {
      // A handful of lines are edited so the chunk differs but stays near-identical.
      out += `${label} line ${i}: the swift red fox vaults across the sleepy hound ${i}.\n`;
    } else {
      out += `${label} line ${i}: the quick brown fox jumps over the lazy dog ${i}.\n`;
    }
  }
  return out;
}

describe('applyDedup near-duplicate collapsing (semanticDedup)', () => {
  it('collapses a near-dup (Jaccard ~0.9, 2 changed lines), keeps freshest verbatim', () => {
    const config = cloneConfig();
    config.compaction.semanticDedup = true;

    const original = bigText('NEARDUP', 200); // pristine copy
    const edited = bigTextWithEdits('NEARDUP', 200, 2); // same file, 2 lines changed
    const body = {
      model: MODEL,
      messages: [
        { role: 'user', content: original }, // index 0 — older near-dup
        { role: 'assistant', content: 'editing the file' },
        { role: 'user', content: edited }, // index 2 — freshest copy, must be KEPT
      ],
    };

    const beforeTokens = adapter.countInputTokens(body, counter);
    const res = applyDedup(body, adapter, counter, config);

    expect(res.applied).toBe(true);
    expect(res.count).toBe(1);
    expect(res.saved).toBeGreaterThan(0);

    const msgs = body.messages as Array<{ role: string; content: string }>;
    // Freshest copy preserved verbatim.
    expect(msgs[2]!.content).toBe(edited);
    // Earlier near-dup replaced by the loss-aware near-dup marker (not the exact one).
    expect(msgs[0]!.content).toContain('near-duplicate of a later copy');
    expect(msgs[0]!.content).toMatch(/lines? differ/);
    expect(msgs[0]!.content).not.toBe(original);

    // Tokens actually drop.
    const afterTokens = adapter.countInputTokens(body, counter);
    expect(afterTokens).toBeLessThan(beforeTokens);
  });

  it('does NOT fire when semanticDedup is false (only exact dedup runs)', () => {
    const config = cloneConfig();
    config.compaction.semanticDedup = false;

    const original = bigText('NEARDUP', 200);
    const edited = bigTextWithEdits('NEARDUP', 200, 2);
    const body = {
      model: MODEL,
      messages: [
        { role: 'user', content: original },
        { role: 'assistant', content: 'editing the file' },
        { role: 'user', content: edited },
      ],
    };

    const res = applyDedup(body, adapter, counter, config);

    const msgs = body.messages as Array<{ role: string; content: string }>;
    // No near-dup marker anywhere — the fuzzy pass is off.
    expect(JSON.stringify(body)).not.toContain('near-duplicate of a later copy');
    // The freshest copy is always untouched.
    expect(msgs[2]!.content).toBe(edited);

    // Whatever the exact pass does, it must NOT have produced a near-dup collapse.
    // (Exact line-run dedup may still collapse the shared identical lines, keeping
    // the changed wrapper — but never the near-dup marker.)
    if (res.applied) {
      expect(msgs[0]!.content).not.toContain('near-duplicate of a later copy');
    }
  });

  it('preserves the exact line-run dedup on byte-identical chunks (semanticDedup=true)', () => {
    const config = cloneConfig();
    config.compaction.semanticDedup = true;

    // Three byte-identical copies — Jaccard 1.0 but 0 lines differ, so the near-dup
    // pass must DEFER to the loss-free exact pass (keep-last verbatim, exact marker).
    const blob = bigText('IDENT', 200);
    const body = {
      model: MODEL,
      messages: [
        { role: 'user', content: blob },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: blob },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: blob },
      ],
    };

    const res = applyDedup(body, adapter, counter, config);
    expect(res.applied).toBe(true);
    expect(res.count).toBe(2);

    const msgs = body.messages as Array<{ role: string; content: string }>;
    expect(msgs[4]!.content).toBe(blob); // freshest kept verbatim
    // Earlier copies collapsed by the EXACT pass, not the near-dup pass.
    expect(msgs[0]!.content).toContain('duplicate lines elided');
    expect(msgs[0]!.content).not.toContain('near-duplicate of a later copy');
    expect(msgs[2]!.content).toContain('duplicate lines elided');
  });

  it('never collapses unrelated (low-Jaccard) chunks', () => {
    const config = cloneConfig();
    config.compaction.semanticDedup = true;

    // Two completely different files — Jaccard well below threshold.
    const body = {
      model: MODEL,
      messages: [
        { role: 'user', content: bigText('ALPHA', 200) },
        { role: 'assistant', content: 'next file' },
        { role: 'user', content: bigText('OMEGA', 200) },
      ],
    };

    const res = applyDedup(body, adapter, counter, config);
    expect(res.applied).toBe(false);
    expect(res.count).toBe(0);
    expect(JSON.stringify(body)).not.toContain('near-duplicate of a later copy');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Regression: dedup must fire on an OpenAI body with the SAME big block 4x.
//
// This is the shape the real MiniMax-M3 A/B benchmark used, where dedup fired
// 0/5. Root cause was pipeline ordering: elision rewrote each duplicate into a
// DISTINCT marker before dedup ran, so dedup saw no byte-identical blocks. The
// fix runs dedup BEFORE elision and skips ctxgov markers. We assert dedup fires,
// collapses 3 of the 4 copies (keeping the freshest), and that the full pipeline
// drops tokens with 'dedup' among the applied strategies.
// ─────────────────────────────────────────────────────────────────────────────
const openaiAdapter = new OpenAIAdapter();
const OPENAI_MODEL = 'minimax-m3';

/** Build an OpenAI chat body with the SAME big block repeated `copies` times. */
function buildOpenAiDupBody(blob: string, copies: number): {
  model: string;
  messages: Array<Record<string, unknown>>;
} {
  const messages: Array<Record<string, unknown>> = [
    { role: 'system', content: 'You are a careful assistant.' },
    { role: 'user', content: 'Investigate the project and report.' },
  ];
  for (let i = 0; i < copies; i++) {
    // The assistant "reads" the file, then a tool result re-pastes the SAME blob.
    messages.push({ role: 'assistant', content: `Reading the project file (attempt ${i}).` });
    messages.push({ role: 'tool', tool_call_id: `call_${i}`, content: blob });
  }
  messages.push({ role: 'user', content: 'Now summarize the file.' });
  return { model: OPENAI_MODEL, messages };
}

describe('applyDedup on OpenAI bodies (benchmark-shape regression)', () => {
  it('collapses a big block repeated 4x to one kept copy and drops tokens', () => {
    const config = cloneConfig();
    const blob = bigText('REPEATED_FILE', 200);
    const body = buildOpenAiDupBody(blob, 4);

    const tokensBefore = openaiAdapter.countInputTokens(body, counter);
    const res = applyDedup(body, openaiAdapter, counter, config);

    expect(res.applied).toBe(true);
    // 4 identical copies -> keep the LAST, replace the 3 earlier ones.
    expect(res.count).toBe(3);
    expect(res.saved).toBeGreaterThan(0);

    const tokensAfter = openaiAdapter.countInputTokens(body, counter);
    expect(tokensAfter).toBeLessThan(tokensBefore);

    // Verify the FRESHEST copy is kept verbatim and the earlier ones are markers.
    const toolMsgs = (body.messages as Array<{ role: string; content: unknown }>)
      .filter((m) => m.role === 'tool');
    expect(toolMsgs).toHaveLength(4);
    expect(toolMsgs[3]!.content).toBe(blob); // freshest kept verbatim
    for (let i = 0; i < 3; i++) {
      expect(String(toolMsgs[i]!.content)).toContain('duplicate lines elided');
    }
  });

  it('full pipeline applies dedup (not just elision) and drops tokens', async () => {
    const compactor = new DefaultCompactor();
    const config = cloneConfig();
    // Enable both safe ops; disable midSummarize for determinism.
    config.compaction.strategies = { elision: true, dedup: true, midSummarize: false };

    const blob = bigText('REPEATED_FILE', 200);
    const body = buildOpenAiDupBody(blob, 4);
    const tokensBefore = openaiAdapter.countInputTokens(body, counter);

    const result = await compactor.maybeCompact({
      body,
      adapter: openaiAdapter,
      counter,
      config,
      rollingDegradationPct: null,
      utilization: 0.95,
      force: true,
    });

    expect(result.applied).toContain('dedup');
    expect(result.changed).toBe(true);
    expect(result.tokensAfter).toBeLessThan(tokensBefore);
    expect(result.tokensSaved).toBeGreaterThan(0);
  });
});
