// bench/tasks/multi-tool-chain.mjs
//
// CATEGORY: multi-tool-chain (SURVIVABLE)
//
// Each task simulates an agent that called SEVERAL tools in sequence. The final
// answer requires COMBINING two facts that live in TWO DIFFERENT tool results
// (e.g. tool A returns "user_id=4471", tool B returns "region=eu2" -> question:
// "what is the user_id for the eu2 region?"). Neither fact alone answers the
// question; the model must join them.
//
// Layout of every conversation (oldest-first):
//   [system]
//   [user] [assistant+tool_call] [tool] x N   <- OLD, IRRELEVANT tool results.
//                                                These are large, realistic, and
//                                                genuinely unrelated to the join.
//                                                With keepRecentToolResults=1 the
//                                                governor elides every one of
//                                                them (they are >200 tokens, not
//                                                pinned, not the most-recent).
//   [user] [assistant+tool_call] [tool]        <- NEEDED FACT A (tool A).
//   [user] [assistant+tool_call] [tool]        <- NEEDED FACT B (tool B, MOST RECENT).
//   [user]  the join question.
//
// SURVIVABILITY (the honest part):
//   - Tool B is the single most-recent tool result, so it is kept VERBATIM
//     (keepRecentToolResults=1) — fact B always survives.
//   - Tool A is the second-most-recent tool result, so it IS an elision
//     candidate. But elision is SIGNAL-PRESERVING: it keeps a 240-char head
//     preview, up to 12 SALIENT lines, and an 80-char tail. We place fact A as
//     its OWN short salient line (a KEY=VALUE / ALLCAPS-code / 3+ digit number
//     line — exactly what extractSalientLines() retains) AND near the head of a
//     SMALL tool-A body, so the fact survives whether tool A is kept whole OR
//     elided to a marker. The bulky junk being thrown away is the OLD unrelated
//     tool results, which a correct compactor is right to drop.
//
// A correct compactor therefore keeps BOTH needed facts (one verbatim, one as a
// preserved salient line) while paging out the unrelated older tool junk — the
// governed answer to the join stays correct on far fewer tokens.
//
// Plain Node ESM, dependency-free, no network, no imports.

// ---------------------------------------------------------------------------
// Junk generators — large, realistic, and IRRELEVANT to every join. Each old
// tool result built from these clears the >200-token elision bar comfortably,
// and several of them together push each task well past the 5000-token
// (~20000 char) bloat floor.
// ---------------------------------------------------------------------------

const LOG_LINES = [
  '2026-04-02T11:02:14.118Z INFO  [http] GET /internal/metrics 200 7ms trace=aa11bb keepalive=true',
  '2026-04-02T11:02:14.140Z DEBUG [pool] acquired connection conn-18 (idle=9 active=7 max=64)',
  '2026-04-02T11:02:14.201Z WARN  [cache] redis SCAN cursor=0 took 91ms exceeded soft budget 50ms',
  '2026-04-02T11:02:14.233Z INFO  [scheduler] tick=88120 due=0 skipped=0 drift=2ms clock=monotonic',
  '2026-04-02T11:02:14.288Z ERROR [mailer] retry 2/5 job=digest.send backoff=300ms cause=ECONNRESET',
  '2026-04-02T11:02:14.301Z DEBUG [gc] minor collection 5.1ms heapUsed=188MB heapTotal=512MB',
  '2026-04-02T11:02:14.355Z INFO  [http] POST /internal/flush 204 31ms trace=cc22dd shard=7',
  '2026-04-02T11:02:14.390Z WARN  [ratelimit] bucket sys:cron near limit 488/500 reset=22s',
  '2026-04-02T11:02:14.412Z DEBUG [pool] released connection conn-18 lifetime=1.4s reused=22',
  '2026-04-02T11:02:14.470Z INFO  [metrics] flushed 612 series to tsdb in 4.0ms drops=0',
  '2026-04-02T11:02:14.501Z ERROR [db] statement timeout after 5000ms stmt=vacuum_analyze_audit',
  '2026-04-02T11:02:14.533Z INFO  [probe] GET /healthz 200 0ms trace=000000 source=kubelet',
  '2026-04-02T11:02:14.560Z DEBUG [feature] flag legacy_export=off cohort=internal sample=0.02',
  '2026-04-02T11:02:14.611Z WARN  [tls] cert for telemetry.internal expires in 14 days renew soon',
  '2026-04-02T11:02:14.644Z INFO  [queue] depth=64 oldest=1.1s consumers=4 lag=ok topic=audit.v1',
  '2026-04-02T11:02:14.690Z DEBUG [router] matched route GET /internal/metrics handler=metricsList',
  '2026-04-02T11:02:14.733Z INFO  [audit] svc-cron action=compact resource=segment_5521 result=ok',
  '2026-04-02T11:02:14.781Z WARN  [memory] rss 1.1GB approaching container limit 2GB scale soon',
  '2026-04-02T11:02:14.822Z ERROR [http] 502 upstream report-gen connect refused retrying once',
  '2026-04-02T11:02:14.860Z INFO  [shutdown] no signal; steady state; in-flight=3 drain=idle',
];

