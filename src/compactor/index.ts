// src/compactor/index.ts — orchestrates compaction strategies behind the Compactor contract.
//
// Strategy order is SAFEST-FIRST: dedup → elision → midSummarize.
//   - dedup is loss-free (the content survives verbatim in the kept copy), so it
//     runs FIRST to harvest the safe savings before anything mutates the blocks.
//     (Running it after elision was the historical "dedup fired 0/5" bug: elision
//     rewrote each duplicate into a distinct marker, so dedup saw no duplicates.)
//   - elision is recoverable + signal-preserving but still lossy on the wire.
//   - midSummarize is the most aggressive/lossy and runs last.
//
// Each strategy is gated by (a) being enabled in config, (b) being permitted by
// current quality headroom (when rolling degradation has reached the budget, only
// the mildest non-lossy ops are allowed), and (c) the per-strategy quality gate
// supplied via input.strategyAllowed. Question-relevant and durable blocks are
// protected from the LOSSY strategies (elision/midSummarize); dedup is loss-free
// (keeps a verbatim copy) so it ignores protection. The body is mutated in place
// by the adapter refs; we recount tokens before and after to report real savings.
import type {
  Compactor,
  CompactionInput,
  CompactionResult,
} from '../types.js';
import { applyElision } from './elision.js';
import { applyDedup } from './dedup.js';
import { applyMidSummarize } from './midsummarize.js';
import { queryTerms, relevanceScore, looksDurable } from './relevance.js';

export { PIN_SENTINEL, isPinnedText, isAutoPinned, looksDurable } from './pin.js';
export { applyElision } from './elision.js';
export { applyDedup } from './dedup.js';
export { applyMidSummarize } from './midsummarize.js';

/**
 * Relevance threshold: a block whose fraction of latest-question terms present
 * reaches this is considered on-topic and is protected from removal. Tunable.
 */
const RELEVANCE_PROTECT_THRESHOLD = 0.34;

export class DefaultCompactor implements Compactor {
  async maybeCompact(input: CompactionInput): Promise<CompactionResult> {
    const { body, adapter, counter, config } = input;
    const tokensBefore = adapter.countInputTokens(body, counter);

    // Compaction globally disabled — pass through untouched.
    if (!config.compaction.enabled) {
      return unchanged(body, tokensBefore);
    }

    // Trigger gate: explicit force, or utilization at/above the configured threshold.
    const trigger = input.force === true || input.utilization >= config.contextUtilizationThreshold;
    if (!trigger) {
      return unchanged(body, tokensBefore);
    }

    // Quality headroom gate. If we've already burned through the degradation
    // budget, restrict to the safe/mild ops only (no midSummarize, no dedup of
    // anything risky — though dedup itself is loss-free, we keep the historical
    // conservative behavior of pausing all but elision when over budget).
    const overBudget =
      input.rollingDegradationPct != null &&
      input.rollingDegradationPct >= config.qualityBudget.maxDegradationPct;

    // Per-strategy gate from the quality guard (defaults to allow-all when absent).
    const gateAllows = (s: string): boolean =>
      typeof input.strategyAllowed === 'function' ? input.strategyAllowed(s) !== false : true;

    const strategies = config.compaction.strategies;
    const allowDedup = !overBudget && strategies.dedup && gateAllows('dedup');
    const allowElision = strategies.elision && gateAllows('elision');
    const allowMidSummarize =
      !overBudget &&
      strategies.midSummarize &&
      typeof input.summarize === 'function' &&
      gateAllows('midSummarize');

    // Relevance-protection: shield blocks lexically on-topic for the latest user
    // question from removal. Durable config-like facts are always protected too.
    const protect = buildProtector(input, config);

    // Cache-prefix protection (Claude Code prompt caching). When enabled, compute
    // the last message index covered by a provider cache breakpoint; everything at
    // or before it is IMMUTABLE — rewriting it invalidates the prompt cache and can
    // make the request cost MORE (cached input is ~10% of normal). We pass this
    // boundary to dedup + elision so they skip any ref in the cached prefix.
    //
    // Defensive note re: thinking/signed blocks: the adapters already exclude
    // extended-thinking and signature-bearing blocks from the editable refs (see
    // isSignedOrThinkingBlock in providers.ts), so they never surface here as
    // compactable. The cache-boundary guard is an additional, independent layer:
    // even an unsigned text block sharing a cached-prefix message is left untouched.
    const cacheBoundaryIndex = computeCacheBoundary(input, config);

    const applied: string[] = [];

    // 1) Dedup first — loss-free, sees the original (un-mangled) repeated blocks.
    //    Dedup keeps the freshest copy VERBATIM, so the information survives
    //    regardless of relevance/durability. Relevance-protection therefore does
    //    NOT apply to dedup (only the lossy strategies below honor `protect`);
    //    gating dedup by relevance was shielding on-topic duplicates and leaving
    //    free, zero-risk savings on the table.
    if (allowDedup) {
      const r = applyDedup(body, adapter, counter, config, {
        protect: () => false,
        cacheBoundaryIndex,
      });
      if (r.applied) applied.push('dedup');
    }

    // 2) Elision — recoverable, signal-preserving; threads the store + protector.
    if (allowElision) {
      const r = applyElision(body, adapter, counter, config, {
        store: config.compaction.recoverable ? input.store : undefined,
        sessionId: deriveSessionId(input),
        protect,
        cacheBoundaryIndex,
      });
      if (r.applied) applied.push('elision');
    }

    // 3) Mid-history summarization — most aggressive, runs last.
    if (allowMidSummarize) {
      const r = await applyMidSummarize(body, adapter, counter, config, input.summarize);
      if (r.applied) applied.push('midSummarize');
    }

    // Authoritative savings come from a fresh recount of the (mutated) body.
    const tokensAfter = adapter.countInputTokens(body, counter);

    return {
      body,
      applied,
      tokensBefore,
      tokensAfter,
      tokensSaved: Math.max(0, tokensBefore - tokensAfter),
      changed: applied.length > 0,
    };
  }
}

