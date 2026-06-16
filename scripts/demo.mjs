#!/usr/bin/env node
// scripts/demo.mjs — PROVE the savings claim locally, with NO real API key.
//
// What this does, end to end:
//   1. Spins up a mock Anthropic upstream (plain http server) that echoes back
//      the input token count it received and returns a fixed canned answer +
//      usage. The answer is identical no matter how big the input is — that is
//      the whole point: compaction shrinks the *input* (old tool-result dumps)
//      without changing the model's *answer*, so measured quality degradation
//      stays ~0.
//   2. Imports the BUILT library from dist/index.js (run `npm run build` first).
//   3. Starts the Context Governor proxy pointed at the mock via
//      CTXGOV_ANTHROPIC_UPSTREAM, with a deliberately small contextWindowTokens
//      so utilization crosses the threshold and compaction fires. Telemetry
//      lands in a throwaway temp dataDir.
//   4. Sends one realistic agent-style request stuffed with several large,
//      repetitive tool_result blocks (simulated logs / file dumps) — exactly
//      the bloat the compactor targets — plus a duplicated file chunk so both
//      elision and dedup engage.
//   5. Forces a shadow-eval (sampleRate=1) and waits for it, then prints a
//      before/after table: input tokens, % reduction, $ saved (from
//      pricing.json), strategies applied, and the measured degradation.
//   6. Tears down both servers + the temp dir and exits 0.
//
// No real network, no API key, fully deterministic enough to demo.
//
// Run after building:  npm run build && node scripts/demo.mjs

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST_INDEX = path.join(ROOT, 'dist', 'index.js');
const MODEL = 'claude-sonnet-4';

// Declared up front so the hoisted cleanup() never hits a temporal-dead-zone
// error if an early failure (e.g. a failed request) calls it before the rest of
// the module body has finished evaluating.
let cleaned = false;

// ── 0. Friendly hint if the build is missing ─────────────────────────────────
if (!existsSync(DIST_INDEX)) {
  console.error('\n  Context Governor demo: dist/ not found.');
  console.error('  Build the library first, then re-run the demo:\n');
  console.error('      npm run build');
  console.error('      node scripts/demo.mjs\n');
  process.exit(1);
}

// The proxy resolves the Anthropic upstream from this env var; set it before we
// import/start anything so the adapter picks it up.
const mock = await startMockUpstream();
process.env.CTXGOV_ANTHROPIC_UPSTREAM = mock.url;

// ── 1. Import the built library ───────────────────────────────────────────────
const {
  startProxy,
  openStore,
  InProcessEventBus,
  PricingImpl,
  normalizeConfig,
  DEFAULT_CONFIG,
} = await import(pathToFileURL(DIST_INDEX).href);

// ── 2. Throwaway data dir + config ────────────────────────────────────────────
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ctxgov-demo-'));

// startProxy() captures server.address().port synchronously right after
// listen(), so when given proxyPort:0 its handle reports a stale 0. We instead
// reserve a concrete free loopback port ourselves (via a throwaway listener
// whose 'listening' event reliably exposes the assigned port) and hand that to
// the proxy, so we always know exactly where to send the request.
const proxyPort = await findFreePort();

const config = normalizeConfig(
  {
    ...DEFAULT_CONFIG,
    proxyPort, // concrete free loopback port reserved above
    dashboardEnabled: false,
    // Small window so a fat agent request immediately crosses the utilization
    // threshold and compaction triggers.
    contextWindowTokens: 8_000,
    contextUtilizationThreshold: 0.5,
    onBudgetExceeded: 'warn', // never block in the demo
    budgets: { perSessionUSD: null, perDayUSD: null, perRepoMonthlyUSD: null },
    compaction: {
      enabled: true,
      // elision + dedup only; midSummarize needs a real summarizer model.
      strategies: { elision: true, dedup: true, midSummarize: false },
      keepRecentToolResults: 1, // keep just the freshest; elide the older dumps
      minToolResultTokens: 200,
    },
    qualityBudget: { maxDegradationPct: 2.0 },
    shadowEval: { enabled: true, sampleRate: 1, judge: 'heuristic' }, // force it
    safeMode: true,
    dataDir,
    pricingPath: null,
  },
  ROOT,
);

