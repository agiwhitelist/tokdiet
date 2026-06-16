// tests/budget.test.ts — unit tests for budget period boundaries and enforcement.
import { describe, it, expect, vi } from 'vitest';
import { dayStart, monthStart, BudgetEnforcer } from '../src/budget.js';
import type {
  Store,
  GovernorConfig,
  EventBus,
  GovernorEvent,
  RequestEvent,
  ShadowEvalEvent,
  ReportSummary,
  OnBudgetExceeded,
  BudgetConfig,
} from '../src/types.js';

const MS_PER_DAY = 86_400_000;

/** A controllable Store stub: only the cost readers matter for budget tests. */
function makeStore(costs: {
  session?: number;
  day?: number;
  repoMonth?: number;
}): Store {
  return {
    recordRequest: (_e: RequestEvent) => 0,
    recordShadowEval: (_e: ShadowEvalEvent) => 0,
    updateRequestQualityScore: (_id: number, _pct: number) => {},
    recordShadowCost: (_sessionId: string, _costUSD: number) => {},
    sessionCostUSD: (_sessionId: string) => costs.session ?? 0,
    dayCostUSD: (_dayEpochStart: number) => costs.day ?? 0,
    repoMonthCostUSD: (_repo: string, _monthEpochStart: number) => costs.repoMonth ?? 0,
    rollingDegradationPct: (_windowN: number) => null,
    recentRequests: (_limit: number) => [],
    summary: (_opts?: { since?: number }): ReportSummary => ({
      totalCostUSD: 0,
      totalTokensSaved: 0,
      estSavedUSD: 0,
      shadowCostUSD: 0,
      avgDegradationPct: null,
      requestCount: 0,
      byProvider: [],
      bySource: [],
      byStrategy: [],
    }),
    close: () => {},
  };
}

/** An EventBus stub that records emitted events for assertions. */
function makeBus(): { bus: EventBus; events: GovernorEvent[] } {
  const events: GovernorEvent[] = [];
  const bus: EventBus = {
    emit: (e: GovernorEvent) => {
      events.push(e);
    },
    subscribe: (_fn) => () => {},
  };
  return { bus, events };
}

function makeConfig(opts: {
  onBudgetExceeded?: OnBudgetExceeded;
  budgets?: Partial<BudgetConfig>;
}): GovernorConfig {
  return {
    proxyPort: 7787,
    dashboardPort: 7878,
    dashboardEnabled: true,
    contextWindowTokens: 'auto',
    contextUtilizationThreshold: 0.7,
    onBudgetExceeded: opts.onBudgetExceeded ?? 'warn',
    budgets: {
      perSessionUSD: opts.budgets?.perSessionUSD ?? null,
      perDayUSD: opts.budgets?.perDayUSD ?? null,
      perRepoMonthlyUSD: opts.budgets?.perRepoMonthlyUSD ?? null,
    },
    compaction: {
      enabled: true,
      strategies: { elision: true, dedup: true, midSummarize: false },
      keepRecentToolResults: 4,
      minToolResultTokens: 500,
    },
    qualityBudget: { maxDegradationPct: 2.0 },
    shadowEval: { enabled: true, sampleRate: 0.05, judge: 'heuristic', judgeModel: 'claude-haiku-4' },
    safeMode: true,
    dataDir: '/tmp/cg',
    pricingPath: null,
  };
}

