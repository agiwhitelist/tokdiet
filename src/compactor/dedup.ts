// src/compactor/dedup.ts — collapse repeated text (the SAFE, loss-free op).
//
// Agents constantly re-paste the same file/log/dump across a conversation. In the
// real world each re-paste is wrapped in a slightly different framing line
// ("Here it is again:", "Pasting once more:", ...), so the WHOLE message is rarely
// byte-identical even though the bulk (the artifact) is. Whole-chunk equality
// therefore misses almost all real re-pastes.
//
// This implementation deduplicates at LINE-RUN granularity: it collapses maximal
// contiguous runs of lines that already appeared verbatim in an EARLIER chunk,
// replacing them with a small pointer marker while keeping each chunk's unique
// wrapper text intact. It is loss-free: the collapsed content still exists
// verbatim in the earlier (kept) copy. A fully-identical chunk is just the special
// case where the entire body is one repeated run.
//
// Markers are never re-deduplicated; pinned/durable chunks are exempt. Relevance
// protection does NOT apply to dedup (see index.ts) — the content survives in the
// kept copy regardless of relevance, so there is nothing to protect.
import type { GovernorConfig, ProviderAdapter, TextChunkRef, TokenCounter } from '../types.js';
import { isAutoPinned } from './pin.js';

/** A chunk must be at least this long (normalized) to be worth scanning. */
const MIN_DEDUP_CHARS = 200;
/** A line must be at least this long (normalized) to participate in a repeat-run. */
const SIG_LINE_CHARS = 16;
/** Only collapse a repeated run at least this many raw chars (avoids incidental matches). */
const MIN_RUN_CHARS = 300;
/** Any ctxgov-injected marker — never treat these as dedup keys or targets. */
const RE_CTXGOV_MARKER = /\[ctxgov:/;
/**
 * Near-duplicate threshold (Jaccard over normalized line-shingles). Two chunks at
 * or above this similarity are treated as a near-dup pair: the same artifact
 * re-pasted with a few lines changed. Empirically high enough to avoid collapsing
 * merely-related files while still catching real re-pastes.
 */
const NEAR_DUP_JACCARD = 0.85;
/** A chunk needs at least this many significant lines for a stable Jaccard signal. */
const NEAR_DUP_MIN_LINES = 8;

/** Collapse internal whitespace runs and trim, for stable line comparison. */
function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Options for dedup (relevance-protection hook). */
export interface DedupOptions {
  /** Protect a chunk from dedup. Optional; not used by the pipeline (dedup is loss-free). */
  protect?: (text: string) => boolean;
  /**
   * Index of the last message covered by a provider cache breakpoint (Anthropic
   * `cache_control`). Chunks at or before this index are IMMUTABLE — even though
   * dedup is loss-free, REWRITING a cached-prefix chunk (to insert a pointer
   * marker) still changes its bytes and invalidates the prompt cache. Such chunks
   * are never collapsed; they may still serve as the verbatim "kept" copy that a
   * later (uncached) duplicate points back to, since they are left untouched.
   * -1 (the default) means no breakpoint — nothing is protected on these grounds.
   */
  cacheBoundaryIndex?: number;
}

/** The set of normalized, significant lines in a chunk (its shingle set for Jaccard). */
function shingleSet(text: string): Set<string> {
  const s = new Set<string>();
  for (const l of text.split(/\r?\n/)) {
    const n = normalize(l);
    if (n.length >= SIG_LINE_CHARS) s.add(n);
  }
  return s;
}

/** Jaccard similarity |A∩B| / |A∪B| over two shingle sets (0 when either is empty). */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (large.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Count how many significant lines differ between an earlier copy and the kept
 * (later) copy: significant lines present in `earlier` but absent from `kept`.
 * This is the "M lines differ" surfaced in the near-dup marker so the elision
 * stays loss-aware.
 */
function lineDiffCount(earlier: Set<string>, kept: Set<string>): number {
  let diff = 0;
  for (const x of earlier) if (!kept.has(x)) diff++;
  return diff;
}

/** True if a chunk is a viable dedup participant at all. */
function isCandidate(text: unknown, protect?: (text: string) => boolean): text is string {
  if (typeof text !== 'string') return false;
  if (RE_CTXGOV_MARKER.test(text)) return false; // never touch our own markers
  if (isAutoPinned(text)) return false; // pinned + durable facts are exempt
  if (protect && protect(text)) return false;
  return normalize(text).length > MIN_DEDUP_CHARS;
}

/**
 * Collapse repeated line-runs across text chunks, keeping the FIRST occurrence
 * verbatim and replacing later identical runs with a pointer marker. Loss-free.
 *
 * @returns saved tokens, whether anything changed, and count of chunks modified.
 */
export function applyDedup(
  body: unknown,
  adapter: ProviderAdapter,
  counter: TokenCounter,
  config: GovernorConfig,
  opts: DedupOptions = {},
): { saved: number; applied: boolean; count: number } {
  const chunks: TextChunkRef[] = adapter.listTextChunks(body, counter);
  const protect = opts.protect;
  // Cache-prefix protection: chunks at or before this index must never be rewritten.
  const cacheBoundary = typeof opts.cacheBoundaryIndex === 'number' ? opts.cacheBoundaryIndex : -1;
  /** A chunk is mutable only when it lives strictly after the cache boundary. */
  const mutable = (ref: TextChunkRef): boolean => ref.messageIndex > cacheBoundary;

  let saved = 0;
  let count = 0;

  // Pass 0 — NEAR-DUPLICATE collapsing (whole-chunk granularity), gated by config.
  // Catches the same artifact re-pasted with a few lines changed: such chunks are
  // NOT byte-identical so the exact line-run pass below misses the changed lines.
  // We keep the freshest (last) member of each near-dup group verbatim and replace
  // earlier members with a short diff-aware marker. Identical chunks (Jaccard 1.0,
  // 0 lines differ) are deliberately LEFT for the loss-free exact pass — that path
  // is keep-last verbatim too but preserves shared lines elsewhere and is the
  // existing, tested behavior. Runs only when config.compaction.semanticDedup.
  if (config.compaction.semanticDedup === true) {
    const near = applyNearDup(chunks, adapter, counter, protect, mutable);
    saved += near.saved;
    count += near.count;
  }

  // The near-dup pass mutated the body in place, but TextChunkRef.text snapshots
  // are now stale. Re-list so the exact pass reads the post-near-dup body — the
  // freshly-injected near-dup markers are then skipped via RE_CTXGOV_MARKER and
  // the exact pass never re-collapses (or overwrites) an already-collapsed chunk.
  const exactChunks: TextChunkRef[] = count > 0 ? adapter.listTextChunks(body, counter) : chunks;

  // Pass 1 — build the dedup dictionary: for each significant normalized line,
  // remember the index of the LAST candidate chunk that contains it. That latest
  // copy is the one kept verbatim (the model attends most to recent content).
  const lastChunkOf = new Map<string, number>();
  for (let ci = 0; ci < exactChunks.length; ci++) {
    const ref = exactChunks[ci];
    if (!ref || !isCandidate(ref.text, protect)) continue;
    for (const l of ref.text.split(/\r?\n/)) {
      const n = normalize(l);
      if (n.length >= SIG_LINE_CHARS) lastChunkOf.set(n, ci);
    }
  }

  // Pass 2 — in every chunk EXCEPT the latest copy of each line, collapse maximal
  // contiguous runs of lines that reappear in a later chunk.
  for (let ci = 0; ci < exactChunks.length; ci++) {
    const ref = exactChunks[ci];
    if (!ref || !isCandidate(ref.text, protect)) continue;
    // Cache-anchored chunks are immutable: never rewrite them (would invalidate the
    // prompt cache). They remain valid verbatim sources for later duplicates above.
    if (!mutable(ref)) continue;
    const lines = ref.text.split(/\r?\n/);

    // A line is removable here if it is significant and its LAST occurrence is in a
    // later chunk (so a verbatim copy survives downstream).
    const removable: boolean[] = lines.map((l) => {
      const n = normalize(l);
      if (n.length < SIG_LINE_CHARS) return false;
      const last = lastChunkOf.get(n);
      return last !== undefined && last > ci;
    });

    const out: string[] = [];
    let chunkSaved = 0;
    let j = 0;
    while (j < lines.length) {
      if (!removable[j]) { out.push(lines[j] as string); j++; continue; }
      let k = j;
      let runChars = 0;
      while (k < lines.length && removable[k]) { runChars += (lines[k] as string).length + 1; k++; }
      if (runChars >= MIN_RUN_CHARS) {
        const runText = lines.slice(j, k).join('\n');
        const runTokens = counter.count(runText, adapter.id);
        const marker = `[ctxgov: ${k - j} duplicate lines elided — kept verbatim in the latest copy (${runTokens} tokens saved)]`;
        const markerTokens = counter.count(marker, adapter.id);
        if (runTokens - markerTokens > 0) {
          out.push(marker);
          chunkSaved += runTokens - markerTokens;
          j = k;
          continue;
        }
      }
      // Run too small to be worth a marker — keep verbatim.
      for (let m = j; m < k; m++) out.push(lines[m] as string);
      j = k;
    }

    if (chunkSaved > 0) {
      ref.replace(out.join('\n'));
      saved += chunkSaved;
      count += 1;
    }
  }

  return { saved, applied: count > 0, count };
}

/**
 * NEAR-DUPLICATE pass (whole-chunk granularity). Detects large text chunks that
 * are HIGHLY similar but not byte-identical — typically the same file/log/dump
 * re-pasted with a few lines changed — using a cheap, dependency-free Jaccard over
 * normalized line-shingles. Within each near-dup group the LAST (freshest) chunk
 * is kept verbatim and every earlier member is replaced by a diff-aware marker.
 *
 * Properties / guards (mirror the exact pass):
 *   - candidate gate: skips ctxgov markers, pinned/auto-pinned, protected, and
 *     too-small chunks (isCandidate);
 *   - only collapses a chunk when it ACTUALLY saves tokens (marker < original);
 *   - only collapses chunks that DIFFER from the kept copy (≥1 line differs) —
 *     byte/line-identical copies are left for the loss-free exact line-run pass;
 *   - keeps the freshest copy verbatim so recent context is never degraded.
 *
 * Greedy grouping: scanning oldest→newest, each earlier candidate is collapsed
 * against the NEAREST later candidate it is near-dup with (Jaccard ≥ threshold),
 * which is the freshest copy of that artifact still standing.
 */
function applyNearDup(
  chunks: TextChunkRef[],
  adapter: ProviderAdapter,
  counter: TokenCounter,
  protect?: (text: string) => boolean,
  mutable?: (ref: TextChunkRef) => boolean,
): { saved: number; count: number } {
  // Index every candidate chunk with its precomputed shingle set.
  const cand: Array<{ ci: number; ref: TextChunkRef; sh: Set<string> }> = [];
  for (let ci = 0; ci < chunks.length; ci++) {
    const ref = chunks[ci];
    if (!ref || !isCandidate(ref.text, protect)) continue;
    const sh = shingleSet(ref.text);
    if (sh.size < NEAR_DUP_MIN_LINES) continue; // too few lines for a stable signal
    cand.push({ ci, ref, sh });
  }

  let saved = 0;
  let count = 0;

  // For each candidate (oldest→newest, excluding the very last which is the
  // freshest possible kept copy), find the nearest LATER candidate it near-dups.
  for (let i = 0; i < cand.length; i++) {
    const earlier = cand[i]!;
    // The earlier copy is the one we'd REWRITE — skip it if it's cache-anchored.
    if (mutable && !mutable(earlier.ref)) continue;
    let keptIdx = -1;
    for (let j = i + 1; j < cand.length; j++) {
      const later = cand[j]!;
      const sim = jaccard(earlier.sh, later.sh);
      if (sim >= NEAR_DUP_JACCARD) { keptIdx = j; break; }
    }
    if (keptIdx === -1) continue; // no fresher near-dup copy — leave it alone
    const kept = cand[keptIdx]!;

    const linesDiffer = lineDiffCount(earlier.sh, kept.sh);
    // Identical (no differing lines) → defer to the loss-free exact line-run pass.
    if (linesDiffer === 0) continue;

    const originalTokens = counter.count(earlier.ref.text, adapter.id);
    const marker = `[ctxgov: near-duplicate of a later copy — ${originalTokens} tokens elided; ${linesDiffer} ${linesDiffer === 1 ? 'line differs' : 'lines differ'}]`;
    const markerTokens = counter.count(marker, adapter.id);

    // Only collapse when it actually saves tokens.
    if (originalTokens - markerTokens <= 0) continue;

    earlier.ref.replace(marker);
    saved += originalTokens - markerTokens;
    count += 1;
  }

  return { saved, count };
}