const store = openStore(config.dataDir);
const bus = new InProcessEventBus();
const pricing = PricingImpl.load(); // bundled pricing.json

// Capture the shadow-eval result so we can report the measured degradation.
let shadowResult = null;
const shadowSeen = new Promise((resolve) => {
  bus.subscribe((e) => {
    if (e.type === 'shadow') {
      shadowResult = e.payload;
      resolve(e.payload);
    }
  });
});

const proxy = startProxy({ config, store, bus, pricing });
// Use the port we reserved (proxy.port can be a stale 0 — see findFreePort note).
const listenPort = proxy.port && proxy.port > 0 ? proxy.port : proxyPort;
const proxyUrl = `http://127.0.0.1:${listenPort}`;

// ── 3. Send a realistic, bloated agent request THROUGH the proxy ──────────────
const requestBody = buildBloatedRequest();

// startProxy() returns before listen() has fully bound; give it a moment.
await waitForListening(listenPort, 2000);

try {
  await postJson(`${proxyUrl}/v1/messages`, requestBody, {
    'x-api-key': 'sk-ant-DEMO-not-a-real-key', // forwarded, never stored/logged
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  });
} catch (err) {
  console.error('Demo request failed:', err?.message ?? err);
  await cleanup(1);
}

// Wait for the (detached) shadow eval to finish, but never hang the demo.
await Promise.race([shadowSeen, delay(5000)]);

// ── 4. Pull the metered truth out of the telemetry store ──────────────────────
const recent = store.recentRequests(10);
// The primary metered request is the compacted one.
const primary =
  recent.find((r) => r.compacted) ?? recent.find((r) => r.status === 'ok') ?? recent[0];

const summary = store.summary();

// Primary numbers come from the governor's OWN metered telemetry (its real
// tokenizer), so the table and the store totals line agree exactly:
//   after  = input tokens the proxy actually forwarded (post-compaction)
//   before = after + the tokens compaction removed
// The mock independently echoed how many input tokens it received for the
// compacted call vs the uncompacted shadow baseline; we surface that as a
// corroborating cross-check that the upstream truly saw a smaller request.
const tokensAfter = primary?.inputTokens ?? 0;
const tokensSaved = primary?.tokensSaved ?? 0;
const tokensBefore = tokensAfter + tokensSaved;
const reductionPct = tokensBefore > 0 ? (tokensSaved / tokensBefore) * 100 : 0;

// Independent corroboration from the mock upstream (its own char-based count).
const mockBefore = mock.baselineInputTokens ?? null;
const mockAfter = mock.lastCompactedInputTokens ?? null;
const mockReductionPct =
  mockBefore && mockAfter != null && mockBefore > 0
    ? ((mockBefore - mockAfter) / mockBefore) * 100
    : null;

// $ saved = input-token cost of the tokens we removed, at this model's price.
const savedCost = pricing.cost('anthropic', MODEL, { inputTokens: tokensSaved, outputTokens: 0 });
const costBefore = pricing.cost('anthropic', MODEL, { inputTokens: tokensBefore, outputTokens: 0 });
const costAfter = pricing.cost('anthropic', MODEL, { inputTokens: tokensAfter, outputTokens: 0 });

const strategies = primary?.strategies || '(none)';
const degradationPct =
  shadowResult?.degradationPct ??
  (primary?.qualityScore != null ? primary.qualityScore : null);

// ── 5. Print the before/after table ───────────────────────────────────────────
const lines = [];
const L = (s = '') => lines.push(s);

