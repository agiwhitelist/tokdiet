# Context as Virtual Memory for LLMs

**Status:** Design north-star + roadmap. Some pieces ship this iteration (marked **NOW**); the rest is **ROADMAP**.
**Scope:** This document is design-only. It defines the model, the data structures, and the eventual APIs. It does not prescribe special-casing for any benchmark.

---

## 0. The thesis

Today's compaction is **delete-and-pray**. When the context window fills, we throw away the bulky
parts and hope the model didn't need them. Our own honest A/B benchmark on MiniMax-M3 (24 tasks)
proves the danger: baseline accuracy **100% → governed 79% (-21 pts)**. The failure modes were not
subtle:

- **Elision destroyed buried facts.** A tool result was replaced by a marker holding only the first
  120 characters of head text (`elisionMarker` in `src/compactor/elision.ts`). Anything past char 120
  — an error code on line 40, an id three paragraphs down — was gone forever. The `needle-old-junk`
  class scored **0/4**.
- **Dedup, the *safe* op, never fired (0/5).** Agents re-paste near-identical files, but the dedup
  pass (`src/compactor/dedup.ts`) compares **exact normalized-whitespace equality**. A one-character
  diff (a changed line number, a re-run timestamp) defeats it. So we shipped the *risky* savings
  (elision) and skipped the *free* ones (dedup).
- **No recovery, no relevance awareness.** Once a block was elided it could not be recovered, and we
  never checked whether the block we were about to gut was the very thing the user just asked about.

The reframe: **context is virtual memory, and the model is the CPU.** A finite, expensive resource
(the window) is backed by a larger, cheaper store (local SQLite). We don't *delete* pages — we
**evict** them to backing store and keep a recoverable stub. Three residency tiers:

| Tier | What lives here | Policy |
|------|-----------------|--------|
| **Hot** | recent turns, pinned content, blocks lexically relevant to the latest question | resident, untouched |
| **Warm** | older content that *might* be relevant | compressed in place (signal-preserving stub), indexed, page-in on demand |
| **Cold** | stale or redundant content | evicted to the `elided_blobs` store as a stub, recoverable by id |

The job of the Governor is no longer "shrink the payload." It is **page replacement with a quality
guarantee**: maximize savings from low-risk evictions, make every eviction recoverable and
signal-preserving, and never evict a hot page.

---

## 1. What the model already gives us

The contract (`src/types.ts`) was extended to support this model. The doc builds on these primitives;
it does not redefine them.

- `CompactionConfig`: `elisionPreviewChars`, `elisionSalientLines`, `relevanceProtect`, `recoverable`.
- `CompactionInput`: optional `store?: Store`, `strategyAllowed?: (s) => boolean`, `latestQuestion?: string`.
- `Store`: `recordElidedBlob(blob: ElidedBlob): void` and `getElidedBlob(id): string | undefined`,
  plus the `ElidedBlob` type `{ id, sessionId, ts, tokens, content }`.
- `QualityGuard`: `isStrategyAllowed(strategy: string): boolean`.

The backing store already exists. `src/store.ts` defines the **`elided_blobs` table**:

```sql
CREATE TABLE IF NOT EXISTS elided_blobs (
  id        TEXT    PRIMARY KEY,   -- content-addressed handle, embedded in the marker
  sessionId TEXT    NOT NULL,
  ts        INTEGER NOT NULL,
  tokens    INTEGER NOT NULL,      -- original size, for "N tokens saved" accounting
  content   TEXT    NOT NULL       -- the full, verbatim paged-out body
);
CREATE INDEX IF NOT EXISTS idx_elided_blobs_sessionId ON elided_blobs(sessionId);
```

This is the **page table**. The marker the model sees is the **page-table entry**; the row is the
**physical page** in backing store.

---

## 2. The marker format (the page-table entry)

Today's marker (`[ctxgov: tool result elided — N tokens saved. preview: <120 chars>…]`) is a dead
end: not recoverable (no id) and not signal-preserving (head-only). The new marker is a structured,
self-describing **page-table entry**.

```
[ctxgov:paged id=cgv_3f9a2b kind=tool_result tokens=1840 recoverable=1
 preview: <first elisionPreviewChars chars, whitespace-collapsed>
 salient:
   • Error: ENOENT open '/etc/app/conf.yaml'
   • build_id=20260615-7c1
   • https://api.example.com/v3/orders
   • exit code 137
 (full content recoverable by id cgv_3f9a2b)]
```

Fields:

