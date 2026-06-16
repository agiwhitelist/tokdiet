// bench/tasks/reason-table.mjs
//
// CATEGORY: reason-table  (SURVIVABLE — tests that reasoning over a small table
// is preserved after compaction).
//
// Honesty contract for this category:
//   * The table the question is asked about lives in a RECENT user message
//     (here: the final user turn, the question itself). It is a UNIQUE string,
//     so dedup never touches it (dedup only collapses byte-identical repeats and
//     keeps the LAST copy verbatim anyway) and elision never touches it (elision
//     only rewrites role:'tool' results, and only the OLDER ones — keepRecent=1).
//   * All the >5000-token bloat is genuinely irrelevant to the question:
//       - 3-5 byte-identical pasted "file" dumps (collapsed by dedup), and
//       - several large role:'tool' results (older ones elided).
//     None of the junk contains the table or the answer.
//   * A correct compactor therefore keeps every digit the model needs, so the
//     GOVERNED answer should match the BASELINE answer exactly.
//
// Plain Node ESM, dependency-free, no network.

// ---------------------------------------------------------------------------
// Junk builders. These produce large, realistic-looking, IRRELEVANT context.
// ---------------------------------------------------------------------------

const LOG_LINES = [
  '2026-03-11T08:14:02.118Z INFO  [http] GET /api/v2/health 200 3ms region=us-east-1 trace=4f9a',
  '2026-03-11T08:14:02.402Z DEBUG [pool] acquired connection conn#0007 idle=12 active=4 waiters=0',
  '2026-03-11T08:14:03.771Z WARN  [cache] redis MGET timeout 250ms key=session:8831 retrying(1/3)',
  '2026-03-11T08:14:04.009Z INFO  [auth] token refreshed sub=usr_4471 ttl=3600 scope=read:billing',
  '2026-03-11T08:14:04.553Z ERROR [worker] job rebuild-index failed attempt=2 err=ETIMEDOUT host=es-02',
  '2026-03-11T08:14:05.110Z DEBUG [gc] minor collection 18ms heapUsed=412MB heapTotal=768MB ext=22MB',
  '2026-03-11T08:14:05.884Z INFO  [queue] enqueued task=email.send id=tsk_99213 delay=0 priority=5',
  '2026-03-11T08:14:06.231Z TRACE [router] matched route POST /webhooks/stripe handler=stripeHook',
  '2026-03-11T08:14:06.998Z WARN  [ratelimit] client 203.0.113.44 over soft limit 118/100 window=60s',
  '2026-03-11T08:14:07.540Z INFO  [migrate] applied 0042_add_index_orders_created_at in 812ms ok',
  '2026-03-11T08:14:08.002Z DEBUG [s3] put object bucket=assets key=img/9f/q4.png size=20481 etag=ba12',
  '2026-03-11T08:14:08.661Z ERROR [db] deadlock detected txn=tx_5567 victim=tx_5562 retry scheduled',
  '2026-03-11T08:14:09.140Z INFO  [scheduler] cron tick name=nightly-rollup next=2026-03-12T02:00:00Z',
  '2026-03-11T08:14:09.773Z DEBUG [tls] handshake complete cipher=TLS_AES_128_GCM_SHA256 alpn=h2',
  '2026-03-11T08:14:10.219Z WARN  [disk] volume /var/data at 86% usage inodes=71% throttle=soft',
];

const STACK_TRACE = [
  'Traceback (most recent call last):',
  '  File "/srv/app/pipeline/runner.py", line 211, in _execute_stage',
  '    result = stage.run(ctx, payload)',
  '  File "/srv/app/pipeline/stages/transform.py", line 88, in run',
  '    rows = self._normalize(rows)',
  '  File "/srv/app/pipeline/stages/transform.py", line 132, in _normalize',
  '    return [self._coerce(r) for r in rows]',
  '  File "/srv/app/pipeline/stages/transform.py", line 132, in <listcomp>',
  '    return [self._coerce(r) for r in rows]',
  '  File "/srv/app/pipeline/stages/transform.py", line 150, in _coerce',
  '    raise ValueError(f"unparseable cell at {r.idx}: {r.raw!r}")',
  'ValueError: unparseable cell at 4471: b"\\x00\\x01garbage"',
];

