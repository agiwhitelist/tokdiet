import { describe, it, expect } from 'vitest';
import { formatReport, toCSV, renderTerminalReport } from '../src/report.js';
import type { ReportSummary, RequestEvent, Store } from '../src/types.js';

function makeSummary(overrides: Partial<ReportSummary> = {}): ReportSummary {
  return {
    totalCostUSD: 12.3456,
    totalTokensSaved: 4200,
    estSavedUSD: 0.0123,
    shadowCostUSD: 0.5,
    avgDegradationPct: 0.42,
    requestCount: 7,
    byProvider: [
      { provider: 'anthropic', costUSD: 10.2, requests: 5 },
      { provider: 'openai', costUSD: 2.1456, requests: 2 },
    ],
    bySource: [
      { source: 'claude-code', costUSD: 9.0, requests: 4 },
      { source: 'cursor', costUSD: 3.3456, requests: 3 },
    ],
    byStrategy: [
      { strategy: 'elision', uses: 3, tokensSaved: 3000, avgDegradationPct: 0.5 },
      { strategy: 'dedup', uses: 1, tokensSaved: 1200, avgDegradationPct: null },
    ],
    ...overrides,
  };
}

function makeEvent(overrides: Partial<RequestEvent> = {}): RequestEvent {
  return {
    id: 1,
    ts: 1700000000000,
    sessionId: 'sess-1',
    provider: 'anthropic',
    model: 'claude-opus-4',
    source: 'claude-code',
    repo: 'context-governor',
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUSD: 0.0123,
    compacted: true,
    tokensSaved: 200,
    costSavedUSD: 0.0001,
    strategies: 'elision,dedup',
    utilization: 0.55,
    qualityScore: 0.42,
    status: 'ok',
    durationMs: 1234,
    ...overrides,
  };
}

describe('formatReport', () => {
  it('returns a string with headline totals and section headers', () => {
    const out = formatReport(makeSummary());
    expect(typeof out).toBe('string');
    // Total cost ($1+ => 2dp).
    expect(out).toContain('$12.35');
    // Section headers.
    expect(out).toContain('By provider');
    expect(out).toContain('By source');
    expect(out).toContain('Strategy leaderboard');
    // Degradation rendered as percent.
    expect(out).toContain('0.42%');
    // Row content present.
    expect(out).toContain('anthropic');
    expect(out).toContain('claude-code');
    expect(out).toContain('elision');
  });

  it('formats sub-$1 amounts with 4 decimal places', () => {
    const out = formatReport(makeSummary({ totalCostUSD: 0.0123 }));
    expect(out).toContain('$0.0123');
  });

  it('renders n/a when avg degradation is null', () => {
    const out = formatReport(makeSummary({ avgDegradationPct: null }));
    expect(out).toContain('n/a');
  });

  it('does not throw on empty arrays and shows no-data placeholders', () => {
    const empty: ReportSummary = {
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
    let out = '';
    expect(() => {
      out = formatReport(empty);
    }).not.toThrow();
    expect(out).toContain('By provider');
    expect(out).toContain('(no data)');
    expect(out).toContain('$0.0000');
  });

  it('emits ANSI escape codes when color is enabled', () => {
    const plain = formatReport(makeSummary(), { color: false });
    const colored = formatReport(makeSummary(), { color: true });
    expect(plain).not.toContain('\x1b[');
    expect(colored).toContain('\x1b[');
  });
});

describe('toCSV', () => {
  it('produces a header row plus one row per event', () => {
    const rows = [makeEvent(), makeEvent({ id: 2, sessionId: 'sess-2' })];
    const csv = toCSV(rows);
    const lines = csv.split('\n');
    expect(lines.length).toBe(3); // header + 2 rows
    expect(lines[0]).toContain('sessionId');
    expect(lines[0]).toContain('costUSD');
    expect(lines[0]).toContain('status');
    expect(lines[1]).toContain('sess-1');
    expect(lines[2]).toContain('sess-2');
  });

  it('escapes commas and quotes in fields', () => {
    const csv = toCSV([makeEvent({ source: 'tool, "v2"' })]);
    const lines = csv.split('\n');
    expect(lines[1]).toContain('"tool, ""v2"""');
  });

  it('returns just the header for empty input', () => {
    const csv = toCSV([]);
    const lines = csv.split('\n');
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('sessionId');
  });
});

describe('renderTerminalReport', () => {
  it('calls store.summary and formats the result', () => {
    let receivedOpts: { since?: number } | undefined;
    const summary = makeSummary();
    const store: Store = {
      recordRequest: () => 0,
      recordShadowEval: () => 0,
      updateRequestQualityScore: () => {},
      recordShadowCost: () => {},
      sessionCostUSD: () => 0,
      dayCostUSD: () => 0,
      repoMonthCostUSD: () => 0,
      rollingDegradationPct: () => null,
      recentRequests: () => [],
      summary: (opts?: { since?: number }) => {
        receivedOpts = opts;
        return summary;
      },
      close: () => {},
    };

    const out = renderTerminalReport(store, { since: 123, color: false });
    expect(receivedOpts).toEqual({ since: 123 });
    expect(out).toContain('By provider');
    expect(out).toContain('$12.35');
  });

  it('passes undefined opts to summary when no since given', () => {
    let called = false;
    let receivedOpts: { since?: number } | undefined = { since: -1 };
    const store: Store = {
      recordRequest: () => 0,
      recordShadowEval: () => 0,
      updateRequestQualityScore: () => {},
      recordShadowCost: () => {},
      sessionCostUSD: () => 0,
      dayCostUSD: () => 0,
      repoMonthCostUSD: () => 0,
      rollingDegradationPct: () => null,
      recentRequests: () => [],
      summary: (opts?: { since?: number }) => {
        called = true;
        receivedOpts = opts;
        return makeSummary();
      },
      close: () => {},
    };

    renderTerminalReport(store);
    expect(called).toBe(true);
    expect(receivedOpts).toBeUndefined();
  });
});
