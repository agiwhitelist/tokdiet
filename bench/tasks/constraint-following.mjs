// bench/tasks/constraint-following.mjs
//
// CATEGORY: constraint-following  (SURVIVABLE)
//
// Each task plants an explicit INSTRUCTION / CONSTRAINT that the model must obey
// in its final answer — a fixed output format ("answer as CODE-<n>"), a secret
// passphrase to repeat, a mandatory prefix/suffix, a forbidden word, a required
// sign-off token, etc. The constraint is placed in a RECENT user/assistant turn
// or marked with the '<!--ctxgov:pin-->' sentinel so a correct compactor keeps
// it verbatim. The earlier conversation is stuffed with >=5000 tokens (~20000+
// chars) of genuinely irrelevant bloat: OLD role:'tool' result dumps (elided
// beyond the most-recent 1) and byte-identical re-pasted blocks (deduped).
//
// HONESTY: the constraint never lives in the junk that gets compacted away. The
// junk is unrelated boilerplate; eliding/deduping it cannot affect the model's
// ability to follow the recent/pinned constraint. A correct compactor keeps the
// constraint => governed answer still obeys it while using far fewer tokens.
//
// Graders are objective: they check the constraint was literally satisfied
// (exact format via regex, passphrase substring present, required prefix at the
// start, forbidden word absent, sign-off token present). Empty/wrong answers are
// rejected.
//
// Plain Node ESM, dependency-free, no network, no imports.

// ---------------------------------------------------------------------------
// Junk generators (irrelevant to every constraint).
// ---------------------------------------------------------------------------

const LOG_LINES = [
  '2026-04-02T11:02:14.118Z INFO  [http] GET /api/v3/catalog 200 17ms trace=9a1f2c keepalive=true',
  '2026-04-02T11:02:14.140Z DEBUG [pool] acquired connection conn-7 (idle=5 active=9 max=48)',
  '2026-04-02T11:02:14.201Z WARN  [cache] memcached get latency 71ms exceeded soft budget 50ms',
  '2026-04-02T11:02:14.233Z INFO  [auth] session validated sub=user_3120 scope=read:catalog ok',
  '2026-04-02T11:02:14.288Z ERROR [worker] retry 2/5 job=index.rebuild backoff=300ms cause=ECONNRESET',
  '2026-04-02T11:02:14.301Z DEBUG [gc] minor collection 4.8ms heapUsed=188MB heapTotal=480MB',
  '2026-04-02T11:02:14.355Z INFO  [http] POST /api/v3/search 201 38ms trace=44c0d9 region=us-east',
  '2026-04-02T11:02:14.390Z WARN  [ratelimit] bucket api:std near limit 880/1000 reset=42s',
  '2026-04-02T11:02:14.412Z DEBUG [pool] released connection conn-7 lifetime=1.8s reused=22',
  '2026-04-02T11:02:14.470Z INFO  [metrics] flushed 280 series to statsd in 2.9ms drops=0',
  '2026-04-02T11:02:14.501Z ERROR [db] deadlock detected victim=txn_5521 statement=UPDATE_inventory',
  '2026-04-02T11:02:14.533Z INFO  [http] GET /healthz 200 0ms trace=000000 probe=kubelet',
  '2026-04-02T11:02:14.560Z DEBUG [feature] flag fast_facets=on for user_3120 cohort=treatment',
  '2026-04-02T11:02:14.611Z WARN  [tls] certificate for api.internal expires in 14 days renew soon',
  '2026-04-02T11:02:14.644Z INFO  [queue] depth=64 oldest=1.1s consumers=8 lag=ok',
  '2026-04-02T11:02:14.690Z DEBUG [router] matched route POST /api/v3/search handler=searchCatalog',
  '2026-04-02T11:02:14.733Z INFO  [audit] user_3120 action=search resource=catalog result=allow',
  '2026-04-02T11:02:14.781Z WARN  [memory] rss 1.1GB approaching container limit 2GB scale soon',
  '2026-04-02T11:02:14.822Z ERROR [http] 504 upstream search-svc gateway timeout retrying once',
  '2026-04-02T11:02:14.860Z INFO  [shutdown] SIGTERM received draining 5 in-flight requests',
];

