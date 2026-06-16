// src/proxy.ts — the interceptor. Sits between an agent tool and the model API,
// metering tokens/cost, optionally compacting bloated context, and proving (via
// shadow eval) that quality didn't drop.
//
// Design tenets:
//  - FAIL-OPEN: the governor must NEVER break the user's workflow. Any internal
//    error degrades to a transparent passthrough of the original request bytes.
//  - UNBUFFERED RESPONSES: upstream output is piped straight back to the client
//    while a tee parses usage out-of-band, so latency is not added.
//  - SECRET HYGIENE: x-api-key / authorization are forwarded but never logged or
//    persisted.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as undiciRequest, type Dispatcher } from 'undici';
import type {
  EventBus,
  GovernorConfig,
  Pricing,
  ProviderAdapter,
  ProviderId,
  RequestEvent,
  RequestMeta,
  Store,
  TokenCounter,
  UsageCounts,
} from './types.js';
import { DEFAULT_CONTEXT_WINDOW } from './config.js';
import { detectProvider, anthropic as anthropicAdapter } from './providers.js';
import { DefaultTokenCounter, approxTokens } from './tokenizer.js';
import { DefaultCompactor } from './compactor/index.js';
import { DefaultQualityGuard } from './quality/guard.js';
import { heuristicJudge, makeLlmJudge } from './quality/similarity.js';
import { BudgetEnforcer } from './budget.js';
import { DefaultSessionTracker } from './session.js';
import { detectPageFault, elidedIdsIn, restoreElidedBlobs } from './pagefault.js';

/** Options accepted by {@link startProxy}. */
export interface StartProxyOptions {
  config: GovernorConfig;
  store: Store;
  bus: EventBus;
  pricing: Pricing;
}

/** Handle returned from {@link startProxy}. */
export interface ProxyHandle {
  close(): Promise<void> | void;
  /**
   * The bound port. Reads the live socket address, so when `proxyPort: 0`
   * (ephemeral) is used this reflects the OS-assigned port once the server is
   * listening. Await {@link ProxyHandle.whenReady} if you need it synchronously
   * after start.
   */
  port: number;
  /** Resolves with the actual bound port once the server is accepting connections. */
  whenReady: Promise<number>;
}

/**
 * Headers that must never be copied verbatim or recomputed wrong on forward.
 *
 * `accept-encoding` is stripped so the upstream returns identity-encoded bytes:
 * undici's request() (unlike fetch()) does NOT auto-decompress, and we strip
 * `content-encoding` on the way back, so forwarding the client's gzip/br accept
 * would hand the client compressed bytes with no content-encoding header — a
 * broken stream — and would also feed compressed bytes to the usage/answer
 * parsers. Asking upstream for identity keeps the proxy transparent and the
 * metering honest.
 */
const STRIP_REQUEST_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
  'accept-encoding',
]);

/** Max bytes we will buffer for an inbound request body (defensive cap, ~64MB). */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** Read the entire request body into a Buffer, capped for safety. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Lower-case a Node header map into a flat Record<string,string>. */
function lowerHeaders(raw: NodeJS.Dict<string | string[]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

/** Coerce a Node request method into undici's HttpMethod (defaulting to POST). */
function httpMethod(m: string | undefined): Dispatcher.HttpMethod {
  return (m ?? 'POST').toUpperCase() as Dispatcher.HttpMethod;
}

/** Split a request target into path (query stripped) and the raw query (incl. leading '?'). */
function splitPathQuery(url: string): { path: string; query: string } {
  const q = url.indexOf('?');
  if (q < 0) return { path: url, query: '' };
  return { path: url.slice(0, q), query: url.slice(q) };
}

/**
 * Remove the `alt=sse` parameter from a raw query string (incl. leading '?').
 * Used to turn a Gemini streaming baseline call into a real JSON call. Returns
 * '' when no params remain, otherwise a normalized '?...' query.
 */
function stripAltSse(query: string): string {
  if (!query) return query;
  const raw = query.startsWith('?') ? query.slice(1) : query;
  const kept = raw
    .split('&')
    .filter((pair) => pair.length > 0 && pair.toLowerCase() !== 'alt=sse');
  return kept.length > 0 ? '?' + kept.join('&') : '';
}

/** Best-effort JSON parse; returns undefined on any failure (never throws). */
function tryParseJson(buf: Buffer): unknown {
  if (buf.length === 0) return undefined;
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return undefined;
  }
}

/** Build the headers to forward upstream: copy all but stripped ones, set JSON content-type. */
function buildForwardHeaders(
  inbound: Record<string, string>,
  bodyByteLength: number,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(inbound)) {
    if (STRIP_REQUEST_HEADERS.has(k)) continue;
    out[k] = v;
  }
  out['content-type'] = 'application/json';
  out['content-length'] = String(bodyByteLength);
  return out;
}

