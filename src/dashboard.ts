// src/dashboard.ts — lightweight live dashboard server.
//
// Serves a single self-contained SPA and streams GovernorEvents over SSE.
// SECURITY: only the fixed bundled HTML is served; no path from the request is
// ever mapped onto the filesystem.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Store, EventBus, GovernorEvent } from './types.js';

/** Heartbeat comment interval for SSE connections (ms). */
const SSE_PING_MS = 15_000;

/** Minimal fallback page used only when the bundled index.html cannot be located. */
const FALLBACK_HTML = `<!doctype html><html><head><meta charset="utf-8">
<title>tokdiet</title>
<style>body{font-family:system-ui,sans-serif;background:#0b0e14;color:#e6e6e6;margin:0;padding:2rem}</style>
</head><body><h1>tokdiet</h1>
<p>ccusage that shrinks the bill — without losing quality.</p>
<pre id="out"></pre>
<script>
const out=document.getElementById('out');
const es=new EventSource('/events');
es.onmessage=e=>{out.textContent=(e.data+"\\n"+out.textContent).slice(0,20000);};
</script></body></html>`;

/**
 * Resolve the on-disk SPA html, trying locations relative to this module
 * (works from both src/ and dist/) and finally the process working directory.
 * Returns the file contents, or the inline fallback when nothing is found.
 */
function loadIndexHtml(): string {
  let here = '';
  try {
    here = dirname(fileURLToPath(import.meta.url));
  } catch {
    here = process.cwd();
  }
  const candidates = [
    join(here, '..', 'src', 'dashboard', 'index.html'), // dist/dashboard.js -> ../src/dashboard/index.html
    join(here, 'dashboard', 'index.html'), // dist/dashboard.js -> ./dashboard/index.html
    join(here, '..', 'dashboard', 'index.html'), // alt layout
    join(process.cwd(), 'src', 'dashboard', 'index.html'),
  ];
  for (const c of candidates) {
    try {
      if (existsSync(c)) return readFileSync(c, 'utf8');
    } catch {
      // Ignore and try the next candidate.
    }
  }
  return FALLBACK_HTML;
}

/** Write a JSON body with a 200 status. */
function sendJson(res: ServerResponse, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** Parse the numeric `limit` query param, with sane bounds. */
function parseLimit(url: URL, fallback: number): number {
  const raw = url.searchParams.get('limit');
  if (raw == null) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, 1000);
}

/**
 * Start the dashboard HTTP server.
 *
 * Routes:
 *  - GET /              -> SPA html (fixed, never a filesystem path from input)
 *  - GET /events        -> SSE stream of GovernorEvents (with an initial snapshot)
 *  - GET /api/summary   -> JSON store.summary()
 *  - GET /api/recent    -> JSON store.recentRequests(limit)
 */
export function startDashboard(opts: { port: number; store: Store; bus: EventBus }): { close(): void } {
  const { port, store, bus } = opts;
  // Read the html once at startup; it is static for the process lifetime.
  const indexHtml = loadIndexHtml();

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const method = (req.method ?? 'GET').toUpperCase();
    // Robust URL parse: never throw on malformed request targets.
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      res.writeHead(400).end();
      return;
    }
    const path = url.pathname;

    if (method !== 'GET') {
      res.writeHead(405, { Allow: 'GET' }).end();
      return;
    }

    // ── SPA ──────────────────────────────────────────────────────────────────
    if (path === '/' || path === '/index.html') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(indexHtml);
      return;
    }

    // ── SSE event stream ───────────────────────────────────────────────────────
    if (path === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      // Initial snapshot so a freshly-connected client renders immediately.
      const snapshot = {
        type: 'snapshot',
        payload: { summary: safeSummary(store), recent: safeRecent(store, 50) },
      };
      res.write(`data: ${JSON.stringify(snapshot)}\n\n`);

      const onEvent = (e: GovernorEvent): void => {
        try {
          res.write(`data: ${JSON.stringify(e)}\n\n`);
        } catch {
          // Connection torn down mid-write; cleanup runs via 'close'.
        }
      };
      const unsubscribe = bus.subscribe(onEvent);

      const ping = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {
          // Ignore — 'close' will clean up.
        }
      }, SSE_PING_MS);
      // Do not keep the process alive solely for the heartbeat.
      if (typeof ping.unref === 'function') ping.unref();

      const cleanup = (): void => {
        clearInterval(ping);
        unsubscribe();
      };
      req.on('close', cleanup);
      req.on('error', cleanup);
      return;
    }

    // ── JSON APIs ────────────────────────────────────────────────────────────
    if (path === '/api/summary') {
      sendJson(res, safeSummary(store));
      return;
    }
    if (path === '/api/recent') {
      const limit = parseLimit(url, 50);
      sendJson(res, safeRecent(store, limit));
      return;
    }

    // ── 404 ──────────────────────────────────────────────────────────────────
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  });

  // Bind to loopback only. The dashboard exposes cost/usage telemetry with no
  // auth; the Node default (all interfaces) would make it readable network-wide.
  server.listen(port, '127.0.0.1');

  return {
    close(): void {
      server.close();
    },
  };
}

/** Call store.summary() defensively; never throw out of a request handler. */
function safeSummary(store: Store): ReturnType<Store['summary']> | Record<string, never> {
  try {
    return store.summary();
  } catch {
    return {} as Record<string, never>;
  }
}

/** Call store.recentRequests() defensively. */
function safeRecent(store: Store, limit: number): ReturnType<Store['recentRequests']> | [] {
  try {
    return store.recentRequests(limit);
  } catch {
    return [];
  }
}