const CONFIG_DUMP = `# ---- catalog-svc.yaml (rendered) ----
apiVersion: apps/v1
kind: Deployment
metadata:
  name: catalog-svc
  namespace: storefront
  labels: { app: catalog-svc, tier: backend, version: "7.3.1" }
spec:
  replicas: 8
  strategy: { type: RollingUpdate, rollingUpdate: { maxSurge: 2, maxUnavailable: 1 } }
  template:
    spec:
      containers:
        - name: catalog-svc
          image: registry.internal/storefront/catalog-svc:7.3.1
          resources:
            requests: { cpu: "400m", memory: "384Mi" }
            limits:   { cpu: "2",    memory: "1536Mi" }
          env:
            - { name: LOG_LEVEL, value: "info" }
            - { name: POOL_MIN,  value: "6" }
            - { name: POOL_MAX,  value: "48" }
            - { name: CACHE_TTL, value: "240" }
            - { name: HTTP_TIMEOUT_MS, value: "4000" }
          readinessProbe: { httpGet: { path: /healthz, port: 8080 }, periodSeconds: 5 }
          livenessProbe:  { httpGet: { path: /livez,   port: 8080 }, periodSeconds: 10 }
# ---- end catalog-svc.yaml ----`;

const STACK_TRACE = `Unhandled rejection at indexDocuments (search/indexer.js:174:21)
    at async rebuildIndex (search/jobs.js:62:5)
    at async Scheduler.tick (server/scheduler.js:118:9)
    at async Worker.loop (server/worker.js:47:3)
  caused by: ConnectionResetError: Connection reset by peer during bulk upsert.
    at BulkWriter.flush (es/bulk.js:288:17)
    at BulkWriter.add (es/bulk.js:240:11)
    at indexDocuments (search/indexer.js:160:24)
  context: { jobId: 'index.rebuild', batch: 12, docs: 5000, region: 'us-east-1' }`;

/**
 * Build a big junk blob, seeded for visual variety. Sized so a couple of these
 * easily clear the >=5000-token (~20000+ char) bloat floor per task.
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
 * A byte-identical large block (no seed variance) used to trigger dedup: when
 * the same normalized text appears 3-5x, the compactor keeps the last copy and
 * elides the earlier ones. Well over the 200-char minimum.
 */
function dedupBlob() {
  const parts = [CONFIG_DUMP, STACK_TRACE];
  for (let r = 0; r < 10; r++) {
    for (const line of LOG_LINES) parts.push(line);
  }
  return parts.join('\n');
}

