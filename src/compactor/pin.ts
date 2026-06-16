// src/compactor/pin.ts — pin sentinel detection.
//
// A message (or text chunk) is "pinned" — i.e. exempt from compaction — when it
// contains the pin sentinel anywhere in its text. The sentinel is an HTML-style
// comment so it survives untouched through markdown / plain-text round-trips and
// is invisible when rendered.
import { looksDurable } from './relevance.js';

/** Marker users embed in content they never want compacted. */
export const PIN_SENTINEL = '<!--ctxgov:pin-->';

/**
 * True if the given text is pinned (contains the pin sentinel).
 * Robust to non-string input — returns false rather than throwing.
 */
export function isPinnedText(t: string): boolean {
  if (typeof t !== 'string' || t.length === 0) return false;
  return t.includes(PIN_SENTINEL);
}

/**
 * True if the text should be treated as pinned for compaction purposes: either
 * an explicit user pin sentinel, OR a short, durable config-like fact (a
 * credential/id/endpoint KEY=VALUE) that is cheap to keep and costly to lose.
 *
 * This is the auto-pin gate used by the compaction pipeline and adapters so
 * durable facts are never elided/deduped even without an explicit sentinel.
 * Robust to non-string input.
 */
export function isAutoPinned(t: string): boolean {
  if (typeof t !== 'string' || t.length === 0) return false;
  return isPinnedText(t) || looksDurable(t);
}

// Re-export the durable-fact predicate so callers (index.ts, adapters) can treat
// durable facts as pinned without importing relevance.ts directly.
export { looksDurable } from './relevance.js';
