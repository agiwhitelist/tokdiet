// src/report.ts — ccusage-style terminal reports + CSV export for telemetry.
//
// Renders a ReportSummary as an aligned, optionally-colored multi-line string and
// exports raw RequestEvents as CSV. No external dependencies — ANSI escapes are
// emitted manually and gated behind an explicit `color` flag (default off).
import type { ReportSummary, RequestEvent, Store } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// ANSI helpers (manual, dependency-free)
// ─────────────────────────────────────────────────────────────────────────────

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
} as const;

type AnsiKey = keyof typeof ANSI;

/** Wrap `s` in the given ANSI code when `enabled`, otherwise return it unchanged. */
function paint(s: string, code: AnsiKey, enabled: boolean): string {
  return enabled ? `${ANSI[code]}${s}${ANSI.reset}` : s;
}

// ─────────────────────────────────────────────────────────────────────────────
// Number / money formatting
// ─────────────────────────────────────────────────────────────────────────────

/** Coerce an unknown numeric field to a finite number, defaulting to 0. */
function safeNum(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

/**
 * Format a USD amount. Amounts under $1 use 4 decimal places (e.g. $0.0123);
 * $1 and above use 2 (e.g. $12.34). Always prefixed with "$".
 */
export function formatMoney(usd: number): string {
  const v = safeNum(usd);
  const abs = Math.abs(v);
  const dp = abs < 1 ? 4 : 2;
  return `$${v.toFixed(dp)}`;
}

/** Format an average degradation percent as e.g. "0.42%", or "n/a" when null. */
export function formatDegradation(pct: number | null | undefined): string {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return 'n/a';
  return `${pct.toFixed(2)}%`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Table rendering
// ─────────────────────────────────────────────────────────────────────────────

interface Column {
  /** Header label. */
  header: string;
  /** Right-align numeric columns; left-align text. */
  align: 'left' | 'right';
}

/**
 * Render an aligned monospace text table. Columns are padded to the widest cell
 * (including the header). Returns the header line, a separator, and one line per
 * row, joined by newlines.
 */
function renderTable(columns: Column[], rows: string[][], color: boolean): string {
  const widths = columns.map((col, i) => {
    let w = col.header.length;
    for (const row of rows) {
      const cell = row[i] ?? '';
      if (cell.length > w) w = cell.length;
    }
    return w;
  });

  const pad = (text: string, width: number, align: 'left' | 'right'): string =>
    align === 'right' ? text.padStart(width) : text.padEnd(width);

  const headerLine = columns
    .map((col, i) => paint(pad(col.header, widths[i], col.align), 'bold', color))
    .join('  ');

  const sepLine = paint(widths.map((w) => '─'.repeat(w)).join('  '), 'dim', color);

  const bodyLines = rows.map((row) =>
    columns.map((col, i) => pad(row[i] ?? '', widths[i], col.align)).join('  '),
  );

  return [headerLine, sepLine, ...bodyLines].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Report formatting
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Render a ReportSummary as a ccusage-style terminal report. Produces a header
 * block of headline totals followed by "By provider", "By source" and
 * "Strategy leaderboard" tables. Robust to missing/empty arrays. Pass
 * `{ color: true }` to emit ANSI escapes (default plain text).
 */
export function formatReport(summary: ReportSummary, opts: { color?: boolean } = {}): string {
  const color = opts.color === true;
  const s = summary ?? ({} as ReportSummary);

  const byProvider = Array.isArray(s.byProvider) ? s.byProvider : [];
  const bySource = Array.isArray(s.bySource) ? s.bySource : [];
  const byStrategy = Array.isArray(s.byStrategy) ? s.byStrategy : [];

  const lines: string[] = [];

  // Header.
  lines.push(paint('tokdiet — Usage Report', 'cyan', color));
  lines.push('');

  // Headline totals (pricing-free aggregates).
  const totalCost = formatMoney(safeNum(s.totalCostUSD));
  const estSaved = formatMoney(safeNum(s.estSavedUSD));
  const shadowCost = formatMoney(safeNum(s.shadowCostUSD));
  const avgDeg = formatDegradation(s.avgDegradationPct);
  const reqCount = safeNum(s.requestCount);
  const tokensSaved = safeNum(s.totalTokensSaved);

  const label = (text: string): string => paint(text, 'dim', color);
  lines.push(`${label('Requests        ')} ${reqCount}`);
  lines.push(`${label('Total cost      ')} ${paint(totalCost, 'green', color)}`);
  lines.push(`${label('Est. saved      ')} ${paint(estSaved, 'green', color)} (${tokensSaved} tokens)`);
  lines.push(`${label('Shadow cost     ')} ${paint(shadowCost, 'yellow', color)}`);
  lines.push(`${label('Avg degradation ')} ${avgDeg}`);
  lines.push('');

  // By provider.
  lines.push(paint('By provider', 'bold', color));
  if (byProvider.length === 0) {
    lines.push('  (no data)');
  } else {
    lines.push(
      renderTable(
        [
          { header: 'PROVIDER', align: 'left' },
          { header: 'COST', align: 'right' },
          { header: 'REQUESTS', align: 'right' },
        ],
        byProvider.map((r) => [
          String(r?.provider ?? ''),
          formatMoney(safeNum(r?.costUSD)),
          String(safeNum(r?.requests)),
        ]),
        color,
      ),
    );
  }
  lines.push('');

  // By source.
  lines.push(paint('By source', 'bold', color));
  if (bySource.length === 0) {
    lines.push('  (no data)');
  } else {
    lines.push(
      renderTable(
        [
          { header: 'SOURCE', align: 'left' },
          { header: 'COST', align: 'right' },
          { header: 'REQUESTS', align: 'right' },
        ],
        bySource.map((r) => [
          String(r?.source ?? ''),
          formatMoney(safeNum(r?.costUSD)),
          String(safeNum(r?.requests)),
        ]),
        color,
      ),
    );
  }
  lines.push('');

  // Strategy leaderboard.
  lines.push(paint('Strategy leaderboard', 'bold', color));
  if (byStrategy.length === 0) {
    lines.push('  (no data)');
  } else {
    lines.push(
      renderTable(
        [
          { header: 'STRATEGY', align: 'left' },
          { header: 'USES', align: 'right' },
          { header: 'TOKENS SAVED', align: 'right' },
          { header: 'AVG DEGRADATION', align: 'right' },
        ],
        byStrategy.map((r) => [
          String(r?.strategy ?? ''),
          String(safeNum(r?.uses)),
          String(safeNum(r?.tokensSaved)),
          formatDegradation(r?.avgDegradationPct),
        ]),
        color,
      ),
    );
  }

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV export
// ─────────────────────────────────────────────────────────────────────────────

/** Column order for CSV export — mirrors the RequestEvent interface. */
const CSV_COLUMNS: ReadonlyArray<keyof RequestEvent> = [
  'id',
  'ts',
  'sessionId',
  'provider',
  'model',
  'source',
  'repo',
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'costUSD',
  'compacted',
  'tokensSaved',
  'costSavedUSD',
  'strategies',
  'utilization',
  'qualityScore',
  'status',
  'durationMs',
];

/** Escape a single CSV field per RFC 4180 (quote if it contains , " CR or LF). */
function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = typeof value === 'string' ? value : String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Serialize RequestEvents to CSV: a header row of RequestEvent field names
 * followed by one row per event. Quotes/commas/newlines are escaped. Returns
 * just the header row when given an empty (or non-array) input.
 */
export function toCSV(rows: RequestEvent[]): string {
  const safeRows = Array.isArray(rows) ? rows : [];
  const header = CSV_COLUMNS.join(',');
  const body = safeRows.map((row) => {
    const r = (row ?? {}) as Partial<RequestEvent>;
    return CSV_COLUMNS.map((col) => csvEscape(r[col])).join(',');
  });
  return [header, ...body].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Store-backed convenience
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch a summary from the store and render it. `since` (epoch ms) limits the
 * reporting window; `color` toggles ANSI output.
 */
export function renderTerminalReport(
  store: Store,
  opts: { since?: number; color?: boolean } = {},
): string {
  const summary = store.summary(opts.since !== undefined ? { since: opts.since } : undefined);
  return formatReport(summary, { color: opts.color });
}