describe('dayStart / monthStart', () => {
  it('dayStart returns UTC midnight (aligned to 86_400_000 ms)', () => {
    const ts = Date.UTC(2026, 5, 16, 13, 47, 22, 500); // 2026-06-16T13:47:22.5Z
    const start = dayStart(ts);
    expect(start % MS_PER_DAY).toBe(0);
    expect(start).toBe(Date.UTC(2026, 5, 16));
    expect(start).toBeLessThanOrEqual(ts);
  });

  it('dayStart is idempotent on an already-aligned instant', () => {
    const midnight = Date.UTC(2026, 0, 1);
    expect(dayStart(midnight)).toBe(midnight);
  });

  it('monthStart returns UTC first-of-month at 00:00:00', () => {
    const ts = Date.UTC(2026, 5, 16, 13, 47, 22, 500);
    const start = monthStart(ts);
    expect(start).toBe(Date.UTC(2026, 5, 1));
    expect(start % MS_PER_DAY).toBe(0);
    expect(new Date(start).getUTCDate()).toBe(1);
    expect(new Date(start).getUTCHours()).toBe(0);
    expect(start).toBeLessThanOrEqual(ts);
  });

  it('boundary instants are handled (epoch 0 and non-finite)', () => {
    expect(dayStart(0)).toBe(0);
    expect(monthStart(0)).toBe(Date.UTC(1970, 0, 1));
    expect(dayStart(Number.NaN)).toBe(0);
    expect(monthStart(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('BudgetEnforcer.check', () => {
  const now = Date.UTC(2026, 5, 16, 12, 0, 0);

  it('blocks on session budget when perSessionUSD exceeded and action=block', () => {
    const store = makeStore({ session: 7.5 });
    const { bus, events } = makeBus();
    const config = makeConfig({ onBudgetExceeded: 'block', budgets: { perSessionUSD: 5 } });
    const enforcer = new BudgetEnforcer({ store, config, bus });

    const decision = enforcer.check('sess-1', 'repo-a', now);

    expect(decision.action).toBe('block');
    expect(decision.scope).toBe('session');
    expect(decision.limitUSD).toBe(5);
    expect(decision.spentUSD).toBe(7.5);

    // Emits exactly one budget event matching the contract payload.
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: 'budget',
      payload: { scope: 'session', limitUSD: 5, spentUSD: 7.5, action: 'block' },
    });
  });

  it('allows when all configured budgets are under limit', () => {
    const store = makeStore({ session: 1.0, day: 2.0, repoMonth: 3.0 });
    const { bus, events } = makeBus();
    const config = makeConfig({
      onBudgetExceeded: 'block',
      budgets: { perSessionUSD: 5, perDayUSD: 50, perRepoMonthlyUSD: 400 },
    });
    const enforcer = new BudgetEnforcer({ store, config, bus });

    const decision = enforcer.check('sess-1', 'repo-a', now);

    expect(decision).toEqual({ action: 'allow', scope: 'none', limitUSD: 0, spentUSD: 1.0 });
    expect(events).toHaveLength(0);
  });

  it('evaluates session before day before repo-month (precedence)', () => {
    // Day budget exceeded, session under, repo-month also exceeded.
    const store = makeStore({ session: 1.0, day: 99, repoMonth: 9999 });
    const { bus, events } = makeBus();
    const config = makeConfig({
      onBudgetExceeded: 'warn',
      budgets: { perSessionUSD: 5, perDayUSD: 50, perRepoMonthlyUSD: 400 },
    });
    const enforcer = new BudgetEnforcer({ store, config, bus });

    const decision = enforcer.check('sess-1', 'repo-a', now);

    expect(decision.scope).toBe('day');
    expect(decision.action).toBe('warn');
    expect(decision.limitUSD).toBe(50);
    expect(decision.spentUSD).toBe(99);
    expect(events[0].type).toBe('budget');
    if (events[0].type === 'budget') expect(events[0].payload.scope).toBe('day');
  });

  it('skips null (unconfigured) budgets and trips the next configured one', () => {
    const store = makeStore({ session: 100, repoMonth: 500 });
    const { bus } = makeBus();
    const config = makeConfig({
      onBudgetExceeded: 'compact',
      budgets: { perSessionUSD: null, perDayUSD: null, perRepoMonthlyUSD: 400 },
    });
    const enforcer = new BudgetEnforcer({ store, config, bus });

    const decision = enforcer.check('sess-1', 'repo-a', now);

    expect(decision.scope).toBe('repo-month');
    expect(decision.action).toBe('compact');
    expect(decision.limitUSD).toBe(400);
    expect(decision.spentUSD).toBe(500);
  });

  it('treats spend exactly at the limit as allowed (strictly greater = exceeded)', () => {
    const store = makeStore({ session: 5 });
    const { bus, events } = makeBus();
    const config = makeConfig({ onBudgetExceeded: 'block', budgets: { perSessionUSD: 5 } });
    const enforcer = new BudgetEnforcer({ store, config, bus });

    const decision = enforcer.check('sess-1', 'repo-a', now);

    expect(decision.action).toBe('allow');
    expect(decision.scope).toBe('none');
    expect(events).toHaveLength(0);
  });

  it('passes the correct period starts to the store readers', () => {
    const store = makeStore({});
    const daySpy = vi.spyOn(store, 'dayCostUSD');
    const monthSpy = vi.spyOn(store, 'repoMonthCostUSD');
    const { bus } = makeBus();
    const config = makeConfig({
      onBudgetExceeded: 'warn',
      budgets: { perDayUSD: 50, perRepoMonthlyUSD: 400 },
    });
    const enforcer = new BudgetEnforcer({ store, config, bus });

    enforcer.check('sess-1', 'repo-a', now);

    expect(daySpy).toHaveBeenCalledWith(dayStart(now));
    expect(monthSpy).toHaveBeenCalledWith('repo-a', monthStart(now));
  });

  it('returns safe defaults when the store yields malformed values', () => {
    const store = makeStore({});
    // Force a malformed (NaN) session cost to verify defensive coercion.
    store.sessionCostUSD = () => Number.NaN as unknown as number;
    const { bus, events } = makeBus();
    const config = makeConfig({ onBudgetExceeded: 'block', budgets: { perSessionUSD: 5 } });
    const enforcer = new BudgetEnforcer({ store, config, bus });

    const decision = enforcer.check('sess-1', 'repo-a', now);

    expect(decision.action).toBe('allow');
    expect(decision.spentUSD).toBe(0);
    expect(events).toHaveLength(0);
  });
});
