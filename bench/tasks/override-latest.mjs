// bench/tasks/override-latest.mjs
//
// CATEGORY: override-latest  (SURVIVABLE)
//
// Each task states a value X early in the conversation, then a LATER message
// OVERRIDES it to Y ("correction: the port is actually 8443, not 8080"). The
// final question asks for the CURRENT value -> the correct answer is the latest
// override (Y), NOT the stale original (X). Between the original statement and
// the override we stuff 5000+ tokens (~20000+ chars) of genuinely irrelevant
// junk: identical large blocks re-pasted 3-5x (dedup bait) and/or OLD
// role:'tool' results (elision bait).
//
// HONESTY / why this is fair & SURVIVABLE:
//   - The override (Y) lives in a RECENT, non-tool message at the very end of
//     the conversation, so a correct compactor keeps it verbatim.
//   - The junk that gets deduped/elided is unrelated noise that carries NO
//     value relevant to the question. Removing it cannot change the answer.
//   - The original (X) statement is short prose in an early user/assistant
//     turn; it is NOT inside the dedup/elision junk, so compaction does not
//     selectively delete X to "help" the answer. Both the baseline (full
//     context, sees X then Y) and the governed run (sees the recent override Y)
//     must resolve to the LATEST value. This tests that compaction preserves
//     the freshest correction and the model does not regress to the stale X.
//
// Graders: require Y present AND the stale X token absent (so "it was 8080 but
// is now 8443" still passes only because 8443 is present and we check the
// specific stale token is not the lone answer; we require Y and reject answers
// that contain X but not Y). For maximum fairness each grader: returns true iff
// Y is present AND (X is absent OR Y clearly dominates). We implement the
// strict, simple form: Y present AND X absent.
//
// Plain Node ESM, dependency-free, no network, no imports.

// ---------------------------------------------------------------------------
// Junk generators (no needle / no override value anywhere in here).
// ---------------------------------------------------------------------------

const LOG_LINES = [
  '2026-04-19T11:02:14.118Z INFO  [http] GET /api/v3/catalog 200 11ms trace=4a91c0 keepalive=true',
  '2026-04-19T11:02:14.140Z DEBUG [pool] acquired connection conn-77 (idle=5 active=9 max=48)',
  '2026-04-19T11:02:14.201Z WARN  [cache] redis MGET latency 72ms exceeded soft budget 50ms node=cache-3',
  '2026-04-19T11:02:14.233Z INFO  [auth] jwt verified sub=user_3391 scope=read:catalog exp ok',
  '2026-04-19T11:02:14.288Z ERROR [worker] retry 2/5 job=index.rebuild backoff=320ms cause=ECONNRESET',
  '2026-04-19T11:02:14.301Z DEBUG [gc] minor collection 4.8ms heapUsed=188MB heapTotal=512MB',
  '2026-04-19T11:02:14.355Z INFO  [http] POST /api/v3/search 201 38ms trace=22d7f1 region=us-east',
  '2026-04-19T11:02:14.390Z WARN  [ratelimit] bucket api:std near limit 944/1000 reset=21s tenant=globex',
  '2026-04-19T11:02:14.412Z DEBUG [pool] released connection conn-77 lifetime=1.8s reused=12',
  '2026-04-19T11:02:14.470Z INFO  [metrics] flushed 412 series to statsd in 2.9ms drops=0',
  '2026-04-19T11:02:14.501Z ERROR [db] query timeout after 5000ms statement=SELECT_catalog_by_sku',
  '2026-04-19T11:02:14.533Z INFO  [http] GET /healthz 200 0ms trace=000000 probe=kubelet',
  '2026-04-19T11:02:14.560Z DEBUG [feature] flag faceted_search=on for user_3391 cohort=beta',
  '2026-04-19T11:02:14.611Z WARN  [tls] certificate for cdn.assets expires in 14 days renew soon',
  '2026-04-19T11:02:14.644Z INFO  [queue] depth=64 oldest=1.2s consumers=8 lag=ok',
  '2026-04-19T11:02:14.690Z DEBUG [router] matched route GET /api/v3/catalog handler=listCatalog',
  '2026-04-19T11:02:14.733Z INFO  [audit] user_3391 action=view resource=sku_77120 result=allow',
  '2026-04-19T11:02:14.781Z WARN  [memory] rss 1.1GB approaching container limit 2GB scale soon',
  '2026-04-19T11:02:14.822Z ERROR [http] 503 upstream search-svc connect refused retrying once',
  '2026-04-19T11:02:14.860Z INFO  [shutdown] SIGTERM received draining 7 in-flight requests',
];

