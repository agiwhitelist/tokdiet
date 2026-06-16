// tests/quality.test.ts — quality guard: similarity heuristics, rolling average, safe-mode tripping.
import { describe, it, expect } from 'vitest';
import {
  heuristicDegradation,
  heuristicJudge,
  makeLlmJudge,
} from '../src/quality/similarity.js';
import { RollingAverage } from '../src/quality/ledger.js';
import { DefaultQualityGuard } from '../src/quality/guard.js';
import type {
  EventBus,
  GovernorConfig,
  GovernorEvent,
  JudgeFn,
  ReportSummary,
  RequestEvent,
  ShadowEvalEvent,
  Store,
} from '../src/types.js';
import { DEFAULT_CONFIG } from '../src/config.js';

// ─────────────────────────────────────────────────────────────────────────────
// similarity
// ─────────────────────────────────────────────────────────────────────────────

describe('heuristicDegradation', () => {
  it('returns 0 for identical strings', () => {
    expect(heuristicDegradation('abc', 'abc')).toBe(0);
    expect(heuristicDegradation('the quick brown fox', 'the quick brown fox')).toBe(0);
  });

  it('returns 0 (or near 0) for two empty strings', () => {
    expect(heuristicDegradation('', '')).toBeLessThanOrEqual(1);
  });

  it('returns high degradation for empty-vs-nonempty', () => {
    expect(heuristicDegradation('', 'some substantial text here')).toBeGreaterThan(50);
    expect(heuristicDegradation('some substantial text here', '')).toBeGreaterThan(50);
  });

  it('returns high degradation for very different strings', () => {
    const a = 'The mitochondria is the powerhouse of the cell.';
    const b = 'Quarterly revenue grew 12 percent in the northeast region.';
    expect(heuristicDegradation(a, b)).toBeGreaterThan(50);
  });

  it('returns low degradation for nearly-identical strings', () => {
    const a = 'The quick brown fox jumps over the lazy dog.';
    const b = 'The quick brown fox jumps over the lazy dog!';
    expect(heuristicDegradation(a, b)).toBeLessThan(20);
  });

  it('clamps to the 0..100 range', () => {
    const d = heuristicDegradation('a'.repeat(1000), 'z'.repeat(3));
    expect(d).toBeGreaterThanOrEqual(0);
    expect(d).toBeLessThanOrEqual(100);
  });
});

describe('heuristicJudge', () => {
  it('matches heuristicDegradation', async () => {
    const a = 'hello world';
    const b = 'goodbye moon';
    expect(await heuristicJudge(a, b)).toBe(heuristicDegradation(a, b));
  });
});

