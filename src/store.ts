// src/store.ts — SQLite-backed telemetry store (better-sqlite3).
//
// Persists every proxied RequestEvent, shadow-eval result, and shadow request
// cost, and answers the aggregate questions the budget/quality/report layers ask
// (session/day/repo cost, rolling degradation, recent requests, full summary).
//
// All queries use prepared statements with bound parameters — never string
// interpolation of values — so user-derived strings (sessionId/repo/source)
// cannot inject SQL.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type {
  ElidedBlob,
  ProviderId,
  ReportSummary,
  RequestEvent,
  ShadowEvalEvent,
  Store,
} from './types.js';

/** Row shape as stored in the `requests` table (compacted stored as 0/1). */
interface RequestRow {
  id: number;
  ts: number;
  sessionId: string;
  provider: string;
  model: string;
  source: string;
  repo: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUSD: number;
  compacted: number;
  tokensSaved: number;
  costSavedUSD: number;
  strategies: string;
  utilization: number;
  qualityScore: number | null;
  status: string;
  durationMs: number;
  proxyOverheadMs: number;
}

/** Convert a better-sqlite3 rowid (number | bigint) to a JS number. */
function toNumber(v: number | bigint): number {
  return typeof v === 'bigint' ? Number(v) : v;
}

/** Map a stored row back into a RequestEvent (0/1 -> boolean for compacted). */
function rowToRequestEvent(r: RequestRow): RequestEvent {
  return {
    id: r.id,
    ts: r.ts,
    sessionId: r.sessionId,
    provider: r.provider as ProviderId,
    model: r.model,
    source: r.source,
    repo: r.repo,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cacheReadTokens: r.cacheReadTokens,
    cacheWriteTokens: r.cacheWriteTokens,
    costUSD: r.costUSD,
    compacted: r.compacted !== 0,
    tokensSaved: r.tokensSaved,
    costSavedUSD: r.costSavedUSD,
    strategies: r.strategies,
    utilization: r.utilization,
    qualityScore: r.qualityScore,
    status: r.status as RequestEvent['status'],
    durationMs: r.durationMs,
    proxyOverheadMs: r.proxyOverheadMs,
  };
}

/**
 * SQLite implementation of {@link Store}. Schema is created on construction;
 * WAL is enabled for concurrent read durability. All statements are prepared
 * once and reused.
 */
export class SqliteStore implements Store {
  private readonly db: Database.Database;

  // Prepared statements (created once in the constructor).
  private readonly stmtInsertRequest: Database.Statement;
  private readonly stmtUpdateQualityScore: Database.Statement;
  private readonly stmtInsertShadow: Database.Statement;
  private readonly stmtInsertShadowCost: Database.Statement;
  private readonly stmtSessionCost: Database.Statement;
  private readonly stmtDayCost: Database.Statement;
  private readonly stmtRepoMonthCost: Database.Statement;
  private readonly stmtRollingDegradation: Database.Statement;
  private readonly stmtRecent: Database.Statement;
  private readonly stmtInsertElidedBlob: Database.Statement;
  private readonly stmtGetElidedBlob: Database.Statement;
  private readonly stmtGetRepoStrategyDegradation: Database.Statement;
  private readonly stmtUpsertRepoStrategyDegradation: Database.Statement;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new Database(join(dataDir, 'data.db'));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.initSchema();

    this.stmtInsertRequest = this.db.prepare(
      `INSERT INTO requests (
         ts, sessionId, provider, model, source, repo,
         inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
         costUSD, compacted, tokensSaved, costSavedUSD, strategies,
         utilization, qualityScore, status, durationMs, proxyOverheadMs
       ) VALUES (
         @ts, @sessionId, @provider, @model, @source, @repo,
         @inputTokens, @outputTokens, @cacheReadTokens, @cacheWriteTokens,
         @costUSD, @compacted, @tokensSaved, @costSavedUSD, @strategies,
         @utilization, @qualityScore, @status, @durationMs, @proxyOverheadMs
       )`,
    );

    this.stmtUpdateQualityScore = this.db.prepare(
      `UPDATE requests SET qualityScore = @qualityScore WHERE id = @id`,
    );

    this.stmtInsertShadow = this.db.prepare(
      `INSERT INTO shadow_evals (
         ts, sessionId, requestEventId, strategy, degradationPct,
         method, baselineTokens, compactedTokens
       ) VALUES (
         @ts, @sessionId, @requestEventId, @strategy, @degradationPct,
         @method, @baselineTokens, @compactedTokens
       )`,
    );

    this.stmtInsertShadowCost = this.db.prepare(
      `INSERT INTO shadow_costs (ts, sessionId, costUSD) VALUES (?, ?, ?)`,
    );