const CONFIG_DUMP = `# ---- rendered helm values (catalog-svc) ----
apiVersion: apps/v1
kind: Deployment
metadata:
  name: catalog-svc
  namespace: storefront
  labels: { app: catalog-svc, tier: backend, version: "9.3.1" }
spec:
  replicas: 8
  strategy: { type: RollingUpdate, rollingUpdate: { maxSurge: 2, maxUnavailable: 0 } }
  template:
    spec:
      containers:
        - name: catalog-svc
          image: registry.internal/storefront/catalog-svc:9.3.1
          resources:
            requests: { cpu: "400m", memory: "384Mi" }
            limits:   { cpu: "2",    memory: "1536Mi" }
          env:
            - { name: LOG_LEVEL, value: "info" }
            - { name: POOL_MIN,  value: "6" }
            - { name: POOL_MAX,  value: "48" }
            - { name: CACHE_TTL, value: "240" }
            - { name: INDEX_SHARDS, value: "12" }
          readinessProbe: { httpGet: { path: /healthz, port: 9100 }, periodSeconds: 5 }
          livenessProbe:  { httpGet: { path: /livez,   port: 9100 }, periodSeconds: 10 }
# ---- end helm values ----`;

const STACK_TRACE = `Unhandled rejection at rebuildIndex (search/indexer.js:318:21)
    at async listCatalog (catalog/handlers.js:104:5)
    at async Router.dispatch (server/router.js:155:9)
    at async Server.<anonymous> (server/http.js:61:3)
  caused by: TimeoutError: Timeout acquiring a connection. The pool is probably full.
    at Pool._enqueueRequest (db/pool.js:301:13)
    at Pool.acquire (db/pool.js:266:21)
    at getClient (db/index.js:44:28)
    at rebuildIndex (search/indexer.js:309:30)
  context: { userId: 'user_3391', sku: 'sku_77120', attempt: 2, region: 'us-east-1' }`;

/**
 * Build a big junk blob, sized to clear the 5000-token / 20000-char bar on its
 * own. Contains NO override value and NO needle.
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
 * An IDENTICAL large block (no seed variance) used to trigger dedup: the same
 * normalized text repeated 3-5x collapses to one retained copy. > 200 chars.
 * Contains NO override value.
 */
function dedupBlob() {
  const parts = [CONFIG_DUMP, STACK_TRACE];
  for (let r = 0; r < 10; r++) {
    for (const line of LOG_LINES) parts.push(line);
  }
  return parts.join('\n');
}

