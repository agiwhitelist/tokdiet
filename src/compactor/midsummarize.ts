// src/compactor/midsummarize.ts — summarize mid-history messages with a cheap model.
//
// The most aggressive (and lossy) strategy: replace bulky messages buried in the
// middle of a conversation with a model-generated summary. We protect the opening
// context (first 2) and the recent working set (last 4), skip pinned and short
// messages, and fail open per-message — any summarization error leaves the
// original message untouched.
import type { GovernorConfig, MessageRef, ProviderAdapter, SummarizeFn, TokenCounter } from '../types.js';

/** Messages at the very start to preserve (system / task framing). */
const SKIP_FIRST = 2;
/** Most-recent messages to preserve (active working set). */
const SKIP_LAST = 4;
/** Messages smaller than this (tokens) are not worth summarizing. */
const MIN_SUMMARIZE_TOKENS = 300;
/** Target compression ratio for the summary. */
const SUMMARY_RATIO = 0.3;

/**
 * Summarize eligible middle-of-history messages in place.
 *
 * If no `summarize` function is provided, this is a no-op. Each candidate is
 * summarized to roughly 30% of its size and prefixed with a marker. Errors are
 * caught per-message so a single failure never aborts the pass.
 *
 * @returns saved tokens, whether anything changed, and count of summaries.
 */
export async function applyMidSummarize(
  body: unknown,
  adapter: ProviderAdapter,
  counter: TokenCounter,
  config: GovernorConfig,
  summarize?: SummarizeFn,
): Promise<{ saved: number; applied: boolean; count: number }> {
  void config; // thresholds are intrinsic; signature kept uniform for the pipeline.
  if (typeof summarize !== 'function') {
    return { saved: 0, applied: false, count: 0 };
  }

  const messages: MessageRef[] = adapter.listMessages(body, counter);
  const start = SKIP_FIRST;
  const end = messages.length - SKIP_LAST;
  let saved = 0;
  let count = 0;

  for (let i = start; i < end; i++) {
    const ref = messages[i];
    if (!ref) continue;
    if (ref.pinned) continue;
    if (ref.tokens < MIN_SUMMARIZE_TOKENS) continue;

    const targetTokens = Math.ceil(ref.tokens * SUMMARY_RATIO);
    try {
      const result = await summarize(ref.text, targetTokens);
      if (typeof result !== 'string' || result.length === 0) continue;

      const newText = `[ctxgov: summarized]\n${result}`;
      const newTokens = counter.count(newText, adapter.id);
      const delta = ref.tokens - newTokens;
      // Only commit when the summary is genuinely smaller.
      if (delta <= 0) continue;

      ref.replaceText(newText);
      saved += delta;
      count += 1;
    } catch {
      // Fail open: leave this message untouched and continue.
      continue;
    }
  }

  return { saved, applied: count > 0, count };
}