const CONFIG_DUMP = `# ---- rendered chart values (UNRELATED to this task) ----
apiVersion: apps/v1
kind: Deployment
metadata:
  name: report-generator
  namespace: analytics
  labels: { app: report-generator, tier: batch, version: "2.31.0" }
spec:
  replicas: 3
  strategy: { type: RollingUpdate, rollingUpdate: { maxSurge: 1, maxUnavailable: 0 } }
  template:
    spec:
      containers:
        - name: report-generator
          image: registry.internal/analytics/report-generator:2.31.0
          resources:
            requests: { cpu: "250m", memory: "256Mi" }
            limits:   { cpu: "1",    memory: "1Gi" }
          env:
            - { name: LOG_LEVEL, value: "info" }
            - { name: BATCH_SIZE, value: "500" }
            - { name: FLUSH_INTERVAL_MS, value: "2000" }
            - { name: TMP_DIR, value: "/var/tmp/reports" }
# ---- end chart values ----`;

const STACK_TRACE = `Unhandled rejection at buildDigest (reports/digest.js:144:21)
    at async runBatch (reports/batch.js:62:5)
    at async Scheduler.fire (core/scheduler.js:201:9)
    at async Timer._onTimeout (core/timer.js:48:3)
  caused by: RangeError: invalid array length while paginating rows
    at paginate (reports/page.js:77:13)
    at buildDigest (reports/digest.js:139:19)
  context: { batchId: 'batch-7781', rows: 0, window: '24h', tz: 'UTC' }`;

/**
 * Build a big, IRRELEVANT junk blob for an old tool result. `seed` is woven in so
 * blobs read distinct; sized to clear the 200-token elision bar many times over.
 * @param {string} seed
 * @param {number} reps
 */
function junkBlob(seed, reps = 10) {
  const parts = [];
  parts.push(`==== unrelated diagnostic capture ${seed} ====`);
  parts.push(CONFIG_DUMP);
  for (let r = 0; r < reps; r++) {
    parts.push(`--- log segment ${seed}#${r} ---`);
    for (const line of LOG_LINES) parts.push(line);
    if (r % 3 === 0) parts.push(STACK_TRACE);
  }
  parts.push(`==== end unrelated capture ${seed} ====`);
  return parts.join('\n');
}

/**
 * Assemble a multi-tool-chain conversation.
 *
 * @param {object} o
 * @param {string} o.system            - system prompt.
 * @param {Array<{user,toolName,args,result}>} o.oldCalls
 *        OLD, irrelevant tool calls (each becomes user + assistant(tool_call) +
 *        tool). Their `result` is bulky junk that the governor will elide.
 * @param {{user,toolName,args,result}} o.toolA  - second-most-recent (needed fact A).
 * @param {{user,toolName,args,result}} o.toolB  - most-recent (needed fact B; kept verbatim).
 * @param {string} o.question          - the final join question.
 * @returns {{messages:Array, question:string}}
 */
