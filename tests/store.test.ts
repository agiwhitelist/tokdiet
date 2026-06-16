// tests/store.test.ts — exercise the SQLite Store implementation end-to-end.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ElidedBlob, RequestEvent, ShadowEvalEvent, Store } from '../src/types.js';
import { SqliteStore, openStore } from '../src/store.js';

/** Build a RequestEvent with sane defaults, overridable per-field. */
function makeRequest(overrides: Partial<RequestEvent> = {}): RequestEvent {
  return {
    ts: 1_000,
    sessionId: 'sess-a',
    provider: 'anthropic',
    model: 'claude-opus-4',
    source: 'claude-code',
    repo: 'repo-x',
    inputTokens: 1_000,
    outputTokens: 200,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUSD: 1.0,
    compacted: false,
    tokensSaved: 0,
    costSavedUSD: 0,
    strategies: '',
    utilization: 0.5,
    qualityScore: null,
    status: 'ok',
    durationMs: 100,
    proxyOverheadMs: 0,
    ...overrides,
  };
}

/** Build a ShadowEvalEvent with sane defaults, overridable per-field. */
function makeShadow(overrides: Partial<ShadowEvalEvent> = {}): ShadowEvalEvent {
  return {
    ts: 1_000,
    sessionId: 'sess-a',
    strategy: 'elision',
    degradationPct: 1.0,
    method: 'heuristic',
    baselineTokens: 1_000,
    compactedTokens: 800,
    ...overrides,
  };
}

/** Build an ElidedBlob with sane defaults, overridable per-field. */
function makeBlob(overrides: Partial<ElidedBlob> = {}): ElidedBlob {
  return {
    id: 'blob-1',
    sessionId: 'sess-a',
    ts: 1_000,
    tokens: 42,
    content: 'the full paged-out content',
    ...overrides,
  };
}

