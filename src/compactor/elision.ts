// src/compactor/elision.ts — elide large, older tool results (signal-preserving + recoverable).
//
// The cheapest compaction op, but historically the RISKIEST: the old version
// replaced a whole tool-result body with a 120-char head, so any fact buried past
// char 120 (a stack trace deep in a log, an id at the end of a file dump) was
// destroyed. This version keeps the high-information signal and makes the removed
// bytes RECOVERABLE:
//   - a head PREVIEW (config.compaction.elisionPreviewChars),
//   - up to config.compaction.elisionSalientLines SALIENT lines (errors, ids,
//     KEY=VALUE, urls, paths, ports, big numbers) via extractSalientLines,
//   - a TAIL snippet (last ~80 chars),
//   - and, when a store + recoverable config are present, a content-addressed id
//     pointing at the full block persisted in the store (context virtual memory).
//
// Recent results are always kept intact (agents most often re-read them).
import { createHash } from 'node:crypto';
import type { GovernorConfig, ProviderAdapter, Store, TokenCounter } from '../types.js';
import { isAutoPinned } from './pin.js';
import { extractSalientLines } from './relevance.js';

/** Tail snippet length kept from the end of a paged-out block. */
const TAIL_CHARS = 80;

/** Collapse whitespace, trim, and cap to `n` chars. */
function collapse(t: string, n: number): string {
  const s = t.replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) : s;
}

/** Last `n` chars of `t` with whitespace collapsed. */
function lastNChars(t: string, n: number): string {
  const s = t.replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(s.length - n) : s;
}

/** Short content-addressed id for a paged-out block: `cg-<sha1[0..10]>`. */
function blobId(content: string): string {
  try {
    return 'cg-' + createHash('sha1').update(content).digest('hex').slice(0, 10);
  } catch {
    // Hashing must never throw on the request path; fall back to a length tag.
    return 'cg-' + String(content.length);
  }
}

/**
 * Build the signal-preserving elision marker.
 *
 * Format:
 *   [ctxgov: paged out N tokens — id=<id>. head: <preview> | key lines: <l1> ⏎ <l2> … | tail: <…last 80 chars>]
 *
 * The `id=` clause is included only when the block was persisted (recoverable).
 * Sections that are empty (no salient lines, no tail) are omitted so the marker
 * stays compact and always shrinks the payload.
 */
function elisionMarker(
  tokens: number,
  text: string,
  previewChars: number,
  salientLines: number,
  id: string | undefined,
): string {
  const head = collapse(text, Math.max(0, previewChars));
  const lines = extractSalientLines(text, salientLines);
  const tail = lastNChars(text, TAIL_CHARS);

  const idClause = id ? ` — id=${id}` : '';
  // Explicit warning so a weaker model does not read the preview/key-lines as the
  // COMPLETE tool output and answer from the leftover noise instead of the
  // surviving (pinned/recent) content. Keeps the "ctxgov: paged out" prefix and
  // the "id=cg-..." clause intact (relied on by tests + page-fault recovery).
  const warn = 'COMPACTED SUMMARY — not the full tool result; do not treat the preview/key-lines below as complete or authoritative';
  const parts: string[] = [`[ctxgov: paged out ${tokens} tokens (${warn})${idClause}. head: ${head}`];
  if (lines.length > 0) parts.push(`key lines: ${lines.join(' ⏎ ')}`);
  if (tail.length > 0) parts.push(`tail: ${tail}`);
  return parts.join(' | ') + ']';
}

/** Options threading recoverable-paging context through the pipeline. */
export interface ElisionOptions {
  store?: Store;
  sessionId?: string;
  /** Protect a block from elision (e.g. relevance-protection). Optional. */
  protect?: (text: string) => boolean;
  /**
   * Index of the last message covered by a provider cache breakpoint (Anthropic
   * `cache_control`). Tool results at or before this index are IMMUTABLE — eliding
   * them rewrites the cached prefix and invalidates the prompt cache (cached input
   * is ~10% of normal, so mutating it can make the request cost MORE). -1 (the
   * default) means no breakpoint, so nothing is protected on these grounds.
   */
  cacheBoundaryIndex?: number;
}

/**
 * Elide eligible tool results in place, signal-preserving and recoverable.
 *
 * Skips the most-recent `keepRecentToolResults` entries (the tail of the
 * oldest-first list). Of the remainder, only those at or above
 * `minToolResultTokens`, not pinned/auto-pinned, and not protected are replaced
 * with a compact, salient-line-preserving marker. When `opts.store` is set and
 * `config.compaction.recoverable` is true, the full block is persisted under a
 * content id surfaced in the marker so it can be recovered/audited.
 *
 * @returns saved tokens (sum of orig minus marker), whether anything changed, and count.
 */
export function applyElision(
  body: unknown,
  adapter: ProviderAdapter,
  counter: TokenCounter,
  config: GovernorConfig,
  opts: ElisionOptions = {},
): { saved: number; applied: boolean; count: number } {
  const results = adapter.listToolResults(body, counter);
  const keepRecent = Math.max(0, config.compaction.keepRecentToolResults | 0);
  const minTokens = Math.max(0, config.compaction.minToolResultTokens | 0);
  const previewChars = Math.max(0, config.compaction.elisionPreviewChars | 0);
  const salientLines = Math.max(0, config.compaction.elisionSalientLines | 0);
  const recoverable = config.compaction.recoverable === true && opts.store !== undefined;
  const sessionId = typeof opts.sessionId === 'string' && opts.sessionId.length > 0 ? opts.sessionId : 'proxy';
  // Cache-prefix protection: messages at or before this index are immutable.
  const cacheBoundary = typeof opts.cacheBoundaryIndex === 'number' ? opts.cacheBoundaryIndex : -1;

  // Candidates exclude the trailing (most-recent) `keepRecent` entries.
  const cutoff = results.length - keepRecent;
  let saved = 0;
  let count = 0;

  for (let i = 0; i < cutoff; i++) {
    const ref = results[i];
    if (!ref) continue;
    // Never touch the cache-anchored prefix — editing it invalidates the prompt cache.
    if (ref.messageIndex <= cacheBoundary) continue;
    if (ref.tokens < minTokens) continue;
    if (isAutoPinned(ref.text)) continue;
    if (opts.protect && opts.protect(ref.text)) continue;

    // Persist the full block first (best-effort) so the marker can point at it.
    let id: string | undefined;
    if (recoverable && opts.store) {
      id = blobId(ref.text);
      try {
        opts.store.recordElidedBlob({
          id,
          sessionId,
          ts: Date.now(),
          tokens: ref.tokens,
          content: ref.text,
        });
      } catch {
        // Persistence is best-effort; never break the request path. If it fails
        // we still elide, but drop the id from the marker (it isn't recoverable).
        id = undefined;
      }
    }

    const marker = elisionMarker(ref.tokens, ref.text, previewChars, salientLines, id);
    const markerTokens = counter.count(marker, adapter.id);
    const delta = ref.tokens - markerTokens;
    // Only elide when it actually shrinks the payload.
    if (delta <= 0) continue;

    ref.replace(marker);
    saved += delta;
    count += 1;
  }

  return { saved, applied: count > 0, count };
}