/** Whether the upstream response is an SSE stream (by content-type). */
function isEventStream(headers: Record<string, string | string[] | undefined>): boolean {
  const ct = headers['content-type'];
  const s = Array.isArray(ct) ? ct.join(' ') : ct ?? '';
  return s.toLowerCase().includes('text/event-stream');
}

/** Convert undici response headers into a plain outbound header map (drop hop-by-hop). */
function outboundHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    const lk = k.toLowerCase();
    if (lk === 'connection' || lk === 'transfer-encoding' || lk === 'content-length' || lk === 'content-encoding') {
      continue;
    }
    out[lk] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

/**
 * Incrementally parse SSE bytes into (event, data) pairs and feed adapter usage
 * accumulation. A stateful parser kept across chunks (events may straddle a
 * chunk boundary). Robust: malformed data lines are skipped silently.
 */
class SseUsageTee {
  private buffer = '';
  private eventName: string | undefined;
  private answerParts: string[] = [];
  readonly usage: UsageCounts = { inputTokens: 0, outputTokens: 0 };

  constructor(private readonly adapter: ProviderAdapter) {}

  /** The reassembled assistant answer text accumulated across stream deltas. */
  get answerText(): string {
    return this.answerParts.join('');
  }

  /** Feed a chunk of raw SSE bytes. */
  push(chunk: Buffer | string): void {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let nl: number;
    // Process complete lines; keep the trailing partial line in the buffer.
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, '');
      this.buffer = this.buffer.slice(nl + 1);
      this.consumeLine(line);
    }
  }

  private consumeLine(line: string): void {
    if (line.length === 0) {
      // Blank line ends an event; reset the event name.
      this.eventName = undefined;
      return;
    }
    if (line.startsWith(':')) return; // comment / heartbeat
    if (line.startsWith('event:')) {
      this.eventName = line.slice('event:'.length).trim();
      return;
    }
    if (line.startsWith('data:')) {
      const raw = line.slice('data:'.length).trim();
      if (raw === '[DONE]' || raw.length === 0) return;
      let data: unknown;
      try {
        data = JSON.parse(raw);
      } catch {
        return;
      }
      try {
        this.adapter.parseUsageFromStreamEvent(this.eventName, data, this.usage);
      } catch {
        // A misbehaving adapter must never break the proxy.
      }
      try {
        const delta = this.adapter.extractStreamDeltaText(this.eventName, data);
        if (delta) this.answerParts.push(delta);
      } catch {
        // A misbehaving adapter must never break the proxy.
      }
    }
  }
}

/** Pull the bearer/secret-free model id for a Gemini-style path-encoded request. */
function resolveModel(adapter: ProviderAdapter, body: unknown, meta: RequestMeta): string | undefined {
  try {
    return adapter.getModel(body, meta);
  } catch {
    return undefined;
  }
}

/**
 * Best-effort extraction of the LAST user-message text from a request body, via
 * the adapter's `listMessages`. Used to drive relevance-protection (shield blocks
 * lexically on-topic for the latest user turn). Never throws; returns '' when no
 * user message text is found.
 */
function latestUserQuestion(
  adapter: ProviderAdapter,
  body: unknown,
  counter: TokenCounter,
): string {
  try {
    const messages = adapter.listMessages(body, counter);
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m && m.role === 'user' && typeof m.text === 'string' && m.text.length > 0) {
        return m.text;
      }
    }
  } catch {
    // A misbehaving adapter must never break the compaction path.
  }
  return '';
}

/** Build the soft 429 budget-exceeded error body (matches the contract wording). */
function budgetErrorBody(scope: string, spentUSD: number, limitUSD: number): string {
  return JSON.stringify({
    error: {
      type: 'ctxgov_budget_exceeded',
      message:
        `tokdiet: budget exceeded for scope ${scope} ` +
        `($${spentUSD.toFixed(2)}/$${limitUSD.toFixed(2)}). ` +
        'Raise it in tokdiet.config.json or run with a higher limit.',
    },
  });
}

/** Resolve the utilization window size (number, honoring 'auto'). */
function windowSizeFor(config: GovernorConfig): number {
  const w = config.contextWindowTokens;
  return w === 'auto' || typeof w !== 'number' || !Number.isFinite(w) || w <= 0
    ? DEFAULT_CONTEXT_WINDOW
    : w;
}

/**
 * Optional per-repo adaptive-backoff persistence on the store. These methods are
 * NOT part of the {@link Store} contract — the SqliteStore exposes them directly
 * for the quality guard's per-repo seed/backoff. Returns undefined when the store
 * does not implement them (e.g. an in-memory test double).
 */
interface RepoBackoffStore {
  recordRepoStrategyDegradation(repo: string, strategy: string, pct: number): void;
  repoStrategyDegradation(repo: string, strategy: string): { avgPct: number; samples: number } | undefined;
}

/** Narrow a Store to RepoBackoffStore if it implements the optional per-repo methods. */
function asRepoBackoffStore(store: Store): RepoBackoffStore | undefined {
  const s = store as unknown as Partial<RepoBackoffStore>;
  return typeof s.recordRepoStrategyDegradation === 'function' &&
    typeof s.repoStrategyDegradation === 'function'
    ? (s as RepoBackoffStore)
    : undefined;
}