/**
 * Build the per-block protection predicate. A block is protected when it is a
 * durable config-like fact, OR (when relevance-protection is enabled and a latest
 * question is present) when it scores at/above the relevance threshold for the
 * latest user question. Returns a predicate that never throws.
 */
function buildProtector(
  input: CompactionInput,
  config: typeof input.config,
): (text: string) => boolean {
  const relevanceOn =
    config.compaction.relevanceProtect === true &&
    typeof input.latestQuestion === 'string' &&
    input.latestQuestion.length > 0;
  const terms = relevanceOn ? queryTerms(input.latestQuestion as string) : undefined;

  return (text: string): boolean => {
    try {
      // Always protect durable facts (auto-pin already covers this in dedup/elision,
      // but keep it here so the protector alone is sufficient for any caller).
      if (looksDurable(text)) return true;
      if (terms && terms.size > 0 && relevanceScore(text, terms) >= RELEVANCE_PROTECT_THRESHOLD) {
        return true;
      }
      return false;
    } catch {
      // Never let protection logic throw on the request path; default to NOT
      // protecting so compaction can still proceed (fail toward savings, since
      // the block is recoverable anyway).
      return false;
    }
  };
}

/**
 * Compute the cache-prefix boundary (last message index covered by a provider
 * cache breakpoint) when protection is enabled, else -1. Never throws: a
 * misbehaving adapter degrades to -1 (no protection) so compaction still runs —
 * but a thrown adapter is itself caught upstream, so the only failure mode here
 * is a non-numeric return, which we coerce to -1.
 */
function computeCacheBoundary(
  input: CompactionInput,
  config: typeof input.config,
): number {
  if (config.compaction.protectCachedPrefix !== true) return -1;
  try {
    const b = input.adapter.cacheBoundaryIndex(input.body);
    return typeof b === 'number' && Number.isFinite(b) ? b : -1;
  } catch {
    return -1;
  }
}

/**
 * Derive a session id for recoverable paging. CompactionInput does not carry a
 * sessionId field in the contract, so we fall back to the conventional 'proxy'
 * label; if a future caller attaches one we read it defensively.
 */
function deriveSessionId(input: CompactionInput): string {
  const maybe = (input as { sessionId?: unknown }).sessionId;
  return typeof maybe === 'string' && maybe.length > 0 ? maybe : 'proxy';
}

/** Build a no-op result where before/after are equal and nothing was applied. */
function unchanged(body: unknown, tokens: number): CompactionResult {
  return {
    body,
    applied: [],
    tokensBefore: tokens,
    tokensAfter: tokens,
    tokensSaved: 0,
    changed: false,
  };
}
