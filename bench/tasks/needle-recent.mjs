// bench/tasks/needle-recent.mjs
//
// CATEGORY: needle-recent (SURVIVABLE).
//
// Each task buries a UNIQUE, unambiguous fact (a code, a name, a port number)
// inside a RECENT user/assistant message near the END of the conversation, or
// marks it pinned with the '<!--ctxgov:pin-->' sentinel. The EARLIER part of
// every conversation is stuffed with 5000+ tokens of genuinely irrelevant junk:
// old duplicated file/log dumps and old tool results that a correct compactor
// elides (older tool results beyond the most-recent 1) or dedupes (earlier
// duplicate copies). The final question asks only for the recent needle.
//
// HONESTY: the answer never lives in the junk that gets compacted away. The junk
// is irrelevant to the question, so eliding/deduping it cannot change the answer.
// A correct compactor keeps the recent/pinned needle => governed answer stays
// correct while using far fewer tokens.
//
// Plain Node ESM, dependency-free, no network, no imports.

// ---------------------------------------------------------------------------
// Junk generators. These build large, realistic-looking blobs of text that have
// nothing to do with any task's needle. We size them so each task carries well
// over 5000 tokens (~20000+ chars) of bloat before the recent needle.
// ---------------------------------------------------------------------------

/** A varied pool of realistic-looking log lines (no needle content). */
const LOG_LINES = [
  '2026-05-12T09:14:02.118Z INFO  [http] GET /api/v2/orders 200 14ms trace=7f3a9c keepalive=true',
  '2026-05-12T09:14:02.140Z DEBUG [pool] acquired connection conn-41 (idle=7 active=12 max=64)',
  '2026-05-12T09:14:02.201Z WARN  [cache] redis MGET latency 88ms exceeded soft budget 50ms',
  '2026-05-12T09:14:02.233Z INFO  [auth] jwt verified sub=user_8812 scope=read:orders exp ok',
  '2026-05-12T09:14:02.288Z ERROR [worker] retry 3/5 job=email.send backoff=400ms cause=ETIMEDOUT',
  '2026-05-12T09:14:02.301Z DEBUG [gc] minor collection 6.2ms heapUsed=212MB heapTotal=512MB',
  '2026-05-12T09:14:02.355Z INFO  [http] POST /api/v2/checkout 201 42ms trace=11b8e2 region=eu',
  '2026-05-12T09:14:02.390Z WARN  [ratelimit] bucket api:free near limit 992/1000 reset=37s',
  '2026-05-12T09:14:02.412Z DEBUG [pool] released connection conn-41 lifetime=2.1s reused=18',
  '2026-05-12T09:14:02.470Z INFO  [metrics] flushed 340 series to statsd in 3.4ms drops=0',
  '2026-05-12T09:14:02.501Z ERROR [db] query timeout after 5000ms statement=SELECT_orders_by_user',
  '2026-05-12T09:14:02.533Z INFO  [http] GET /healthz 200 0ms trace=000000 probe=kubelet',
  '2026-05-12T09:14:02.560Z DEBUG [feature] flag new_checkout=off for user_8812 cohort=control',
  '2026-05-12T09:14:02.611Z WARN  [tls] certificate for cdn.internal expires in 9 days renew soon',
  '2026-05-12T09:14:02.644Z INFO  [queue] depth=128 oldest=2.0s consumers=6 lag=ok',
  '2026-05-12T09:14:02.690Z DEBUG [router] matched route GET /api/v2/orders handler=listOrders',
  '2026-05-12T09:14:02.733Z INFO  [audit] user_8812 action=view resource=order_55021 result=allow',
  '2026-05-12T09:14:02.781Z WARN  [memory] rss 1.4GB approaching container limit 2GB scale soon',
  '2026-05-12T09:14:02.822Z ERROR [http] 502 upstream payment-gw connect refused retrying once',
  '2026-05-12T09:14:02.860Z INFO  [shutdown] SIGTERM received draining 12 in-flight requests',
];