/**
 * Repo identifier the proxy seeds per-repo backoff from at startup. A single
 * process-wide guard reads its repoSeed once, so we use the operator's repo
 * (CTXGOV_REPO) or the cwd as the realistic single-repo Claude Code default.
 */
function startupRepoId(): string {
  const fromEnv = process.env.TOKDIET_REPO || process.env.CTXGOV_REPO;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  try {
    return process.cwd();
  } catch {
    return 'unknown';
  }
}

/**
 * Start the interceptor proxy.
 *
 * Each inbound request is buffered, provider-detected, optionally budget-checked
 * and compacted, then forwarded upstream with the response streamed straight
 * back. Usage is parsed out-of-band and recorded. Any internal failure falls
 * back to a transparent passthrough so the user's workflow is never broken.
 */
export function startProxy(opts: StartProxyOptions): ProxyHandle {
  const { config, store, bus, pricing } = opts;
  const counter = new DefaultTokenCounter();
  const compactor = new DefaultCompactor();
  const tracker = new DefaultSessionTracker();
  const budget = new BudgetEnforcer({ store, config, bus });
  // LLM-judge: when configured, build a real judge from a cheap-model caller that
  // posts a tiny non-stream request to the same upstream (config.shadowEval.judgeModel).
  // Otherwise the guard falls back to its heuristic judge.
  const judge = config.shadowEval.judge === 'llm' ? makeLlmJudge(makeJudgeCaller()) : heuristicJudge;

  // Per-repo adaptive backoff seed/persist. The SqliteStore exposes
  // recordRepoStrategyDegradation / repoStrategyDegradation OUTSIDE the Store
  // interface, so detect them by capability (the in-memory test store may omit
  // them). The guard is a single process-wide instance; its repoSeed is read once
  // at construction, so we seed from the repo the proxy was started against
  // (CTXGOV_REPO, else cwd) — the realistic single-repo Claude Code case. Live
  // per-repo persistence is keyed by each request's actual repo in runShadowEval,
  // which is race-free (the repo is captured in that call's scope).
  const repoStore = asRepoBackoffStore(store);
  const startupRepo = startupRepoId();
  const qualityGuard = new DefaultQualityGuard({
    store,
    config,
    bus,
    judge,
    repo: startupRepo,
    repoSeed: repoStore
      ? (strategy: string) => {
          try {
            return repoStore.repoStrategyDegradation(startupRepo, strategy);
          } catch {
            return undefined;
          }
        }
      : undefined,
  });

  /** Build the llm-judge caller that asks the cheap judge model (best-effort). */
  function makeJudgeCaller(): (prompt: string) => Promise<string> {
    return async (prompt: string): Promise<string> => {
      const judgeModel = config.shadowEval.judgeModel;
      if (!judgeModel) return '';
      // Use the Anthropic adapter + upstream for the judge call (cheap haiku-class).
      const body = {
        model: judgeModel,
        max_tokens: 16,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
      };
      try {
        const url = anthropicAdapter.upstreamBaseUrl(process.env) + '/v1/messages';
        const res = await undiciRequest(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
          body: JSON.stringify(body),
        });
        const text = await res.body.text();
        const json: unknown = JSON.parse(text);
        return anthropicAdapter.extractAnswerText(json);
      } catch {
        return '';
      }
    };
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      // Absolute last-ditch guard; handle() already fails open internally.
      try {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
        if (!res.writableEnded) res.end(JSON.stringify({ error: { type: 'ctxgov_internal', message: 'proxy error' } }));
      } catch {
        // nothing more we can do
      }
    });
  });

  /** Forward the raw inbound bytes upstream untouched and stream the reply back. */
  async function transparentPassthrough(
    req: IncomingMessage,
    res: ServerResponse,
    rawBody: Buffer,
    inboundHeaders: Record<string, string>,
    path: string,
    query: string,
    adapter?: ProviderAdapter,
  ): Promise<void> {
    const base = (adapter ?? anthropicAdapter).upstreamBaseUrl(process.env);
    const url = base + path + query;
    const headers = buildForwardHeaders(inboundHeaders, rawBody.length);
    try {
      const upstream = await undiciRequest(url, {
        method: httpMethod(req.method),
        headers,
        body: rawBody.length > 0 ? rawBody : undefined,
      });
      if (!res.headersSent) {
        res.writeHead(upstream.statusCode, outboundHeaders(upstream.headers));
      }
      for await (const chunk of upstream.body) res.write(chunk);
      res.end();
    } catch {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      if (!res.writableEnded) res.end(JSON.stringify({ error: { type: 'ctxgov_upstream', message: 'upstream unreachable' } }));
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const startedAt = Date.now();
    const { path, query } = splitPathQuery(req.url ?? '/');
    const inboundHeaders = lowerHeaders(req.headers);
    let rawBody: Buffer;
    try {
      rawBody = await readBody(req);
    } catch {
      // Could not buffer the body — nothing safe to forward. End softly.
      if (!res.headersSent) res.writeHead(400, { 'content-type': 'application/json' });
      if (!res.writableEnded) res.end(JSON.stringify({ error: { type: 'ctxgov_bad_request', message: 'unreadable body' } }));
      return;
    }

    const meta: RequestMeta = { method: req.method ?? 'POST', path, headers: inboundHeaders };
    const parsed = tryParseJson(rawBody);

    // Provider detection requires a JSON body. Anything else -> transparent passthrough.
    const adapter = parsed !== undefined ? safeDetect(meta, parsed) : undefined;
    if (!adapter || parsed === null || typeof parsed !== 'object') {
      await transparentPassthrough(req, res, rawBody, inboundHeaders, path, query, adapter);
      return;
    }

    // From here on we are in the metered path. Wrap everything so any failure
    // falls back to a transparent passthrough of the ORIGINAL request bytes.
    try {
      await meteredHandle(req, res, rawBody, parsed, adapter, meta, path, query, startedAt);
    } catch {
      if (!res.headersSent) {
        // Nothing has been sent yet — safe to retry transparently.
        await transparentPassthrough(req, res, rawBody, inboundHeaders, path, query, adapter);
      } else if (!res.writableEnded) {
        try {
          res.end();
        } catch {
          /* ignore */
        }
      }
    }
  }

  /** Detection that never throws. */
  function safeDetect(meta: RequestMeta, body: unknown): ProviderAdapter | undefined {
    try {
      return detectProvider(meta, body);
    } catch {
      return undefined;
    }
  }

  async function meteredHandle(
    req: IncomingMessage,
    res: ServerResponse,
    rawBody: Buffer,
    parsedBody: object,
    adapter: ProviderAdapter,
    meta: RequestMeta,
    path: string,
    query: string,
    startedAt: number,
  ): Promise<void> {
    const provider: ProviderId = adapter.id;
    const model = resolveModel(adapter, parsedBody, meta);
    const sessionId = tracker.idFor(meta, parsedBody);
    const repo = tracker.repoFor(meta, parsedBody);
    const source = tracker.sourceFor(meta);

    // ── Budget gate ──────────────────────────────────────────────────────────
    const decision = budget.check(sessionId, repo, Date.now());
    let forceCompaction = false;
    if (decision.action === 'block') {
      const payload = budgetErrorBody(decision.scope, decision.spentUSD, decision.limitUSD);
      res.writeHead(429, {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(payload)),
      });
      res.end(payload);
      recordBlocked({ sessionId, provider, model, source, repo, startedAt });
      return;
    }
    if (decision.action === 'compact') forceCompaction = true;

    // ── Compaction ───────────────────────────────────────────────────────────
    // Keep a deep clone of the ORIGINAL body for shadow eval BEFORE compaction.
    let originalBody: unknown;
    try {
      originalBody = structuredClone(parsedBody);
    } catch {
      originalBody = JSON.parse(JSON.stringify(parsedBody)) as unknown;
    }

    const inputTokensBefore = safeCount(() => adapter.countInputTokens(parsedBody, counter), 0);
    const windowSize = windowSizeFor(config);
    const utilization = windowSize > 0 ? inputTokensBefore / windowSize : 0;

    let workingBody: unknown = parsedBody;
    let compChanged = false;
    let compApplied: string[] = [];
    let tokensSaved = 0;

    if (config.compaction.enabled && qualityGuard.isCompactionAllowed()) {
      try {
        const summarize = makeSummarizeFn(adapter);
        const result = await compactor.maybeCompact({
          body: parsedBody,
          adapter,
          counter,
          config,
          rollingDegradationPct: safeRolling(),
          utilization,
          force: forceCompaction,
          summarize,
          // Recoverable paging: hand the store to elision only when enabled, so
          // paged-out blocks are persisted and recoverable (context virtual mem).
          store: config.compaction.recoverable ? store : undefined,
          // Per-strategy quality gate: skip a strategy the guard has disabled.
          strategyAllowed: (s: string): boolean => {
            try {
              return qualityGuard.isStrategyAllowed(s);
            } catch {
              return true; // fail-open: never let the gate block compaction by erroring.
            }
          },
          // Relevance-protection input: the latest user question, used to shield
          // on-topic blocks from removal.
          latestQuestion: latestUserQuestion(adapter, parsedBody, counter),
        });
        workingBody = result.body;
        compChanged = result.changed;
        compApplied = result.applied;
        tokensSaved = result.tokensSaved;
      } catch {
        // Compaction failure: forward the original body untouched (fail-open).
        workingBody = parsedBody;
        compChanged = false;
        compApplied = [];
        tokensSaved = 0;
      }
    }

    // ── Forward upstream ───────────────────────────────────────────────────────
    // Track the wall time spent awaiting undici (request + response body read) so
    // proxyOverheadMs can subtract it from total handler time. Only the governor's
    // own work (compaction, parsing, recording) should count as overhead.
    let upstreamMs = 0;
    const outBuf = Buffer.from(JSON.stringify(workingBody), 'utf8');
    const fwdHeaders = buildForwardHeaders(meta.headers, outBuf.length);
    const upstreamUrl = adapter.upstreamBaseUrl(process.env) + path + query;

    const upstreamStart = Date.now();
    const upstream = await undiciRequest(upstreamUrl, {
      method: httpMethod(req.method),
      headers: fwdHeaders,
      body: outBuf,
    });
    // Time-to-headers counts as upstream latency; body-read time is added below.
    upstreamMs += Date.now() - upstreamStart;

    const streaming = isEventStream(upstream.headers);

    let usage: UsageCounts | undefined;
    let answerText = '';
    let respStatusCode = upstream.statusCode;

    if (streaming) {
      // Stream straight back, teeing bytes through the SSE usage parser. Page-fault
      // recovery is intentionally SKIPPED for streaming: the client bytes are
      // already on the wire before we have the reassembled answer, so we cannot
      // swap in a recovered answer without buffering the whole stream — the
      // simplest correct choice is to leave streaming responses untouched.
      if (!res.headersSent) {
        res.writeHead(upstream.statusCode, outboundHeaders(upstream.headers));
      }
      const bodyReadStart = Date.now();
      const tee = new SseUsageTee(adapter);
      for await (const chunk of upstream.body) {
        try {
          tee.push(chunk as Buffer);
        } catch {
          /* tee failures must never affect the client stream */
        }
        res.write(chunk);
      }
      res.end();
      upstreamMs += Date.now() - bodyReadStart;
      usage = tee.usage;
      // Reassembled streamed answer text — used as the compacted answer for
      // shadow-eval so streaming traffic (the dominant case) is scored against
      // real text, not an empty string.
      answerText = tee.answerText;
    } else {
      // Buffer the full response, parse usage + answer. Headers/body are NOT sent
      // yet — for compacted+recoverable requests we may detect a page-fault and
      // re-send with the paged-out content restored, returning THAT answer instead.
      const bodyReadStart = Date.now();
      const respBuf = Buffer.from(await upstream.body.arrayBuffer());
      upstreamMs += Date.now() - bodyReadStart;
      const json = tryParseJson(respBuf);
      try {
        usage = adapter.parseUsageFromResponse(json);
      } catch {
        usage = undefined;
      }
      try {
        answerText = adapter.extractAnswerText(json);
      } catch {
        answerText = '';
      }

      // ── Page-fault recovery (non-streaming only) ───────────────────────────────
      // If compaction paged out recoverable blobs AND the model's answer signals it
      // is missing that content (references an elision id, or complains the content
      // was elided / it cannot find it), restore the blob(s) and re-send ONCE. The
      // recovered answer replaces the original for the client. Bounded by
      // maxReinjections; any failure falls back to the original (compacted) answer.
      let outBufToSend: Buffer = respBuf;
      let outHeaders = outboundHeaders(upstream.headers);
      if (
        config.pageFault.enabled &&
        compChanged &&
        config.compaction.recoverable &&
        config.pageFault.maxReinjections > 0
      ) {
        try {
          const recovered = await maybePageFaultRecover({
            adapter,
            originalCompactedBody: workingBody,
            answerText,
            path,
            query,
            inboundHeaders: meta.headers,
            sessionId,
          });
          if (recovered) {
            outBufToSend = recovered.respBuf;
            outHeaders = recovered.headers;
            respStatusCode = recovered.statusCode;
            usage = recovered.usage ?? usage;
            answerText = recovered.answerText || answerText;
            upstreamMs += recovered.upstreamMs;
          }
        } catch {
          // Page-fault recovery must NEVER break the client — keep the original answer.
        }
      }

      if (!res.headersSent) {
        res.writeHead(respStatusCode, outHeaders);
      }
      res.end(outBufToSend);
    }

    // ── Finish: compute usage, cost, record, emit ───────────────────────────────
    const finalUsage = finalizeUsage(usage, workingBody, adapter, provider, model, answerText);
    const cost = pricing.cost(provider, model, finalUsage);
    const compactedInputTokens = safeCount(() => adapter.countInputTokens(workingBody, counter), finalUsage.inputTokens);

    const status: RequestEvent['status'] = respStatusCode >= 400 ? 'error' : 'ok';

    // Governor-only latency: total handler wall time MINUS the upstream round-trip
    // (incl. any page-fault re-send). Never negative; 0 when nothing is meaningful.
    const proxyOverheadMs = Math.max(0, Date.now() - startedAt - upstreamMs);

    // Cache-aware savings: the compactor already recounts tokens AFTER honoring the
    // cached-prefix boundary, so `tokensSaved` reflects ONLY what was actually
    // removed from the uncached, non-thinking region. When the cached prefix limited
    // compaction, savings are correspondingly smaller — no fake savings are claimed.
    // We re-derive the effective saving from the authoritative before/after counts
    // here too, so the recorded value can never exceed reality.
    const effectiveTokensSaved = compChanged
      ? Math.max(0, Math.min(tokensSaved, inputTokensBefore - compactedInputTokens))
      : 0;

    let costSavedUSD = 0;
    if (effectiveTokensSaved > 0) {
      // Cost saved = input-token cost of the tokens we removed.
      const savedCost = pricing.cost(provider, model, { inputTokens: effectiveTokensSaved, outputTokens: 0 });
      costSavedUSD = savedCost.totalUSD;
    }

    const requestEvent: RequestEvent = {
      ts: startedAt,
      sessionId,
      provider,
      model: model ?? '',
      source,
      repo,
      inputTokens: finalUsage.inputTokens,
      outputTokens: finalUsage.outputTokens,
      cacheReadTokens: finalUsage.cacheReadTokens ?? 0,
      cacheWriteTokens: finalUsage.cacheWriteTokens ?? 0,
      costUSD: cost.totalUSD,
      compacted: compChanged,
      tokensSaved: effectiveTokensSaved,
      costSavedUSD,
      strategies: compApplied.join(','),
      utilization,
      qualityScore: null,
      status,
      durationMs: Date.now() - startedAt,
      proxyOverheadMs,
    };

    let requestEventId: number | undefined;
    try {
      requestEventId = store.recordRequest(requestEvent);
    } catch {
      requestEventId = undefined;
    }
    safeEmit({ type: 'request', payload: { ...requestEvent, id: requestEventId } });

    if (compChanged) {
      safeEmit({
        type: 'compaction',
        payload: { sessionId, strategies: compApplied, tokensSaved, utilization },
      });
    }

    // ── Shadow eval (non-blocking, AFTER the client has been served) ───────────
    if (compChanged && qualityGuard.shouldShadowEval()) {
      // Run detached; never affects the user's request path.
      void runShadowEval({
        adapter,
        provider,
        model,
        originalBody,
        sessionId,
        repo,
        requestEventId,
        compApplied,
        compactedAnswer: answerText,
        compactedTokens: compactedInputTokens,
        baselineInputTokens: inputTokensBefore,
        path,
        query,
        inboundHeaders: meta.headers,
      });
    }
  }

  /** Record a blocked request as a telemetry event (no upstream call happened). */
  function recordBlocked(args: {
    sessionId: string;
    provider: ProviderId;
    model: string | undefined;
    source: string;
    repo: string;
    startedAt: number;
  }): void {
    const ev: RequestEvent = {
      ts: args.startedAt,
      sessionId: args.sessionId,
      provider: args.provider,
      model: args.model ?? '',
      source: args.source,
      repo: args.repo,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUSD: 0,
      compacted: false,
      tokensSaved: 0,
      costSavedUSD: 0,
      strategies: '',
      utilization: 0,
      qualityScore: null,
      status: 'blocked',
      durationMs: Date.now() - args.startedAt,
      proxyOverheadMs: 0,
    };
    let id: number | undefined;
    try {
      id = store.recordRequest(ev);
    } catch {
      id = undefined;
    }
    safeEmit({ type: 'request', payload: { ...ev, id } });
  }

  /**
   * Run the shadow baseline: send the UNCOMPACTED body upstream (non-stream),
   * get its answer text + cost, then evaluate degradation vs the compacted run.
   * Wrapped so a shadow failure can never surface to the user.
   */
  async function runShadowEval(args: {
    adapter: ProviderAdapter;
    provider: ProviderId;
    model: string | undefined;
    originalBody: unknown;
    sessionId: string;
    repo: string;
    requestEventId: number | undefined;
    compApplied: string[];
    compactedAnswer: string;
    compactedTokens: number;
    baselineInputTokens: number;
    path: string;
    query: string;
    inboundHeaders: Record<string, string>;
  }): Promise<void> {
    try {
      // Clone and force a non-streaming baseline call.
      let baselineBody: Record<string, unknown>;
      try {
        baselineBody = structuredClone(args.originalBody) as Record<string, unknown>;
      } catch {
        baselineBody = JSON.parse(JSON.stringify(args.originalBody)) as Record<string, unknown>;
      }
      if (baselineBody && typeof baselineBody === 'object') baselineBody.stream = false;

      // For Gemini, the streaming variant lives in the path; force the non-stream
      // path AND strip `alt=sse` from the query — otherwise :generateContent
      // still returns an SSE stream and the baseline JSON parse below sees SSE
      // text, yielding an empty baseline and a bogus ~100% degradation signal.
      const path = args.adapter.id === 'gemini'
        ? args.path.replace(':streamGenerateContent', ':generateContent')
        : args.path;
      const query =
        args.adapter.id === 'gemini' ? stripAltSse(args.query) : args.query;

      const outBuf = Buffer.from(JSON.stringify(baselineBody), 'utf8');
      const headers = buildForwardHeaders(args.inboundHeaders, outBuf.length);
      const url = args.adapter.upstreamBaseUrl(process.env) + path + query;

      const res = await undiciRequest(url, { method: 'POST', headers, body: outBuf });
      const respBuf = Buffer.from(await res.body.arrayBuffer());
      const json = tryParseJson(respBuf);

      let baselineText = '';
      try {
        baselineText = args.adapter.extractAnswerText(json);
      } catch {
        baselineText = '';
      }

      // Record the cost of this shadow baseline call (the "cost of the guarantee").
      let baselineUsage: UsageCounts | undefined;
      try {
        baselineUsage = args.adapter.parseUsageFromResponse(json);
      } catch {
        baselineUsage = undefined;
      }
      const usage = baselineUsage ?? {
        inputTokens: args.baselineInputTokens,
        outputTokens: approxTokens(baselineText),
      };
      const shadowCost = pricing.cost(args.provider, args.model, usage);
      try {
        store.recordShadowCost(args.sessionId, shadowCost.totalUSD);
      } catch {
        /* best-effort */
      }

      const evt = await qualityGuard.evaluate({
        sessionId: args.sessionId,
        requestEventId: args.requestEventId,
        strategy: args.compApplied.join(','),
        baselineText,
        compactedText: args.compactedAnswer,
        baselineTokens: usage.inputTokens,
        compactedTokens: args.compactedTokens,
      });

      // Persist per-repo, per-strategy degradation keyed by THIS request's repo
      // (race-free: repo is captured in this call's scope). Seeds adaptive backoff
      // across restarts. Best-effort and only when the store supports it.
      const rs = asRepoBackoffStore(store);
      if (rs && args.repo) {
        for (const name of args.compApplied) {
          const s = name.trim();
          if (s.length === 0) continue;
          try {
            rs.recordRepoStrategyDegradation(args.repo, s, evt.degradationPct);
          } catch {
            /* best-effort: adaptive backoff seed is recoverable telemetry, not critical */
          }
        }
      }
    } catch {
      // Shadow failures are silently swallowed — they must never affect the user.
    }
  }

  /**
   * Page-fault recovery (non-streaming). Given the COMPACTED body that was sent
   * upstream and the model's answer, decide whether the answer signals it needed
   * a paged-out block. If so, restore the block(s) from the store, re-send the
   * request ONCE (non-stream), and return the recovered upstream response. Returns
   * undefined when no fault is detected, nothing could be restored, or the re-send
   * failed (the caller then keeps the original compacted answer). Bounded by
   * config.pageFault.maxReinjections. Never throws on the request path.
   */
  async function maybePageFaultRecover(args: {
    adapter: ProviderAdapter;
    originalCompactedBody: unknown;
    answerText: string;
    path: string;
    query: string;
    inboundHeaders: Record<string, string>;
    sessionId: string;
  }): Promise<
    | { respBuf: Buffer; headers: Record<string, string>; statusCode: number; usage: UsageCounts | undefined; answerText: string; upstreamMs: number }
    | undefined
  > {
    // Which paged-out ids actually live in the compacted body we sent?
    const bodyIds = collectBodyElidedIds(args.adapter, args.originalCompactedBody);
    if (bodyIds.size === 0) return undefined;

    // Does the answer signal a fault against one of those ids?
    if (!detectPageFault(args.answerText, bodyIds)) return undefined;

    // Clone the compacted body and restore the paged-out block(s) from the store.
    let restoredBody: unknown;
    try {
      restoredBody = structuredClone(args.originalCompactedBody);
    } catch {
      try {
        restoredBody = JSON.parse(JSON.stringify(args.originalCompactedBody)) as unknown;
      } catch {
        return undefined;
      }
    }

    const restoredCount = restoreElidedBlobs(restoredBody, args.adapter, counter, store);
    if (restoredCount === 0) return undefined; // nothing recoverable — keep original.

    // Re-send ONCE, non-streaming. We force non-stream so we can buffer + return it.
    let resendBody: Record<string, unknown>;
    try {
      resendBody = restoredBody as Record<string, unknown>;
      if (resendBody && typeof resendBody === 'object') resendBody.stream = false;
    } catch {
      return undefined;
    }

    // Gemini streams via the path; force the non-stream path + strip alt=sse.
    const path =
      args.adapter.id === 'gemini'
        ? args.path.replace(':streamGenerateContent', ':generateContent')
        : args.path;
    const query = args.adapter.id === 'gemini' ? stripAltSse(args.query) : args.query;

    const outBuf = Buffer.from(JSON.stringify(resendBody), 'utf8');
    const headers = buildForwardHeaders(args.inboundHeaders, outBuf.length);
    const url = args.adapter.upstreamBaseUrl(process.env) + path + query;

    const resendStart = Date.now();
    const res = await undiciRequest(url, { method: 'POST', headers, body: outBuf });
    const respBuf = Buffer.from(await res.body.arrayBuffer());
    const upstreamMs = Date.now() - resendStart;

    const json = tryParseJson(respBuf);
    let recoveredAnswer = '';
    try {
      recoveredAnswer = args.adapter.extractAnswerText(json);
    } catch {
      recoveredAnswer = '';
    }
    let recoveredUsage: UsageCounts | undefined;
    try {
      recoveredUsage = args.adapter.parseUsageFromResponse(json);
    } catch {
      recoveredUsage = undefined;
    }

    // Record that a page-fault recovery happened.
    safeEmit({
      type: 'log',
      payload: {
        level: 'info',
        message:
          `tokdiet: page-fault recovery — restored ${restoredCount} ` +
          `paged-out block(s) and re-sent (session ${args.sessionId}).`,
      },
    });

    return {
      respBuf,
      headers: outboundHeaders(res.headers),
      statusCode: res.statusCode,
      usage: recoveredUsage,
      answerText: recoveredAnswer,
      upstreamMs,
    };
  }

  /** Collect every paged-out elision id present in a body's editable text refs. */
  function collectBodyElidedIds(adapter: ProviderAdapter, body: unknown): Set<string> {
    const ids = new Set<string>();
    const add = (text: string): void => {
      for (const id of elidedIdsIn(text)) ids.add(id);
    };
    try {
      for (const ref of adapter.listToolResults(body, counter)) add(ref.text);
    } catch {
      /* never throw on the request path */
    }
    try {
      for (const ref of adapter.listTextChunks(body, counter)) add(ref.text);
    } catch {
      /* never throw on the request path */
    }
    return ids;
  }

  /**
   * Build a SummarizeFn for mid-history summarization: asks the cheap judge model
   * to compress text to <= maxTokens via the same adapter/upstream. Tolerant of
   * failure (returns the original text so compaction simply no-ops on it).
   */
  function makeSummarizeFn(adapter: ProviderAdapter) {
    return async (text: string, maxTokens: number): Promise<string> => {
      const judgeModel = config.shadowEval.judgeModel;
      if (!judgeModel) return text;
      const prompt =
        `Summarize the following content to at most ${maxTokens} tokens, ` +
        `preserving key facts, identifiers, and decisions. Output only the summary.\n\n${text}`;
      try {
        // Use the Anthropic upstream for the cheap summarizer regardless of the
        // primary provider (haiku-class models are cheap and reliable).
        const body = {
          model: judgeModel,
          max_tokens: Math.max(64, Math.ceil(maxTokens * 1.5)),
          messages: [{ role: 'user', content: prompt }],
          stream: false,
        };
        const url = anthropicAdapter.upstreamBaseUrl(process.env) + '/v1/messages';
        const res = await undiciRequest(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
          body: JSON.stringify(body),
        });
        const json: unknown = JSON.parse(await res.body.text());
        const out = anthropicAdapter.extractAnswerText(json);
        return out && out.length > 0 ? out : text;
      } catch {
        return text;
      }
    };
  }

  /** Compute the final usage, filling gaps from a token recount / answer estimate. */
  function finalizeUsage(
    usage: UsageCounts | undefined,
    body: unknown,
    adapter: ProviderAdapter,
    provider: ProviderId,
    model: string | undefined,
    answerText: string,
  ): UsageCounts {
    const inputTokens =
      usage && usage.inputTokens > 0
        ? usage.inputTokens
        : safeCount(() => adapter.countInputTokens(body, counter), 0);
    const outputTokens =
      usage && usage.outputTokens > 0 ? usage.outputTokens : approxTokens(answerText);
    return {
      inputTokens,
      outputTokens,
      cacheReadTokens: usage?.cacheReadTokens,
      cacheWriteTokens: usage?.cacheWriteTokens,
    };
  }

  /** Token recount that never throws; returns `fallback` on error. */
  function safeCount(fn: () => number, fallback: number): number {
    try {
      const n = fn();
      return Number.isFinite(n) && n >= 0 ? n : fallback;
    } catch {
      return fallback;
    }
  }

  /** Rolling degradation read that never throws. */
  function safeRolling(): number | null {
    try {
      return store.rollingDegradationPct(50);
    } catch {
      return null;
    }
  }

  /** Emit on the bus, isolating any failure. */
  function safeEmit(e: Parameters<EventBus['emit']>[0]): void {
    try {
      bus.emit(e);
    } catch {
      /* bus failures must never break the request path */
    }
  }

  // Bind to loopback only. This is a LOCAL proxy that forwards the operator's
  // real upstream API keys; listening on all interfaces (the Node default when
  // no host is given) would turn it into a remotely reachable, key-spending
  // open relay for anyone who can reach the port.
  const livePort = (): number => {
    const addr = server.address();
    return typeof addr === 'object' && addr !== null ? addr.port : config.proxyPort;
  };
  const whenReady = new Promise<number>((resolve) => {
    server.once('listening', () => resolve(livePort()));
  });
  server.listen(config.proxyPort, '127.0.0.1');

  return {
    get port(): number {
      return livePort();
    },
    whenReady,
    close(): Promise<void> {
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
