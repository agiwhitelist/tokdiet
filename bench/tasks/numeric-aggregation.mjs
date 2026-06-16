// bench/tasks/numeric-aggregation.mjs
//
// CATEGORY: numeric-aggregation (SURVIVABLE).
//
// Each task scatters a handful of numbers across a small, RECENT structured
// block (a markdown table or a short list) that lives in the FINAL user turn,
// and asks for an aggregate over those numbers: sum / average / max / count /
// min. The `expected` value is the exact number; the grader extracts a number
// from the answer (tolerating $, commas, and surrounding prose) and compares it
// to the target within a tiny epsilon.
//
// HONESTY CONTRACT for this category:
//   * The numbers that feed the aggregate appear ONLY in the recent structured
//     block (the last user message). That message is unique (never duplicated)
//     and recent, so dedup never touches it (dedup collapses byte-identical
//     repeats and keeps the LAST copy anyway) and elision never touches it
//     (elision only rewrites OLDER role:'tool' results; keepRecent=1).
//   * Every byte of the >5000-token bloat is genuinely irrelevant to the
//     aggregate:
//       - large byte-identical "file paste" blocks pasted 3-5x (dedup bait), and
//       - several big role:'tool' results (older ones elided).
//     The junk contains plenty of unrelated digits (timestamps, sizes, ports)
//     but NONE of the numbers the question aggregates over. A correct compactor
//     keeps the recent table verbatim, so the GOVERNED answer must match the
//     BASELINE answer exactly.
//
// Plain Node ESM, dependency-free, no network, no imports beyond builtins.

// ---------------------------------------------------------------------------
// Junk builders. Large, realistic-looking, IRRELEVANT context. The digits in
// here (timestamps, byte counts, ports, line numbers) are deliberately NOT the
// numbers any task aggregates over.
// ---------------------------------------------------------------------------

const LOG_LINES = [
  '2026-06-01T11:02:14.118Z INFO  [http] GET /api/v3/catalog 200 9ms trace=aa01 region=us-east-1',
  '2026-06-01T11:02:14.402Z DEBUG [pool] acquired connection conn#0019 idle=6 active=9 waiters=0',
  '2026-06-01T11:02:15.771Z WARN  [cache] redis GET miss key=cat:page:7 backfill scheduled ttl=300',
  '2026-06-01T11:02:16.009Z INFO  [auth] token verified sub=svc_2210 scope=read:catalog exp ok',
  '2026-06-01T11:02:16.553Z ERROR [worker] job reindex-catalog failed attempt=2 err=ECONNRESET',
  '2026-06-01T11:02:17.110Z DEBUG [gc] minor collection 14ms heapUsed=388MB heapTotal=640MB ext=18MB',
  '2026-06-01T11:02:17.884Z INFO  [queue] enqueued task=thumb.render id=tsk_70551 delay=0 priority=4',
  '2026-06-01T11:02:18.231Z TRACE [router] matched route GET /api/v3/catalog handler=listCatalog',
  '2026-06-01T11:02:18.998Z WARN  [ratelimit] client 198.51.100.7 over soft limit 121/100 window=60s',
  '2026-06-01T11:02:19.540Z INFO  [migrate] applied 0091_add_index_catalog_slug in 640ms ok',
  '2026-06-01T11:02:20.002Z DEBUG [s3] put object bucket=media key=thumb/c1/x8.webp size=18204 etag=cd77',
  '2026-06-01T11:02:20.661Z ERROR [db] statement timeout txn=tx_8821 after 5000ms stmt=SELECT_catalog',
  '2026-06-01T11:02:21.140Z INFO  [scheduler] cron tick name=hourly-sitemap next=2026-06-01T12:00:00Z',
  '2026-06-01T11:02:21.773Z DEBUG [tls] handshake complete cipher=TLS_AES_256_GCM_SHA384 alpn=h2',
  '2026-06-01T11:02:22.219Z WARN  [disk] volume /var/media at 79% usage inodes=64% throttle=none',
];

const STACK_TRACE = [
  'Traceback (most recent call last):',
  '  File "/srv/app/ingest/runner.py", line 318, in _run_stage',
  '    out = stage.process(batch)',
  '  File "/srv/app/ingest/stages/dedupe.py", line 96, in process',
  '    keys = self._fingerprint(batch)',
  '  File "/srv/app/ingest/stages/dedupe.py", line 141, in _fingerprint',
  '    return [self._hash(row) for row in batch]',
  '  File "/srv/app/ingest/stages/dedupe.py", line 141, in <listcomp>',
  '    return [self._hash(row) for row in batch]',
  '  File "/srv/app/ingest/stages/dedupe.py", line 159, in _hash',
  '    raise KeyError(f"missing required column at row {row.idx}")',
  'KeyError: \'missing required column at row 2210\'',
];