/** A valid OpenAI assistant tool_call + matching role:'tool' result. */
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
  // 1. Fixed output FORMAT constraint (answer as TICKET-<n>). Constraint recent.
  //    Junk via OLD tool results (elided beyond the most-recent 1).
  // -------------------------------------------------------------------------
  {
    id: 'cf-format-ticket-code',
    category: 'constraint-following',
    answerLocation: 'recent',
    build() {
      const messages = [
        {
          role: 'system',
          content:
            'You are a support-triage assistant. Be concise and follow the user formatting rules exactly.',
        },
        { role: 'user', content: 'Gather the catalog-svc manifest and the recent indexer error logs while I draft the ticket.' },
        // OLD large tool results: all but the most-recent are elided.
        ...toolPair('call_1', 'read_file', { path: 'k8s/catalog-svc.yaml' }, junkBlob('manifest', 14)),
        ...toolPair('call_2', 'tail_logs', { service: 'catalog-svc', lines: 4000 }, junkBlob('logs-a', 16)),
        ...toolPair('call_3', 'tail_logs', { service: 'catalog-svc', lines: 4000 }, junkBlob('logs-b', 16)),
        ...toolPair('call_4', 'get_stacktrace', { incident: 'INC-7781' }, junkBlob('trace', 14)),
        {
          role: 'assistant',
          content:
            'I reviewed the manifest, both log tails, and the stack trace. The reindex failures trace to upstream connection resets. Ready to file the ticket whenever you are.',
        },
        // RECENT constraint: a strict output format.
        {
          role: 'user',
          content:
            'New rule for the rest of this chat: whenever I ask for a ticket id, you MUST reply with ONLY a code in the exact format TICKET-<number>, nothing else. ' +
            'The ticket number for this issue is 4471. Give me the ticket id now.',
        },
      ];
      return {
        messages,
        question:
          'Reply with ONLY the ticket id in the exact format TICKET-<number>.',
      };
    },
    expected: 'TICKET-4471',
    grade(answer) {
      if (typeof answer !== 'string') return false;
      return /\bticket-4471\b/i.test(answer);
    },
    note: 'Format rule + the number 4471 are both in the final user turn; the old manifest/log tool dumps are irrelevant and only elided, so the recent constraint survives.',
  },

  // -------------------------------------------------------------------------
  // 2. Secret PASSPHRASE to repeat on request. Constraint recent. Junk via DEDUP.
  // -------------------------------------------------------------------------
  {
    id: 'cf-passphrase-repeat',
    category: 'constraint-following',
    answerLocation: 'recent',
    build() {
      const dup = dedupBlob(); // byte-identical block re-pasted -> dedup bait
      const messages = [
        { role: 'system', content: 'You are a secure-ops assistant. Follow the user instructions precisely.' },
        { role: 'user', content: 'Keep this diagnostic bundle for reference during the maintenance window:\n' + dup },
        { role: 'assistant', content: 'Diagnostic bundle received and noted.' },
        { role: 'user', content: 'Pasting the same bundle again so it stays in view:\n' + dup },
        { role: 'assistant', content: 'Second copy received; it matches the first byte-for-byte.' },
        { role: 'user', content: 'One more identical paste of the bundle, just in case:\n' + dup },
        { role: 'assistant', content: 'Confirmed — the third copy is identical to the others.' },
        // RECENT constraint: the secret passphrase to echo verbatim.
        {
          role: 'user',
          content:
            'Remember this for the rest of the session: the secret maintenance passphrase is QUILL-88. ' +
            'Whenever I ask you to confirm access, you must repeat the passphrase exactly. Confirm access now.',
        },
      ];
      return {
        messages,
        question:
          'Confirm access by repeating the secret maintenance passphrase exactly.',
      };
    },
    expected: 'QUILL-88',
    grade(answer) {
      if (typeof answer !== 'string') return false;
      return answer.toLowerCase().includes('quill-88');
    },
    note: 'Passphrase QUILL-88 is in the final user turn; the thrice-pasted identical bundle is pure dedup bait that a correct compactor collapses without touching the constraint.',
  },

  // -------------------------------------------------------------------------
  // 3. PINNED output format: every answer must end with a sign-off token.
  //    Junk via OLD tool results (elision).
  // -------------------------------------------------------------------------
  {
    id: 'cf-pinned-signoff-token',
    category: 'constraint-following',
    answerLocation: 'pinned',
    build() {
      const messages = [
        { role: 'system', content: 'You are an audit-logging assistant. Obey all standing formatting rules.' },
        { role: 'user', content: 'Collect the env dumps and recent connection logs for the storefront cluster.' },
        ...toolPair('call_1', 'dump_env', { host: 'cat-prod-1' }, junkBlob('env-1', 16)),
        ...toolPair('call_2', 'dump_env', { host: 'cat-prod-2' }, junkBlob('env-2', 16)),
        ...toolPair('call_3', 'tail_logs', { service: 'pgbouncer', lines: 5000 }, junkBlob('pgb', 16)),
        // PINNED constraint: sentinel keeps this verbatim regardless of position.
        {
          role: 'user',
          content:
            '<!--ctxgov:pin--> STANDING RULE: every single reply you give from now on MUST end with the exact audit sign-off token "<<AUDIT-OK-5150>>" on its own at the end. Do not omit it.',
        },
        ...toolPair('call_4', 'tail_logs', { service: 'pgbouncer', lines: 5000 }, junkBlob('pgb2', 16)),
        { role: 'assistant', content: 'Collected the env dumps and connection logs. Ready for your question. <<AUDIT-OK-5150>>' },
        { role: 'user', content: 'Briefly: did the cluster look healthy overall? Answer in one short sentence and follow the standing rule.' },
      ];
      return {
        messages,
        question:
          'Answer in one short sentence and follow the standing sign-off rule.',
      };
    },
    expected: '<<AUDIT-OK-5150>>',
    grade(answer) {
      if (typeof answer !== 'string') return false;
      return answer.toLowerCase().includes('<<audit-ok-5150>>');
    },
    note: 'Sign-off rule lives in a pin-sentinel message kept verbatim; surrounding env/log tool dumps are irrelevant and elided, so the required token still gets appended.',
  },

  // -------------------------------------------------------------------------
  // 4. Mandatory PREFIX constraint: answer must START with a fixed phrase.
  //    Junk via DEDUP + OLD tool results.
  // -------------------------------------------------------------------------
  {
    id: 'cf-required-prefix',
    category: 'constraint-following',
    answerLocation: 'recent',
    build() {
      const dup = dedupBlob();
      const messages = [
        { role: 'system', content: 'You are a release-comms assistant. Follow the user prefix rule exactly.' },
        { role: 'user', content: 'Reference incident bundle for the reindex failure:\n' + dup },
        ...toolPair('call_1', 'get_pipeline', { id: 'pipe-3301' }, junkBlob('pipe-a', 16)),
        { role: 'assistant', content: 'Reviewed the incident bundle and the first pipeline dump.' },
        { role: 'user', content: 'Same incident bundle again so it stays loaded:\n' + dup },
        ...toolPair('call_2', 'get_pipeline', { id: 'pipe-3302' }, junkBlob('pipe-b', 16)),
        { role: 'assistant', content: 'Second copy matches; pipeline dumps reviewed.' },
        { role: 'user', content: 'One more identical paste of the incident bundle:\n' + dup },
        { role: 'assistant', content: 'All three bundle copies are byte-for-byte identical. Standing by.' },
        // RECENT constraint: required opening phrase.
        {
          role: 'user',
          content:
            'For your next reply only, you MUST begin the message with the exact phrase "STATUS UPDATE:" (capitalized, with the colon) before anything else. ' +
            'Give me a one-line status of the reindex job.',
        },
      ];
      return {
        messages,
        question:
          'Give a one-line status, and begin your reply with the exact required prefix.',
      };
    },
    expected: 'STATUS UPDATE:',
    grade(answer) {
      if (typeof answer !== 'string') return false;
      return /^\s*status update:/i.test(answer);
    },
    note: 'Prefix rule is in the last user turn; the thrice-pasted identical bundle and old pipeline dumps are irrelevant, so the required opening phrase survives compaction.',
  },

  // -------------------------------------------------------------------------
  // 5. FORBIDDEN-word constraint: must answer WITHOUT using a banned word, using
  //    a mandated substitute token instead. Constraint recent. Junk via OLD tools.
  // -------------------------------------------------------------------------
  {
    id: 'cf-forbidden-word',
    category: 'constraint-following',
    answerLocation: 'recent',
    build() {
      const messages = [
        { role: 'system', content: 'You are a status-page editor. Obey vocabulary constraints exactly.' },
        { role: 'user', content: 'Fetch the gateway config and recent request logs for the search integration.' },
        ...toolPair('call_1', 'read_file', { path: 'gateway/config.yaml' }, junkBlob('gw-cfg', 16)),
        ...toolPair('call_2', 'tail_logs', { service: 'gateway', lines: 4000 }, junkBlob('gw-log-a', 16)),
        ...toolPair('call_3', 'tail_logs', { service: 'gateway', lines: 4000 }, junkBlob('gw-log-b', 16)),
        { role: 'user', content: 'Draft a short public status note about the search slowdown.' },
        {
          role: 'assistant',
          content:
            'Here is a draft: "Search is currently experiencing an outage; engineers are investigating." Let me know if you want changes.',
        },
        // RECENT constraint: ban a word, mandate a replacement token.
        {
          role: 'user',
          content:
            'Hard rule for the rewrite: the word "outage" is BANNED — you must NOT use it anywhere. Instead, refer to the situation using the exact phrase "service disruption". ' +
            'Rewrite the status note in one sentence following this rule.',
        },
      ];
      return {
        messages,
        question:
          'Rewrite the status note in one sentence: do not use the banned word "outage", and use the phrase "service disruption" instead.',
      };
    },
    expected: 'Search is currently experiencing a service disruption; engineers are investigating.',
    grade(answer) {
      if (typeof answer !== 'string') return false;
      const a = answer.toLowerCase();
      return a.includes('service disruption') && !a.includes('outage');
    },
    note: 'Ban + mandated substitute are stated in the final user turn; gateway config and log tool dumps are irrelevant and elided, so the model can satisfy the vocabulary constraint.',
  },

  // -------------------------------------------------------------------------
  // 6. Combined FORMAT + VALUE constraint: answer must be exactly RGB-<3 digits>
  //    with a specific value. Constraint in a RECENT assistant turn. Junk via DEDUP.
  // -------------------------------------------------------------------------
  {
    id: 'cf-format-rgb-value',
    category: 'constraint-following',
    answerLocation: 'recent',
    build() {
      const dup = dedupBlob();
      const messages = [
        { role: 'system', content: 'You are a design-systems assistant. Follow the agreed answer format exactly.' },
        { role: 'user', content: 'Keep this build/diagnostic bundle for the theming audit:\n' + dup },
        { role: 'assistant', content: 'Bundle received for the theming audit.' },
        { role: 'user', content: 'Re-pasting the identical bundle so it stays in context:\n' + dup },
        { role: 'assistant', content: 'Second identical copy received.' },
        { role: 'user', content: 'And the same bundle one more time:\n' + dup },
        // RECENT constraint: agreed code format AND the value, stated by the assistant.
        {
          role: 'assistant',
          content:
            'Understood. To keep things consistent: whenever you ask me for the brand swatch, I will answer with ONLY a code in the exact format RGB-<3 digits>. The approved brand swatch code is RGB-204. Ask whenever ready.',
        },
        { role: 'user', content: 'What is the approved brand swatch code? Use the agreed format.' },
      ];
      return {
        messages,
        question:
          'Reply with ONLY the approved brand swatch code in the exact format RGB-<3 digits>.',
      };
    },
    expected: 'RGB-204',
    grade(answer) {
      if (typeof answer !== 'string') return false;
      return /\brgb-204\b/i.test(answer);
    },
    note: 'Both the format rule and the value RGB-204 are in the recent assistant turn; the thrice-pasted identical bundle is dedup bait that does not affect the constraint.',
  },

  // -------------------------------------------------------------------------
  // 7. EXACT-VERBATIM constraint: must reproduce a one-time confirmation phrase
  //    word-for-word. Constraint recent. Junk via OLD tool results + dedup.
  // -------------------------------------------------------------------------
  {
    id: 'cf-verbatim-phrase',
    category: 'constraint-following',
    answerLocation: 'recent',
    build() {
      const dup = dedupBlob();
      const messages = [
        { role: 'system', content: 'You are a deployment-confirmation assistant. Reproduce required phrases verbatim.' },
        { role: 'user', content: 'Pull the deploy manifest and recent rollout logs before we confirm.' },
        ...toolPair('call_1', 'read_file', { path: 'k8s/catalog-svc.yaml' }, junkBlob('manifest', 14)),
        ...toolPair('call_2', 'tail_logs', { service: 'rollout', lines: 4000 }, junkBlob('rollout-a', 16)),
        { role: 'user', content: 'Here is the diagnostic bundle for the rollout, keep it handy:\n' + dup },
        { role: 'assistant', content: 'Manifest, rollout logs, and the diagnostic bundle are all loaded.' },
        { role: 'user', content: 'Re-pasting the identical diagnostic bundle so it does not scroll off:\n' + dup },
        {
          role: 'assistant',
          content: 'Second copy of the bundle received; identical to the first. Ready when you are.',
        },
        // RECENT constraint: reproduce an exact confirmation phrase verbatim.
        {
          role: 'user',
          content:
            'To authorize the rollout you must reply with this exact confirmation phrase, word for word and verbatim: ' +
            '"I CONFIRM ROLLOUT GAMMA-19 TO PRODUCTION". Reply with it now to authorize.',
        },
      ];
      return {
        messages,
        question:
          'Reply with the exact authorization confirmation phrase, verbatim, to authorize the rollout.',
      };
    },
    expected: 'I CONFIRM ROLLOUT GAMMA-19 TO PRODUCTION',
    grade(answer) {
      if (typeof answer !== 'string') return false;
      const norm = answer.toLowerCase().replace(/\s+/g, ' ').trim();
      return norm.includes('i confirm rollout gamma-19 to production');
    },
    note: 'The exact phrase (incl. token GAMMA-19) is in the final user turn; old manifest/rollout tool dumps and the twice-pasted identical bundle are irrelevant and compacted, so the verbatim phrase survives.',
  },
];

export default tasks;