/** A realistic-looking config/source dump (no needle content). */
const CONFIG_DUMP = `# ---- service.yaml (rendered) ----
apiVersion: apps/v1
kind: Deployment
metadata:
  name: orders-api
  namespace: commerce
  labels: { app: orders-api, tier: backend, version: "4.18.2" }
spec:
  replicas: 6
  strategy: { type: RollingUpdate, rollingUpdate: { maxSurge: 2, maxUnavailable: 0 } }
  template:
    spec:
      containers:
        - name: orders-api
          image: registry.internal/commerce/orders-api:4.18.2
          resources:
            requests: { cpu: "500m", memory: "512Mi" }
            limits:   { cpu: "2",    memory: "2Gi" }
          env:
            - { name: LOG_LEVEL, value: "info" }
            - { name: POOL_MIN,  value: "8" }
            - { name: POOL_MAX,  value: "64" }
            - { name: CACHE_TTL, value: "300" }
            - { name: HTTP_TIMEOUT_MS, value: "5000" }
          readinessProbe: { httpGet: { path: /healthz, port: 8080 }, periodSeconds: 5 }
          livenessProbe:  { httpGet: { path: /livez,   port: 8080 }, periodSeconds: 10 }
# ---- end service.yaml ----`;

/** A realistic-looking stack trace (no needle content). */
const STACK_TRACE = `Unhandled rejection at processOrder (orders/pipeline.js:212:17)
    at async listOrders (orders/handlers.js:88:5)
    at async Router.dispatch (server/router.js:140:9)
    at async Server.<anonymous> (server/http.js:53:3)
  caused by: TimeoutError: Timeout acquiring a connection. The pool is probably full.
    at Pool._enqueueRequest (db/pool.js:301:13)
    at Pool.acquire (db/pool.js:266:21)
    at getClient (db/index.js:44:28)
    at processOrder (orders/pipeline.js:205:30)
  context: { userId: 'user_8812', orderId: 'order_55021', attempt: 3, region: 'eu-west-1' }`;

/**
 * Build a big junk blob (the same content every call when `seed` is fixed), sized
 * to clear the 5000-token / 20000-char bloat bar on its own.
 * @param {string} seed - label woven into the blob so blobs can look distinct.
 * @param {number} reps - how many times to repeat the log block.
 */
function junkBlob(seed, reps = 16) {
  const parts = [];
  parts.push(`==== diagnostic bundle ${seed} ====`);
  parts.push(CONFIG_DUMP);
  for (let r = 0; r < reps; r++) {
    parts.push(`--- log segment ${seed}#${r} ---`);
    for (const line of LOG_LINES) parts.push(line);
    if (r % 4 === 0) parts.push(STACK_TRACE);
  }
  parts.push(`==== end diagnostic bundle ${seed} ====`);
  return parts.join('\n');
}

/**
 * An IDENTICAL large blob (no seed variance) used to trigger dedup: when the same
 * normalized text appears 3-5 times, the compactor keeps the last copy and elides
 * the earlier ones. Must be > 200 normalized chars (it is, by far).
 */
function dedupBlob() {
  const parts = [CONFIG_DUMP, STACK_TRACE];
  for (let r = 0; r < 10; r++) {
    for (const line of LOG_LINES) parts.push(line);
  }
  return parts.join('\n');
}

/** Convenience: a valid OpenAI tool call + matching tool result, big content. */
function toolPair(callId, fnName, args, resultText) {
  return [
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: callId,
          type: 'function',
          function: { name: fnName, arguments: JSON.stringify(args) },
        },
      ],
    },
    { role: 'tool', tool_call_id: callId, content: resultText },
  ];
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

