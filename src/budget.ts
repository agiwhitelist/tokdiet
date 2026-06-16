// src/budget.ts — budget enforcement across session, day, and repo-month scopes.
//
// Evaluates configured spend limits in a fixed precedence (session -> day ->
// repo-month). On the first exceeded budget it emits a `budget` event and
// returns the configured action; otherwise it allows the request through.
import type {
  Store,
  GovernorConfig,
  EventBus,
  OnBudgetExceeded,
} from './types.js';

const MS_PER_DAY = 86_400_000;

/** UTC midnight (start of day) for the given epoch-ms instant. */
export function dayStart(now: number): number {
  if (!Number.isFinite(now)) return 0;
  return Math.floor(now / MS_PER_DAY) * MS_PER_DAY;
}

/** UTC first-of-month (00:00:00) for the given epoch-ms instant. */
export function monthStart(now: number): number {
  if (!Number.isFinite(now)) return 0;
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/** Outcome of a budget check, with the triggering scope and its numbers. */
export interface BudgetDecision {
  action: 'allow' | 'warn' | 'compact' | 'block';
  scope: string;
  limitUSD: number;
  spentUSD: number;
}

interface BudgetEnforcerOpts {
  store: Store;
  config: GovernorConfig;
  bus: EventBus;
}

/** One scope's configured limit paired with a lazy reader for current spend. */
interface ScopeCheck {
  scope: string;
  limit: number | null;
  spent: () => number;
}

/**
 * Enforces per-session, per-day, and per-repo-month USD budgets, emitting a
 * `budget` event and returning the configured action on the first breach.
 */
export class BudgetEnforcer {
  private readonly store: Store;
  private readonly config: GovernorConfig;
  private readonly bus: EventBus;

  constructor(opts: BudgetEnforcerOpts) {
    this.store = opts.store;
    this.config = opts.config;
    this.bus = opts.bus;
  }

  /**
   * Evaluate budgets in order: session -> day -> repo-month. On the first
   * configured (non-null) budget whose spend exceeds its limit, emit a budget
   * event and return the configured action. If none are exceeded, allow.
   */
  check(sessionId: string, repo: string, now: number): BudgetDecision {
    const budgets = this.config.budgets;
    const action = normalizeAction(this.config.onBudgetExceeded);
    const sessionSpend = safeNumber(this.store.sessionCostUSD(sessionId));

    const checks: ScopeCheck[] = [
      {
        scope: 'session',
        limit: budgets.perSessionUSD,
        spent: () => sessionSpend,
      },
      {
        scope: 'day',
        limit: budgets.perDayUSD,
        spent: () => safeNumber(this.store.dayCostUSD(dayStart(now))),
      },
      {
        scope: 'repo-month',
        limit: budgets.perRepoMonthlyUSD,
        spent: () => safeNumber(this.store.repoMonthCostUSD(repo, monthStart(now))),
      },
    ];

    for (const c of checks) {
      if (c.limit == null || !Number.isFinite(c.limit)) continue;
      const spentUSD = c.spent();
      if (spentUSD > c.limit) {
        this.bus.emit({
          type: 'budget',
          payload: { scope: c.scope, limitUSD: c.limit, spentUSD, action },
        });
        return { action, scope: c.scope, limitUSD: c.limit, spentUSD };
      }
    }

    return { action: 'allow', scope: 'none', limitUSD: 0, spentUSD: sessionSpend };
  }
}

/** Coerce a possibly-malformed store value into a finite number (default 0). */
function safeNumber(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Defensively narrow the configured action to a known value (default 'warn'). */
function normalizeAction(a: OnBudgetExceeded): 'warn' | 'compact' | 'block' {
  return a === 'compact' || a === 'block' ? a : 'warn';
}
