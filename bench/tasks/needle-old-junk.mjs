// bench/tasks/needle-old-junk.mjs
//
// CATEGORY: needle-old-junk  (ADVERSARIAL / honest boundary)
//
// These tasks deliberately bury a single unique fact DEEP inside an OLD
// role:'tool' result that the governor WILL elide. With the harness config
// (contextWindow=6000, threshold=0.5, keepRecentToolResults=1,
// minToolResultTokens=200) the elision strategy:
//   - keeps only the most-recent 1 tool result intact,
//   - elides every older tool result >= ~200 tokens,
//   - and when it elides, it preserves ONLY the first ~120 chars as a preview
//     (see src/compactor/elision.ts -> firstNChars(text, 120)).
//
// Therefore the needle is placed AFTER the first ~300 characters of an OLD
// tool result. The preview window (120 chars) cannot reach it, the recent-1
// keep window cannot protect it, and it is large enough to be elided. Under
// compaction the GOVERNED answer is EXPECTED to possibly fail — that is the
// honest point of this category. It demonstrates the hard limit of lossy
// compaction and motivates the product's mitigation (safe-mode / quality
// budget). The baseline (compaction OFF) run still has the fact and should
// answer correctly; the governed run is the stress case.
//
// Plain Node ESM, dependency-free, no network, no imports.

// ── junk generators ─────────────────────────────────────────────────────────
// Realistic, varied log/file content. Repeated to comfortably exceed the
// >=5000-token (~20000+ char) bloat floor per task.

const LOG_LINES = [
  '2026-03-11T08:14:22.118Z INFO  [api.gateway] inbound POST /v1/orders rid=req_8f12 status=202 dur=41ms',
  '2026-03-11T08:14:22.502Z DEBUG [auth.jwt] verified bearer token sub=usr_4471 scope=orders:write exp=1773901322',
  '2026-03-11T08:14:23.009Z WARN  [db.pool] connection acquire slow waited=812ms pool=primary size=20 idle=0',
  '2026-03-11T08:14:23.771Z INFO  [worker.queue] dequeued job kind=settle.batch attempt=1 backlog=3127',
  '2026-03-11T08:14:24.330Z ERROR [payments.stripe] charge declined code=insufficient_funds intent=pi_9Hx2',
  '2026-03-11T08:14:24.901Z DEBUG [cache.redis] MGET keys=14 hit=11 miss=3 ttl_avg=288s node=cache-2',
  '2026-03-11T08:14:25.412Z INFO  [http.client] GET https://ext.vendor.io/rates 200 in 132ms bytes=2841',
  '2026-03-11T08:14:25.998Z TRACE [serde.json] decoded envelope v=3 fields=27 unknown=0 lenient=false',
  '2026-03-11T08:14:26.551Z WARN  [ratelimit] tenant=acme bucket=write tokens=2/200 refill=10/s throttled',
  '2026-03-11T08:14:27.140Z INFO  [scheduler] tick=44910 due=2 skipped=0 drift=3ms clock=monotonic',
  '2026-03-11T08:14:27.733Z DEBUG [grpc.server] unary /inventory.Reserve peer=10.2.4.18:51244 ok=true',
  '2026-03-11T08:14:28.221Z ERROR [fs.writer] ENOSPC writing /var/spool/out/seg-0192.tmp retry=2/5',
  '2026-03-11T08:14:28.880Z INFO  [metrics.flush] pushed 1840 series to tsdb lag=204ms dropped=0',
  '2026-03-11T08:14:29.444Z DEBUG [tls.handshake] resumed session alpn=h2 cipher=TLS_AES_128_GCM_SHA256',
  '2026-03-11T08:14:30.012Z WARN  [gc] pause young=18ms promoted=4.1MB heap=812MB/1536MB next=eden',
];

