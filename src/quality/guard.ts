// src/quality/guard.ts — runtime quality guard.
//
// Shadow-evaluates a sampled fraction of compacted requests, records the
// measured degradation, maintains a rolling average, and trips "safe mode"
// (disabling further compaction) once degradation exceeds the configured
// quality budget. Runtime randomness/clock usage is intentional here.
import type {
  EventBus,
  GovernorConfig,
  JudgeFn,
  QualityGuard,
  ShadowEvalEvent,
  ShadowEvalInput,
  Store,
} from '../types.js';
import { RollingAverage } from './ledger.js';
import { heuristicJudge } from './similarity.js';

const ROLLING_WINDOW = 50;

/**
 * Strategy names we may receive a durable per-repo seed for. Used only to drive
 * seed lookups on construction; live attribution still parses whatever CSV the
 * shadow-eval reports, so an unlisted strategy is never dropped.
 */
const KNOWN_STRATEGIES = ['elision', 'dedup', 'midSummarize'] as const;

/** Per-strategy degradation prior loaded from durable storage to seed backoff. */
export interface RepoStrategySeed {
  /** Mean measured degradation pct (0..100) for this strategy in this repo. */
  avgPct: number;
  /** How many measurements that average summarizes. */
  samples: number;
}

/** Split a CSV strategy field into trimmed, non-empty strategy names. */
function parseStrategies(csv: string): string[] {
  if (typeof csv !== 'string' || csv.length === 0) return [];
  return csv
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export interface DefaultQualityGuardOptions {
  store: Store;
  config: GovernorConfig;
  bus: EventBus;
  /**
   * Judge used to score baseline-vs-compacted. OPTIONAL and back-compatible:
   * when provided it is used as-is (the proxy injects `makeLlmJudge(...)` when
   * `config.shadowEval.judge === 'llm'`). When omitted, the guard selects a
   * judge from `config.shadowEval.judge`: 'heuristic'/'embedding' => the
   * heuristic judge ('embedding' is not implemented yet and falls back to
   * heuristic with a one-time note); 'llm' with no injected judge also falls
   * back to heuristic with a one-time note (a real llm judge must be injected).
   */
  judge?: JudgeFn;
  /** Repo / working-dir identifier this guard instance is scoped to (for per-repo backoff). */
  repo?: string;
  /**
   * Optional durable seed: returns the stored per-strategy degradation prior for
   * this repo so a fresh process starts with historically-bad strategies already
   * close to their backoff threshold (the prior is pushed once as a single seed
   * sample into that strategy's rolling window).
   */
  repoSeed?: (strategy: string) => RepoStrategySeed | undefined;
  /**
   * Optional durable persistence: called after each evaluate() with the strategy
   * name and the measurement, so per-repo backoff survives restarts. Best-effort;
   * failures must never break the request path.
   */
  persistRepo?: (strategy: string, pct: number) => void;
}

/** Default {@link QualityGuard}: samples, scores, records, and enforces safe mode. */
export class DefaultQualityGuard implements QualityGuard {
  private readonly store: Store;
  private readonly config: GovernorConfig;
  private readonly bus: EventBus;
  private readonly judge: JudgeFn;
  private readonly persistRepo?: (strategy: string, pct: number) => void;
  private readonly rolling = new RollingAverage(ROLLING_WINDOW);

  /**
   * Per-strategy rolling degradation. A shadow eval's `strategy` field is a CSV
   * of the strategies applied to that request (e.g. "dedup,elision"); we
   * attribute the measured degradation to EACH named strategy so a single bad
   * strategy can be disabled without tripping the others.
   */
  private readonly perStrategy = new Map<string, RollingAverage>();

  private safeModeTripped = false;
  private safeModeReason = '';
  private notedJudgeFallback = false;

  constructor(opts: DefaultQualityGuardOptions) {
    this.store = opts.store;
    this.config = opts.config;
    this.bus = opts.bus;
    this.persistRepo = opts.persistRepo;
    this.judge = this.selectJudge(opts);

    // Seed per-strategy rolling windows from the durable per-repo prior (if a
    // seed accessor was supplied) so a fresh process resumes the backoff state
    // for strategies this repo has already measured as degrading. Each prior is
    // pushed as a single seed sample (the strategy's only sample until live
    // measurements arrive) — an accepted approximation, not a full replay.
    if (opts.repoSeed) {
      for (const name of KNOWN_STRATEGIES) {
        let seed: RepoStrategySeed | undefined;
        try {
          seed = opts.repoSeed(name);
        } catch {
          seed = undefined; // Seed accessor failure is non-fatal.
        }
        if (seed && Number.isFinite(seed.avgPct) && seed.samples > 0) {
          this.strategyAverage(name).push(seed.avgPct);
        }
      }
    }

    // Seed the rolling window with a SINGLE aggregate prior: the average of up
    // to the last ROLLING_WINDOW persisted shadow evals. This is intentionally a
    // one-sample summary, not a replay of individual measurements, so a fresh
    // process starts near the historical mean rather than at zero. The next few
    // live measurements are therefore blended with this prior (it is the only
    // sample until real ones arrive); this is an accepted approximation, not a
    // full window restore.
    try {
      const seed = this.store.rollingDegradationPct(ROLLING_WINDOW);
      if (seed !== null && Number.isFinite(seed)) this.rolling.push(seed);
    } catch {
      // Store may not support seeding yet — non-fatal.
    }
  }

  /**
   * Choose the judge. An explicitly injected judge always wins (the proxy passes
   * `makeLlmJudge(...)` when `config.shadowEval.judge === 'llm'`). Otherwise we
   * derive from config: 'heuristic' uses the heuristic judge silently;
   * 'embedding' is not implemented yet and falls back to heuristic with a
   * one-time note; 'llm' without an injected judge also falls back to heuristic
   * with a one-time note (the real llm judge must be injected by the proxy).
   */
  private selectJudge(opts: DefaultQualityGuardOptions): JudgeFn {
    if (opts.judge) return opts.judge;
    const mode = opts.config.shadowEval.judge;
    if (mode === 'embedding') {
      this.noteJudgeFallback('shadowEval.judge="embedding" is not implemented yet; using heuristic judge.');
    } else if (mode === 'llm') {
      this.noteJudgeFallback('shadowEval.judge="llm" but no llm judge was injected; using heuristic judge.');
    }
    return heuristicJudge;
  }

  /** Emit a single informational log note (deduped for the lifetime of the guard). */
  private noteJudgeFallback(message: string): void {
    if (this.notedJudgeFallback) return;
    this.notedJudgeFallback = true;
    try {
      this.bus.emit({ type: 'log', payload: { level: 'info', message } });
    } catch {
      // Logging must never break construction.
    }
  }

  /** Get-or-create the rolling-degradation window for a single strategy name. */
  private strategyAverage(name: string): RollingAverage {
    let ra = this.perStrategy.get(name);
    if (!ra) {
      ra = new RollingAverage(ROLLING_WINDOW);
      this.perStrategy.set(name, ra);
    }
    return ra;
  }

  /** Whether compaction is currently permitted (blocked only when safe mode has tripped). */
  isCompactionAllowed(): boolean {
    return !(this.config.safeMode && this.safeModeTripped);
  }

  /**
   * Per-strategy gate. A strategy is DISALLOWED only when safe mode is on AND its
   * own rolling-average degradation exceeds the configured budget. Unknown /
   * never-measured strategies are allowed (allow-by-default until we have a
   * signal that they degrade quality), and when safe mode is off everything is
   * allowed. Parsing a CSV strategy name attributes the gate to each component.
   */
  isStrategyAllowed(strategy: string): boolean {
    if (!this.config.safeMode) return true;
    const budget = this.config.qualityBudget.maxDegradationPct;
    for (const name of parseStrategies(strategy)) {
      const ra = this.perStrategy.get(name);
      if (!ra) continue;
      const avg = ra.avg();
      if (avg !== null && avg > budget) return false;
    }
    return true;
  }

  /** Whether this request should be shadow-evaluated (enabled gate + sampling). */
  shouldShadowEval(): boolean {
    const se = this.config.shadowEval;
    return se.enabled && Math.random() < se.sampleRate;
  }

  /** Score baseline vs compacted, persist the event, update rolling stats, and maybe trip safe mode. */
  async evaluate(input: ShadowEvalInput): Promise<ShadowEvalEvent> {
    let degradationPct = 0;
    try {
      degradationPct = await this.judge(input.baselineText, input.compactedText);
    } catch {
      degradationPct = 0;
    }
    if (!Number.isFinite(degradationPct)) degradationPct = 0;
    degradationPct = Math.min(100, Math.max(0, degradationPct));

    const event: ShadowEvalEvent = {
      ts: Date.now(),
      sessionId: input.sessionId,
      requestEventId: input.requestEventId,
      strategy: input.strategy,
      degradationPct,
      method: this.config.shadowEval.judge,
      baselineTokens: input.baselineTokens,
      compactedTokens: input.compactedTokens,
    };

    try {
      this.store.recordShadowEval(event);
    } catch {
      // Persistence failure must not break the request path.
    }

    // Backfill the measured degradation onto the originating request so the
    // report and dashboard (which read requests.qualityScore) surface it.
    if (input.requestEventId !== undefined) {
      try {
        this.store.updateRequestQualityScore(input.requestEventId, degradationPct);
      } catch {
        // Best-effort: never break the request path on a telemetry update.
      }
    }

    this.rolling.push(degradationPct);

    // Attribute this measurement to each strategy named in the (CSV) strategy
    // field so per-strategy safe-mode can disable a single bad strategy, and
    // persist it durably (best-effort) so per-repo backoff survives restarts.
    for (const name of parseStrategies(input.strategy)) {
      this.strategyAverage(name).push(degradationPct);
      if (this.persistRepo) {
        try {
          this.persistRepo(name, degradationPct);
        } catch {
          // Durable persistence is best-effort; never break the request path.
        }
      }
    }

    this.bus.emit({ type: 'shadow', payload: event });

    const avg = this.rolling.avg();
    if (
      this.config.safeMode &&
      !this.safeModeTripped &&
      avg !== null &&
      avg > this.config.qualityBudget.maxDegradationPct
    ) {
      this.safeModeTripped = true;
      this.safeModeReason =
        `Rolling degradation ${avg.toFixed(2)}% exceeded budget ` +
        `${this.config.qualityBudget.maxDegradationPct}%; compaction disabled.`;
      this.bus.emit({ type: 'safe-mode', payload: { enabled: true, reason: this.safeModeReason } });
    }

    return event;
  }

  /** Current safe-mode status and the reason it tripped (empty when not tripped). */
  currentSafeMode(): { enabled: boolean; reason: string } {
    return { enabled: this.safeModeTripped, reason: this.safeModeReason };
  }
}