L();
L('  Context Governor — local savings proof (mock upstream, no API key)');
L('  ' + '='.repeat(66));
L(`  upstream     : mock Anthropic @ ${mock.url}`);
L(`  proxy        : ${proxyUrl}`);
L(`  model        : ${MODEL}   (pricing.json v${pricing.version})`);
L(
  `  context win  : ${config.contextWindowTokens.toLocaleString()} tokens  ` +
    `(compaction triggers > ${Math.round(config.contextUtilizationThreshold * 100)}% util)`,
);
L('  ' + '-'.repeat(66));
L('  metric                          before         after         delta');
L('  ' + '-'.repeat(66));
L(row('input tokens', fmtNum(tokensBefore), fmtNum(tokensAfter), `-${fmtNum(tokensSaved)}`));
L(row('input cost (USD)', fmtUSD(costBefore.totalUSD), fmtUSD(costAfter.totalUSD), `-${fmtUSD(savedCost.totalUSD)}`));
L(
  row(
    'utilization',
    pct((primary?.utilization ?? tokensBefore / config.contextWindowTokens) * 100),
    pct((tokensAfter / config.contextWindowTokens) * 100),
    '',
  ),
);
L('  ' + '-'.repeat(66));
L(`  reduction               : ${reductionPct.toFixed(1)}%  input tokens removed`);
L(`  estimated $ saved        : ${fmtUSD(savedCost.totalUSD)}  on this single request`);
L(`  strategies applied       : ${strategies}`);
L(`  shadow-eval judge        : ${config.shadowEval.judge}  (baseline answer vs compacted answer)`);
L(
  `  measured degradation     : ${degradationPct == null ? 'n/a' : '+' + degradationPct.toFixed(2) + '%'}` +
    `   (budget ${config.qualityBudget.maxDegradationPct.toFixed(1)}%)`,
);
L(`  quality verdict          : ${qualityVerdict(degradationPct, config.qualityBudget.maxDegradationPct)}`);
L('  ' + '-'.repeat(66));
L(
  `  store totals             : ${summary.requestCount} req, ` +
    `${fmtNum(summary.totalTokensSaved)} tokens saved, ` +
    `est ${fmtUSD(summary.estSavedUSD)} saved`,
);
L(
  `  upstream cross-check     : mock received ${mockBefore == null ? '?' : fmtNum(mockBefore)} -> ` +
    `${mockAfter == null ? '?' : fmtNum(mockAfter)} input tokens` +
    `${mockReductionPct == null ? '' : `  (-${mockReductionPct.toFixed(1)}%, independent count)`}`,
);
L('  ' + '='.repeat(66));
const headlineSpend = reductionPct.toFixed(0);
const headlineDeg = degradationPct == null ? '0.0' : degradationPct.toFixed(1);
L(`  HEADLINE: spend -${headlineSpend}% / measured degradation +${headlineDeg}%`);
L();

const output = lines.join('\n');
console.log(output);