const tasks = [
  // -------------------------------------------------------------------------
  // 1. Deploy token in a RECENT user message. Junk via OLD tool results (elision).
  // -------------------------------------------------------------------------
  {
    id: 'nr-deploy-token',
    category: 'needle-recent',
    answerLocation: 'recent',
    build() {
      const messages = [
        {
          role: 'system',
          content:
            'You are a release-automation assistant. Answer concisely using the conversation.',
        },
        { role: 'user', content: 'Pull the orders-api deployment manifest and the recent error logs so we can debug the timeout.' },
        // Several OLD large tool results: all but the most recent get elided.
        ...toolPair('call_1', 'read_file', { path: 'k8s/orders-api.yaml' }, junkBlob('manifest', 14)),
        ...toolPair('call_2', 'tail_logs', { service: 'orders-api', lines: 4000 }, junkBlob('logs-a', 16)),
        ...toolPair('call_3', 'tail_logs', { service: 'orders-api', lines: 4000 }, junkBlob('logs-b', 16)),
        ...toolPair('call_4', 'get_stacktrace', { incident: 'INC-4471' }, junkBlob('trace', 14)),
        {
          role: 'assistant',
          content:
            'Thanks — I reviewed the manifest, the log tails, and the stack trace. The timeouts line up with pool exhaustion under load. Before I trigger the rollout, what deploy token should I use?',
        },
        // RECENT needle: lives in the last user turn, not in any junk.
        {
          role: 'user',
          content:
            'Use the one-time deploy token for this release: ZX-7782. Go ahead and reference it when you summarize the plan.',
        },
      ];
      return { messages, question: 'What deploy token should I use for this release?' };
    },
    expected: 'ZX-7782',
    grade(answer) {
      return typeof answer === 'string' && answer.toLowerCase().includes('zx-7782');
    },
    note: 'Token lives in the final user message; old tool-result dumps are irrelevant and only elided.',
  },

  // -------------------------------------------------------------------------
  // 2. On-call engineer name in a RECENT assistant message. Junk via DEDUP.
  // -------------------------------------------------------------------------
  {
    id: 'nr-oncall-engineer',
    category: 'needle-recent',
    answerLocation: 'recent',
    build() {
      const dup = dedupBlob(); // identical large block pasted multiple times -> dedup
      const messages = [
        { role: 'system', content: 'You are an incident-response coordinator. Be concise and exact.' },
        { role: 'user', content: 'Here is the full diagnostic bundle for INC-4471. Keep it for reference:\n' + dup },
        { role: 'assistant', content: 'Received the diagnostic bundle. Noted.' },
        { role: 'user', content: 'I am pasting the same bundle again to be safe:\n' + dup },
        { role: 'assistant', content: 'Got the second copy; it matches the first.' },
        { role: 'user', content: 'And once more, identical bundle, just in case it scrolled off:\n' + dup },
        { role: 'assistant', content: 'Confirmed — third copy is byte-for-byte the same as the others.' },
        { role: 'user', content: 'Who is picking up this incident tonight?' },
        // RECENT needle: in the final assistant message.
        {
          role: 'assistant',
          content:
            'I checked the on-call rotation for tonight. The on-call engineer for INC-4471 is Priya Raman; page her if the error rate crosses 2%.',
        },
        { role: 'user', content: 'Good. Remind me of that name.' },
      ];
      return { messages, question: 'Who is the on-call engineer for INC-4471 tonight?' };
    },
    expected: 'Priya Raman',
    grade(answer) {
      return typeof answer === 'string' && answer.toLowerCase().includes('priya raman');
    },
    note: 'Name is stated in the recent assistant turn; the thrice-pasted identical bundle is pure dedup bait.',
  },

  // -------------------------------------------------------------------------
  // 3. Prod DB port in a PINNED message. Junk via OLD tool results (elision).
  // -------------------------------------------------------------------------
  {
    id: 'nr-prod-db-port',
    category: 'needle-recent',
    answerLocation: 'pinned',
    build() {
      const messages = [
        { role: 'system', content: 'You are a database operations assistant. Answer with exact values.' },
        { role: 'user', content: 'Gather the env dumps and recent connection logs for the prod cluster.' },
        ...toolPair('call_1', 'dump_env', { host: 'pg-prod-1' }, junkBlob('env-1', 16)),
        ...toolPair('call_2', 'dump_env', { host: 'pg-prod-2' }, junkBlob('env-2', 16)),
        ...toolPair('call_3', 'tail_logs', { service: 'pgbouncer', lines: 5000 }, junkBlob('pgb', 16)),
        // PINNED needle: sentinel keeps this message verbatim no matter where it sits.
        {
          role: 'user',
          content:
            '<!--ctxgov:pin--> IMPORTANT REFERENCE: the production Postgres database listens on port 5439 (not the default 5432). Always connect to 5439 in prod.',
        },
        ...toolPair('call_4', 'tail_logs', { service: 'pgbouncer', lines: 5000 }, junkBlob('pgb2', 16)),
        { role: 'assistant', content: 'Collected the env dumps and connection logs. Ready for your question.' },
        { role: 'user', content: 'What port does the production Postgres database listen on?' },
      ];
      return { messages, question: 'What port does the production Postgres database listen on?' };
    },
    expected: '5439',
    grade(answer) {
      if (typeof answer !== 'string') return false;
      const m = answer.match(/\b(\d{3,5})\b/g);
      return Array.isArray(m) && m.includes('5439');
    },
    note: 'Port is in a pin-sentinel message (kept verbatim); surrounding tool dumps are irrelevant and elided.',
  },

  // -------------------------------------------------------------------------
  // 4. Rollback build number in a RECENT user message. Junk via DEDUP + old tools.
  // -------------------------------------------------------------------------
  {
    id: 'nr-rollback-build',
    category: 'needle-recent',
    answerLocation: 'recent',
    build() {
      const dup = dedupBlob();
      const messages = [
        { role: 'system', content: 'You are a CI/CD assistant. Give exact build identifiers.' },
        { role: 'user', content: 'Reference CI bundle for the failing pipeline:\n' + dup },
        ...toolPair('call_1', 'get_pipeline', { id: 'pipe-9001' }, junkBlob('pipe-a', 16)),
        { role: 'assistant', content: 'Reviewed the CI bundle and the first pipeline dump.' },
        { role: 'user', content: 'Same CI bundle again so it stays in view:\n' + dup },
        ...toolPair('call_2', 'get_pipeline', { id: 'pipe-9002' }, junkBlob('pipe-b', 16)),
        { role: 'assistant', content: 'Second copy matches; pipeline dumps reviewed.' },
        { role: 'user', content: 'One more identical paste of the CI bundle:\n' + dup },
        {
          role: 'assistant',
          content:
            'All three CI bundle copies are identical. The current release is unstable. Which build should we roll back to?',
        },
        // RECENT needle: final user turn.
        {
          role: 'user',
          content:
            'Roll back production to the last known-good build: build #4471-stable. Pin that as the rollback target.',
        },
      ];
      return { messages, question: 'Which build should we roll back production to?' };
    },
    expected: '4471-stable',
    grade(answer) {
      if (typeof answer !== 'string') return false;
      const a = answer.toLowerCase();
      return a.includes('4471-stable') || (a.includes('4471') && a.includes('stable'));
    },
    note: 'Build id is in the last user message; the thrice-pasted CI bundle and old pipeline dumps are irrelevant.',
  },

  // -------------------------------------------------------------------------
  // 5. API base URL / region in a RECENT assistant message. Junk via old tools.
  // -------------------------------------------------------------------------
  {
    id: 'nr-api-base-url',
    category: 'needle-recent',
    answerLocation: 'recent',
    build() {
      const messages = [
        { role: 'system', content: 'You are an integration assistant. Answer with the exact endpoint.' },
        { role: 'user', content: 'Fetch the gateway config and recent request logs for the payments integration.' },
        ...toolPair('call_1', 'read_file', { path: 'gateway/config.yaml' }, junkBlob('gw-cfg', 16)),
        ...toolPair('call_2', 'tail_logs', { service: 'gateway', lines: 4000 }, junkBlob('gw-log-a', 16)),
        ...toolPair('call_3', 'tail_logs', { service: 'gateway', lines: 4000 }, junkBlob('gw-log-b', 16)),
        { role: 'user', content: 'Where should the payments client point now?' },
        // RECENT needle: final assistant turn carries the unique endpoint.
        {
          role: 'assistant',
          content:
            'Based on the migration, the payments client should point at the new endpoint: https://pay-eu2.api.internal:8443/v3. The old eu1 host is being decommissioned, so use pay-eu2 going forward.',
        },
        { role: 'user', content: 'Repeat the exact base URL the payments client should use.' },
      ];
      return { messages, question: 'What base URL should the payments client point at?' };
    },
    expected: 'https://pay-eu2.api.internal:8443/v3',
    grade(answer) {
      if (typeof answer !== 'string') return false;
      const a = answer.toLowerCase();
      return a.includes('pay-eu2.api.internal:8443/v3') || a.includes('https://pay-eu2.api.internal:8443/v3');
    },
    note: 'Endpoint stated in the recent assistant turn; gateway config + log tool dumps are irrelevant and elided.',
  },
];

export default tasks;