const CONFIG_DUMP = [
  '# /etc/edge-proxy/edge.conf  (rendered)',
  'worker_processes auto;',
  'worker_rlimit_nofile 65535;',
  'events { worker_connections 16384; multi_accept on; }',
  'http {',
  '  sendfile on; tcp_nopush on; tcp_nodelay on;',
  '  keepalive_timeout 65; keepalive_requests 1000;',
  '  gzip on; gzip_comp_level 5; gzip_min_length 1024;',
  '  proxy_buffering on; proxy_buffer_size 8k; proxy_buffers 16 8k;',
  '  upstream app_pool { least_conn; server 10.0.3.11:8080 weight=3; server 10.0.3.12:8080; }',
  '  log_format main \'$remote_addr - $request "$status" $body_bytes_sent rt=$request_time\';',
  '  server { listen 443 ssl http2; server_name api.example.com; ssl_session_cache shared:SSL:50m; }',
  '}',
];

/** Repeat a block of lines until it reaches at least `targetChars` characters. */
function fill(lines, targetChars, header) {
  const out = header ? [header] : [];
  let chars = out.join('\n').length;
  let i = 0;
  while (chars < targetChars) {
    const line = lines[i % lines.length];
    out.push(line);
    chars += line.length + 1;
    i++;
  }
  return out.join('\n');
}

/**
 * One large, byte-identical "file paste". Returned identically every call so
 * that emitting it 3-5 times lets dedup collapse the earlier copies.
 * ~6000 chars => well over the bloat floor on its own when repeated.
 */
function dupFileDump() {
  return [
    '===== BEGIN PASTE: services/legacy/reconciler.log =====',
    fill(LOG_LINES, 2400, '--- application log (rotated segment 14) ---'),
    '',
    fill(STACK_TRACE, 1400, '--- captured exception (non-fatal, retried) ---'),
    '',
    fill(CONFIG_DUMP, 1400, '--- effective edge config snapshot ---'),
    '===== END PASTE =====',
  ].join('\n');
}

/** A big, unique-ish tool result body (used as role:'tool' content). */
function toolDump(tag) {
  return [
    `### tool output [${tag}]`,
    fill(LOG_LINES, 1800, `--- ${tag}: service logs ---`),
    fill(CONFIG_DUMP, 1200, `--- ${tag}: config ---`),
  ].join('\n');
}

const SYSTEM = [
  'You are a meticulous operations and finance assistant.',
  'Answer ONLY the final question. When the answer is numeric, state the number plainly.',
  'Show the single final value clearly (you may show brief working first).',
].join(' ');

/**
 * Assemble a standard bloated conversation:
 *   system, then a few user/assistant/tool cycles full of irrelevant junk
 *   (duplicated file pastes + several tool results), then finally a RECENT
 *   user message carrying the small table + the question.
 *
 * `tableMsg` is the final user content (string) — the only place the table
 * appears. It is unique, recent, and never duplicated, so it survives both
 * dedup and elision.
 */
