// src/compactor/relevance.ts — pure, dependency-free relevance & salience helpers.
//
// These power signal-preserving, recoverable elision and relevance-protection:
//  - `extractSalientLines` keeps the high-information lines (errors, ids,
//    KEY=VALUE, urls, paths, big numbers) when a bulky block is paged out, so a
//    head-truncated preview never destroys buried facts.
//  - `queryTerms` / `relevanceScore` shield blocks that are lexically on-topic
//    for the latest user question.
//  - `looksDurable` flags short config-like facts worth auto-pinning.
//
// Everything here is pure string/number work: no I/O, no contract types, no deps.
// Robust to malformed input — never throws on the request path.

// ─────────────────────────────────────────────────────────────────────────────
// Patterns. Kept module-level so they are compiled once. NOTE: any regex used
// with the global flag is reset (`lastIndex = 0`) before each use to avoid the
// stateful-`.test()` footgun.
// ─────────────────────────────────────────────────────────────────────────────

/** error/fail/exception/warn/fatal/panic anywhere, case-insensitive. */
const RE_ERRORY = /\b(?:error|fail(?:ed|ure)?|exception|warn(?:ing)?|fatal|panic)\b/i;

/** An ALLCAPS code/identifier like ABC-123, ERR_CODE, HTTP-404, X1_Y2. */
const RE_CODE = /[A-Z][A-Z0-9]*[-_][A-Z0-9-]{2,}/;

/** KEY=VALUE or KEY: value with an identifier-ish key (>=3 chars). */
const RE_KEYVALUE = /\b[A-Za-z][A-Za-z0-9_.]{2,}\s*[=:]\s*\S+/;

/** http(s) URL. */
const RE_URL = /https?:\/\/\S+/i;

/** A POSIX-ish path (>=2 segments) or a Windows drive path. */
const RE_PATH = /(?:\/[\w.-]+){2,}|[A-Za-z]:\\/;

/** A :port like :8080 (2..5 digits). */
const RE_PORT = /:\d{2,5}\b/;

/** A standalone multi-digit number token (3+ digits). */
const RE_BIGNUM = /\b\d{3,}\b/;

/**
 * Durable/credential-ish KEY=VALUE: an UPPER_SNAKE-ish or dotted key bound to a
 * non-trivial value. Used by `looksDurable`. Allows `=` or `:` separators.
 */
const RE_DURABLE_KV =
  /\b[A-Za-z][A-Za-z0-9_.]*(?:_[A-Za-z0-9]+|\.[A-Za-z0-9]+|[A-Z]{2,})[A-Za-z0-9_.]*\s*[=:]\s*\S{2,}/;

/**
 * Word/code/number token for query-term extraction. Uses Unicode letter classes
 * so non-Latin scripts (e.g. Russian) are tokenized too — relevance-protection
 * must work for the user's natural language, not just ASCII.
 */
const RE_TOKEN = /[\p{L}\p{N}_][\p{L}\p{N}_.-]*/gu;

/** Looks like a code or number token (contains a digit or a -/_/. separator). */
const RE_CODEISH = /\d|[-_.]/u;

// A small bilingual stopword set. Short words (<4 chars) are already dropped for
// plain prose, so this mostly trims common 4+ char fillers.
const STOPWORDS = new Set<string>([
  // English
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'any', 'can', 'had',
  'her', 'was', 'one', 'our', 'out', 'his', 'has', 'him', 'how', 'its', 'who',
  'with', 'this', 'that', 'from', 'they', 'them', 'then', 'than', 'have', 'will',
  'would', 'could', 'should', 'about', 'there', 'their', 'which', 'what', 'when',
  'where', 'were', 'been', 'into', 'such', 'only', 'some', 'more', 'most', 'over',
  'your', 'does', 'done', 'just', 'like', 'also', 'each', 'very', 'much', 'many',
  'these', 'those', 'because',
  // Russian
  'это', 'как', 'что', 'для', 'или', 'все', 'был', 'была', 'было', 'были',
  'если', 'когда', 'который', 'которые', 'этот', 'эта', 'эти', 'там', 'тут',
  'нет', 'так', 'уже', 'еще', 'ещё', 'его', 'ему', 'них', 'нам', 'вам', 'они',
  'оно', 'она', 'чтобы', 'тоже', 'также', 'очень', 'можно', 'надо', 'будет',
]);