function buildChain(o) {
  const messages = [{ role: 'system', content: o.system }];
  let n = 0;
  const push = (call) => {
    n += 1;
    const id = `call_${n}`;
    messages.push({ role: 'user', content: call.user });
    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: [
        { id, type: 'function', function: { name: call.toolName, arguments: call.args } },
      ],
    });
    messages.push({ role: 'tool', tool_call_id: id, content: call.result });
  };

  for (const c of o.oldCalls) push(c);
  push(o.toolA); // second-most-recent tool result (needed fact A)
  push(o.toolB); // most-recent tool result (needed fact B — kept verbatim)

  messages.push({ role: 'user', content: o.question });
  return { messages, question: o.question };
}

// A tiny realistic wrapper around a needed fact so the tool body is small and the
// fact lands near the head AND on its own salient line. `lead`/`tail` are short.
function factResult(lead, factLine, tail) {
  return `${lead}\n${factLine}\n${tail}`;
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

const tasks = [
  // 1) Join user_id (tool A) with region (tool B) ---------------------------
  {
    id: 'mtc-userid-for-region',
    category: 'multi-tool-chain',
    answerLocation: 'recent',
    build() {
      return buildChain({
        system:
          'You are an internal support agent. You may call tools to look things up. ' +
          'Answer the final question by COMBINING facts from the tool results. ' +
          'Answer with just the exact value requested.',
        oldCalls: [
          {
            user: 'First, dump the report-generator diagnostics so we have context.',
            toolName: 'get_diagnostics',
            args: '{"service":"report-generator"}',
            result: junkBlob('diag-A', 12),
          },
          {
            user: 'Also pull the recent batch logs, unrelated but keep them handy.',
            toolName: 'tail_logs',
            args: '{"service":"report-generator","lines":200}',
            result: junkBlob('logs-A', 12),
          },
        ],
        toolA: {
          user: 'Look up the account record for the customer named Halverson.',
          toolName: 'lookup_account',
          args: '{"name":"Halverson"}',
          result: factResult(
            'account record (lookup_account):',
            'user_id=4471 plan=enterprise status=active',
            'note: profile complete; no flags.',
          ),
        },
        toolB: {
          user: 'Now resolve which deployment region serves that account.',
          toolName: 'resolve_region',
          args: '{"user_id":4471}',
          result: factResult(
            'region resolution (resolve_region):',
            'user_id=4471 region=eu2 datacenter=fra-3',
            'routing: sticky; failover=eu1.',
          ),
        },
        question:
          'Combining the two lookups, what is the user_id of the account that is served by the eu2 region? Answer with just the number.',
      });
    },
    expected: '4471',
    grade(answer) {
      if (typeof answer !== 'string') return false;
      const nums = answer.match(/\d{3,6}/g) || [];
      return nums.includes('4471');
    },
    note: 'Both needed facts (user_id=4471, region=eu2) are in the two most-recent tool results; toolB is kept verbatim and toolA survives elision as a salient KEY=VALUE line. Old report-generator junk is irrelevant to the join.',
  },

  // 2) Join order_id (tool A) with carrier tracking (tool B) ----------------
  {
    id: 'mtc-tracking-for-order',
    category: 'multi-tool-chain',
    answerLocation: 'recent',
    build() {
      return buildChain({
        system:
          'You are a logistics assistant with tool access. Combine facts across ' +
          'tool results to answer. Tracking codes look like TRK-XXXXXX. ' +
          'Answer with just the exact value requested.',
        oldCalls: [
          {
            user: 'Dump the warehouse health diagnostics first.',
            toolName: 'get_diagnostics',
            args: '{"site":"wh-frankfurt"}',
            result: junkBlob('wh-diag', 12),
          },
          {
            user: 'And the conveyor controller logs, unrelated for now.',
            toolName: 'tail_logs',
            args: '{"component":"conveyor","lines":200}',
            result: junkBlob('conveyor', 12),
          },
          {
            user: 'Throw in the scanner firmware dump too.',
            toolName: 'get_diagnostics',
            args: '{"component":"scanner"}',
            result: junkBlob('scanner', 10),
          },
        ],
        toolA: {
          user: 'Find the open order for customer reference RMA-5582.',
          toolName: 'find_order',
          args: '{"rma":"RMA-5582"}',
          result: factResult(
            'order match (find_order):',
            'order_id=88203 rma=RMA-5582 state=picked',
            'warehouse: wh-frankfurt; priority=standard.',
          ),
        },
        toolB: {
          user: 'Now get the shipment tracking attached to that order.',
          toolName: 'get_shipment',
          args: '{"order_id":88203}',
          result: factResult(
            'shipment (get_shipment):',
            'order_id=88203 carrier=DHL tracking=TRK-7K9QD4',
            'eta: 2 business days; insured=true.',
          ),
        },
        question:
          'Combining both tool results, what is the carrier tracking code for the order whose order_id is 88203? Answer with just the tracking code.',
      });
    },
    expected: 'TRK-7K9QD4',
    grade(answer) {
      if (typeof answer !== 'string') return false;
      return answer.toLowerCase().replace(/\s+/g, '').includes('trk-7k9qd4');
    },
    note: 'order_id=88203 (toolA) joins to tracking=TRK-7K9QD4 (toolB, kept verbatim). Both are recent salient lines; the warehouse/conveyor/scanner dumps are unrelated and elidable.',
  },

  // 3) Join host (tool A) with discovered port (tool B) ---------------------
  {
    id: 'mtc-port-for-host',
    category: 'multi-tool-chain',
    answerLocation: 'recent',
    build() {
      return buildChain({
        system:
          'You are a network-recon assistant with tools. Combine facts across tool ' +
          'results. Report exact integers. Answer with just the number when asked.',
        oldCalls: [
          {
            user: 'Capture the gateway router diagnostics for context.',
            toolName: 'get_diagnostics',
            args: '{"device":"gw-router-1"}',
            result: junkBlob('gw-router', 12),
          },
          {
            user: 'Also dump the switch fabric logs, unrelated.',
            toolName: 'tail_logs',
            args: '{"device":"switch-fabric","lines":200}',
            result: junkBlob('switch', 12),
          },
        ],
        toolA: {
          user: 'Resolve the management host for service codenamed "lighthouse".',
          toolName: 'resolve_host',
          args: '{"service":"lighthouse"}',
          result: factResult(
            'host resolution (resolve_host):',
            'service=lighthouse host=10.6.3.21 env=staging',
            'owner: platform; tags=internal.',
          ),
        },
        toolB: {
          user: 'Scan that host and report the admin console port.',
          toolName: 'scan_host',
          args: '{"host":"10.6.3.21"}',
          result: factResult(
            'scan result (scan_host):',
            'host=10.6.3.21 admin_console_port=39142 tls=true',
            'other: 22 ssh, 443 https (public).',
          ),
        },
        question:
          'Combining both tool results, which port is the admin console on for the host that runs the "lighthouse" service? Answer with just the port number.',
      });
    },
    expected: '39142',
    grade(answer) {
      if (typeof answer !== 'string') return false;
      const nums = answer.match(/\d{2,6}/g) || [];
      return nums.includes('39142');
    },
    note: 'host=10.6.3.21 (toolA) joins to admin_console_port=39142 (toolB, kept verbatim); both recent salient lines. Router/switch dumps are irrelevant and elidable.',
  },

  // 4) Join invoice (tool A) with FX-converted total (tool B) ---------------
  {
    id: 'mtc-total-for-invoice',
    category: 'multi-tool-chain',
    answerLocation: 'recent',
    build() {
      return buildChain({
        system:
          'You are a finance ops assistant with tools. Combine facts from tool ' +
          'results to answer. Amounts are integers in minor units. ' +
          'Answer with just the requested value.',
        oldCalls: [
          {
            user: 'Pull the billing service diagnostics first.',
            toolName: 'get_diagnostics',
            args: '{"service":"billing"}',
            result: junkBlob('billing-diag', 12),
          },
          {
            user: 'And the ledger reconciliation logs, unrelated.',
            toolName: 'tail_logs',
            args: '{"service":"ledger","lines":200}',
            result: junkBlob('ledger', 12),
          },
        ],
        toolA: {
          user: 'Find the open invoice for account ACME-DE.',
          toolName: 'find_invoice',
          args: '{"account":"ACME-DE"}',
          result: factResult(
            'invoice (find_invoice):',
            'invoice_id=INV-90217 currency=EUR amount_minor=412900',
            'status: open; terms=net30.',
          ),
        },
        toolB: {
          user: 'Convert that invoice amount to USD minor units at today\'s rate.',
          toolName: 'fx_convert',
          args: '{"invoice_id":"INV-90217","to":"USD"}',
          result: factResult(
            'fx conversion (fx_convert):',
            'invoice_id=INV-90217 to=USD usd_amount_minor=451631',
            'rate: 1.0939; as_of=2026-04-02.',
          ),
        },
        question:
          'Combining both tool results, what is the converted USD amount (in minor units) for invoice INV-90217? Answer with just the number.',
      });
    },
    expected: '451631',
    grade(answer) {
      if (typeof answer !== 'string') return false;
      const nums = answer.match(/\d{4,9}/g) || [];
      return nums.includes('451631');
    },
    note: 'invoice INV-90217 (toolA) joins to usd_amount_minor=451631 (toolB, kept verbatim); both recent salient lines. Billing/ledger dumps are irrelevant and elidable.',
  },

  // 5) Join failing pod (tool A) with assigned node (tool B) ----------------
  {
    id: 'mtc-node-for-pod',
    category: 'multi-tool-chain',
    answerLocation: 'recent',
    build() {
      return buildChain({
        system:
          'You are an SRE assistant with cluster tools. Combine facts across tool ' +
          'results to answer. Node names look like node-XX. ' +
          'Answer with just the exact value requested.',
        oldCalls: [
          {
            user: 'Dump the cluster autoscaler diagnostics for context.',
            toolName: 'get_diagnostics',
            args: '{"component":"autoscaler"}',
            result: junkBlob('autoscaler', 12),
          },
          {
            user: 'Pull the ingress controller logs too, unrelated.',
            toolName: 'tail_logs',
            args: '{"component":"ingress","lines":200}',
            result: junkBlob('ingress', 12),
          },
          {
            user: 'And the kubelet event stream for good measure.',
            toolName: 'tail_logs',
            args: '{"component":"kubelet","lines":200}',
            result: junkBlob('kubelet', 10),
          },
        ],
        toolA: {
          user: 'Find the pod that is CrashLoopBackOff in namespace payments.',
          toolName: 'find_pod',
          args: '{"namespace":"payments","state":"CrashLoopBackOff"}',
          result: factResult(
            'pod match (find_pod):',
            'pod=payments-api-6c4f restarts=27 state=CrashLoopBackOff',
            'namespace: payments; container=api.',
          ),
        },
        toolB: {
          user: 'Show which node that pod is scheduled on.',
          toolName: 'describe_pod',
          args: '{"pod":"payments-api-6c4f"}',
          result: factResult(
            'pod placement (describe_pod):',
            'pod=payments-api-6c4f node=node-77 zone=eu-central-1a',
            'qos: Burstable; scheduler=default.',
          ),
        },
        question:
          'Combining both tool results, which node is the CrashLoopBackOff pod (in the payments namespace) scheduled on? Answer with just the node name.',
      });
    },
    expected: 'node-77',
    grade(answer) {
      if (typeof answer !== 'string') return false;
      return /node-0*77\b/.test(answer.toLowerCase().replace(/\s+/g, ''));
    },
    note: 'pod=payments-api-6c4f (toolA) joins to node=node-77 (toolB, kept verbatim); both recent salient lines. Autoscaler/ingress/kubelet dumps are irrelevant and elidable.',
  },

  // 6) Join experiment (tool A) with winning variant code (tool B) ----------
  {
    id: 'mtc-variant-for-experiment',
    category: 'multi-tool-chain',
    answerLocation: 'recent',
    build() {
      return buildChain({
        system:
          'You are a growth-analytics assistant with tools. Combine facts across ' +
          'tool results to answer. Variant codes look like VAR-XXXX. ' +
          'Answer with just the exact value requested.',
        oldCalls: [
          {
            user: 'Dump the analytics pipeline diagnostics for context.',
            toolName: 'get_diagnostics',
            args: '{"service":"analytics-pipeline"}',
            result: junkBlob('analytics', 12),
          },
          {
            user: 'And the event ingestion logs, unrelated.',
            toolName: 'tail_logs',
            args: '{"service":"event-ingest","lines":200}',
            result: junkBlob('event-ingest', 12),
          },
        ],
        toolA: {
          user: 'Find the running experiment on the checkout-button surface.',
          toolName: 'find_experiment',
          args: '{"surface":"checkout-button"}',
          result: factResult(
            'experiment (find_experiment):',
            'experiment_id=EXP-3310 surface=checkout-button status=running',
            'allocation: 50/50; metric=conversion.',
          ),
        },
        toolB: {
          user: 'Show the current winning variant for that experiment.',
          toolName: 'get_results',
          args: '{"experiment_id":"EXP-3310"}',
          result: factResult(
            'results (get_results):',
            'experiment_id=EXP-3310 winning_variant=VAR-8842 lift=6.3%',
            'significance: p=0.012; sample=41200.',
          ),
        },
        question:
          'Combining both tool results, what is the winning variant code for the experiment running on the checkout-button surface? Answer with just the variant code.',
      });
    },
    expected: 'VAR-8842',
    grade(answer) {
      if (typeof answer !== 'string') return false;
      return answer.toLowerCase().replace(/\s+/g, '').includes('var-8842');
    },
    note: 'experiment EXP-3310 on checkout-button (toolA) joins to winning_variant=VAR-8842 (toolB, kept verbatim); both recent salient lines. Pipeline/ingest dumps are irrelevant and elidable.',
  },

  // 7) Three-recent chain: device (A) -> firmware build (B, most recent) ----
  //    Two OLD irrelevant tool results are elided; the two needed facts are the
  //    final two tool results. The join requires reading both.
  {
    id: 'mtc-firmware-for-device',
    category: 'multi-tool-chain',
    answerLocation: 'recent',
    build() {
      return buildChain({
        system:
          'You are a fleet-ops assistant with device tools. Combine facts across ' +
          'tool results to answer. Firmware builds look like FW-XXXXX. ' +
          'Answer with just the exact value requested.',
        oldCalls: [
          {
            user: 'Dump the OTA update server diagnostics first.',
            toolName: 'get_diagnostics',
            args: '{"service":"ota-server"}',
            result: junkBlob('ota', 12),
          },
          {
            user: 'And the telemetry collector logs, unrelated.',
            toolName: 'tail_logs',
            args: '{"service":"telemetry-collector","lines":200}',
            result: junkBlob('telemetry', 12),
          },
        ],
        toolA: {
          user: 'Find the device registered to asset tag AST-6071.',
          toolName: 'find_device',
          args: '{"asset_tag":"AST-6071"}',
          result: factResult(
            'device (find_device):',
            'device_id=DEV-2290 asset_tag=AST-6071 model=sensor-x2',
            'site: depot-9; online=true.',
          ),
        },
        toolB: {
          user: 'Show the firmware build currently installed on that device.',
          toolName: 'get_firmware',
          args: '{"device_id":"DEV-2290"}',
          result: factResult(
            'firmware (get_firmware):',
            'device_id=DEV-2290 firmware_build=FW-41207 channel=stable',
            'installed: 2026-03-30; rollback=FW-41033.',
          ),
        },
        question:
          'Combining both tool results, what is the firmware build currently installed on the device with asset tag AST-6071? Answer with just the firmware build code.',
      });
    },
    expected: 'FW-41207',
    grade(answer) {
      if (typeof answer !== 'string') return false;
      return answer.toLowerCase().replace(/\s+/g, '').includes('fw-41207');
    },
    note: 'asset tag AST-6071 -> device_id=DEV-2290 (toolA) joins to firmware_build=FW-41207 (toolB, kept verbatim); both recent salient lines. The rollback FW-41033 and OTA/telemetry dumps are decoys/irrelevant and elidable.',
  },
];

export default tasks;