const STACK_TRACE = [
  'Traceback (most recent call last):',
  '  File "/srv/app/handlers/settle.py", line 211, in run_batch',
  '    result = self._reconcile(ledger, window)',
  '  File "/srv/app/core/ledger.py", line 644, in _reconcile',
  '    delta = compute_delta(entries, opening_balance)',
  '  File "/srv/app/core/math.py", line 88, in compute_delta',
  '    raise ValueError(f"unbalanced batch: residual={residual!r}")',
  'ValueError: unbalanced batch: residual=Decimal("0.0003")',
  'During handling of the above exception, another exception occurred:',
  '  File "/srv/app/handlers/settle.py", line 219, in run_batch',
  '    self._rollback(txn)',
  '  File "/srv/app/db/txn.py", line 132, in _rollback',
  '    raise RollbackError("connection already closed") from exc',
  'app.errors.RollbackError: connection already closed',
];

const CONFIG_DUMP = [
  '# ---- effective runtime config (redacted) ----',
  'service: settlement-worker',
  'env: production',
  'region: eu-central-1',
  'replicas: 6',
  'pool.primary.max: 20',
  'pool.replica.max: 40',
  'queue.kind: kafka',
  'queue.topic: settle.batches.v3',
  'queue.consumer_group: settle-workers',
  'retry.max_attempts: 5',
  'retry.backoff_ms: [200,800,2400,7200,21600]',
  'feature.flags: ["dedup_ledger","async_payout","strict_residual"]',
  'telemetry.sample_rate: 0.05',
  'log.level: DEBUG',
  'shutdown.grace_seconds: 30',
];

/**
 * Build a big block of realistic junk of at least `minChars` characters.
 * Mixes log lines, stack traces, and config dumps so it reads like a real
 * agent transcript dump rather than one repeated line. Deterministic.
 */
function junk(minChars, seedTag = 'seg') {
  const blocks = [];
  let n = 0;
  let i = 0;
  while (blocks.join('\n').length < minChars) {
    const seg = [
      `==== ${seedTag}-${String(i).padStart(4, '0')} captured at offset ${n} ====`,
      ...LOG_LINES,
      '',
      '--- python traceback (settlement worker) ---',
      ...STACK_TRACE,
      '',
      '--- config snapshot ---',
      ...CONFIG_DUMP,
      '',
    ];
    blocks.push(seg.join('\n'));
    n += seg.join('\n').length;
    i += 1;
  }
  return blocks.join('\n');
}

// A short realistic header used to push the needle PAST the 120-char preview
// window that elision preserves. Plain prose so the whole block reads natural.
function preamble(label) {
  return (
    `Tool output for ${label}. The following is the raw captured stream from the ` +
    `remote host; lines are emitted oldest-first and may contain interleaved ` +
    `diagnostics, retries, and partial frames. Operators should scroll past the ` +
    `boilerplate banner before locating any operationally significant value. `
  );
}

// ── tasks ────────────────────────────────────────────────────────────────────