- **`id`** — opaque handle (`cgv_` + short content hash). The key into `elided_blobs`. Stable across
  re-paste of identical content (content-addressed), so the same blob is never stored twice.
- **`kind`** — `tool_result` | `text_chunk` | `message`, so page-fault recovery and the dashboard
  know what they're restoring.
- **`tokens`** — original token count (drives the savings ledger).
- **`recoverable`** — `1` when the full body was persisted (`config.compaction.recoverable === true`
  and a `store` was provided), `0` when running storeless (the stub is then best-effort signal only).
- **`preview`** — first `elisionPreviewChars` characters (config-tunable; replaces the hardcoded 120).
- **`salient`** — up to `elisionSalientLines` extracted **high-signal lines**. This is the core fix
  for `needle-old-junk`: a buried error/id/number/URL/path survives the page-out.

### 2.1 Salient-line extraction (signal preservation)

A general, content-agnostic ranker over the block's lines. **It must work on arbitrary tool dumps and
logs — not be tuned to any benchmark.** Score each line by presence of:

- error/exception markers: `error`, `exception`, `failed`, `panic`, `traceback`, `warning`, `fatal`,
  non-zero `exit code`, stack-frame shapes (`at <fn> (<file>:<line>)`);
- structured identifiers: `KEY=VALUE`, `key: value`, JSON-ish `"key": value`, UUIDs, hex/sha hashes,
  long digit runs, semver, ISO timestamps;
- locators: URLs, file paths, line:col references;
- numbers with units / currency / percentages.

Take the top `elisionSalientLines` by score, dedupe, preserve original order. Lines are quoted from
the **original** text, never paraphrased — this is lossless capture of the signal subset, so it can't
hallucinate. A block with no salient lines (pure prose filler) is the *safest* thing to evict and
gets a preview-only stub.

> **Why a stub at all, not just an id?** The model frequently reasons over the stub *without* faulting
> the page back in. A good stub (preview + salient lines) answers "what was here?" in-band for the
> common case; the id is the escape hatch for the rare case where the model needs the verbatim body.

---

## 3. Page-fault recovery (ROADMAP)

A page fault is "the model needs a page that isn't resident." Two detectors:

1. **Explicit-reference fault.** A later request body contains a paged-out id (`cgv_…`) verbatim — the
   model (or a tool) quoted the marker back. We look it up and re-inject.
2. **Implicit-complaint fault.** The model's *answer* says some variant of "that was elided / I don't
   have that content / the output was truncated / cannot see the full result." We already reassemble
   the streamed answer for shadow-eval (`extractStreamDeltaText` / `extractAnswerText` on the
   adapter), so this signal is available on the response path at no extra cost.

### 3.1 The page-fault API (eventual)

```ts
// Resolve a paged-out id back to its physical page.
interface PageFaultResolver {
  // Returns the verbatim content for a marker id, or undefined if not recoverable.
  resolve(id: string): string | undefined;            // -> store.getElidedBlob(id)
  // Scan a request body for paged ids and return the set referenced this turn.
  referencedIds(body: unknown, adapter: ProviderAdapter): string[];
  // Re-inject resolved content in place of its stub, within a token budget.
  pageIn(body: unknown, ids: string[], budgetTokens: number): { restored: string[]; tokens: number };
}
```

Recovery is **demand paging with a budget**: re-inject only the faulted pages, newest-first, until a
re-inflation budget (a fraction of the freed window) is hit — never re-inflate the whole history.
A fault increments a per-id `faultCount`; pages that fault repeatedly are promoted back toward *hot*
and exempted from future eviction this session (working-set learning, §6).

---

## 4. Retrieval, not deletion (ROADMAP)

Page-fault recovery is reactive. The proactive version is **RAG over the conversation's own history.**
When a turn arrives:

1. Take `latestQuestion` (already plumbed into `CompactionInput`).
2. Rank every paged-out `elided_blobs` row for this `sessionId` against the question.
   - **v1:** BM25 over a tokenized index of paged content (no extra deps, deterministic, auditable).
   - **v2:** local embeddings; the existing `shadowEval.judge: 'embedding'` path shows we're already
     willing to run an embedder.
3. If a cold page scores above threshold, **page in its relevant slice** (the matching window, not the
   whole blob) into the hot tier *before* the request forwards upstream.

This closes the loop: we evict aggressively because we can always pull the right slice back
just-in-time. The window holds the **working set**, the store holds the **corpus**, and the question
is the query.