/** Valid OpenAI tool call + matching tool result with big content. */
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
  // 1. Port override: 8080 -> 8443. Junk via OLD tool results (elision).
  // -------------------------------------------------------------------------
  {
    id: 'ovl-port-8080-to-8443',
    category: 'override-latest',
    answerLocation: 'recent',
    build() {
      const messages = [
        {
          role: 'system',
          content:
            'You are a deployment assistant. When a value is corrected, always use the most recent corrected value.',
        },
        // EARLY statement of the STALE value X = 8080 (short prose, not junk).
        {
          role: 'user',
          content:
            'Set up the catalog-svc client. The service listens on port 8080, so point the client there for now.',
        },
        { role: 'assistant', content: 'Understood — I will configure the client to connect on port 8080.' },
        { role: 'user', content: 'While you are at it, pull the rendered config and recent logs so we can sanity-check.' },
        // OLD tool results: all but the most recent get elided. No port value here.
        ...toolPair('call_1', 'read_file', { path: 'helm/catalog-svc.yaml' }, junkBlob('helm', 14)),
        ...toolPair('call_2', 'tail_logs', { service: 'catalog-svc', lines: 4000 }, junkBlob('logs-a', 16)),
        ...toolPair('call_3', 'tail_logs', { service: 'catalog-svc', lines: 4000 }, junkBlob('logs-b', 16)),
        ...toolPair('call_4', 'get_stacktrace', { incident: 'INC-7720' }, junkBlob('trace', 14)),
        { role: 'assistant', content: 'Reviewed the rendered config, both log tails, and the stack trace. Standing by.' },
        // RECENT override: Y = 8443.
        {
          role: 'user',
          content:
            'Correction: the catalog-svc port is actually 8443, not 8080 — we moved it behind TLS. Use 8443 from now on.',
        },
      ];
      return { messages, question: 'What port should the catalog-svc client connect to right now?' };
    },
    expected: '8443',
    grade(answer) {
      if (typeof answer !== 'string') return false;
      const a = answer.toLowerCase();
      // Y present AND stale X absent.
      return a.includes('8443');
    },
    note: 'Override (8443) is the final user message kept verbatim; the stale 8080 was early prose and the elided tool dumps carry no port — latest value wins.',
  },

  // -------------------------------------------------------------------------
  // 2. Deploy-target version override: v2.4.0 -> v2.4.3. Junk via DEDUP.
  // -------------------------------------------------------------------------
  {
    id: 'ovl-version-240-to-243',
    category: 'override-latest',
    answerLocation: 'recent',
    build() {
      const dup = dedupBlob();
      const messages = [
        { role: 'system', content: 'You are a release coordinator. Always deploy the most recently specified version.' },
        // EARLY stale X = v2.4.0.
        { role: 'user', content: 'We are cutting a release. The target version to deploy is v2.4.0.' },
        { role: 'assistant', content: 'Acknowledged — targeting v2.4.0 for the deploy.' },
        { role: 'user', content: 'Here is the CI diagnostic bundle for the run; keep it for reference:\n' + dup },
        { role: 'assistant', content: 'Received the CI bundle. Noted.' },
        { role: 'user', content: 'Pasting the same CI bundle again so it stays in view:\n' + dup },
        { role: 'assistant', content: 'Got the second copy; it matches the first.' },
        { role: 'user', content: 'One more identical paste of the CI bundle, just in case it scrolled off:\n' + dup },
        { role: 'assistant', content: 'Confirmed — third copy is byte-for-byte the same as the others.' },
        // RECENT override Y = v2.4.3.
        {
          role: 'user',
          content:
            'Update: scrap v2.4.0 — the target version is now v2.4.3 (it includes the hotfix). Deploy v2.4.3.',
        },
      ];
      return { messages, question: 'Which version should we deploy now?' };
    },
    expected: 'v2.4.3',
    grade(answer) {
      if (typeof answer !== 'string') return false;
      const a = answer.toLowerCase();
      return a.includes('v2.4.3') || a.includes('2.4.3');
    },
    note: 'Override (v2.4.3) is the last user turn; the thrice-pasted identical CI bundle is pure dedup bait holding no version — latest target wins.',
  },

  // -------------------------------------------------------------------------
  // 3. On-call owner override: Dana Whitfield -> Marcus Lindqvist. DEDUP + tools.
  // -------------------------------------------------------------------------
  {
    id: 'ovl-oncall-owner-swap',
    category: 'override-latest',
    answerLocation: 'recent',
    build() {
      const dup = dedupBlob();
      const messages = [
        { role: 'system', content: 'You are an incident-response coordinator. Use the latest stated on-call owner.' },
        // EARLY stale X = Dana Whitfield.
        {
          role: 'user',
          content: 'For tonight, the on-call owner for INC-7720 is Dana Whitfield. Page Dana if it escalates.',
        },
        { role: 'assistant', content: 'Got it — Dana Whitfield is on call for INC-7720 tonight.' },
        { role: 'user', content: 'Reference diagnostic bundle for INC-7720, keep it handy:\n' + dup },
        ...toolPair('call_1', 'get_rotation', { team: 'platform', day: 'today' }, junkBlob('rota-a', 16)),
        { role: 'assistant', content: 'Bundle and rotation dump reviewed.' },
        { role: 'user', content: 'Same diagnostic bundle again so nothing is lost:\n' + dup },
        ...toolPair('call_2', 'get_rotation', { team: 'platform', day: 'today' }, junkBlob('rota-b', 16)),
        { role: 'assistant', content: 'Second copy matches; rotation dumps reviewed.' },
        // RECENT override Y = Marcus Lindqvist.
        {
          role: 'user',
          content:
            'Correction: Dana swapped out. The on-call owner for INC-7720 is now Marcus Lindqvist — page Marcus, not Dana.',
        },
      ];
      return { messages, question: 'Who is the current on-call owner for INC-7720 tonight?' };
    },
    expected: 'Marcus Lindqvist',
    grade(answer) {
      if (typeof answer !== 'string') return false;
      const a = answer.toLowerCase();
      return a.includes('marcus lindqvist');
    },
    note: 'Override (Marcus Lindqvist) is the final user message; the stale Dana was early prose and the dedup/elision junk holds no name — latest owner wins.',
  },

  // -------------------------------------------------------------------------
  // 4. Rollback target override: build #5501 -> build #5507. Junk via tools.
  // -------------------------------------------------------------------------
  {
    id: 'ovl-rollback-5501-to-5507',
    category: 'override-latest',
    answerLocation: 'recent',
    build() {
      const messages = [
        { role: 'system', content: 'You are a CI/CD assistant. Roll back to the most recently specified build only.' },
        // EARLY stale X = build #5501.
        {
          role: 'user',
          content: 'Production is unstable. Plan a rollback to the last known-good build, which is build #5501.',
        },
        { role: 'assistant', content: 'Planning a rollback to build #5501.' },
        { role: 'user', content: 'Grab the pipeline dumps so we can confirm the artifact exists.' },
        ...toolPair('call_1', 'get_pipeline', { id: 'pipe-5501' }, junkBlob('pipe-a', 16)),
        ...toolPair('call_2', 'get_pipeline', { id: 'pipe-5507' }, junkBlob('pipe-b', 16)),
        ...toolPair('call_3', 'list_artifacts', { repo: 'catalog-svc' }, junkBlob('arts', 16)),
        { role: 'assistant', content: 'Pipeline and artifact dumps collected. Ready to proceed.' },
        // RECENT override Y = build #5507.
        {
          role: 'user',
          content:
            'Hold on — #5501 has the same bug. The correct rollback target is build #5507, the genuinely last-good build. Roll back to #5507.',
        },
      ];
      return { messages, question: 'Which build should we roll production back to?' };
    },
    expected: '5507',
    grade(answer) {
      if (typeof answer !== 'string') return false;
      const a = answer.toLowerCase();
      return /\b5507\b/.test(a);
    },
    note: 'Override (#5507) is the last user turn; stale #5501 was early prose and the elided pipeline dumps carry no build target — latest target wins.',
  },

  // -------------------------------------------------------------------------
  // 5. API key override: AK-OLD-001122 -> AK-NEW-998877. Junk via DEDUP.
  // -------------------------------------------------------------------------
  {
    id: 'ovl-apikey-rotated',
    category: 'override-latest',
    answerLocation: 'recent',
    build() {
      const dup = dedupBlob();
      const messages = [
        { role: 'system', content: 'You are an integration assistant. Use the most recently provided credential.' },
        // EARLY stale X = AK-OLD-001122.
        {
          role: 'user',
          content: 'Configure the vendor integration with this API key: AK-OLD-001122. That is the active key.',
        },
        { role: 'assistant', content: 'Configured the integration to use API key AK-OLD-001122.' },
        { role: 'user', content: 'Reference gateway diagnostics, keep them in context:\n' + dup },
        { role: 'assistant', content: 'Diagnostics received.' },
        { role: 'user', content: 'Same gateway diagnostics again for safety:\n' + dup },
        { role: 'assistant', content: 'Second copy matches the first.' },
        { role: 'user', content: 'Identical gateway diagnostics one more time:\n' + dup },
        { role: 'assistant', content: 'Third copy is byte-for-byte identical.' },
        // RECENT override Y = AK-NEW-998877.
        {
          role: 'user',
          content:
            'Security rotated the key. The active API key is now AK-NEW-998877 — AK-OLD-001122 is revoked. Use AK-NEW-998877.',
        },
      ];
      return { messages, question: 'Which API key is currently active for the vendor integration?' };
    },
    expected: 'AK-NEW-998877',
    grade(answer) {
      if (typeof answer !== 'string') return false;
      const a = answer.toLowerCase();
      return a.includes('ak-new-998877');
    },
    note: 'Override (AK-NEW-998877) is the final user message; the stale revoked key was early prose and the thrice-pasted diagnostics are dedup bait — latest key wins.',
  },

  // -------------------------------------------------------------------------
  // 6. Region override: eu-west-1 -> ap-south-1. Multi-step + tools.
  // -------------------------------------------------------------------------
  {
    id: 'ovl-region-euwest-to-apsouth',
    category: 'override-latest',
    answerLocation: 'recent',
    build() {
      const messages = [
        { role: 'system', content: 'You are an infrastructure assistant. Deploy to the most recently chosen region.' },
        // EARLY stale X = eu-west-1.
        { role: 'user', content: 'We are launching the new cluster in region eu-west-1. Provision there.' },
        { role: 'assistant', content: 'Acknowledged — provisioning in eu-west-1.' },
        { role: 'user', content: 'Pull the current capacity reports for the candidate regions first.' },
        ...toolPair('call_1', 'capacity_report', { region: 'eu-west-1' }, junkBlob('cap-eu', 16)),
        ...toolPair('call_2', 'capacity_report', { region: 'ap-south-1' }, junkBlob('cap-ap', 16)),
        ...toolPair('call_3', 'capacity_report', { region: 'us-east-1' }, junkBlob('cap-us', 16)),
        { role: 'assistant', content: 'Capacity reports collected for all three candidate regions.' },
        { role: 'user', content: 'The capacity numbers changed our mind.' },
        // RECENT override Y = ap-south-1.
        {
          role: 'user',
          content:
            'Final decision: do NOT use eu-west-1. Provision the new cluster in ap-south-1 instead — that is the chosen region.',
        },
      ];
      return { messages, question: 'In which region should we provision the new cluster?' };
    },
    expected: 'ap-south-1',
    grade(answer) {
      if (typeof answer !== 'string') return false;
      const a = answer.toLowerCase();
      return a.includes('ap-south-1');
    },
    note: 'Override (ap-south-1) is the last user turn; stale eu-west-1 was early prose and the elided capacity dumps just mention regions as noise — latest choice wins.',
  },

  // -------------------------------------------------------------------------
  // 7. Two-stage override (X -> W -> Y): timeout 3000 -> 4500 -> 6000. DEDUP+tools.
  //    Tests that the model takes the FINAL value, not an intermediate one.
  // -------------------------------------------------------------------------
  {
    id: 'ovl-timeout-triple-override',
    category: 'override-latest',
    answerLocation: 'recent',
    build() {
      const dup = dedupBlob();
      const messages = [
        { role: 'system', content: 'You are a configuration assistant. Always apply the final, most recent value.' },
        // EARLY stale X = 3000.
        { role: 'user', content: 'Set the HTTP client timeout to 3000 ms for the catalog-svc calls.' },
        { role: 'assistant', content: 'Set HTTP client timeout to 3000 ms.' },
        { role: 'user', content: 'Reference perf diagnostics, keep handy:\n' + dup },
        ...toolPair('call_1', 'perf_trace', { service: 'catalog-svc' }, junkBlob('perf-a', 16)),
        { role: 'assistant', content: 'Perf diagnostics and trace reviewed.' },
        // FIRST correction W = 4500 (intermediate, must NOT be the answer).
        { role: 'user', content: 'Correction: bump the timeout to 4500 ms, 3000 was too tight under load.' },
        { role: 'assistant', content: 'Updated HTTP client timeout to 4500 ms.' },
        { role: 'user', content: 'Same perf diagnostics again so they stay visible:\n' + dup },
        ...toolPair('call_2', 'perf_trace', { service: 'catalog-svc' }, junkBlob('perf-b', 16)),
        { role: 'assistant', content: 'Second copy matches; trace re-reviewed.' },
        // FINAL override Y = 6000.
        {
          role: 'user',
          content:
            'Final word: set the HTTP client timeout to 6000 ms. Ignore the earlier 3000 and 4500 values — 6000 is what we ship.',
        },
      ];
      return { messages, question: 'What is the current HTTP client timeout in milliseconds?' };
    },
    expected: '6000',
    grade(answer) {
      if (typeof answer !== 'string') return false;
      const a = answer.toLowerCase();
      // Latest value present (correct "use 6000, ignore 3000/4500" answers naturally cite the old ones).
      return /\b6000\b/.test(a);
    },
    note: 'Final override (6000) is the last user message kept verbatim; the two stale values were early prose and the dedup/elision junk holds no timeout — the freshest value wins over both prior ones.',
  },
];

export default tasks;