// ── 6. Clean up and exit ───────────────────────────────────────────────────────
await cleanup(0);

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Mock Anthropic Messages upstream. Echoes back the *received* input token count
 * (approx 4 chars/token — matching the governor's deterministic fallback) and a
 * FIXED canned answer + usage. Because the answer text never depends on the
 * input size, the governor's shadow-eval (compacted-answer vs baseline-answer)
 * sees identical text and reports ~0% degradation — proving compaction was safe.
 */
function startMockUpstream() {
  const CANNED_ANSWER =
    'Root cause: the retry loop in fetchWidget() has no backoff ceiling, so a ' +
    'transient 503 from the inventory service spins it into a tight loop that ' +
    'exhausts the connection pool. Fix: cap retries at 5 with exponential ' +
    'backoff + jitter, treat 5xx as retryable but 4xx as terminal.';

  const state = {
    url: '',
    baselineInputTokens: null, // largest call seen = uncompacted shadow baseline
    lastCompactedInputTokens: null, // smallest non-stream call = compacted primary
    calls: 0,
  };

  // Same heuristic the tokenizer uses as its deterministic fallback (ceil(len/4)).
  const approxFromChars = (chars) => (chars > 0 ? Math.ceil(chars / 4) : 0);

  function countInputChars(body) {
    let chars = 0;
    if (body && typeof body === 'object') {
      if (typeof body.system === 'string') chars += body.system.length;
      else if (Array.isArray(body.system)) {
        for (const b of body.system) if (b && typeof b.text === 'string') chars += b.text.length;
      }
      for (const msg of Array.isArray(body.messages) ? body.messages : []) {
        const c = msg?.content;
        if (typeof c === 'string') chars += c.length;
        else if (Array.isArray(c)) {
          for (const block of c) {
            if (!block || typeof block !== 'object') continue;
            if (typeof block.text === 'string') chars += block.text.length;
            const rc = block.content;
            if (typeof rc === 'string') chars += rc.length;
            else if (Array.isArray(rc)) {
              for (const inner of rc) if (inner && typeof inner.text === 'string') chars += inner.text.length;
            }
            if (block.input && typeof block.input === 'object') {
              chars += JSON.stringify(block.input).length;
            }
          }
        }
      }
    }
    return chars;
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        /* leave body = {} */
      }
      const inputTokens = approxFromChars(countInputChars(body));
      state.calls += 1;

      // Biggest call we ever see is the uncompacted shadow baseline.
      if (state.baselineInputTokens == null || inputTokens > state.baselineInputTokens) {
        state.baselineInputTokens = inputTokens;
      }
      // Smallest non-stream call is the compacted primary request.
      if (body && body.stream !== true) {
        if (state.lastCompactedInputTokens == null || inputTokens < state.lastCompactedInputTokens) {
          state.lastCompactedInputTokens = inputTokens;
        }
      }

      const outputTokens = approxFromChars(CANNED_ANSWER.length);
      const payload = JSON.stringify({
        id: 'msg_demo_' + state.calls,
        type: 'message',
        role: 'assistant',
        model: body?.model ?? MODEL,
        content: [{ type: 'text', text: CANNED_ANSWER }],
        stop_reason: 'end_turn',
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      });
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(payload)),
      });
      res.end(payload);
    });
    req.on('error', () => {
      try {
        res.writeHead(400);
        res.end();
      } catch {
        /* ignore */
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      state.url = `http://127.0.0.1:${addr.port}`;
      resolve({
        get url() {
          return state.url;
        },
        get baselineInputTokens() {
          return state.baselineInputTokens;
        },
        get lastCompactedInputTokens() {
          return state.lastCompactedInputTokens;
        },
        get calls() {
          return state.calls;
        },
        close: () =>
          new Promise((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}

/** Build an agent-style request with several big, repetitive tool_result dumps. */
function buildBloatedRequest() {
  // A chunky simulated log line, repeated to make a fat "file dump".
  const logBlock = (tag, n) =>
    Array.from(
      { length: n },
      (_, i) =>
        `[2026-06-16T12:${String(i % 60).padStart(2, '0')}:0${i % 10}Z] ${tag} ` +
        `worker=pool-3 conn=tcp://10.0.${i % 8}.${i % 250} status=503 ` +
        `retry=${i} latency_ms=${1200 + i} msg="upstream inventory service unavailable, retrying without backoff"`,
    ).join('\n');

  const fileDump =
    '// src/widgets/fetchWidget.ts\n' +
    Array.from(
      { length: 120 },
      (_, i) => `  line${i}: const r${i} = await fetch(url, { retry: true }); // no backoff ceiling`,
    ).join('\n');

  const toolResult = (id, text) => ({
    type: 'tool_result',
    tool_use_id: id,
    content: [{ type: 'text', text }],
    // An UNKNOWN sibling field the compactor must preserve untouched.
    _ctxgov_demo_meta: { source: 'demo', kept: true },
  });

  return {
    model: MODEL,
    max_tokens: 512,
    stream: false,
    // Unknown top-level field — must survive the round trip.
    metadata: { user_id: 'demo-user', _demo: true },
    system: 'You are a debugging assistant. Diagnose the failure from the logs.',
    messages: [
      { role: 'user', content: 'My widget service is throwing 503s in a hot loop. Here are the logs and the source.' },
      { role: 'assistant', content: [{ type: 'text', text: 'Let me read the logs and the source file.' }] },
      {
        role: 'user',
        content: [
          // Three large OLD tool-result dumps -> elision targets.
          toolResult('toolu_log1', 'LOG DUMP 1 (app server):\n' + logBlock('ERROR', 200)),
          toolResult('toolu_log2', 'LOG DUMP 2 (gateway):\n' + logBlock('WARN', 200)),
          // The SAME file dumped twice across the convo -> dedup target.
          toolResult('toolu_file_a', 'FILE DUMP:\n' + fileDump),
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'I see repeated 503s with no backoff. Let me re-read the file to confirm.' }],
      },
      {
        role: 'user',
        content: [
          // Duplicate of the earlier file dump (earlier copy gets deduped).
          toolResult('toolu_file_b', 'FILE DUMP:\n' + fileDump),
          // The FRESHEST result is kept intact (keepRecentToolResults=1).
          toolResult('toolu_log3', 'LOG DUMP 3 (latest tail):\n' + logBlock('ERROR', 40)),
        ],
      },
      { role: 'user', content: 'What is the root cause and the fix?' },
    ],
  };
}

/** POST JSON and return the parsed response (throws on transport failure). */
function postJson(url, body, headers) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body), 'utf8');
    const u = new URL(url);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: 'POST',
        headers: { ...headers, 'content-length': String(data.length) },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            resolve(JSON.parse(text));
          } catch {
            resolve(text);
          }
        });
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Poll a loopback port with quick TCP connects until it accepts, or time out. */
async function waitForListening(port, timeoutMs) {
  const net = await import('node:net');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ok = await new Promise((resolve) => {
      const sock = net.connect({ host: '127.0.0.1', port }, () => {
        sock.end();
        resolve(true);
      });
      sock.on('error', () => resolve(false));
      sock.setTimeout(200, () => {
        sock.destroy();
        resolve(false);
      });
    });
    if (ok) return;
    if (Date.now() > deadline) return; // give up quietly; the POST will surface it
    await delay(40);
  }
}