/** Collapse whitespace, trim, and cap length. */
function clamp(line: string, max: number): string {
  const s = line.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) : s;
}

/** True if a single line carries high-information signal worth preserving. */
function isSalientLine(line: string): boolean {
  return (
    RE_ERRORY.test(line) ||
    RE_CODE.test(line) ||
    RE_KEYVALUE.test(line) ||
    RE_URL.test(line) ||
    RE_PATH.test(line) ||
    RE_PORT.test(line) ||
    RE_BIGNUM.test(line)
  );
}

/**
 * Split `text` into lines and return up to `max` SALIENT lines, in original
 * order, de-duplicated, each whitespace-collapsed and truncated to ~200 chars.
 *
 * A line is salient if it matches ANY of: error/fail/exception/warn/fatal/panic
 * (case-insensitive); an ALLCAPS code like ABC-123 / ERR_CODE; a KEY=VALUE or
 * KEY: value; a URL; a filesystem path; a :port; or a standalone 3+ digit number.
 */
export function extractSalientLines(text: string, max: number): string[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  const cap = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : 0;
  if (cap === 0) return [];

  const out: string[] = [];
  const seen = new Set<string>();

  // Split on any newline flavor; keep splitting cheap and allocation-light.
  const lines = text.split(/\r\n|\r|\n/);
  for (const raw of lines) {
    if (out.length >= cap) break;
    if (!raw) continue;
    if (!isSalientLine(raw)) continue;

    const cleaned = clamp(raw, 200);
    if (cleaned.length === 0) continue;
    if (seen.has(cleaned)) continue;

    seen.add(cleaned);
    out.push(cleaned);
  }

  return out;
}

/**
 * Extract query terms from `question`: lowercased word tokens of length >= 4,
 * PLUS any code/number-ish tokens regardless of length, minus a small
 * English/Russian stopword set. Returns a Set (deduped).
 */
export function queryTerms(question: string): Set<string> {
  const terms = new Set<string>();
  if (typeof question !== 'string' || question.length === 0) return terms;

  const lower = question.toLowerCase();
  RE_TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE_TOKEN.exec(lower)) !== null) {
    const tok = m[0];
    if (tok.length === 0) continue;
    // Keep short tokens only when they look like a code/number (e.g. "v2", "404").
    const codeish = RE_CODEISH.test(tok);
    if (tok.length < 4 && !codeish) continue;
    if (STOPWORDS.has(tok)) continue;
    terms.add(tok);
  }
  return terms;
}

/**
 * Fraction (0..1) of `terms` that appear as a substring of `text` (lowercased).
 * Returns 0 when `terms` is empty or `text` is not a usable string.
 */
export function relevanceScore(text: string, terms: Set<string>): number {
  if (!(terms instanceof Set) || terms.size === 0) return 0;
  if (typeof text !== 'string' || text.length === 0) return 0;

  const hay = text.toLowerCase();
  let hits = 0;
  for (const term of terms) {
    if (term.length > 0 && hay.includes(term)) hits += 1;
  }
  return hits / terms.size;
}

/**
 * True for SHORT text (< ~400 chars) that contains a config-like durable fact —
 * an UPPER_SNAKE / dotted KEY bound to a value (credentials, ids, endpoints).
 * These are cheap to keep and costly to lose, so callers may auto-pin them.
 * Long prose returns false even if it happens to contain a `key: value` clause.
 */
export function looksDurable(text: string): boolean {
  if (typeof text !== 'string') return false;
  const t = text.trim();
  if (t.length === 0 || t.length >= 400) return false;
  return RE_DURABLE_KV.test(t);
}