const tasks = [
  // 1) Needle: an incident remediation code buried in an OLD tool result.
  {
    id: 'noj-incident-code',
    category: 'needle-old-junk',
    answerLocation: 'old-tool-junk',
    build() {
      const buried =
        preamble('cat /var/log/incident/INC-4471.log (full)') +
        junk(7000, 'inc') +
        '\n\n>>> REMEDIATION RECORD <<<\n' +
        'Root cause confirmed: stale residual in ledger batch. ' +
        'The approved remediation reference code for this incident is RMD-9931-QX. ' +
        'Apply it via the runbook before reopening the queue.\n\n' +
        junk(7000, 'inc-tail');

      const recentToolResult =
        preamble('tail -n 40 /var/log/settlement-worker/current.log') +
        junk(4000, 'tail') +
        '\nqueue resumed: false; awaiting remediation reference before reopen.\n';

      const messages = [
        {
          role: 'system',
          content:
            'You are an on-call SRE assistant. Answer using only facts found in the conversation. ' +
            'Reference codes look like RMD-####-XX.',
        },
        { role: 'user', content: 'Pull the full incident log for INC-4471 so we can find the remediation reference.' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"/var/log/incident/INC-4471.log"}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: buried }, // OLD: will be elided
        { role: 'user', content: 'Now tail the worker log so we know if the queue reopened.' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_2', type: 'function', function: { name: 'read_file', arguments: '{"path":"/var/log/settlement-worker/current.log"}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_2', content: recentToolResult }, // RECENT: kept
        {
          role: 'user',
          content:
            'What is the approved remediation reference code for incident INC-4471? Answer with just the code.',
        },
      ];

      return {
        messages,
        question:
          'What is the approved remediation reference code for incident INC-4471? Answer with just the code.',
      };
    },
    expected: 'RMD-9931-QX',
    grade(answer) {
      return typeof answer === 'string' && answer.toLowerCase().includes('rmd-9931-qx');
    },
    note: 'Intentional stress case: the only copy of RMD-9931-QX lives past char ~300 of an OLD tool result that elision replaces with a 120-char preview; honest demonstration of lossy-compaction limit.',
  },

  // 2) Needle: a numeric port discovered in an OLD nmap-style tool result.
  {
    id: 'noj-hidden-port',
    category: 'needle-old-junk',
    answerLocation: 'old-tool-junk',
    build() {
      const buried =
        preamble('nmap -p- 10.4.2.7 (full scan output)') +
        junk(7000, 'scan') +
        '\n\n# open ports summary\n' +
        '22/tcp open ssh\n80/tcp open http\n443/tcp open https\n' +
        'The internal admin console is reachable on port 48823/tcp (filtered to VPN range only).\n\n' +
        junk(7000, 'scan-tail');

      const recentToolResult =
        preamble('curl -sS http://10.4.2.7/health') +
        junk(4000, 'health') +
        '\n{"status":"degraded","admin_console":"see prior scan for port"}\n';

      const messages = [
        {
          role: 'system',
          content:
            'You are a security-recon assistant. Report exact port numbers found in scan output. ' +
            'Do not guess; cite only ports present in the conversation.',
        },
        { role: 'user', content: 'Run a full port scan on 10.4.2.7 and capture everything.' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'run_shell', arguments: '{"cmd":"nmap -p- 10.4.2.7"}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: buried }, // OLD: will be elided
        { role: 'user', content: 'Check the health endpoint while we are at it.' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_2', type: 'function', function: { name: 'run_shell', arguments: '{"cmd":"curl -sS http://10.4.2.7/health"}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_2', content: recentToolResult }, // RECENT: kept
        {
          role: 'user',
          content:
            'Which TCP port is the internal admin console reachable on for host 10.4.2.7? Answer with just the number.',
        },
      ];

      return {
        messages,
        question:
          'Which TCP port is the internal admin console reachable on for host 10.4.2.7? Answer with just the number.',
      };
    },
    expected: '48823',
    grade(answer) {
      if (typeof answer !== 'string') return false;
      const nums = answer.match(/\d{2,6}/g) || [];
      return nums.includes('48823');
    },
    note: 'Intentional stress case: port 48823 appears only deep inside an OLD nmap tool result that gets elided; the surviving 120-char preview is only the banner, so the governed run is expected to possibly miss it.',
  },

  // 3) Needle: a config key->value buried in an OLD env-dump tool result.
  {
    id: 'noj-feature-flag-value',
    category: 'needle-old-junk',
    answerLocation: 'old-tool-junk',
    build() {
      const buried =
        preamble('GET /admin/config?include=flags (full JSON pretty-printed)') +
        junk(7000, 'cfg') +
        '\n\n"feature_flags": {\n' +
        '  "dedup_ledger": true,\n' +
        '  "async_payout": false,\n' +
        '  "MAX_PAYOUT_BATCH_SIZE": 7340,\n' +
        '  "strict_residual": true\n' +
        '}\n\n' +
        junk(7000, 'cfg-tail');

      const recentToolResult =
        preamble('GET /admin/config?include=meta') +
        junk(4000, 'meta') +
        '\n{"config_version":"v3","generated_at":"2026-03-11T08:00:00Z","flags":"see full dump above"}\n';

      const messages = [
        {
          role: 'system',
          content:
            'You are a platform configuration assistant. Report exact configuration values found in dumps. ' +
            'Values are integers or booleans; quote them verbatim.',
        },
        { role: 'user', content: 'Fetch the full admin config including feature flags.' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'http_get', arguments: '{"url":"/admin/config?include=flags"}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: buried }, // OLD: will be elided
        { role: 'user', content: 'Also grab the config metadata block.' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_2', type: 'function', function: { name: 'http_get', arguments: '{"url":"/admin/config?include=meta"}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_2', content: recentToolResult }, // RECENT: kept
        {
          role: 'user',
          content:
            'What integer value is configured for MAX_PAYOUT_BATCH_SIZE? Answer with just the number.',
        },
      ];

      return {
        messages,
        question:
          'What integer value is configured for MAX_PAYOUT_BATCH_SIZE? Answer with just the number.',
      };
    },
    expected: '7340',
    grade(answer) {
      if (typeof answer !== 'string') return false;
      const nums = answer.match(/\d{3,7}/g) || [];
      return nums.includes('7340');
    },
    note: 'Intentional stress case: MAX_PAYOUT_BATCH_SIZE=7340 sits deep in an OLD config-dump tool result that is elided down to a 120-char banner preview; governed run is expected to possibly fail.',
  },

  // 4) Needle: a unique tracking/serial token buried in an OLD shipment tool result.
  {
    id: 'noj-serial-token',
    category: 'needle-old-junk',
    answerLocation: 'old-tool-junk',
    build() {
      const buried =
        preamble('SELECT * FROM shipments WHERE id=918 (raw rows + audit log)') +
        junk(7000, 'ship') +
        '\n\n-- audit row (authoritative) --\n' +
        'shipment_id=918 carrier=DHL status=in_transit ' +
        'tracking_serial=SHPX-77K-20453-Z origin=Hamburg dest=Lyon\n\n' +
        junk(7000, 'ship-tail');

      const recentToolResult =
        preamble('SELECT status FROM shipments WHERE id=918') +
        junk(4000, 'status') +
        '\nstatus=in_transit; tracking_serial=(see full row dump above)\n';

      const messages = [
        {
          role: 'system',
          content:
            'You are a logistics assistant. Report exact tracking serials found in query output. ' +
            'Serials look like SHPX-###-#####-X.',
        },
        { role: 'user', content: 'Pull the full row and audit log for shipment 918.' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'sql_query', arguments: '{"q":"SELECT * FROM shipments WHERE id=918"}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: buried }, // OLD: will be elided
        { role: 'user', content: 'Now just confirm its current status.' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_2', type: 'function', function: { name: 'sql_query', arguments: '{"q":"SELECT status FROM shipments WHERE id=918"}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_2', content: recentToolResult }, // RECENT: kept
        {
          role: 'user',
          content:
            'What is the tracking_serial for shipment 918? Answer with just the serial.',
        },
      ];

      return {
        messages,
        question: 'What is the tracking_serial for shipment 918? Answer with just the serial.',
      };
    },
    expected: 'SHPX-77K-20453-Z',
    grade(answer) {
      if (typeof answer !== 'string') return false;
      const norm = answer.toLowerCase().replace(/\s+/g, '');
      return norm.includes('shpx-77k-20453-z');
    },
    note: 'Intentional stress case: the only copy of tracking_serial SHPX-77K-20453-Z is deep in an OLD tool result that elision collapses to a 120-char banner preview; governed run is expected to possibly fail.',
  },
];

export default tasks;