`relevanceProtect` (**NOW**, §5.3) is the cheap precursor: don't evict what's obviously on-topic in
the first place. Retrieval is the expensive, higher-recall successor: pull back what we *did* evict
when it turns out to matter.

---

## 5. What ships NOW (this iteration)

Ordered mildest-first, matching the pipeline in `src/compactor/index.ts` (elision → dedup →
midSummarize). Every strategy still mutates the body in place via adapter refs and recounts tokens
for authoritative savings.

### 5.1 Recoverable, signal-preserving elision (**NOW**) — fixes `needle-old-junk` 0/4

In `applyElision`, for each eligible (old, large, non-pinned) tool result:

1. If `config.compaction.recoverable && input.store`: mint a content-addressed `id`, call
   `store.recordElidedBlob({ id, sessionId, ts, tokens, content: ref.text })`.
2. Build the structured marker (§2) with `elisionPreviewChars` preview + `elisionSalientLines`
   salient lines extracted from `ref.text`.
3. `ref.replace(marker)`; account `delta = tokens(orig) - tokens(marker)`; only commit when `delta > 0`.

Net effect: the same window savings as before, but a buried needle now survives in the salient block,
and the verbatim body is one `getElidedBlob(id)` away. Storeless / `recoverable=false` degrades
gracefully to preview+salient (still strictly better than head-only).

### 5.2 Near-duplicate (semantic) dedup (**NOW**) — fixes dedup 0/5

Replace exact-equality matching with **near-duplicate collapse** so a re-pasted file with a one-line
diff is still caught.

- Compute a **SimHash / MinHash** signature over each chunk's shingles (token n-grams).
- Two chunks are near-duplicates when Hamming distance (SimHash) is below a small threshold, or
  Jaccard estimate (MinHash) is above a high one (e.g. ≥ 0.9). Bucket by signature band (LSH) so
  comparison stays roughly linear, not O(n²).
- Keep the **last (freshest)** occurrence verbatim (preserves the existing recency rule), and for each
  earlier near-duplicate emit a marker that **also carries the tiny diff** against the kept copy:

  ```
  [ctxgov:dup of cgv_<keptId> — 1840 tokens elided; diff vs kept:
     - line 42: const PORT = 3000
     + line 42: const PORT = 8080]
  ```

  The diff makes dedup **lossless even when the copies aren't identical** — the earlier version's
  unique bytes survive in the marker. This is what makes near-dup dedup *safe* enough to be the
  low-risk default, instead of a silent-corruption risk.

Dedup is the **lowest-risk, highest-free-savings** op (the agent already has a fresher copy resident),
so it should run unconditionally whenever enabled — and §0 shows it was leaving money on the table.

### 5.3 Relevance protection (**NOW**) — shields the hot tier

When `config.compaction.relevanceProtect && input.latestQuestion`:

- Build a lightweight lexical model of the question (lower-cased word set + key bigrams, reusing the
  primitives already in `src/quality/similarity.ts`).
- Before eliding/deduping/summarizing a block, score block-vs-question similarity. If it clears a
  protection threshold, **mark the block hot and skip it** this turn.

This is a precision guard, not recall: it only *prevents* eviction of on-topic content. It directly
addresses the recent-needle regression — the block the user is asking about stays resident verbatim.
General by construction (pure lexical overlap; no benchmark knowledge).

### 5.4 Per-strategy safe-mode backoff (**NOW**) — auto-protects quality

`QualityGuard.isStrategyAllowed(strategy)` exists in the contract but `src/quality/guard.ts` tracks
only one global `RollingAverage`. Extend it to a **per-strategy** rolling window keyed by the
`strategy` field already recorded on every `ShadowEvalEvent`:

- Maintain `Map<strategy, RollingAverage>`.
- `isStrategyAllowed(s)` returns `false` once strategy `s`'s rolling degradation exceeds the quality
  budget — independently of the others.
- The compactor consults `input.strategyAllowed?.(s)` per strategy (the field is already on
  `CompactionInput`).

Result: if elision is hurting quality but dedup is clean, we **back off elision only** and keep
banking dedup's free savings — instead of today's all-or-nothing global safe mode. This is the
per-strategy auto-backoff the north-star calls for.

### 5.5 Wiring (**NOW**)

`src/proxy.ts` currently calls `maybeCompact` with `{ body, adapter, counter, config,
rollingDegradationPct, utilization, force, summarize }` (around line 465) and does **not** yet pass
`store`, `latestQuestion`, or `strategyAllowed`. Shipping 5.1–5.4 requires threading those three
through:

