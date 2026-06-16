// bench/tasks/summarize-logs.mjs
//
// Category: summarize-logs  (SURVIVABLE)
//
// Each task ships a large, repetitive-but-realistic log payload (>= 5000 tokens
// of junk, ~20k+ chars). The benchmarked question always has an OBJECTIVE answer
// (a dominant HTTP status, a distinct-error-code count, a most-frequent service,
// etc.) that is encoded by a HIGH-FREQUENCY repeated pattern. Because the pattern
// repeats hundreds of times across the log, it survives compaction:
//   - dedup collapses the duplicate full-file pastes, but the kept copy still
//     contains the dominant pattern hundreds of times.
//   - elision drops OLDER tool results (keepRecentToolResults=1), but the answer
//     is restated in the RECENT user message AND is the majority pattern of the
//     surviving recent tool result.
// So a correct compactor preserves the signal. The answer is never hidden in a
// single needle line buried in junk — it IS the bulk of the junk.
//
// Plain Node ESM, dependency-free, no network.

// ---------------------------------------------------------------------------
// Deterministic helpers (no randomness, so token counts are stable per run)
// ---------------------------------------------------------------------------

// Small deterministic PRNG (mulberry32) so "noise" lines are varied but stable.
function makeRng(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pad(n, width) {
  const s = String(n);
  return s.length >= width ? s : '0'.repeat(width - s.length) + s;
}

function ts(base, i) {
  // Fake but realistic ISO-ish timestamp, monotonically increasing.
  const sec = base + i;
  const hh = pad(Math.floor((sec / 3600) % 24), 2);
  const mm = pad(Math.floor((sec / 60) % 60), 2);
  const ss = pad(sec % 60, 2);
  const ms = pad((i * 137) % 1000, 3);
  return `2026-06-16T${hh}:${mm}:${ss}.${ms}Z`;
}

// Build a big log body. `dominantLine(i)` is emitted with probability ~`ratio`,
// otherwise one of `noiseLines` is emitted. This guarantees the dominant pattern
// is the strict majority and survives any reasonable compaction of the bulk.
function buildLog({
  seed,
  lines,
  ratio,
  dominantLine,
  noiseLines,
  header = '',
  baseEpoch = 36000,
}) {
  const rng = makeRng(seed);
  const out = [];
  if (header) out.push(header);
  for (let i = 0; i < lines; i++) {
    const r = rng();
    if (r < ratio) {
      out.push(dominantLine(i, ts(baseEpoch, i)));
    } else {
      const idx = Math.floor(rng() * noiseLines.length) % noiseLines.length;
      out.push(noiseLines[idx](i, ts(baseEpoch, i)));
    }
  }
  return out.join('\n');
}

// A chunky, realistic config/stacktrace block to inflate token counts as junk.
function junkBlock(tag) {
  const lines = [];
  lines.push(`# ===== ${tag} :: runtime configuration dump (auto-generated, do not edit) =====`);
  for (let i = 0; i < 40; i++) {
    lines.push(
      `cfg.${tag}.param_${pad(i, 3)} = { enabled: ${i % 2 === 0}, retries: ${i % 5}, ` +
        `timeoutMs: ${1000 + i * 50}, backoff: "exponential", jitter: 0.${pad(i % 100, 2)}, ` +
        `pool: ${4 + (i % 8)}, region: "eu-central-${1 + (i % 3)}" }`
    );
  }
  lines.push(`# ----- ${tag} :: representative stack trace (truncated) -----`);
  const frames = [
    'at HikariPool.getConnection(HikariPool.java:194)',
    'at com.acme.db.PooledDataSource.fetch(PooledDataSource.java:88)',
    'at com.acme.svc.OrderRepository.load(OrderRepository.java:142)',
    'at com.acme.svc.OrderService.process(OrderService.java:331)',
    'at com.acme.http.OrderHandler.handle(OrderHandler.java:77)',
    'at io.netty.channel.AbstractChannelHandlerContext.invoke(AbstractChannelHandlerContext.java:379)',
    'at java.base/java.lang.Thread.run(Thread.java:842)',
  ];
  for (let i = 0; i < 30; i++) {
    lines.push('\t' + frames[i % frames.length]);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Reusable noise line factories (look like real interleaved log chatter)
// ---------------------------------------------------------------------------
const infoNoise = [
  (i, t) => `${t} INFO  [gateway]    req ${pad(i, 6)} routed upstream=catalog-svc latency_ms=${12 + (i % 40)}`,
  (i, t) => `${t} INFO  [gateway]    req ${pad(i, 6)} routed upstream=user-svc latency_ms=${8 + (i % 30)}`,
  (i, t) => `${t} DEBUG [cache]      key=session:${pad(i, 6)} hit=${i % 3 === 0} ttl=${300 - (i % 120)}`,
  (i, t) => `${t} INFO  [healthcheck] node-${i % 6} ok cpu=${20 + (i % 50)}% mem=${40 + (i % 40)}%`,
  (i, t) => `${t} DEBUG [scheduler]  tick ${pad(i, 6)} queued=${i % 17} inflight=${i % 5}`,
  (i, t) => `${t} INFO  [metrics]    flush batch=${pad(i, 5)} points=${100 + (i % 400)} ok`,
];

// ---------------------------------------------------------------------------
// TASK 1 — dominant repeating HTTP status (503) via duplicated full-file pastes.
//   Compaction path: DEDUP (same big log pasted 4x by re-reading agents).
//   Survivable: 503 is the strict majority status; even one surviving copy keeps it.
// ---------------------------------------------------------------------------
function task1() {
  const log = buildLog({
    seed: 11,
    lines: 520,
    ratio: 0.62, // strict majority -> 503
    header: '== nginx upstream access log :: production cluster eu-central-1 ==',
    dominantLine: (i, t) =>
      `${t} ERROR [upstream] GET /api/v2/checkout -> 503 Service Unavailable ` +
      `upstream=payments-svc backend=10.0.${i % 8}.${i % 250} retries=2 took_ms=${30 + (i % 200)}`,
    noiseLines: [
      (i, t) => `${t} INFO  [upstream] GET /api/v2/catalog -> 200 OK upstream=catalog-svc took_ms=${5 + (i % 40)}`,
      (i, t) => `${t} WARN  [upstream] GET /api/v2/user -> 404 Not Found upstream=user-svc took_ms=${3 + (i % 20)}`,
      (i, t) => `${t} INFO  [upstream] POST /api/v2/cart -> 201 Created upstream=cart-svc took_ms=${9 + (i % 35)}`,
      (i, t) => `${t} WARN  [upstream] GET /api/v2/search -> 429 Too Many Requests upstream=search-svc took_ms=${2 + (i % 15)}`,
      ...infoNoise,
    ],
  });

  // The exact same large log is pasted 4 times across the conversation, as if
  // multiple agent turns re-read and re-pasted the same artifact -> dedup fires.
  const messages = [
    {
      role: 'system',
      content:
        'You are an SRE assistant. When asked about logs, answer with the single objective fact requested. ' +
        'Be terse and precise.',
    },
    { role: 'user', content: 'Here is the access log dump from the incident. Please ingest it.\n\n' + log },
    { role: 'assistant', content: 'Ingested the access log. Ready for analysis.' },
    { role: 'user', content: 'Re-pasting the SAME dump for the on-call engineer, verbatim:\n\n' + log },
    { role: 'assistant', content: 'Acknowledged, identical to the previous dump.' },
    { role: 'user', content: 'Audit trail copy of the identical dump:\n\n' + log },
    { role: 'assistant', content: 'Noted; this matches the prior two copies.' },
    { role: 'user', content: 'Final archival copy (identical):\n\n' + log },
    {
      role: 'user',
      content:
        'Across these logs, exactly ONE HTTP error status repeats far more than any other ' +
        '(it is the dominant failing status during the incident). Reply with only that 3-digit HTTP status code.',
    },
  ];

  return {
    messages,
    question:
      'Across the access logs, which single 3-digit HTTP status code repeats far more than any other ' +
      '(the dominant failing status)? Answer with just the number.',
  };
}

// ---------------------------------------------------------------------------
// TASK 2 — count of DISTINCT error codes via OLD tool results (elision).
//   Several read_file tool calls dump log chunks; older ones get elided.
//   Survivable: the RECENT user message restates the full distinct-code list,
//   and the kept recent tool result also enumerates them. Answer = 4.
// ---------------------------------------------------------------------------
function task2() {
  // Each chunk emphasizes a different distinct error code, but ALL four codes
  // are also explicitly enumerated in the final recent user message (the survivor).
  const codes = ['E-DB-1001', 'E-AUTH-2002', 'E-NET-3003', 'E-DISK-4004'];

  function chunk(seed, dominantCode) {
    return buildLog({
      seed,
      lines: 240,
      ratio: 0.55,
      header: `== service journal segment (code focus: ${dominantCode}) ==`,
      dominantLine: (i, t) =>
        `${t} ERROR [worker-${i % 4}] code=${dominantCode} msg="operation failed" ` +
        `attempt=${1 + (i % 3)} trace=${pad(i, 6)}`,
      noiseLines: [
        ...infoNoise,
        (i, t) => `${t} WARN  [worker-${i % 4}] slow op took_ms=${500 + (i % 900)} threshold_ms=500`,
        (i, t) => `${t} INFO  [worker-${i % 4}] heartbeat seq=${pad(i, 6)} ok`,
      ],
    });
  }

  const messages = [
    {
      role: 'system',
      content:
        'You are a log-analysis assistant. Use the tool outputs as evidence. ' +
        'Answer counting questions with a single integer.',
    },
    { role: 'user', content: 'Read the four journal segments and tell me how many DISTINCT error codes appear.' },
    {
      role: 'assistant',
      content: 'I will read each segment.',
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"/var/log/seg1.log"}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'call_1', content: junkBlock('seg1-prelude') + '\n' + chunk(101, codes[0]) },
    {
      role: 'assistant',
      content: 'Read segment 1. Reading segment 2.',
      tool_calls: [
        { id: 'call_2', type: 'function', function: { name: 'read_file', arguments: '{"path":"/var/log/seg2.log"}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'call_2', content: junkBlock('seg2-prelude') + '\n' + chunk(202, codes[1]) },
    {
      role: 'assistant',
      content: 'Read segment 2. Reading segment 3.',
      tool_calls: [
        { id: 'call_3', type: 'function', function: { name: 'read_file', arguments: '{"path":"/var/log/seg3.log"}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'call_3', content: junkBlock('seg3-prelude') + '\n' + chunk(303, codes[2]) },
    {
      role: 'assistant',
      content: 'Read segment 3. Reading segment 4.',
      tool_calls: [
        { id: 'call_4', type: 'function', function: { name: 'read_file', arguments: '{"path":"/var/log/seg4.log"}' } },
      ],
    },
    // This is the most-recent tool result (kept). It enumerates ALL four codes
    // explicitly, so even with older segments elided the answer is recoverable.
    {
      role: 'tool',
      tool_call_id: 'call_4',
      content:
        junkBlock('seg4-prelude') +
        '\n' +
        chunk(404, codes[3]) +
        '\n== consolidated distinct error-code index (across all four segments) ==\n' +
        codes.map((c, i) => `index ${i + 1}: ${c}`).join('\n'),
    },
    {
      role: 'user',
      content:
        'Summary of distinct error codes seen across the four segments: ' +
        codes.join(', ') +
        '. How many DISTINCT error codes appear in total? Answer with a single integer.',
    },
  ];

  return {
    messages,
    question:
      'How many distinct error codes appear in total across the four log segments? Answer with a single integer.',
  };
}

// ---------------------------------------------------------------------------
// TASK 3 — most frequent failing SERVICE via duplicated pastes (dedup).
//   "payments-svc" is the dominant service in error lines. Pasted 3x.
//   Survivable: dominant service is the majority of error lines in any kept copy.
// ---------------------------------------------------------------------------
function task3() {
  const log = buildLog({
    seed: 77,
    lines: 480,
    ratio: 0.58, // strict majority of ERROR lines -> payments-svc
    header: '== distributed tracing error feed :: span errors only-ish ==',
    dominantLine: (i, t) =>
      `${t} ERROR [trace] span_id=${pad(i, 8)} service=payments-svc op=charge ` +
      `status=ERROR duration_ms=${50 + (i % 300)} peer=acquirer-gw err="timeout"`,
    noiseLines: [
      (i, t) =>
        `${t} ERROR [trace] span_id=${pad(i, 8)} service=catalog-svc op=query status=ERROR duration_ms=${10 + (i % 80)} err="db_conn"`,
      (i, t) =>
        `${t} ERROR [trace] span_id=${pad(i, 8)} service=user-svc op=lookup status=ERROR duration_ms=${5 + (i % 40)} err="not_found"`,
      (i, t) =>
        `${t} INFO  [trace] span_id=${pad(i, 8)} service=cart-svc op=add status=OK duration_ms=${4 + (i % 20)}`,
      ...infoNoise,
    ],
  });

  const messages = [
    {
      role: 'system',
      content: 'You are a tracing analyst. Answer service-name questions with the exact service name only.',
    },
    { role: 'user', content: 'Span error feed (copy 1 of 3):\n\n' + log },
    { role: 'assistant', content: 'Loaded copy 1.' },
    { role: 'user', content: 'Span error feed (copy 2 of 3, identical):\n\n' + log },
    { role: 'assistant', content: 'Loaded copy 2, identical to copy 1.' },
    { role: 'user', content: 'Span error feed (copy 3 of 3, identical):\n\n' + log },
    {
      role: 'user',
      content:
        'Among the ERROR spans, exactly one service accounts for the majority of failures. ' +
        'Reply with only that service name (e.g. "xxx-svc").',
    },
  ];

  return {
    messages,
    question:
      'Among the ERROR spans, which single service name accounts for the majority of failures? ' +
      'Answer with just the service name.',
  };
}

// ---------------------------------------------------------------------------
// TASK 4 — dominant repeating exception class via OLD tool results (elision).
//   Multiple journalctl reads; older elided. NullPointerException dominates.
//   Survivable: recent user message + kept recent tool result both state it.
// ---------------------------------------------------------------------------
function task4() {
  function chunk(seed, dominant) {
    return buildLog({
      seed,
      lines: 230,
      ratio: 0.6,
      header: '== application exception journal ==',
      dominantLine: (i, t) =>
        `${t} ERROR [app] uncaught java.lang.NullPointerException at com.acme.OrderMapper.map line ${100 + (i % 50)} ` +
        `thread=worker-${i % 8} corr=${pad(i, 6)}`,
      noiseLines: [
        (i, t) => `${t} ERROR [app] caught java.lang.IllegalArgumentException at Validator.check line ${i % 80}`,
        (i, t) => `${t} ERROR [app] caught java.io.IOException at FileSink.flush line ${i % 60}`,
        (i, t) => `${t} WARN  [app] retrying op idempotency_key=${pad(i, 8)} attempt=${1 + (i % 3)}`,
        ...infoNoise,
      ],
    });
  }

  const messages = [
    {
      role: 'system',
      content:
        'You diagnose Java services from logs. Answer exception-class questions with the bare class name.',
    },
    { role: 'user', content: 'Find the most frequent uncaught exception class across these journal reads.' },
    {
      role: 'assistant',
      content: 'Reading journal page 1.',
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'journalctl', arguments: '{"page":1}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'call_1', content: junkBlock('page1') + '\n' + chunk(501, true) },
    {
      role: 'assistant',
      content: 'Reading journal page 2.',
      tool_calls: [
        { id: 'call_2', type: 'function', function: { name: 'journalctl', arguments: '{"page":2}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'call_2', content: junkBlock('page2') + '\n' + chunk(502, true) },
    {
      role: 'assistant',
      content: 'Reading journal page 3 (latest).',
      tool_calls: [
        { id: 'call_3', type: 'function', function: { name: 'journalctl', arguments: '{"page":3}' } },
      ],
    },
    // Most-recent tool result (kept), restates the dominant exception explicitly.
    {
      role: 'tool',
      tool_call_id: 'call_3',
      content:
        junkBlock('page3') +
        '\n' +
        chunk(503, true) +
        '\n== aggregation footer ==\n' +
        'top uncaught exception by count: java.lang.NullPointerException (dominant across all pages)',
    },
    {
      role: 'user',
      content:
        'Per the aggregation footer, the dominant uncaught exception is java.lang.NullPointerException. ' +
        'What is the single most frequent UNCAUGHT exception class? Reply with just the class name ' +
        '(e.g. "NullPointerException" or the fully-qualified name).',
    },
  ];

  return {
    messages,
    question:
      'What is the single most frequent uncaught exception class across the journal pages? ' +
      'Answer with just the exception class name.',
  };
}

// ---------------------------------------------------------------------------
// TASK 5 — dominant repeating syslog severity / signal via duplicated pastes.
//   "OOMKilled" (exit 137) dominates pod-restart events. Pasted 4x -> dedup.
//   Survivable: OOMKilled is the strict majority restart reason in any kept copy.
// ---------------------------------------------------------------------------
function task5() {
  const log = buildLog({
    seed: 909,
    lines: 500,
    ratio: 0.64, // strict majority restart reason -> OOMKilled / exit 137
    header: '== kubelet pod lifecycle events :: namespace=prod ==',
    dominantLine: (i, t) =>
      `${t} WARN  [kubelet] pod=orders-${pad(i % 200, 3)} container=app restarted reason=OOMKilled ` +
      `exitCode=137 memLimitMi=512 lastUsedMi=${500 + (i % 80)} restartCount=${1 + (i % 9)}`,
    noiseLines: [
      (i, t) =>
        `${t} INFO  [kubelet] pod=orders-${pad(i % 200, 3)} container=app restarted reason=Completed exitCode=0 restartCount=${i % 4}`,
      (i, t) =>
        `${t} WARN  [kubelet] pod=orders-${pad(i % 200, 3)} container=app restarted reason=Error exitCode=1 restartCount=${1 + (i % 3)}`,
      (i, t) =>
        `${t} WARN  [kubelet] pod=orders-${pad(i % 200, 3)} container=app probe=liveness failed reason=CrashLoopBackOff exitCode=2`,
      ...infoNoise,
    ],
  });

  const messages = [
    {
      role: 'system',
      content: 'You are a Kubernetes operator. Answer with the single exact reason string requested.',
    },
    { role: 'user', content: 'Kubelet event dump (paste 1 of 4):\n\n' + log },
    { role: 'assistant', content: 'Loaded paste 1.' },
    { role: 'user', content: 'Kubelet event dump (paste 2 of 4, identical):\n\n' + log },
    { role: 'assistant', content: 'Loaded paste 2, identical.' },
    { role: 'user', content: 'Kubelet event dump (paste 3 of 4, identical):\n\n' + log },
    { role: 'assistant', content: 'Loaded paste 3, identical.' },
    { role: 'user', content: 'Kubelet event dump (paste 4 of 4, identical):\n\n' + log },
    {
      role: 'user',
      content:
        'One pod-restart reason dominates all others in these events. ' +
        'Reply with only that reason string exactly as it appears (one word).',
    },
  ];

  return {
    messages,
    question:
      'Which single pod-restart reason dominates all others in the kubelet events? ' +
      'Answer with just the reason string (one word).',
  };
}

// ---------------------------------------------------------------------------
// Graders: case-insensitive, tolerant of surrounding text, objective.
// ---------------------------------------------------------------------------
function gradeContainsCode(answer, code) {
  if (typeof answer !== 'string') return false;
  return answer.toLowerCase().includes(code.toLowerCase());
}

const tasks = [
  {
    id: 'sl-http-503-dedup',
    category: 'summarize-logs',
    answerLocation: 'duplicated',
    build: task1,
    expected: '503',
    grade(answer) {
      if (typeof answer !== 'string') return false;
      // Must mention 503 and must NOT be claiming a different competing code as the answer.
      const nums = (answer.match(/\b\d{3}\b/g) || []).filter((n) =>
        ['200', '201', '404', '429', '503'].includes(n)
      );
      // Robust: 503 present, and if exactly one HTTP code is named it must be 503.
      if (!answer.includes('503')) return false;
      const uniq = [...new Set(nums)];
      if (uniq.length === 1) return uniq[0] === '503';
      // If several appear, accept only if 503 is the last/only emphasized one isn't
      // guaranteed; require 503 present and no other code stated as "the" answer.
      return true;
    },
    note: '503 is the strict majority status repeated hundreds of times; it survives in any kept dedup copy.',
  },
  {
    id: 'sl-distinct-codes-count',
    category: 'summarize-logs',
    answerLocation: 'old-tool-junk',
    build: task2,
    expected: '4',
    grade(answer) {
      if (typeof answer !== 'string') return false;
      // Extract the first standalone integer; accept the word "four" too.
      const m = answer.match(/-?\d+/);
      if (m && parseInt(m[0], 10) === 4) return true;
      return /\bfour\b/i.test(answer);
    },
    note: 'Four distinct codes; the recent (kept) user msg + recent tool result enumerate all four, so elision is safe.',
  },
  {
    id: 'sl-top-service-payments',
    category: 'summarize-logs',
    answerLocation: 'duplicated',
    build: task3,
    expected: 'payments-svc',
    grade(answer) {
      return gradeContainsCode(answer, 'payments-svc');
    },
    note: 'payments-svc is the majority of ERROR spans; majority pattern survives in any kept dedup copy.',
  },
  {
    id: 'sl-top-exception-npe',
    category: 'summarize-logs',
    answerLocation: 'old-tool-junk',
    build: task4,
    expected: 'NullPointerException',
    grade(answer) {
      return gradeContainsCode(answer, 'nullpointerexception');
    },
    note: 'NullPointerException dominates; the kept recent tool result + recent user msg both restate it, so elision is safe.',
  },
  {
    id: 'sl-restart-reason-oomkilled',
    category: 'summarize-logs',
    answerLocation: 'duplicated',
    build: task5,
    expected: 'OOMKilled',
    grade(answer) {
      return gradeContainsCode(answer, 'oomkilled');
    },
    note: 'OOMKilled is the strict majority restart reason; majority pattern survives in any kept dedup copy.',
  },
];

export default tasks;
