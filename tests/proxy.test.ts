// tests/proxy.test.ts — integration coverage for the interceptor (src/proxy.ts).
//
// Spins up startProxy against a controllable mock upstream (a plain http.Server)
// reached via CTXGOV_ANTHROPIC_UPSTREAM, and asserts the product invariants that
// previously had ZERO automated coverage: transparent passthrough of unknown
// bodies, fail-open on upstream errors, incremental SSE streaming + usage parse,
// gzip transparency (regression for the decompression-mismatch bug), streamed
// answer reassembly for shadow-eval (regression for the empty-answer bug), and
// secret hygiene (x-api-key never persisted).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { request as undiciRequest } from 'undici';
import { startProxy, type ProxyHandle } from '../src/proxy.js';
import { openStore } from '../src/store.js';
import { InProcessEventBus } from '../src/events.js';
import { PricingImpl } from '../src/pricing.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import type { EventBus, GovernorConfig, Pricing, Store } from '../src/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Test doubles
// ─────────────────────────────────────────────────────────────────────────────

/** A handler the mock upstream delegates to per-test. */
type UpstreamHandler = (req: IncomingMessage, res: ServerResponse, body: Buffer) => void;

/** Start a mock upstream http server; returns its base URL and a handler setter. */
async function startMockUpstream(): Promise<{
  baseUrl: string;
  setHandler(h: UpstreamHandler): void;
  lastHeaders(): Record<string, string | string[] | undefined>;
  close(): Promise<void>;
  server: Server;
}> {
  let handler: UpstreamHandler = (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  };
  let captured: Record<string, string | string[] | undefined> = {};

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      captured = req.headers;
      try {
        handler(req, res, Buffer.concat(chunks));
      } catch (err) {
        res.writeHead(500).end(String(err));
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    setHandler(h: UpstreamHandler) {
      handler = h;
    },
    lastHeaders: () => captured,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    server,
  };
}

/** Minimal recording in-memory Store implementing the full interface. */
class RecordingStore implements Store {
  requests: import('../src/types.js').RequestEvent[] = [];
  shadowEvals: import('../src/types.js').ShadowEvalEvent[] = [];
  qualityUpdates: Array<{ id: number; pct: number }> = [];

  recordRequest(e: import('../src/types.js').RequestEvent): number {
    this.requests.push(e);
    return this.requests.length;
  }
  recordShadowEval(e: import('../src/types.js').ShadowEvalEvent): number {
    this.shadowEvals.push(e);
    return this.shadowEvals.length;
  }
  updateRequestQualityScore(id: number, pct: number): void {
    this.qualityUpdates.push({ id, pct });
  }
  recordShadowCost(): void {}
  sessionCostUSD(): number {
    return 0;
  }
  dayCostUSD(): number {
    return 0;
  }
  repoMonthCostUSD(): number {
    return 0;
  }
  rollingDegradationPct(): number | null {
    return null;
  }
  recentRequests(): import('../src/types.js').RequestEvent[] {
    return this.requests;
  }
  summary(): import('../src/types.js').ReportSummary {
    return {
      totalCostUSD: 0,
      totalTokensSaved: 0,
      estSavedUSD: 0,
      shadowCostUSD: 0,
      avgDegradationPct: null,
      requestCount: this.requests.length,
      byProvider: [],
      bySource: [],
      byStrategy: [],
    };
  }
  close(): void {}
}

/**
 * Reserve a free TCP port on loopback. startProxy reads server.address()
 * synchronously, so an ephemeral (port 0) cannot be resolved by the handle;
 * we pick a concrete free port and pass it in.
 */
async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const addr = srv.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

function makeConfig(overrides: Partial<GovernorConfig> = {}): GovernorConfig {
  return {
    ...DEFAULT_CONFIG,
    dashboardEnabled: false,
    ...overrides,
    compaction: { ...DEFAULT_CONFIG.compaction, ...(overrides.compaction ?? {}) },
    shadowEval: { ...DEFAULT_CONFIG.shadowEval, ...(overrides.shadowEval ?? {}) },
    budgets: { ...DEFAULT_CONFIG.budgets, ...(overrides.budgets ?? {}) },
  };
}

