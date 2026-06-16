// src/pagefault.ts — context "page-fault" recovery.
//
// Compaction can page out a large tool result, replacing it with a recoverable
// elision marker that carries a content-addressed id (`id=cg-...`) pointing at the
// full block persisted in the store. If the model then answers in a way that shows
// it NEEDED that paged-out content — it echoes one of our paged-out ids, or
// complains the content "was elided / is not present / cannot find it" — we treat
// that like a virtual-memory page fault: restore the original block(s) from the
// store and re-send the request once.
//
// This module holds the pure, network-free pieces (detection + restoration) so they
// can be unit-tested directly; the proxy wires them to the upstream re-send.
//
// IMPORTANT (NodeNext ESM): relative imports end in ".js".
import type { ProviderAdapter, Store, TokenCounter } from './types.js';

/**
 * Matches a recoverable elision marker's id clause, e.g.
 *   [ctxgov: paged out 1234 tokens — id=cg-ab12cd34ef. head: ...]
 * The id is `cg-` followed by hex/length chars (see blobId in elision.ts). Global
 * + case-insensitive so we can scan an entire answer or marker for every id.
 */
const RE_ELIDED_ID = /\bid=(cg-[a-z0-9]+)/gi;

/**
 * Phrases that signal the model is missing content we paged out. Deliberately
 * conservative: each is a clear "I don't have / it was removed / I can't find it"
 * complaint, not merely a topic mention. Case-insensitive.
 */
const RE_FAULT_COMPLAINT = new RegExp(
  [
    'was elided',
    'were elided',
    'has been elided',
    'have been elided',
    'content was (?:removed|omitted|truncated|cut off)',
    'paged out',
    "(?:don't|do not|doesn't|does not) have (?:the|that|this|access to)",
    '(?:is|are|was|were) not (?:present|included|available|shown)',
    "(?:cannot|can't|could not|couldn't|unable to) (?:find|see|access|locate)",
    'no longer (?:have|present|available|shown)',
  ].join('|'),
  'i',
);

/** Collect every distinct `cg-...` elision id referenced in a string. */
export function elidedIdsIn(text: string): Set<string> {
  const ids = new Set<string>();
  if (typeof text !== 'string' || text.length === 0) return ids;
  RE_ELIDED_ID.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE_ELIDED_ID.exec(text)) !== null) {
    if (m[1]) ids.add(m[1]);
  }
  return ids;
}

/**
 * Decide whether the model's answer signals a page fault against the paged-out
 * blocks present in the compacted body. Returns true when EITHER:
 *   (a) the answer text echoes one of the paged-out ids that is actually present
 *       in the compacted body (the model is referencing our marker), OR
 *   (b) the body still contains at least one paged-out id AND the answer carries a
 *       clear "the content was elided / I can't find it / it's not present"
 *       complaint.
 * Never throws.
 */
export function detectPageFault(
  answerText: string,
  compactedBodyIds: Set<string>,
): boolean {
  if (compactedBodyIds.size === 0) return false;
  const answer = typeof answerText === 'string' ? answerText : '';
  // (a) The answer names one of our paged-out ids verbatim.
  for (const id of elidedIdsIn(answer)) {
    if (compactedBodyIds.has(id)) return true;
  }
  // (b) The answer complains about missing/elided content and we DO hold paged-out blobs.
  return RE_FAULT_COMPLAINT.test(answer);
}

/**
 * Restore paged-out blocks in a COMPACTED body in place. For every editable text /
 * tool-result ref whose text is a recoverable elision marker (`id=cg-...`) and
 * whose id resolves via store.getElidedBlob, replace the marker with the original
 * content. Mutates `body` (which must already be a clone the caller owns). Returns
 * the number of blocks restored. Never throws.
 *
 * Both ToolResultRef and TextChunkRef expose `text` + `replace(newText)`, so a
 * single pass over both ref kinds covers every place a marker could live.
 */
export function restoreElidedBlobs(
  body: unknown,
  adapter: ProviderAdapter,
  counter: TokenCounter,
  store: Pick<Store, 'getElidedBlob'>,
): number {
  let restored = 0;
  const seen = new Set<string>();

  const restoreFromRef = (ref: { text: string; replace(s: string): void }): void => {
    const ids = elidedIdsIn(ref.text);
    if (ids.size === 0) return;
    // A marker holds exactly one id; if a ref text carries multiple (defensive),
    // restore the first that resolves so we replace the whole marker once.
    for (const id of ids) {
      let content: string | undefined;
      try {
        content = store.getElidedBlob(id);
      } catch {
        content = undefined;
      }
      if (typeof content === 'string' && content.length > 0) {
        try {
          ref.replace(content);
          restored += 1;
        } catch {
          /* a misbehaving ref must never break recovery */
        }
        return;
      }
    }
    void seen;
  };

  try {
    for (const ref of adapter.listToolResults(body, counter)) {
      restoreFromRef(ref);
    }
  } catch {
    /* adapter failure must not break recovery */
  }
  try {
    for (const ref of adapter.listTextChunks(body, counter)) {
      restoreFromRef(ref);
    }
  } catch {
    /* adapter failure must not break recovery */
  }

  return restored;
}