    this.stmtSessionCost = this.db.prepare(
      `SELECT COALESCE(SUM(costUSD), 0) AS total FROM requests WHERE sessionId = ?`,
    );

    this.stmtDayCost = this.db.prepare(
      `SELECT COALESCE(SUM(costUSD), 0) AS total FROM requests
       WHERE ts >= ? AND ts < ?`,
    );

    this.stmtRepoMonthCost = this.db.prepare(
      `SELECT COALESCE(SUM(costUSD), 0) AS total FROM requests
       WHERE repo = ? AND ts >= ? AND ts < ?`,
    );

    this.stmtRollingDegradation = this.db.prepare(
      `SELECT AVG(degradationPct) AS avg FROM (
         SELECT degradationPct FROM shadow_evals ORDER BY ts DESC LIMIT ?
       )`,
    );

    this.stmtRecent = this.db.prepare(
      `SELECT * FROM requests ORDER BY ts DESC LIMIT ?`,
    );

    this.stmtInsertElidedBlob = this.db.prepare(
      `INSERT OR REPLACE INTO elided_blobs (id, sessionId, ts, tokens, content)
       VALUES (@id, @sessionId, @ts, @tokens, @content)`,
    );

    this.stmtGetElidedBlob = this.db.prepare(
      `SELECT content FROM elided_blobs WHERE id = ?`,
    );

    this.stmtGetRepoStrategyDegradation = this.db.prepare(
      `SELECT avgPct, samples FROM repo_strategy_degradation
       WHERE repo = ? AND strategy = ?`,
    );