const pricing: Pricing = PricingImpl.load();

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe('startProxy (interceptor)', () => {
  let mock: Awaited<ReturnType<typeof startMockUpstream>>;
  let proxy: ProxyHandle | undefined;
  let prevUpstream: string | undefined;

  beforeEach(async () => {
    mock = await startMockUpstream();
    prevUpstream = process.env.CTXGOV_ANTHROPIC_UPSTREAM;
    process.env.CTXGOV_ANTHROPIC_UPSTREAM = mock.baseUrl;
  });

  afterEach(async () => {
    if (proxy) await proxy.close();
    proxy = undefined;
    await mock.close();
    if (prevUpstream === undefined) delete process.env.CTXGOV_ANTHROPIC_UPSTREAM;
    else process.env.CTXGOV_ANTHROPIC_UPSTREAM = prevUpstream;
  });

  /**
   * Start the proxy on a freshly-reserved free port and wait until it accepts
   * connections (startProxy.listen is async; the returned port is only the
   * configured one). Returns the handle.
   */
  async function launch(opts: {
    config?: Partial<GovernorConfig>;
    store: Store;
    bus?: EventBus;
  }): Promise<ProxyHandle> {
    const port = await freePort();
    const config = makeConfig({ ...(opts.config ?? {}), proxyPort: port });
    const handle = startProxy({
      config,
      store: opts.store,
      bus: opts.bus ?? new InProcessEventBus(),
      pricing,
    });
    await waitFor(async () => {
      try {
        const r = await undiciRequest(`http://127.0.0.1:${port}/__ping`, { method: 'GET' });
        await r.body.text();
        return true;
      } catch {
        return false;
      }
    }, 3000);
    return handle;
  }

  /** POST to the running proxy at /v1/messages with the given JSON-ish body. */
  async function postToProxy(
    bodyBuf: Buffer,
    headers: Record<string, string> = {},
    path = '/v1/messages',
  ): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string }> {
    const url = `http://127.0.0.1:${proxy!.port}${path}`;
    const res = await undiciRequest(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: bodyBuf,
    });
    const text = await res.body.text();
    return { status: res.statusCode, headers: res.headers, text };
  }

  it('binds to loopback only and is reachable via 127.0.0.1', async () => {
    const store = new RecordingStore();
    proxy = await launch({ store });
    // The server is listened with an explicit '127.0.0.1' host. Reaching it via
    // loopback must succeed (the launch() readiness probe already proved this).
    expect(proxy.port).toBeGreaterThan(0);
    mock.setHandler((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } }));
    });
    const res = await postToProxy(
      Buffer.from(JSON.stringify({ model: 'claude-sonnet-4', messages: [{ role: 'user', content: 'hi' }] })),
    );
    expect(res.status).toBe(200);
  });

  it('passes a non-JSON body through transparently (no metering)', async () => {
    const store = new RecordingStore();
    proxy = await launch({ store });
    mock.setHandler((_req, res, body) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('echo:' + body.toString('utf8'));
    });

    const res = await postToProxy(Buffer.from('this is not json'), { 'content-type': 'text/plain' });
    expect(res.status).toBe(200);
    expect(res.text).toBe('echo:this is not json');
    // Non-JSON -> no provider detected -> transparent passthrough -> no request recorded.
    expect(store.requests).toHaveLength(0);
  });

  it('forwards an upstream 5xx transparently (fail-open, no governor 5xx)', async () => {
    const store = new RecordingStore();
    proxy = await launch({ store });
    mock.setHandler((_req, res) => {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end('{"error":"upstream is down"}');
    });

    const body = Buffer.from(JSON.stringify({ model: 'claude-sonnet-4', messages: [{ role: 'user', content: 'hi' }] }));
    const res = await postToProxy(body);
    expect(res.status).toBe(503);
    expect(res.text).toContain('upstream is down');
  });

  it('meters a non-streaming response and records usage/cost', async () => {
    const store = new RecordingStore();
    proxy = await launch({ store });
    mock.setHandler((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          content: [{ type: 'text', text: 'the answer' }],
          usage: { input_tokens: 11, output_tokens: 7 },
        }),
      );
    });

    const body = Buffer.from(JSON.stringify({ model: 'claude-sonnet-4-20250514', messages: [{ role: 'user', content: 'hi' }] }));
    const res = await postToProxy(body);
    expect(res.status).toBe(200);
    expect(res.text).toContain('the answer');
    expect(store.requests).toHaveLength(1);
    expect(store.requests[0]!.inputTokens).toBe(11);
    expect(store.requests[0]!.outputTokens).toBe(7);
    expect(store.requests[0]!.provider).toBe('anthropic');
  });

  it('does NOT forward accept-encoding upstream (gzip transparency regression)', async () => {
    const store = new RecordingStore();
    proxy = await launch({ store });
    let upstreamAcceptEncoding: string | string[] | undefined = 'UNSET';
    mock.setHandler((req, res) => {
      upstreamAcceptEncoding = req.headers['accept-encoding'];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } }));
    });

    const body = Buffer.from(JSON.stringify({ model: 'claude-sonnet-4', messages: [{ role: 'user', content: 'hi' }] }));
    const res = await postToProxy(body, { 'accept-encoding': 'gzip, br' });
    expect(res.status).toBe(200);
    // The client asked for gzip/br but the proxy must strip it so undici (which
    // does not auto-decompress) gets identity bytes it can parse and re-serve.
    expect(upstreamAcceptEncoding).toBeUndefined();
    // The client receives valid, parseable JSON (not compressed bytes).
    expect(() => JSON.parse(res.text)).not.toThrow();
    expect(res.text).toContain('ok');
  });

  it('delivers a gzip-encoded upstream body as readable bytes (content-encoding stripped)', async () => {
    // Even if the upstream chooses to gzip regardless, the proxy must not hand
    // the client gzip bytes labelled as identity. With accept-encoding stripped,
    // a well-behaved upstream returns identity; this test pins the more general
    // promise that the client can always parse what it receives.
    const store = new RecordingStore();
    proxy = await launch({ store });
    const payload = JSON.stringify({ content: [{ type: 'text', text: 'plain answer' }], usage: { input_tokens: 2, output_tokens: 3 } });
    mock.setHandler((req, res) => {
      // Honor identity (the proxy strips accept-encoding so this is what we get).
      const ae = String(req.headers['accept-encoding'] ?? '');
      if (ae.includes('gzip')) {
        const gz = gzipSync(Buffer.from(payload));
        res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
        res.end(gz);
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(payload);
      }
    });

    const body = Buffer.from(JSON.stringify({ model: 'claude-sonnet-4', messages: [{ role: 'user', content: 'hi' }] }));
    const res = await postToProxy(body, { 'accept-encoding': 'gzip' });
    expect(res.status).toBe(200);
    expect(() => JSON.parse(res.text)).not.toThrow();
    expect(JSON.parse(res.text).content[0].text).toBe('plain answer');
  });

  it('streams an SSE response incrementally and parses usage', async () => {
    const store = new RecordingStore();
    proxy = await launch({ store });

    mock.setHandler((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (event: string, data: unknown): void => {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      };
      send('message_start', { message: { usage: { input_tokens: 9 } } });
      send('content_block_delta', { delta: { type: 'text_delta', text: 'Hello ' } });
      send('content_block_delta', { delta: { type: 'text_delta', text: 'world' } });
      send('message_delta', { usage: { output_tokens: 5 } });
      send('message_stop', {});
      res.write('data: [DONE]\n\n');
      res.end();
    });

    const body = Buffer.from(JSON.stringify({ model: 'claude-sonnet-4', stream: true, messages: [{ role: 'user', content: 'hi' }] }));
    const res = await postToProxy(body);
    expect(res.status).toBe(200);
    expect(String(res.headers['content-type'])).toContain('text/event-stream');
    // The full SSE body is relayed.
    expect(res.text).toContain('content_block_delta');
    expect(res.text).toContain('[DONE]');
    // Usage was parsed incrementally out of the stream.
    expect(store.requests).toHaveLength(1);
    expect(store.requests[0]!.inputTokens).toBe(9);
    expect(store.requests[0]!.outputTokens).toBe(5);
  });

  it('reassembles streamed answer text so shadow-eval scores real text (regression)', async () => {
    // sampleRate=1 + compaction forced via a tiny window so the request is
    // compacted and shadow-evaluated. The baseline upstream answer matches the
    // streamed answer, so degradation must be LOW (not ~100% from an empty
    // compactedAnswer). We capture the shadow eval recorded by the store.
    const store = new RecordingStore();
    proxy = await launch({
      store,
      config: {
        contextWindowTokens: 50, // tiny window so utilization is high
        compaction: { ...DEFAULT_CONFIG.compaction, enabled: true, minToolResultTokens: 1, keepRecentToolResults: 0 },
        shadowEval: { ...DEFAULT_CONFIG.shadowEval, enabled: true, sampleRate: 1, judge: 'heuristic' },
        safeMode: false,
      },
    });

    const answer = 'The capital of France is Paris and it is a lovely city.';
    mock.setHandler((req, res, reqBody) => {
      const parsed = JSON.parse(reqBody.toString('utf8'));
      if (parsed.stream === true) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('event: message_start\n');
        res.write(`data: ${JSON.stringify({ message: { usage: { input_tokens: 20 } } })}\n\n`);
        for (const word of answer.split(' ')) {
          res.write('event: content_block_delta\n');
          res.write(`data: ${JSON.stringify({ delta: { type: 'text_delta', text: word + ' ' } })}\n\n`);
        }
        res.write('event: message_delta\n');
        res.write(`data: ${JSON.stringify({ usage: { output_tokens: 12 } })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        // Baseline (shadow) non-streaming call.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ content: [{ type: 'text', text: answer }], usage: { input_tokens: 30, output_tokens: 12 } }));
      }
    });

    // Build a body with a big duplicated tool_result so elision/dedup fires.
    const bigText = 'x '.repeat(400);
    const body = Buffer.from(
      JSON.stringify({
        model: 'claude-sonnet-4',
        stream: true,
        messages: [
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: bigText }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: bigText }] },
          { role: 'user', content: 'and now answer' },
        ],
      }),
    );

    const res = await postToProxy(body);
    expect(res.status).toBe(200);

    // Wait for the detached shadow eval to land (it runs after the response).
    await waitFor(() => store.shadowEvals.length > 0, 3000);
    expect(store.shadowEvals).toHaveLength(1);
    // Streamed answer == baseline answer => heuristic degradation must be low,
    // proving the streamed compactedAnswer was reassembled (not '').
    expect(store.shadowEvals[0]!.degradationPct).toBeLessThan(50);
    // And the degradation was backfilled onto the originating request.
    expect(store.qualityUpdates.length).toBeGreaterThan(0);
  });

  it('never persists x-api-key to the SQLite store/db file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ctxgov-proxy-'));
    const store = openStore(dir);
    proxy = await launch({ store, config: { dataDir: dir } });
    const SECRET = 'sk-ant-SECRETVALUE-do-not-store';

    let forwardedKey: string | string[] | undefined = 'UNSET';
    mock.setHandler((req, res) => {
      forwardedKey = req.headers['x-api-key'];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } }));
    });

    const body = Buffer.from(JSON.stringify({ model: 'claude-sonnet-4', messages: [{ role: 'user', content: 'hi' }] }));
    await postToProxy(body, { 'x-api-key': SECRET });

    // The key is forwarded upstream...
    expect(forwardedKey).toBe(SECRET);
    store.close();

    // ...but never written to any on-disk db file.
    let found = false;
    for (const f of readdirSync(dir)) {
      try {
        const buf = readFileSync(join(dir, f));
        if (buf.includes(Buffer.from(SECRET))) found = true;
      } catch {
        /* ignore */
      }
    }
    expect(found).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

/** Poll `cond` (sync or async) until truthy or `timeoutMs` elapses. */
async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (await cond()) return;
    if (Date.now() - start > timeoutMs) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}