describe('SqliteStore', () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ctxgov-store-'));
    store = openStore(dir);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('openStore returns a SqliteStore instance', () => {
    expect(store).toBeInstanceOf(SqliteStore);
  });

  it('recordRequest returns an increasing numeric rowid', () => {
    const id1 = store.recordRequest(makeRequest());
    const id2 = store.recordRequest(makeRequest());
    expect(typeof id1).toBe('number');
    expect(id2).toBeGreaterThan(id1);
  });

  it('recordShadowEval returns a numeric rowid', () => {
    const id = store.recordShadowEval(makeShadow());
    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);
  });

  it('sessionCostUSD sums only the matching session', () => {
    store.recordRequest(makeRequest({ sessionId: 'sess-a', costUSD: 1.5 }));
    store.recordRequest(makeRequest({ sessionId: 'sess-a', costUSD: 2.5 }));
    store.recordRequest(makeRequest({ sessionId: 'sess-b', costUSD: 9.0 }));
    expect(store.sessionCostUSD('sess-a')).toBeCloseTo(4.0, 10);
    expect(store.sessionCostUSD('sess-b')).toBeCloseTo(9.0, 10);
    expect(store.sessionCostUSD('missing')).toBe(0);
  });

  it('dayCostUSD includes events within [start, start+86_400_000) only', () => {
    const dayStart = 1_700_000_000_000;
    store.recordRequest(makeRequest({ ts: dayStart, costUSD: 1.0 }));
    store.recordRequest(makeRequest({ ts: dayStart + 86_400_000 - 1, costUSD: 2.0 }));
    // Boundary (exactly start + 1 day) is excluded.
    store.recordRequest(makeRequest({ ts: dayStart + 86_400_000, costUSD: 4.0 }));
    // Before the window.
    store.recordRequest(makeRequest({ ts: dayStart - 1, costUSD: 8.0 }));
    expect(store.dayCostUSD(dayStart)).toBeCloseTo(3.0, 10);
  });

  it('repoMonthCostUSD filters by repo and ts >= monthEpochStart', () => {
    const monthStart = 1_700_000_000_000;
    store.recordRequest(makeRequest({ repo: 'repo-x', ts: monthStart, costUSD: 1.0 }));
    store.recordRequest(makeRequest({ repo: 'repo-x', ts: monthStart + 5, costUSD: 2.0 }));
    store.recordRequest(makeRequest({ repo: 'repo-x', ts: monthStart - 1, costUSD: 4.0 }));
    store.recordRequest(makeRequest({ repo: 'repo-y', ts: monthStart + 5, costUSD: 8.0 }));
    expect(store.repoMonthCostUSD('repo-x', monthStart)).toBeCloseTo(3.0, 10);
    expect(store.repoMonthCostUSD('repo-y', monthStart)).toBeCloseTo(8.0, 10);
  });

  it('rollingDegradationPct returns null when there are no shadow evals', () => {
    expect(store.rollingDegradationPct(10)).toBeNull();
  });

  it('rollingDegradationPct averages the last N evals by ts DESC', () => {
    // Oldest -> newest. windowN=2 should average the two most recent (ts 30, 20).
    store.recordShadowEval(makeShadow({ ts: 10, degradationPct: 1.0 }));
    store.recordShadowEval(makeShadow({ ts: 20, degradationPct: 3.0 }));
    store.recordShadowEval(makeShadow({ ts: 30, degradationPct: 5.0 }));
    expect(store.rollingDegradationPct(2)).toBeCloseTo(4.0, 10); // (5 + 3) / 2
    expect(store.rollingDegradationPct(3)).toBeCloseTo(3.0, 10); // (1 + 3 + 5) / 3
    expect(store.rollingDegradationPct(100)).toBeCloseTo(3.0, 10);
  });

  it('recentRequests returns newest-first, respects limit, and round-trips booleans', () => {
    store.recordRequest(makeRequest({ ts: 1, costUSD: 1, compacted: false }));
    store.recordRequest(makeRequest({ ts: 2, costUSD: 2, compacted: true, strategies: 'elision' }));
    store.recordRequest(makeRequest({ ts: 3, costUSD: 3, compacted: false }));
    const recent = store.recentRequests(2);
    expect(recent).toHaveLength(2);
    expect(recent[0]!.ts).toBe(3);
    expect(recent[1]!.ts).toBe(2);
    // compacted must be a boolean, not 0/1.
    expect(recent[1]!.compacted).toBe(true);
    expect(typeof recent[0]!.compacted).toBe('boolean');
    expect(recent[1]!.strategies).toBe('elision');
  });

  it('recordShadowCost feeds summary.shadowCostUSD', () => {
    store.recordShadowCost('sess-a', 0.25);
    store.recordShadowCost('sess-b', 0.75);
    const s = store.summary();
    expect(s.shadowCostUSD).toBeCloseTo(1.0, 10);
  });

  it('summary aggregates totals, providers, sources, and strategies', () => {
    store.recordRequest(
      makeRequest({
        provider: 'anthropic',
        source: 'claude-code',
        costUSD: 2.0,
        tokensSaved: 100,
        costSavedUSD: 0.5,
        compacted: true,
        strategies: 'elision,dedup',
        qualityScore: 2.0,
      }),
    );
    store.recordRequest(
      makeRequest({
        provider: 'anthropic',
        source: 'cursor',
        costUSD: 3.0,
        tokensSaved: 50,
        costSavedUSD: 0.25,
        compacted: true,
        strategies: 'elision',
        qualityScore: 4.0,
      }),
    );
    store.recordRequest(
      makeRequest({
        provider: 'openai',
        source: 'codex',
        costUSD: 5.0,
        tokensSaved: 0,
        costSavedUSD: 0,
        compacted: false,
        strategies: '',
        qualityScore: null,
      }),
    );
    store.recordShadowCost('sess-a', 0.4);

    const s = store.summary();

    expect(s.totalCostUSD).toBeCloseTo(10.0, 10);
    expect(s.totalTokensSaved).toBe(150);
    expect(s.estSavedUSD).toBeCloseTo(0.75, 10);
    expect(s.shadowCostUSD).toBeCloseTo(0.4, 10);
    expect(s.requestCount).toBe(3);
    // avgDegradationPct = AVG of non-null qualityScore = (2 + 4) / 2 = 3.
    expect(s.avgDegradationPct).toBeCloseTo(3.0, 10);

    // byProvider
    const anthropic = s.byProvider.find((p) => p.provider === 'anthropic');
    const openai = s.byProvider.find((p) => p.provider === 'openai');
    expect(anthropic).toEqual({ provider: 'anthropic', costUSD: 5.0, requests: 2 });
    expect(openai).toEqual({ provider: 'openai', costUSD: 5.0, requests: 1 });

    // bySource
    const cursor = s.bySource.find((x) => x.source === 'cursor');
    expect(cursor).toEqual({ source: 'cursor', costUSD: 3.0, requests: 1 });

    // byStrategy: elision used twice (100+50 saved), dedup once (100 saved).
    const elision = s.byStrategy.find((x) => x.strategy === 'elision');
    const dedup = s.byStrategy.find((x) => x.strategy === 'dedup');
    expect(elision).toEqual({
      strategy: 'elision',
      uses: 2,
      tokensSaved: 150,
      avgDegradationPct: 3.0, // (2 + 4) / 2
    });
    expect(dedup).toEqual({
      strategy: 'dedup',
      uses: 1,
      tokensSaved: 100,
      avgDegradationPct: 2.0,
    });
  });

  it('updateRequestQualityScore backfills degradation so summary surfaces it', () => {
    // qualityScore is recorded null initially (matching the proxy path); the
    // shadow eval later backfills it, and summary() must then reflect it.
    const id1 = store.recordRequest(
      makeRequest({ compacted: true, strategies: 'elision', qualityScore: null }),
    );
    const id2 = store.recordRequest(
      makeRequest({ compacted: true, strategies: 'elision,dedup', qualityScore: null }),
    );

    // Before backfill: avg degradation is null (no scored rows).
    expect(store.summary().avgDegradationPct).toBeNull();

    store.updateRequestQualityScore(id1, 1.0);
    store.updateRequestQualityScore(id2, 3.0);

    const s = store.summary();
    expect(s.avgDegradationPct).toBeCloseTo(2.0, 10); // (1 + 3) / 2
    const elision = s.byStrategy.find((x) => x.strategy === 'elision');
    const dedup = s.byStrategy.find((x) => x.strategy === 'dedup');
    expect(elision?.avgDegradationPct).toBeCloseTo(2.0, 10); // both rows used elision
    expect(dedup?.avgDegradationPct).toBeCloseTo(3.0, 10); // only the second row used dedup
  });

  it('updateRequestQualityScore ignores a non-finite id without throwing', () => {
    expect(() => store.updateRequestQualityScore(Number.NaN, 5)).not.toThrow();
  });

  it('summary respects the since filter', () => {
    store.recordRequest(makeRequest({ ts: 100, costUSD: 1.0 }));
    store.recordRequest(makeRequest({ ts: 200, costUSD: 2.0 }));
    store.recordRequest(makeRequest({ ts: 300, costUSD: 4.0 }));
    const s = store.summary({ since: 200 });
    expect(s.totalCostUSD).toBeCloseTo(6.0, 10);
    expect(s.requestCount).toBe(2);
  });

  it('summary on an empty store returns zeroed aggregates and null avg', () => {
    const s = store.summary();
    expect(s.totalCostUSD).toBe(0);
    expect(s.totalTokensSaved).toBe(0);
    expect(s.estSavedUSD).toBe(0);
    expect(s.shadowCostUSD).toBe(0);
    expect(s.requestCount).toBe(0);
    expect(s.avgDegradationPct).toBeNull();
    expect(s.byProvider).toEqual([]);
    expect(s.bySource).toEqual([]);
    expect(s.byStrategy).toEqual([]);
  });

  it('recordElidedBlob then getElidedBlob round-trips the full content', () => {
    store.recordElidedBlob(makeBlob({ id: 'blob-x', content: 'recoverable body' }));
    expect(store.getElidedBlob('blob-x')).toBe('recoverable body');
  });

  it('getElidedBlob returns undefined for an unknown id', () => {
    expect(store.getElidedBlob('does-not-exist')).toBeUndefined();
  });

  it('recordElidedBlob with a duplicate id overwrites (INSERT OR REPLACE)', () => {
    store.recordElidedBlob(makeBlob({ id: 'dup', content: 'first' }));
    store.recordElidedBlob(makeBlob({ id: 'dup', content: 'second' }));
    expect(store.getElidedBlob('dup')).toBe('second');
  });

  it('elided blobs survive a reopen of the same dataDir', () => {
    store.recordElidedBlob(makeBlob({ id: 'persist-blob', content: 'durable' }));
    store.close();
    const reopened = openStore(dir);
    expect(reopened.getElidedBlob('persist-blob')).toBe('durable');
    expect(reopened.getElidedBlob('missing')).toBeUndefined();
    reopened.close();
    // Re-open for the afterEach close() to operate on a live db.
    store = openStore(dir);
  });

  it('persists data across reopen of the same dataDir', () => {
    store.recordRequest(makeRequest({ sessionId: 'persist', costUSD: 7.0 }));
    store.close();
    const reopened = openStore(dir);
    expect(reopened.sessionCostUSD('persist')).toBeCloseTo(7.0, 10);
    reopened.close();
    // Re-open for the afterEach close() to operate on a live db.
    store = openStore(dir);
  });

  it('recordRequest persists proxyOverheadMs and recentRequests maps it back', () => {
    store.recordRequest(makeRequest({ ts: 1, proxyOverheadMs: 17 }));
    const recent = store.recentRequests(1);
    expect(recent[0]!.proxyOverheadMs).toBe(17);
  });

  it('proxyOverheadMs defaults to 0 and survives a reopen', () => {
    // makeRequest defaults proxyOverheadMs to 0; confirm it round-trips as 0.
    store.recordRequest(makeRequest({ ts: 5, sessionId: 'sess-overhead' }));
    store.close();
    const reopened = openStore(dir);
    expect(reopened.recentRequests(1)[0]!.proxyOverheadMs).toBe(0);
    reopened.close();
    // Re-open for the afterEach close() to operate on a live db.
    store = openStore(dir);
  });

  it('repoStrategyDegradation returns undefined before any observation', () => {
    const s = store as SqliteStore;
    expect(s.repoStrategyDegradation('repo-x', 'elision')).toBeUndefined();
  });

  it('recordRepoStrategyDegradation maintains a running average per (repo, strategy)', () => {
    const s = store as SqliteStore;
    // First observation seeds the average.
    s.recordRepoStrategyDegradation('repo-x', 'elision', 2.0);
    expect(s.repoStrategyDegradation('repo-x', 'elision')).toEqual({ avgPct: 2.0, samples: 1 });

    // Second observation folds into the mean: (2 + 4) / 2 = 3.
    s.recordRepoStrategyDegradation('repo-x', 'elision', 4.0);
    expect(s.repoStrategyDegradation('repo-x', 'elision')).toEqual({ avgPct: 3.0, samples: 2 });

    // Third observation: (2 + 4 + 6) / 3 = 4.
    s.recordRepoStrategyDegradation('repo-x', 'elision', 6.0);
    const after3 = s.repoStrategyDegradation('repo-x', 'elision')!;
    expect(after3.samples).toBe(3);
    expect(after3.avgPct).toBeCloseTo(4.0, 10);

    // A different strategy is tracked independently.
    s.recordRepoStrategyDegradation('repo-x', 'dedup', 10.0);
    expect(s.repoStrategyDegradation('repo-x', 'dedup')).toEqual({ avgPct: 10.0, samples: 1 });
    // The elision running average is unaffected.
    expect(s.repoStrategyDegradation('repo-x', 'elision')!.samples).toBe(3);

    // A different repo is tracked independently too.
    expect(s.repoStrategyDegradation('repo-y', 'elision')).toBeUndefined();
  });

  it('recordRepoStrategyDegradation ignores a non-finite pct without throwing', () => {
    const s = store as SqliteStore;
    expect(() => s.recordRepoStrategyDegradation('repo-x', 'elision', Number.NaN)).not.toThrow();
    expect(s.repoStrategyDegradation('repo-x', 'elision')).toBeUndefined();
  });

  it('repo_strategy_degradation running average survives a reopen', () => {
    const s = store as SqliteStore;
    s.recordRepoStrategyDegradation('repo-persist', 'elision', 2.0);
    s.recordRepoStrategyDegradation('repo-persist', 'elision', 4.0);
    store.close();
    const reopened = openStore(dir) as SqliteStore;
    expect(reopened.repoStrategyDegradation('repo-persist', 'elision')).toEqual({
      avgPct: 3.0,
      samples: 2,
    });
    reopened.close();
    // Re-open for the afterEach close() to operate on a live db.
    store = openStore(dir);
  });
});