function buildConversation(tableMsg) {
  const dump = dupFileDump(); // identical each call -> dedup target
  const messages = [
    { role: 'system', content: SYSTEM },

    // --- cycle 1: user pastes a file, assistant acks, tool reads more ---
    { role: 'user', content: 'Here is the reconciler log dump for the incident review:\n\n' + dump },
    {
      role: 'assistant',
      content: 'Noted. Pulling the related service logs to cross-check the timestamps.',
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"services/legacy/reconciler.log"}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'call_1', content: toolDump('reconciler-segment-14') },

    // --- cycle 2: same file pasted AGAIN (dup), more tool output ---
    { role: 'user', content: 'For completeness, the same dump again so it is in context:\n\n' + dump },
    {
      role: 'assistant',
      content: 'Got it. Checking the edge proxy config as well.',
      tool_calls: [
        { id: 'call_2', type: 'function', function: { name: 'read_file', arguments: '{"path":"/etc/edge-proxy/edge.conf"}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'call_2', content: toolDump('edge-proxy-config') },

    // --- cycle 3: dump a THIRD time, another tool result ---
    { role: 'user', content: 'And once more, pasting it a third time to be safe:\n\n' + dump },
    {
      role: 'assistant',
      content: 'Understood. Fetching the worker metrics snapshot.',
      tool_calls: [
        { id: 'call_3', type: 'function', function: { name: 'read_file', arguments: '{"path":"metrics/worker.txt"}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'call_3', content: toolDump('worker-metrics') },

    // --- FINAL recent user turn: the small table + the question (unique) ---
    { role: 'user', content: tableMsg },
  ];
  return messages;
}

// ---------------------------------------------------------------------------
// Grader helpers.
// ---------------------------------------------------------------------------

/** Extract the LAST integer/decimal that appears in `s` (most answers end with it). */
function lastNumber(s) {
  if (typeof s !== 'string') return null;
  const cleaned = s.replace(/[,$]/g, ''); // tolerate $1,234.50 style
  const matches = cleaned.match(/-?\d+(?:\.\d+)?/g);
  if (!matches || matches.length === 0) return null;
  return parseFloat(matches[matches.length - 1]);
}

/** True if `answer` contains the number `target` (within a tiny epsilon) anywhere. */
function containsNumber(answer, target) {
  if (typeof answer !== 'string') return false;
  const cleaned = answer.replace(/[,$]/g, '');
  const matches = cleaned.match(/-?\d+(?:\.\d+)?/g);
  if (!matches) return false;
  return matches.some((m) => Math.abs(parseFloat(m) - target) < 0.005);
}

// ===========================================================================
// TASKS
// ===========================================================================

const tasks = [
  // -------------------------------------------------------------------------
  // 1. Price-list arithmetic: 3 widgets + 2 gadgets.
  // -------------------------------------------------------------------------
  {
    id: 'rt-price-total',
    category: 'reason-table',
    answerLocation: 'recent-table',
    build() {
      const table = [
        'Current price list (USD, per unit) — internal sheet, do not redistribute:',
        '',
        '| SKU       | Item          | Unit price |',
        '|-----------|---------------|-----------:|',
        '| WGT-100   | Widget        |      12.50 |',
        '| GDT-200   | Gadget        |      19.00 |',
        '| DOH-300   | Doohickey     |       4.25 |',
        '| THG-400   | Thingamajig   |      31.75 |',
        '',
        'Question: What is the total cost of 3 Widgets plus 2 Gadgets? Give the dollar amount.',
      ].join('\n');
      return { messages: buildConversation(table), question: 'What is the total cost of 3 Widgets plus 2 Gadgets (from the price list above)? Give the dollar amount.' };
    },
    // 3*12.50 + 2*19.00 = 37.50 + 38.00 = 75.50
    expected: '$75.50',
    grade(answer) {
      return containsNumber(answer, 75.5);
    },
    note: 'Table is in the final recent user turn (unique, never duplicated); junk is irrelevant logs/dups, so a correct compactor keeps the prices.',
  },

  // -------------------------------------------------------------------------
  // 2. Inventory lookup: lowest stock SKU.
  // -------------------------------------------------------------------------
  {
    id: 'rt-lowest-stock',
    category: 'reason-table',
    answerLocation: 'recent-table',
    build() {
      const table = [
        'Warehouse stock counts (live snapshot, bin A-aisle):',
        '',
        '| SKU      | On hand |',
        '|----------|--------:|',
        '| QX-1001  |     142 |',
        '| QX-1002  |      37 |',
        '| QX-1003  |     205 |',
        '| QX-1004  |      19 |',
        '| QX-1005  |      88 |',
        '',
        'Question: Which SKU has the lowest stock on hand? Answer with the SKU code.',
      ].join('\n');
      return { messages: buildConversation(table), question: 'Which SKU has the lowest stock on hand (from the stock table above)? Answer with the SKU code.' };
    },
    expected: 'QX-1004',
    grade(answer) {
      return typeof answer === 'string' && answer.toLowerCase().includes('qx-1004');
    },
    note: 'Lowest count (19 => QX-1004) lives in the recent table; the duplicated log pastes and tool dumps contain no SKUs, so compaction cannot change the answer.',
  },

  // -------------------------------------------------------------------------
  // 3. CSV column sum.
  // -------------------------------------------------------------------------
  {
    id: 'rt-column-sum',
    category: 'reason-table',
    answerLocation: 'recent-table',
    build() {
      const table = [
        'Daily revenue export (region=EU), CSV — date,orders,revenue_eur:',
        '',
        '2026-04-01,18,533',
        '2026-04-02,22,610',
        '2026-04-03,15,455',
        '2026-04-04,27,720',
        '2026-04-05,11,300',
        '',
        'Question: What is the SUM of the revenue_eur column (the third column)? Give the number.',
      ].join('\n');
      return { messages: buildConversation(table), question: 'What is the SUM of the revenue_eur column (third column) in the CSV above? Give the number.' };
    },
    // 533 + 610 + 455 + 720 + 300 = 2618
    expected: '2618',
    grade(answer) {
      return containsNumber(answer, 2618);
    },
    note: 'CSV rows are only in the recent user turn; junk has unrelated numbers but never this column, so the governed sum must match the baseline sum.',
  },

  // -------------------------------------------------------------------------
  // 4. Two-step reasoning: highest margin product.
  // -------------------------------------------------------------------------
  {
    id: 'rt-best-margin',
    category: 'reason-table',
    answerLocation: 'recent-table',
    build() {
      const table = [
        'Product economics (per unit, USD):',
        '',
        '| Product   | Sell price | Cost  |',
        '|-----------|-----------:|------:|',
        '| Alpha     |      40.00 | 28.00 |',
        '| Bravo     |      55.00 | 35.00 |',
        '| Charlie   |      30.00 | 12.00 |',
        '| Delta     |      72.00 | 60.00 |',
        '',
        'Margin = sell price - cost.',
        'Question: Which product has the HIGHEST margin? Answer with the product name.',
      ].join('\n');
      return { messages: buildConversation(table), question: 'Which product has the highest margin (sell price minus cost) in the table above? Answer with the product name.' };
    },
    // Alpha 12, Bravo 20, Charlie 18, Delta 12 => Bravo highest (20)
    expected: 'Bravo',
    grade(answer) {
      if (typeof answer !== 'string') return false;
      const a = answer.toLowerCase();
      // Must name Bravo and not pick a different product as the answer.
      if (!a.includes('bravo')) return false;
      // Guard against "not Bravo" style negation around the final pick.
      return !/\bnot\s+bravo\b/.test(a);
    },
    note: 'Margins are computable only from the recent table (Bravo=20 wins); the bloat is irrelevant logs/config, so a correct compactor preserves all four rows.',
  },

  // -------------------------------------------------------------------------
  // 5. Weighted total: hours * rate across a small timesheet.
  // -------------------------------------------------------------------------
  {
    id: 'rt-timesheet-total',
    category: 'reason-table',
    answerLocation: 'recent-table',
    build() {
      const table = [
        'Contractor timesheet for invoice #ZX-7782 (this week):',
        '',
        '| Contractor | Hours | Rate ($/h) |',
        '|------------|------:|-----------:|',
        '| Mara       |     8 |         50 |',
        '| Ivan       |     5 |         40 |',
        '| Priya      |    10 |         60 |',
        '',
        'Question: What is the total amount owed across all three contractors (hours times rate, summed)? Give the dollar amount.',
      ].join('\n');
      return { messages: buildConversation(table), question: 'What is the total amount owed across all three contractors in the timesheet above (hours times rate, summed)? Give the dollar amount.' };
    },
    // 8*50 + 5*40 + 10*60 = 400 + 200 + 600 = 1200
    expected: '$1200',
    grade(answer) {
      return containsNumber(answer, 1200);
    },
    note: 'All figures live in the recent timesheet table; duplicated log dumps and older tool results carry no rates/hours, so compaction cannot alter the computed total.',
  },
];

export default tasks;