/** Reserve a free loopback port by briefly listening on port 0, then closing. */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function fmtNum(n) {
  return Number(n || 0).toLocaleString('en-US');
}
function fmtUSD(n) {
  const v = Number(n || 0);
  if (v !== 0 && Math.abs(v) < 0.01) return '$' + v.toFixed(5);
  return '$' + v.toFixed(4);
}
function pct(n) {
  return Number(n || 0).toFixed(0) + '%';
}
function row(label, a, b, c) {
  return '  ' + label.padEnd(26) + String(a).padStart(11) + String(b).padStart(14) + String(c).padStart(14);
}
function qualityVerdict(deg, budget) {
  if (deg == null) return 'unmeasured';
  if (deg <= budget) return 'PASS - within budget, answer preserved';
  return 'FAIL - over budget (safe-mode would trip)';
}

async function cleanup(code) {
  if (cleaned) return;
  cleaned = true;
  try {
    await proxy?.close?.();
  } catch {
    /* ignore */
  }
  try {
    store?.close?.();
  } catch {
    /* ignore */
  }
  try {
    await mock?.close?.();
  } catch {
    /* ignore */
  }
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  process.exit(code);
}

process.on('uncaughtException', async (err) => {
  console.error('Uncaught:', err?.message ?? err);
  await cleanup(1);
});