const CONFIG_DUMP = [
  '# /etc/media-cdn/cdn.conf  (rendered)',
  'worker_processes auto;',
  'worker_rlimit_nofile 65535;',
  'events { worker_connections 8192; multi_accept on; }',
  'http {',
  '  sendfile on; tcp_nopush on; tcp_nodelay on;',
  '  keepalive_timeout 75; keepalive_requests 800;',
  '  gzip on; gzip_comp_level 6; gzip_min_length 860;',
  '  proxy_buffering on; proxy_buffer_size 16k; proxy_buffers 8 16k;',
  '  upstream media_pool { least_conn; server 10.2.4.21:9090 weight=2; server 10.2.4.22:9090; }',
  '  log_format media \'$remote_addr - $request "$status" $body_bytes_sent rt=$request_time\';',
  '  server { listen 8443 ssl http2; server_name cdn.example.net; ssl_session_cache shared:M:40m; }',
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
 * that emitting it 3-5 times lets dedup collapse the earlier copies. Sized so
 * a few repeats clear the >5000-token / >20000-char bloat floor on their own.
 */
function dupFileDump() {
  return [
    '===== BEGIN PASTE: services/ingest/catalog-dedupe.log =====',
    fill(LOG_LINES, 2600, '--- application log (rotated segment 31) ---'),
    '',
    fill(STACK_TRACE, 1400, '--- captured exception (non-fatal, retried) ---'),
    '',
    fill(CONFIG_DUMP, 1400, '--- effective cdn config snapshot ---'),
    '===== END PASTE =====',
  ].join('\n');
}

/** A big, distinct-looking tool result body (used as role:'tool' content). */
function toolDump(tag) {
  return [
    `### tool output [${tag}]`,
    fill(LOG_LINES, 1900, `--- ${tag}: service logs ---`),
    fill(CONFIG_DUMP, 1200, `--- ${tag}: config ---`),
  ].join('\n');
}

const SYSTEM = [
  'You are a meticulous data and finance assistant.',
  'Answer ONLY the final question. When the answer is numeric, state the single final number plainly.',
  'You may show brief working first, but make the final value unmistakable.',
].join(' ');

/**
 * Assemble a standard bloated conversation:
 *   system, then a few user/assistant/tool cycles full of irrelevant junk
 *   (duplicated file pastes + several tool results), then finally a RECENT
 *   user message carrying the small structured block + the question.
 *
 * `blockMsg` is the final user content (string) — the only place the numbers
 * appear. It is unique, recent, and never duplicated, so it survives both dedup
 * and elision.
 */
function buildConversation(blockMsg) {
  const dump = dupFileDump(); // identical each call -> dedup target
  const messages = [
    { role: 'system', content: SYSTEM },

    // --- cycle 1: user pastes a file, assistant acks, tool reads more ---
    { role: 'user', content: 'Here is the catalog-dedupe log dump for the ingest review:\n\n' + dump },
    {
      role: 'assistant',
      content: 'Noted. Pulling the related service logs to cross-check the timeline.',
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"services/ingest/catalog-dedupe.log"}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'call_1', content: toolDump('catalog-segment-31') },

    // --- cycle 2: same file pasted AGAIN (dup), more tool output ---
    { role: 'user', content: 'For completeness, the same dump again so it stays in context:\n\n' + dump },
    {
      role: 'assistant',
      content: 'Got it. Checking the media CDN config as well.',
      tool_calls: [
        { id: 'call_2', type: 'function', function: { name: 'read_file', arguments: '{"path":"/etc/media-cdn/cdn.conf"}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'call_2', content: toolDump('media-cdn-config') },

    // --- cycle 3: dump a THIRD time, another tool result ---
    { role: 'user', content: 'And once more, pasting it a third time to be safe:\n\n' + dump },
    {
      role: 'assistant',
      content: 'Understood. Fetching the ingest worker metrics snapshot.',
      tool_calls: [
        { id: 'call_3', type: 'function', function: { name: 'read_file', arguments: '{"path":"metrics/ingest-worker.txt"}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'call_3', content: toolDump('ingest-worker-metrics') },

    // --- FINAL recent user turn: the small structured block + question (unique) ---
    { role: 'user', content: blockMsg },
  ];
  return messages;
}

// ---------------------------------------------------------------------------
// Grader helpers.
// ---------------------------------------------------------------------------

/** True if `answer` contains the number `target` (within a tiny epsilon) anywhere. */
function containsNumber(answer, target, eps = 0.005) {
  if (typeof answer !== 'string') return false;
  const cleaned = answer.replace(/[$,]/g, ''); // tolerate $1,234.50 style
  const matches = cleaned.match(/-?\d+(?:\.\d+)?/g);
  if (!matches) return false;
  return matches.some((m) => Math.abs(parseFloat(m) - target) < eps);
}

/** Extract the LAST number in `s` (most answers conclude with the final value). */
function lastNumber(s) {
  if (typeof s !== 'string') return null;
  const cleaned = s.replace(/[$,]/g, '');
  const matches = cleaned.match(/-?\d+(?:\.\d+)?/g);
  if (!matches || matches.length === 0) return null;
  return parseFloat(matches[matches.length - 1]);
}

/** True iff the LAST number in `answer` equals `target` within `eps`. */
function lastNumberIs(answer, target, eps = 0.005) {
  const n = lastNumber(answer);
  return n !== null && Math.abs(n - target) < eps;
}

// ===========================================================================
// TASKS
// ===========================================================================

const tasks = [
  // -------------------------------------------------------------------------
  // 1. SUM of a revenue column in a small markdown table.
  // -------------------------------------------------------------------------
  {
    id: 'na-sum-revenue',
    category: 'numeric-aggregation',
    answerLocation: 'recent-table',
    build() {
      const block = [
        'Quarterly revenue by region (USD thousands) — final, do not redistribute:',
        '',
        '| Region        | Revenue |',
        '|---------------|--------:|',
        '| North America |     412 |',
        '| Europe        |     287 |',
        '| Asia Pacific  |     356 |',
        '| Latin America |      94 |',
        '| Middle East   |     131 |',
        '',
        'Question: What is the SUM of the Revenue column across all five regions? Give the number.',
      ].join('\n');
      return {
        messages: buildConversation(block),
        question: 'What is the SUM of the Revenue column across all five regions in the table above? Give the number.',
      };
    },
    // 412 + 287 + 356 + 94 + 131 = 1280
    expected: '1280',
    grade(answer) {
      return containsNumber(answer, 1280);
    },
    note: 'The five revenue figures appear only in the recent table; duplicated log pastes and old tool dumps carry unrelated digits, so a correct compactor preserves every term of the sum.',
  },

  // -------------------------------------------------------------------------
  // 2. AVERAGE of a small list of response times.
  // -------------------------------------------------------------------------
  {
    id: 'na-avg-latency',
    category: 'numeric-aggregation',
    answerLocation: 'recent-table',
    build() {
      const block = [
        'Synthetic probe latencies just measured (milliseconds), batch #ZX-4410:',
        '',
        '- probe-01: 120 ms',
        '- probe-02: 140 ms',
        '- probe-03: 90 ms',
        '- probe-04: 160 ms',
        '- probe-05: 110 ms',
        '- probe-06: 100 ms',
        '',
        'Question: What is the AVERAGE (mean) latency across these six probes, in milliseconds? Give the number.',
      ].join('\n');
      return {
        messages: buildConversation(block),
        question: 'What is the AVERAGE (mean) latency across the six probes in the list above, in milliseconds? Give the number.',
      };
    },
    // (120+140+90+160+110+100)/6 = 720/6 = 120
    expected: '120',
    grade(answer) {
      return containsNumber(answer, 120);
    },
    note: 'The six latency values live only in the recent list; the bloat is irrelevant logs/config with different numbers, so the governed mean must equal the baseline mean (120).',
  },

  // -------------------------------------------------------------------------
  // 3. MAX value in a small table (peak concurrent users).
  // -------------------------------------------------------------------------
  {
    id: 'na-max-peak-users',
    category: 'numeric-aggregation',
    answerLocation: 'recent-table',
    build() {
      const block = [
        'Peak concurrent users per day this week (live dashboard export):',
        '',
        '| Day       | Peak users |',
        '|-----------|-----------:|',
        '| Monday    |      8420  |',
        '| Tuesday   |      9135  |',
        '| Wednesday |      7788  |',
        '| Thursday  |     10240  |',
        '| Friday    |      9602  |',
        '',
        'Question: What is the MAXIMUM peak-users value in the table? Give the number.',
      ].join('\n');
      return {
        messages: buildConversation(block),
        question: 'What is the MAXIMUM peak-users value in the table above? Give the number.',
      };
    },
    // max(8420, 9135, 7788, 10240, 9602) = 10240
    expected: '10240',
    grade(answer) {
      return containsNumber(answer, 10240);
    },
    note: 'The five daily peaks appear only in the recent table; junk dumps contain no such counts, so eliding/deduping them cannot change which value is the maximum.',
  },

  // -------------------------------------------------------------------------
  // 4. COUNT of rows matching a threshold (errors over 5).
  // -------------------------------------------------------------------------
  {
    id: 'na-count-over-threshold',
    category: 'numeric-aggregation',
    answerLocation: 'recent-table',
    build() {
      const block = [
        'Per-service error counts in the last hour (monitoring snapshot):',
        '',
        '| Service       | Errors |',
        '|---------------|-------:|',
        '| auth-api      |      2 |',
        '| orders-api    |      9 |',
        '| payments-api  |      6 |',
        '| search-api    |      1 |',
        '| inventory-api |      7 |',
        '| notify-api    |      4 |',
        '',
        'Question: How many services have MORE THAN 5 errors? Give the count.',
      ].join('\n');
      return {
        messages: buildConversation(block),
        question: 'How many services in the table above have MORE THAN 5 errors? Give the count.',
      };
    },
    // >5: orders-api(9), payments-api(6), inventory-api(7) => 3
    expected: '3',
    grade(answer) {
      return lastNumberIs(answer, 3);
    },
    note: 'Error counts live only in the recent table; only the count of rows >5 matters and those rows are all present recent, so a correct compactor yields the same count (3).',
  },

  // -------------------------------------------------------------------------
  // 5. Weighted SUM: quantity * unit price across a small order table.
  // -------------------------------------------------------------------------
  {
    id: 'na-weighted-order-total',
    category: 'numeric-aggregation',
    answerLocation: 'recent-table',
    build() {
      const block = [
        'Purchase order PO-55102 line items (USD):',
        '',
        '| Item          | Qty | Unit price |',
        '|---------------|----:|-----------:|',
        '| Steel bracket |   4 |      12.50 |',
        '| Hex bolt M8   |  10 |       0.75 |',
        '| Rubber gasket |   6 |       3.00 |',
        '| Mounting rail |   2 |      18.00 |',
        '',
        'Question: What is the TOTAL order value (sum of Qty x Unit price across all lines)? Give the dollar amount.',
      ].join('\n');
      return {
        messages: buildConversation(block),
        question: 'What is the TOTAL order value for PO-55102 above (sum of Qty times Unit price across all lines)? Give the dollar amount.',
      };
    },
    // 4*12.50 + 10*0.75 + 6*3.00 + 2*18.00 = 50 + 7.5 + 18 + 36 = 111.5
    expected: '$111.50',
    grade(answer) {
      return containsNumber(answer, 111.5);
    },
    note: 'Quantities and prices appear only in the recent line-item table; the duplicated pastes and old tool results have no order data, so the governed total matches the baseline (111.50).',
  },

  // -------------------------------------------------------------------------
  // 6. MIN value (lowest temperature reading) in a short list.
  // -------------------------------------------------------------------------
  {
    id: 'na-min-temperature',
    category: 'numeric-aggregation',
    answerLocation: 'recent-table',
    build() {
      const block = [
        'Cold-chain sensor readings just polled (degrees Celsius), shipment SH-9981:',
        '',
        '- sensor-A: 4.2 C',
        '- sensor-B: 3.8 C',
        '- sensor-C: 5.1 C',
        '- sensor-D: 2.9 C',
        '- sensor-E: 4.7 C',
        '',
        'Question: What is the MINIMUM (lowest) temperature reading among these sensors, in Celsius? Give the number.',
      ].join('\n');
      return {
        messages: buildConversation(block),
        question: 'What is the MINIMUM (lowest) temperature reading among the sensors in the list above, in Celsius? Give the number.',
      };
    },
    // min(4.2, 3.8, 5.1, 2.9, 4.7) = 2.9
    expected: '2.9',
    grade(answer) {
      return containsNumber(answer, 2.9);
    },
    note: 'The five readings live only in the recent list; irrelevant junk holds unrelated numbers, so a correct compactor keeps every reading and the minimum stays 2.9.',
  },

  // -------------------------------------------------------------------------
  // 7. SUM with a subtraction (net total = credits - debits) in a small ledger.
  // -------------------------------------------------------------------------
  {
    id: 'na-net-ledger-total',
    category: 'numeric-aggregation',
    answerLocation: 'recent-table',
    build() {
      const block = [
        'Account GL-7782 daily ledger entries (USD). Positive = credit, negative = debit:',
        '',
        '| Entry | Amount  |',
        '|-------|--------:|',
        '| E-1   |   1,250 |',
        '| E-2   |    -480 |',
        '| E-3   |     900 |',
        '| E-4   |    -325 |',
        '| E-5   |     155 |',
        '',
        'Question: What is the NET total (sum of all amounts, respecting the signs)? Give the dollar amount.',
      ].join('\n');
      return {
        messages: buildConversation(block),
        question: 'What is the NET total for ledger GL-7782 above (sum of all amounts, respecting signs)? Give the dollar amount.',
      };
    },
    // 1250 - 480 + 900 - 325 + 155 = 1500
    expected: '$1500',
    grade(answer) {
      return containsNumber(answer, 1500);
    },
    note: 'All signed ledger amounts appear only in the recent table; the compactable junk has no ledger figures, so the governed net total equals the baseline net total (1500).',
  },
];

export default tasks;