    // Running-average upsert: on first observation insert the value; on
    // subsequent observations fold the new pct into the existing mean using the
    // stored sample count (avgPct_new = (avgPct*samples + pct) / (samples+1)).
    this.stmtUpsertRepoStrategyDegradation = this.db.prepare(
      `INSERT INTO repo_strategy_degradation (repo, strategy, avgPct, samples)
       VALUES (@repo, @strategy, @pct, 1)
       ON CONFLICT(repo, strategy) DO UPDATE SET
         avgPct  = (avgPct * samples + @pct) / (samples + 1),
         samples = samples + 1`,
    );
  }

  /** Create tables and indexes if they do not already exist. */
  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS requests (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        ts               INTEGER NOT NULL,
        sessionId        TEXT    NOT NULL,
        provider         TEXT    NOT NULL,
        model            TEXT    NOT NULL,
        source           TEXT    NOT NULL,
        repo             TEXT    NOT NULL,
        inputTokens      INTEGER NOT NULL,
        outputTokens     INTEGER NOT NULL,
        cacheReadTokens  INTEGER NOT NULL,
        cacheWriteTokens INTEGER NOT NULL,
        costUSD          REAL    NOT NULL,
        compacted        INTEGER NOT NULL,
        tokensSaved      INTEGER NOT NULL,
        costSavedUSD     REAL    NOT NULL,
        strategies       TEXT    NOT NULL,
        utilization      REAL    NOT NULL,
        qualityScore     REAL,
        status           TEXT    NOT NULL,
        durationMs       INTEGER NOT NULL,
        proxyOverheadMs  INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_requests_ts        ON requests(ts);
      CREATE INDEX IF NOT EXISTS idx_requests_sessionId ON requests(sessionId);
      CREATE INDEX IF NOT EXISTS idx_requests_repo      ON requests(repo);

      CREATE TABLE IF NOT EXISTS shadow_evals (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        ts              INTEGER NOT NULL,
        sessionId       TEXT    NOT NULL,
        requestEventId  INTEGER,
        strategy        TEXT    NOT NULL,
        degradationPct  REAL    NOT NULL,
        method          TEXT    NOT NULL,
        baselineTokens  INTEGER NOT NULL,
        compactedTokens INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_shadow_evals_ts ON shadow_evals(ts);

      CREATE TABLE IF NOT EXISTS shadow_costs (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        ts        INTEGER NOT NULL,
        sessionId TEXT    NOT NULL,
        costUSD   REAL    NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_shadow_costs_ts ON shadow_costs(ts);

      CREATE TABLE IF NOT EXISTS elided_blobs (
        id        TEXT    PRIMARY KEY,
        sessionId TEXT    NOT NULL,
        ts        INTEGER NOT NULL,
        tokens    INTEGER NOT NULL,
        content   TEXT    NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_elided_blobs_sessionId ON elided_blobs(sessionId);

      CREATE TABLE IF NOT EXISTS repo_strategy_degradation (
        repo     TEXT    NOT NULL,
        strategy TEXT    NOT NULL,
        avgPct   REAL    NOT NULL,
        samples  INTEGER NOT NULL,
        PRIMARY KEY (repo, strategy)
      );
    `);

    // Forward-compat for databases created before proxyOverheadMs existed: add
    // the column if missing. SQLite has no "ADD COLUMN IF NOT EXISTS", so run it
    // unconditionally and swallow the "duplicate column name" error it throws
    // when the column is already present (e.g. on a freshly-created schema).
    try {
      this.db.exec(
        `ALTER TABLE requests ADD COLUMN proxyOverheadMs INTEGER NOT NULL DEFAULT 0`,
      );
    } catch {
      /* column already exists — nothing to do */
    }
  }

  recordRequest(e: RequestEvent): number {
    const res = this.stmtInsertRequest.run({
      ts: e.ts,
      sessionId: e.sessionId,
      provider: e.provider,
      model: e.model,
      source: e.source,
      repo: e.repo,
      inputTokens: e.inputTokens,
      outputTokens: e.outputTokens,
      cacheReadTokens: e.cacheReadTokens,
      cacheWriteTokens: e.cacheWriteTokens,
      costUSD: e.costUSD,
      compacted: e.compacted ? 1 : 0,
      tokensSaved: e.tokensSaved,
      costSavedUSD: e.costSavedUSD,
      strategies: e.strategies,
      utilization: e.utilization,
      qualityScore: e.qualityScore,
      status: e.status,
      durationMs: e.durationMs,
      // Coerce defensively: the column is NOT NULL, so a malformed/absent value
      // must not abort the insert (fail-open). Non-finite -> 0.
      proxyOverheadMs: Number.isFinite(e.proxyOverheadMs) ? e.proxyOverheadMs : 0,
    });
    return toNumber(res.lastInsertRowid);
  }

  updateRequestQualityScore(requestEventId: number, degradationPct: number): void {
    if (!Number.isFinite(requestEventId)) return;
    this.stmtUpdateQualityScore.run({ id: requestEventId, qualityScore: degradationPct });
  }

  recordShadowEval(e: ShadowEvalEvent): number {
    const res = this.stmtInsertShadow.run({
      ts: e.ts,
      sessionId: e.sessionId,
      requestEventId: e.requestEventId ?? null,
      strategy: e.strategy,
      degradationPct: e.degradationPct,
      method: e.method,
      baselineTokens: e.baselineTokens,
      compactedTokens: e.compactedTokens,
    });
    return toNumber(res.lastInsertRowid);
  }

  recordShadowCost(sessionId: string, costUSD: number): void {
    this.stmtInsertShadowCost.run(Date.now(), sessionId, costUSD);
  }

  sessionCostUSD(sessionId: string): number {
    const row = this.stmtSessionCost.get(sessionId) as { total: number };
    return row.total;
  }

  dayCostUSD(dayEpochStart: number): number {
    const row = this.stmtDayCost.get(dayEpochStart, dayEpochStart + 86_400_000) as {
      total: number;
    };
    return row.total;
  }

  repoMonthCostUSD(repo: string, monthEpochStart: number): number {
    // Bound both ends of the UTC calendar month (mirrors dayCostUSD), so clock
    // skew or backfilled future-dated rows can't leak into "this month".
    const start = new Date(monthEpochStart);
    const nextMonthStart = Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1);
    const row = this.stmtRepoMonthCost.get(repo, monthEpochStart, nextMonthStart) as { total: number };
    return row.total;
  }

  rollingDegradationPct(windowN: number): number | null {
    const row = this.stmtRollingDegradation.get(windowN) as { avg: number | null };
    return row.avg ?? null;
  }

  recentRequests(limit: number): RequestEvent[] {
    const rows = this.stmtRecent.all(limit) as RequestRow[];
    return rows.map(rowToRequestEvent);
  }

  summary(opts?: { since?: number }): ReportSummary {
    const since = opts?.since ?? 0;

    // Top-line aggregates over the requests table.
    const totals = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(costUSD), 0)      AS totalCostUSD,
           COALESCE(SUM(tokensSaved), 0)  AS totalTokensSaved,
           COALESCE(SUM(costSavedUSD), 0) AS estSavedUSD,
           COUNT(*)                       AS requestCount,
           AVG(qualityScore)             AS avgDegradationPct
         FROM requests WHERE ts >= ?`,
      )
      .get(since) as {
      totalCostUSD: number;
      totalTokensSaved: number;
      estSavedUSD: number;
      requestCount: number;
      avgDegradationPct: number | null;
    };

    // Cost of the quality guarantee (shadow baseline requests).
    const shadow = this.db
      .prepare(
        `SELECT COALESCE(SUM(costUSD), 0) AS shadowCostUSD FROM shadow_costs WHERE ts >= ?`,
      )
      .get(since) as { shadowCostUSD: number };

    const byProvider = this.db
      .prepare(
        `SELECT provider, COALESCE(SUM(costUSD), 0) AS costUSD, COUNT(*) AS requests
         FROM requests WHERE ts >= ?
         GROUP BY provider ORDER BY costUSD DESC`,
      )
      .all(since) as Array<{ provider: string; costUSD: number; requests: number }>;

    const bySource = this.db
      .prepare(
        `SELECT source, COALESCE(SUM(costUSD), 0) AS costUSD, COUNT(*) AS requests
         FROM requests WHERE ts >= ?
         GROUP BY source ORDER BY costUSD DESC`,
      )
      .all(since) as Array<{ source: string; costUSD: number; requests: number }>;

    // byStrategy: strategies is a CSV per row; expand in JS so a request that
    // applied "elision,dedup" counts toward both strategies.
    const stratRows = this.db
      .prepare(
        `SELECT strategies, tokensSaved, qualityScore
         FROM requests WHERE ts >= ? AND strategies <> ''`,
      )
      .all(since) as Array<{
      strategies: string;
      tokensSaved: number;
      qualityScore: number | null;
    }>;

    const byStrategyMap = new Map<
      string,
      { uses: number; tokensSaved: number; qualitySum: number; qualityCount: number }
    >();
    for (const row of stratRows) {
      const strategies = row.strategies
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      for (const strategy of strategies) {
        let acc = byStrategyMap.get(strategy);
        if (!acc) {
          acc = { uses: 0, tokensSaved: 0, qualitySum: 0, qualityCount: 0 };
          byStrategyMap.set(strategy, acc);
        }
        acc.uses += 1;
        acc.tokensSaved += row.tokensSaved;
        if (row.qualityScore !== null) {
          acc.qualitySum += row.qualityScore;
          acc.qualityCount += 1;
        }
      }
    }
    const byStrategy = Array.from(byStrategyMap.entries())
      .map(([strategy, acc]) => ({
        strategy,
        uses: acc.uses,
        tokensSaved: acc.tokensSaved,
        avgDegradationPct: acc.qualityCount > 0 ? acc.qualitySum / acc.qualityCount : null,
      }))
      .sort((a, b) => b.tokensSaved - a.tokensSaved);

    return {
      totalCostUSD: totals.totalCostUSD,
      totalTokensSaved: totals.totalTokensSaved,
      estSavedUSD: totals.estSavedUSD,
      shadowCostUSD: shadow.shadowCostUSD,
      avgDegradationPct: totals.avgDegradationPct ?? null,
      requestCount: totals.requestCount,
      byProvider,
      bySource,
      byStrategy,
    };
  }

  recordElidedBlob(blob: ElidedBlob): void {
    // Robust on the request path: a failed audit-trail write must never break
    // the proxied request, so swallow any storage error.
    try {
      this.stmtInsertElidedBlob.run({
        id: blob.id,
        sessionId: blob.sessionId,
        ts: blob.ts,
        tokens: blob.tokens,
        content: blob.content,
      });
    } catch {
      /* best-effort: paging-out persistence is recoverable telemetry, not critical */
    }
  }

  getElidedBlob(id: string): string | undefined {
    try {
      const row = this.stmtGetElidedBlob.get(id) as { content: string } | undefined;
      return row?.content;
    } catch {
      return undefined;
    }
  }

  /**
   * Fold a fresh per-(repo, strategy) degradation observation into a persisted
   * running average, so the quality guard can seed per-repo strategy backoff
   * across proxy restarts. Best-effort telemetry: a non-finite pct is ignored,
   * and any storage error is swallowed (must never break the request path).
   *
   * NOT part of the {@link Store} contract — an extra public method on
   * SqliteStore consumed directly by the guard.
   */
  recordRepoStrategyDegradation(repo: string, strategy: string, pct: number): void {
    if (!Number.isFinite(pct)) return;
    try {
      this.stmtUpsertRepoStrategyDegradation.run({ repo, strategy, pct });
    } catch {
      /* best-effort: adaptive backoff seed is recoverable telemetry, not critical */
    }
  }

  /**
   * Read back the persisted running average degradation for a (repo, strategy)
   * pair, or undefined if none has been recorded yet.
   *
   * NOT part of the {@link Store} contract — an extra public method on
   * SqliteStore consumed directly by the guard.
   */
  repoStrategyDegradation(
    repo: string,
    strategy: string,
  ): { avgPct: number; samples: number } | undefined {
    try {
      const row = this.stmtGetRepoStrategyDegradation.get(repo, strategy) as
        | { avgPct: number; samples: number }
        | undefined;
      return row ? { avgPct: row.avgPct, samples: row.samples } : undefined;
    } catch {
      return undefined;
    }
  }

  close(): void {
    this.db.close();
  }
}

/** Open (creating if needed) a SQLite-backed Store rooted at `dataDir`. */
export function openStore(dataDir: string): Store {
  return new SqliteStore(dataDir);
}