- `store: config.compaction.recoverable ? store : undefined`
- `latestQuestion: adapter`-extracted last user message text
- `strategyAllowed: (s) => qualityGuard.isStrategyAllowed(s)`

All three are additive and fail-open: absent `store` → non-recoverable stubs; absent `latestQuestion`
→ no relevance protection; absent `strategyAllowed` → all enabled strategies run (today's behavior).

---

## 6. The proof IS the product

The Governor's differentiator is not that it compacts — it's that it can **prove it didn't hurt you.**

### 6.1 The quality ledger (auditable before/after)

Every eviction is already half-logged: `requests` carries `tokensSaved` / `strategies` /
`qualityScore`, and `shadow_evals` carries per-strategy `degradationPct` with `baselineTokens` /
`compactedTokens`. With `elided_blobs` we now hold the **verbatim before** for every paged-out block.
Together these form a **cryptographically-anchorable quality ledger**:

- For a shadow-evaluated request, store `hash(originalBody)` and `hash(compactedBody)` alongside the
  measured degradation. The pair (before-hash, after-hash, degradation, strategy) is a tamper-evident
  receipt: "we changed exactly this, and here is the measured quality cost."
- Because paged-out content is recoverable by id, an auditor can **reconstruct the exact compacted
  context** that produced any answer and independently re-score it. The product's headline claim
  ("-X% tokens at ≤ Y% degradation") is then *verifiable*, not asserted.

### 6.2 Per-strategy safe-mode (the live guarantee)

§5.4 turns the ledger into a **control loop**: each strategy's measured degradation feeds back into
whether it's allowed to run. Safe, measured strategies stay on; a strategy that starts hurting backs
itself off automatically. The guarantee is enforced continuously, not just reported after the fact.

---

## 7. Self-calibrating per-repo policy (ROADMAP)

Aggressiveness should not be one global knob. Different content classes carry different risk:
verbose CI logs are nearly free to evict; a carefully-pinned spec is not.

- Classify each block by content-class (tool-result-log, source-file, prose, structured-data).
- From shadow-eval outcomes, learn a per-(repo, content-class) degradation distribution.
- Tune per-class thresholds (`minToolResultTokens`, dedup similarity cutoff, relevance threshold) from
  those outcomes — shadow-eval becomes the training signal for the policy that governs the next turn.
- Working-set learning (§3.1): ids that fault repeatedly in a repo get more eviction-resistant.

This is the long game: a Governor that, per repo, *knows* which pages are cold and which are load-
bearing, and pages accordingly.

---

## 8. Data structures & APIs at a glance

**Backing store (NOW, exists):** `elided_blobs(id PK, sessionId, ts, tokens, content)` — the page
table. `recordElidedBlob` writes a page; `getElidedBlob(id)` faults it back.

**Marker / page-table entry (NOW):** structured `[ctxgov:paged id=… kind=… tokens=… recoverable=…
preview:… salient:…]` (§2) for elision; `[ctxgov:dup of <id> … diff:…]` (§5.2) for dedup.

**Per-strategy guard (NOW):** `Map<strategy, RollingAverage>` behind `isStrategyAllowed` (§5.4).

**Near-dup index (NOW):** SimHash/MinHash LSH buckets over chunk shingles (§5.2), per-request scope.

**Page-fault resolver (ROADMAP):** `resolve(id)` / `referencedIds(body)` / `pageIn(body, ids, budget)`
(§3.1), with per-id `faultCount`.

**Retrieval index (ROADMAP):** BM25→embedding over `elided_blobs` per session, queried by
`latestQuestion` (§4).

**Policy learner (ROADMAP):** per-(repo, content-class) thresholds tuned from `shadow_evals` (§7).

---

## 9. Non-goals / integrity guardrails

- **No benchmark overfitting.** Salient-line scoring, near-dup signatures, and relevance protection
  are all general, content-agnostic heuristics. They must be validated on arbitrary logs/tool dumps,
  never tuned to specific test fixtures.
- **Never throw on the request path.** Every new step (store write, salient extraction, signature,
  diff, relevance scoring) is wrapped fail-open: on any error, fall back to the previous, safe
  behavior (at worst, today's marker / no protection / all-strategies-on).
- **Recoverability is opt-in but default-good.** With `recoverable=false` or no `store`, stubs still
  carry preview+salient — strictly better than the head-only marker that caused `needle-old-junk` 0/4.
