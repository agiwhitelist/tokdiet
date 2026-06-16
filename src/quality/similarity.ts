// src/quality/similarity.ts — text-similarity heuristics + judge factories.
//
// A "judge" returns a degradation percentage (0..100): 0 = identical, higher =
// worse. The heuristic judge blends three cheap signals so no single quirk of
// the input dominates the score; the LLM judge asks a model and falls back to
// the heuristic on any failure.
import type { JudgeFn } from '../types.js';

/** Tokenize into a set of lower-cased word tokens (alphanumerics). */
function wordSet(s: string): Set<string> {
  const set = new Set<string>();
  const matches = s.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  if (matches) for (const m of matches) set.add(m);
  return set;
}

/** Multiset of character bigrams over a normalized (whitespace-collapsed) string. */
function bigrams(s: string): Map<string, number> {
  const norm = s.toLowerCase().replace(/\s+/g, ' ').trim();
  const map = new Map<string, number>();
  for (let i = 0; i < norm.length - 1; i++) {
    const bg = norm.slice(i, i + 2);
    map.set(bg, (map.get(bg) ?? 0) + 1);
  }
  return map;
}

/** Jaccard index over two sets (intersection / union); 1 when both empty. */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 1 : inter / union;
}

/** Sørensen–Dice coefficient over two bigram multisets; 1 when both empty. */
function diceBigrams(a: Map<string, number>, b: Map<string, number>): number {
  const totalA = sumCounts(a);
  const totalB = sumCounts(b);
  if (totalA === 0 && totalB === 0) return 1;
  if (totalA === 0 || totalB === 0) return 0;
  let overlap = 0;
  for (const [bg, ca] of a) {
    const cb = b.get(bg);
    if (cb) overlap += Math.min(ca, cb);
  }
  return (2 * overlap) / (totalA + totalB);
}

function sumCounts(m: Map<string, number>): number {
  let n = 0;
  for (const c of m.values()) n += c;
  return n;
}

/** Ratio of shorter length to longer length; 1 when both empty. */
function lengthRatio(a: string, b: string): number {
  const la = a.length;
  const lb = b.length;
  if (la === 0 && lb === 0) return 1;
  const max = Math.max(la, lb);
  if (max === 0) return 1;
  return Math.min(la, lb) / max;
}

function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Estimate degradation (0..100) between a baseline answer `a` and a compacted
 * answer `b`. 0 means identical; higher means more divergent.
 *
 * Similarity blends word-set Jaccard (0.4), character-bigram Dice (0.4), and a
 * length ratio (0.2). degradation = (1 - similarity) * 100, clamped to 0..100.
 */
export function heuristicDegradation(a: string, b: string): number {
  const sa = typeof a === 'string' ? a : '';
  const sb = typeof b === 'string' ? b : '';

  if (sa === sb) return 0;

  const j = jaccard(wordSet(sa), wordSet(sb));
  const d = diceBigrams(bigrams(sa), bigrams(sb));
  const lr = lengthRatio(sa, sb);

  const similarity = 0.4 * j + 0.4 * d + 0.2 * lr;
  return clamp((1 - similarity) * 100, 0, 100);
}

/** Default heuristic judge — pure, deterministic, no I/O. */
export const heuristicJudge: JudgeFn = async (a, b) => heuristicDegradation(a, b);

/**
 * Robustly extract a 0..100 degradation score from free-form model output.
 *
 * The model is prompted to emit strict JSON `{"degradation": <number>}`, but
 * cheap models routinely wrap it in prose, code fences, or extra keys. We try,
 * in order:
 *   1. the first balanced `{...}` object that parses as JSON and carries a
 *      finite numeric (or numeric-string) `degradation` field;
 *   2. failing that, the first plausible number anywhere in the text.
 * Returns null only when no number can be recovered at all. Any recovered value
 * is clamped to 0..100.
 */
function parseScore(text: string): number | null {
  if (typeof text !== 'string' || text.length === 0) return null;

  // 1) First JSON object with a usable `degradation` field. Scan every
  //    brace-delimited candidate so a leading "{" of prose junk can't poison
  //    the parse of a later, valid object.
  for (const candidate of jsonObjectCandidates(text)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (parsed && typeof parsed === 'object' && 'degradation' in parsed) {
      const raw = (parsed as { degradation: unknown }).degradation;
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : NaN;
      if (Number.isFinite(n)) return clamp(n, 0, 100);
    }
  }

  // 2) Fallback: first plausible number anywhere in the reply.
  const match = text.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const n = Number(match[0]);
  if (!Number.isFinite(n)) return null;
  return clamp(n, 0, 100);
}

/**
 * Yield every balanced `{...}` substring (brace-depth matched) found in `text`,
 * outermost-first. Cheap and allocation-light; ignores braces inside strings
 * only loosely (a malformed candidate simply fails JSON.parse and is skipped).
 */
function* jsonObjectCandidates(text: string): Generator<string> {
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          yield text.slice(i, j + 1);
          break;
        }
      }
    }
  }
}

/**
 * Build an LLM-backed judge. The model is asked to rate semantic degradation on
 * a 0..100 scale and reply with STRICT JSON `{"degradation": <number>}`; the
 * reply is parsed robustly (first valid JSON object, then any number). On ANY
 * failure (throw, non-string, or unparseable output) it falls back to the
 * heuristic so the caller always gets a usable score.
 */
export function makeLlmJudge(call: (prompt: string) => Promise<string>): JudgeFn {
  return async (a, b) => {
    const sa = typeof a === 'string' ? a : '';
    const sb = typeof b === 'string' ? b : '';
    const prompt =
      'You are a strict evaluator. Rate how much the SECOND text degrades or ' +
      'diverges in meaning from the FIRST text, on a scale of 0 to 100 where 0 ' +
      'means semantically identical and 100 means completely unrelated. Reply ' +
      'with ONLY strict JSON in exactly this shape, no prose, no code fences:\n' +
      '{"degradation": <number 0-100>}\n\n' +
      `FIRST:\n${sa}\n\nSECOND:\n${sb}\n\nJSON:`;
    try {
      const out = await call(prompt);
      const score = parseScore(out);
      if (score === null) return heuristicDegradation(sa, sb);
      return score;
    } catch {
      return heuristicDegradation(sa, sb);
    }
  };
}