describe('makeLlmJudge', () => {
  it('parses strict JSON {"degradation": N}', async () => {
    const judge = makeLlmJudge(async () => '{"degradation": 12}');
    expect(await judge('a', 'b')).toBe(12);
  });

  it('parses JSON wrapped in prose / code fences', async () => {
    const judge = makeLlmJudge(
      async () => 'Sure, here is my rating:\n```json\n{"degradation": 37.5}\n```\nDone.',
    );
    expect(await judge('a', 'b')).toBe(37.5);
  });

  it('prefers the degradation field over other numbers in the JSON', async () => {
    const judge = makeLlmJudge(async () => '{"confidence": 99, "degradation": 8}');
    expect(await judge('a', 'b')).toBe(8);
  });

  it('parses a degradation field given as a numeric string', async () => {
    const judge = makeLlmJudge(async () => '{"degradation": "23"}');
    expect(await judge('a', 'b')).toBe(23);
  });

  it('clamps an out-of-range JSON degradation', async () => {
    const judge = makeLlmJudge(async () => '{"degradation": 250}');
    expect(await judge('a', 'b')).toBe(100);
    const judgeLow = makeLlmJudge(async () => '{"degradation": -10}');
    expect(await judgeLow('a', 'b')).toBe(0);
  });

  it('falls back to the first number when JSON is absent', async () => {
    const judge = makeLlmJudge(async () => 'The score is 42 out of 100.');
    expect(await judge('a', 'b')).toBe(42);
  });

  it('clamps out-of-range non-JSON model scores', async () => {
    const judge = makeLlmJudge(async () => '250');
    expect(await judge('a', 'b')).toBe(100);
  });

  it('skips junk braces and finds the later valid JSON object', async () => {
    const judge = makeLlmJudge(async () => '{not json at all} then {"degradation": 5}');
    expect(await judge('a', 'b')).toBe(5);
  });

  it('falls back to heuristic on garbage (no number anywhere)', async () => {
    const judge = makeLlmJudge(async () => 'no number here at all, total garbage');
    const a = 'hello world';
    const b = 'goodbye moon';
    expect(await judge(a, b)).toBe(heuristicDegradation(a, b));
  });

  it('falls back to heuristic on throw', async () => {
    const judge = makeLlmJudge(async () => {
      throw new Error('network down');
    });
    const a = 'hello world';
    const b = 'goodbye moon';
    expect(await judge(a, b)).toBe(heuristicDegradation(a, b));
  });

  it('falls back to heuristic on unparseable output', async () => {
    const judge = makeLlmJudge(async () => 'no number here at all');
    const a = 'hello world';
    const b = 'goodbye moon';
    expect(await judge(a, b)).toBe(heuristicDegradation(a, b));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RollingAverage
// ─────────────────────────────────────────────────────────────────────────────

describe('RollingAverage', () => {
  it('returns null when empty', () => {
    const r = new RollingAverage(5);
    expect(r.avg()).toBeNull();
    expect(r.count()).toBe(0);
  });

  it('computes the mean of held samples', () => {
    const r = new RollingAverage(5);
    r.push(10);
    r.push(20);
    r.push(30);
    expect(r.avg()).toBe(20);
    expect(r.count()).toBe(3);
  });

  it('keeps only the last maxN values', () => {
    const r = new RollingAverage(3);
    r.push(1);
    r.push(2);
    r.push(3);
    r.push(4); // evicts 1
    expect(r.count()).toBe(3);
    expect(r.avg()).toBeCloseTo((2 + 3 + 4) / 3, 10);
  });

  it('ignores non-finite samples', () => {
    const r = new RollingAverage(5);
    r.push(NaN);
    r.push(Infinity);
    expect(r.avg()).toBeNull();
    expect(r.count()).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DefaultQualityGuard
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal in-memory Store stub implementing only the methods the guard touches. */
class StubStore implements Store {
  shadowEvals: ShadowEvalEvent[] = [];
  seedValue: number | null = null;
  qualityScoreUpdates: Array<{ id: number; pct: number }> = [];

  recordRequest(_e: RequestEvent): number {
    return 0;
  }
  recordShadowEval(e: ShadowEvalEvent): number {
    this.shadowEvals.push(e);
    return this.shadowEvals.length;
  }
  updateRequestQualityScore(requestEventId: number, degradationPct: number): void {
    this.qualityScoreUpdates.push({ id: requestEventId, pct: degradationPct });
  }
  recordShadowCost(_sessionId: string, _costUSD: number): void {}
  sessionCostUSD(_sessionId: string): number {
    return 0;
  }
  dayCostUSD(_dayEpochStart: number): number {
    return 0;
  }
  repoMonthCostUSD(_repo: string, _monthEpochStart: number): number {
    return 0;
  }
  rollingDegradationPct(_windowN: number): number | null {
    return this.seedValue;
  }
  recentRequests(_limit: number): RequestEvent[] {
    return [];
  }
  summary(_opts?: { since?: number }): ReportSummary {
    return {
      totalCostUSD: 0,
      totalTokensSaved: 0,
      estSavedUSD: 0,
      shadowCostUSD: 0,
      avgDegradationPct: null,
      requestCount: 0,
      byProvider: [],
      bySource: [],
      byStrategy: [],
    };
  }
  close(): void {}
}

/** Capturing event bus stub. */
class StubBus implements EventBus {
  events: GovernorEvent[] = [];
  emit(e: GovernorEvent): void {
    this.events.push(e);
  }
  subscribe(_fn: (e: GovernorEvent) => void): () => void {
    return () => {};
  }
}

function makeConfig(overrides: Partial<GovernorConfig> = {}): GovernorConfig {
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    qualityBudget: { ...DEFAULT_CONFIG.qualityBudget, ...(overrides.qualityBudget ?? {}) },
    shadowEval: { ...DEFAULT_CONFIG.shadowEval, ...(overrides.shadowEval ?? {}) },
  };
}

describe('DefaultQualityGuard', () => {
  it('records a shadow-eval event and emits it on the bus', async () => {
    const store = new StubStore();
    const bus = new StubBus();
    const config = makeConfig();
    const guard = new DefaultQualityGuard({ store, config, bus, judge: heuristicJudge });

    const event = await guard.evaluate({
      sessionId: 's1',
      requestEventId: 7,
      strategy: 'elision',
      baselineText: 'hello world this is the baseline answer',
      compactedText: 'hello world this is the baseline answer',
      baselineTokens: 100,
      compactedTokens: 40,
    });

    expect(store.shadowEvals).toHaveLength(1);
    expect(event.sessionId).toBe('s1');
    expect(event.requestEventId).toBe(7);
    expect(event.strategy).toBe('elision');
    expect(event.method).toBe('heuristic');
    expect(event.baselineTokens).toBe(100);
    expect(event.compactedTokens).toBe(40);
    expect(event.degradationPct).toBe(0);
    expect(event.ts).toBeGreaterThan(0);
    expect(bus.events.some((e) => e.type === 'shadow')).toBe(true);
  });

  it('backfills the measured degradation onto the originating request', async () => {
    const store = new StubStore();
    const bus = new StubBus();
    const guard = new DefaultQualityGuard({ store, config: makeConfig(), bus, judge: heuristicJudge });

    const event = await guard.evaluate({
      sessionId: 's1',
      requestEventId: 42,
      strategy: 'elision',
      baselineText: 'a thorough baseline answer with unique content',
      compactedText: 'a different answer entirely about something else',
      baselineTokens: 100,
      compactedTokens: 40,
    });

    expect(store.qualityScoreUpdates).toHaveLength(1);
    expect(store.qualityScoreUpdates[0]!.id).toBe(42);
    expect(store.qualityScoreUpdates[0]!.pct).toBe(event.degradationPct);
  });

  it('does not attempt a backfill when requestEventId is absent', async () => {
    const store = new StubStore();
    const bus = new StubBus();
    const guard = new DefaultQualityGuard({ store, config: makeConfig(), bus, judge: heuristicJudge });

    await guard.evaluate({
      sessionId: 's1',
      strategy: 'elision',
      baselineText: 'baseline',
      compactedText: 'baseline',
      baselineTokens: 10,
      compactedTokens: 5,
    });

    expect(store.qualityScoreUpdates).toHaveLength(0);
  });

  it('trips safe mode and blocks compaction after sustained high degradation over budget', async () => {
    const store = new StubStore();
    const bus = new StubBus();
    const config = makeConfig({ safeMode: true, qualityBudget: { maxDegradationPct: 2.0 } });
    const guard = new DefaultQualityGuard({ store, config, bus, judge: heuristicJudge });

    expect(guard.isCompactionAllowed()).toBe(true);
    expect(guard.currentSafeMode().enabled).toBe(false);

    // Several high-degradation evals (empty-vs-large => very high degradation).
    for (let i = 0; i < 5; i++) {
      await guard.evaluate({
        sessionId: 's1',
        strategy: 'midSummarize',
        baselineText: 'a thorough and detailed baseline answer with lots of unique content '.repeat(5),
        compactedText: '',
        baselineTokens: 200,
        compactedTokens: 0,
      });
    }

    expect(guard.currentSafeMode().enabled).toBe(true);
    expect(guard.currentSafeMode().reason).toMatch(/degradation/i);
    expect(guard.isCompactionAllowed()).toBe(false);
    expect(bus.events.some((e) => e.type === 'safe-mode')).toBe(true);
  });

  it('does not block compaction when safeMode is disabled even over budget', async () => {
    const store = new StubStore();
    const bus = new StubBus();
    const config = makeConfig({ safeMode: false, qualityBudget: { maxDegradationPct: 2.0 } });
    const guard = new DefaultQualityGuard({ store, config, bus, judge: heuristicJudge });

    for (let i = 0; i < 5; i++) {
      await guard.evaluate({
        sessionId: 's1',
        strategy: 'midSummarize',
        baselineText: 'a thorough and detailed baseline answer with lots of unique content '.repeat(5),
        compactedText: '',
        baselineTokens: 200,
        compactedTokens: 0,
      });
    }

    expect(guard.isCompactionAllowed()).toBe(true);
    expect(guard.currentSafeMode().enabled).toBe(false);
  });

  it('shouldShadowEval is false when shadow eval is disabled', () => {
    const store = new StubStore();
    const bus = new StubBus();
    const config = makeConfig({ shadowEval: { ...DEFAULT_CONFIG.shadowEval, enabled: false } });
    const guard = new DefaultQualityGuard({ store, config, bus, judge: heuristicJudge });
    expect(guard.shouldShadowEval()).toBe(false);
  });

  it('shouldShadowEval is true when enabled with sampleRate 1', () => {
    const store = new StubStore();
    const bus = new StubBus();
    const config = makeConfig({
      shadowEval: { ...DEFAULT_CONFIG.shadowEval, enabled: true, sampleRate: 1 },
    });
    const guard = new DefaultQualityGuard({ store, config, bus, judge: heuristicJudge });
    expect(guard.shouldShadowEval()).toBe(true);
  });

  it('an injected always-100 llm judge trips safe mode faster than the heuristic', async () => {
    // Identical baseline/compacted text => heuristic scores 0 (never trips).
    // An always-100 llm judge should trip safe mode on the very first eval.
    const text = 'a perfectly faithful answer with rich, unique, specific content';
    const config = makeConfig({ safeMode: true, qualityBudget: { maxDegradationPct: 2.0 } });

    const llmStore = new StubStore();
    const llmBus = new StubBus();
    const always100: JudgeFn = async () => 100;
    const llmGuard = new DefaultQualityGuard({ store: llmStore, config, bus: llmBus, judge: always100 });

    await llmGuard.evaluate({
      sessionId: 's1',
      strategy: 'elision',
      baselineText: text,
      compactedText: text,
      baselineTokens: 100,
      compactedTokens: 40,
    });
    expect(llmGuard.currentSafeMode().enabled).toBe(true);
    expect(llmGuard.isCompactionAllowed()).toBe(false);

    // The heuristic, on the same identical text, scores 0 and never trips even
    // after many evals — proving the llm judge tripped strictly faster.
    const hStore = new StubStore();
    const hBus = new StubBus();
    const hGuard = new DefaultQualityGuard({ store: hStore, config, bus: hBus, judge: heuristicJudge });
    for (let i = 0; i < 10; i++) {
      await hGuard.evaluate({
        sessionId: 's1',
        strategy: 'elision',
        baselineText: text,
        compactedText: text,
        baselineTokens: 100,
        compactedTokens: 40,
      });
    }
    expect(hGuard.currentSafeMode().enabled).toBe(false);
    expect(hGuard.isCompactionAllowed()).toBe(true);
  });

  it('selects the heuristic judge from config when none is injected', async () => {
    const store = new StubStore();
    const bus = new StubBus();
    const config = makeConfig({ shadowEval: { ...DEFAULT_CONFIG.shadowEval, judge: 'heuristic' } });
    // No `judge` passed — back-compatible optional. Must still construct and run.
    const guard = new DefaultQualityGuard({ store, config, bus });
    const event = await guard.evaluate({
      sessionId: 's1',
      strategy: 'elision',
      baselineText: 'hello world',
      compactedText: 'hello world',
      baselineTokens: 10,
      compactedTokens: 5,
    });
    expect(event.degradationPct).toBe(0);
  });

  it('falls back to heuristic with a one-time note when judge="embedding"', async () => {
    const store = new StubStore();
    const bus = new StubBus();
    const config = makeConfig({ shadowEval: { ...DEFAULT_CONFIG.shadowEval, judge: 'embedding' } });
    const guard = new DefaultQualityGuard({ store, config, bus });
    const note = bus.events.find(
      (e) => e.type === 'log' && /embedding/i.test(e.payload.message),
    );
    expect(note).toBeDefined();
    // Behaves as the heuristic: identical text scores 0.
    const event = await guard.evaluate({
      sessionId: 's1',
      strategy: 'elision',
      baselineText: 'same text',
      compactedText: 'same text',
      baselineTokens: 10,
      compactedTokens: 5,
    });
    expect(event.degradationPct).toBe(0);
  });

  it('falls back to heuristic with a one-time note when judge="llm" but none injected', () => {
    const store = new StubStore();
    const bus = new StubBus();
    const config = makeConfig({ shadowEval: { ...DEFAULT_CONFIG.shadowEval, judge: 'llm' } });
    new DefaultQualityGuard({ store, config, bus });
    const note = bus.events.find(
      (e) => e.type === 'log' && /llm/i.test(e.payload.message),
    );
    expect(note).toBeDefined();
  });

  it('seeds per-strategy backoff from repoSeed so a known-bad strategy is gated immediately', () => {
    const store = new StubStore();
    const bus = new StubBus();
    const config = makeConfig({ safeMode: true, qualityBudget: { maxDegradationPct: 5.0 } });
    const guard = new DefaultQualityGuard({
      store,
      config,
      bus,
      repo: 'repoA',
      repoSeed: (strategy) =>
        strategy === 'midSummarize' ? { avgPct: 80, samples: 12 } : undefined,
    });
    // The seeded strategy is over budget and must be disallowed from the start.
    expect(guard.isStrategyAllowed('midSummarize')).toBe(false);
    // An unseeded strategy stays allowed (allow-by-default).
    expect(guard.isStrategyAllowed('elision')).toBe(true);
  });

  it('ignores a repoSeed with zero samples', () => {
    const store = new StubStore();
    const bus = new StubBus();
    const config = makeConfig({ safeMode: true, qualityBudget: { maxDegradationPct: 5.0 } });
    const guard = new DefaultQualityGuard({
      store,
      config,
      bus,
      repoSeed: () => ({ avgPct: 99, samples: 0 }),
    });
    expect(guard.isStrategyAllowed('midSummarize')).toBe(true);
  });

  it('survives a throwing repoSeed accessor', () => {
    const store = new StubStore();
    const bus = new StubBus();
    const config = makeConfig({ safeMode: true });
    expect(
      () =>
        new DefaultQualityGuard({
          store,
          config,
          bus,
          repoSeed: () => {
            throw new Error('db unavailable');
          },
        }),
    ).not.toThrow();
  });

  it('calls persistRepo for each named strategy after evaluate', async () => {
    const store = new StubStore();
    const bus = new StubBus();
    const config = makeConfig();
    const persisted: Array<{ strategy: string; pct: number }> = [];
    const guard = new DefaultQualityGuard({
      store,
      config,
      bus,
      repo: 'repoA',
      persistRepo: (strategy, pct) => persisted.push({ strategy, pct }),
    });
    const event = await guard.evaluate({
      sessionId: 's1',
      strategy: 'dedup,elision',
      baselineText: 'totally different baseline text content here',
      compactedText: 'something else entirely unrelated to the above',
      baselineTokens: 100,
      compactedTokens: 40,
    });
    expect(persisted.map((p) => p.strategy).sort()).toEqual(['dedup', 'elision']);
    for (const p of persisted) expect(p.pct).toBe(event.degradationPct);
  });

  it('does not break the request path when persistRepo throws', async () => {
    const store = new StubStore();
    const bus = new StubBus();
    const guard = new DefaultQualityGuard({
      store,
      config: makeConfig(),
      bus,
      persistRepo: () => {
        throw new Error('write failed');
      },
    });
    await expect(
      guard.evaluate({
        sessionId: 's1',
        strategy: 'elision',
        baselineText: 'baseline',
        compactedText: 'baseline',
        baselineTokens: 10,
        compactedTokens: 5,
      }),
    ).resolves.toBeDefined();
  });
});
