// bench/tasks/long-dialogue-recency.mjs
//
// CATEGORY: long-dialogue-recency  (SURVIVABLE)
//
// Each task is a LONG multi-turn conversation (~20+ turns) in which a single
// unique, unambiguous fact is stated EARLY, then the conversation drifts into
// many turns of genuinely irrelevant chatter (standups, weather, lunch plans,
// JIRA noise) and a couple of large re-pasted dumps / old tool results. Near
// the END, the user RESTATES or PINS the exact same fact (either with a
// '<!--ctxgov:pin-->' sentinel that keeps the message verbatim, or simply by
// putting it in the most-recent user/assistant turn). The final question asks
// for that fact.
//
// Why this is fair / SURVIVABLE:
//   The canonical answer always lives in a RECENT or PINNED message that a
//   correct compactor keeps. The early statement is a bonus; the bloat in the
//   middle is irrelevant chatter, identical re-pasted blocks (collapsed by
//   dedup), and OLD role:'tool' results (elided beyond the most-recent 1).
//   None of the compacted junk carries the answer, so eliding/deduping it
//   cannot change the answer. The governed run keeps the recent/pinned needle
//   and stays correct while spending far fewer tokens.
//
// Harness assumptions: contextWindow=6000, threshold=0.5,
// keepRecentToolResults=1, minToolResultTokens~200. Each task carries well
// over 5000 tokens (~20000+ chars) of junk before/around the needle.
//
// Plain Node ESM, dependency-free, no network, no imports.

// ───────────────────────────────────────────────────────────────────────────
// Junk generators. Realistic-looking filler with NO needle content.
// ───────────────────────────────────────────────────────────────────────────

/** A pool of irrelevant "team chatter" lines used to pad the conversation. */
const CHATTER = [
  "Morning all — coffee machine on the 3rd floor is broken again, use the kitchenette.",
  "Reminder: sprint demo moved to Thursday 2pm, room Olive. Bring your laptops.",
  "Did anyone catch the game last night? That overtime was unreal.",
  "Lunch order going in at 12:15 — reply with your taco vs burrito preference.",
  "The office wifi guest network password rotated, ask IT if you need the new one.",
  "Fire drill scheduled for Friday morning, expect the alarm around 10am.",
  "Parking garage level 2 is closed for resurfacing through the weekend.",
  "Reminder to submit your timesheets before EOD Friday or payroll nags us.",
  "New espresso pods arrived, the hazelnut ones go fast so grab some early.",
  "The all-hands recording is up on the intranet if you missed it yesterday.",
  "Anyone have a spare HDMI-to-USB-C adapter? Mine walked off again.",
  "Weather looks rough this afternoon, bring an umbrella if you're commuting.",
  "Birthday cake for Sam in the break room at 3, come say hi.",
  "Heads up: VPN maintenance window tonight 11pm-1am, expect brief drops.",
  "The standup bot will ping you at 9:45, please post your updates async.",
  "Reminder the quarterly survey closes tomorrow, takes about five minutes.",
  "Someone left a black North Face jacket in conference room Birch.",
  "Friendly nudge to clean out the shared fridge before Friday evening.",
  "The new badge readers are live on the east entrance starting Monday.",
  "Team offsite poll is open — pick bowling, escape room, or mini golf.",
];

/** A large realistic log block used as a re-pasted dump (no needle content). */
const LOG_DUMP_LINES = [
  "2026-04-02T08:14:02.118Z INFO  [http] GET /api/v3/catalog 200 11ms trace=a91f keepalive=true",
  "2026-04-02T08:14:02.140Z DEBUG [pool] acquired connection conn-22 idle=5 active=9 max=48",
  "2026-04-02T08:14:02.201Z WARN  [cache] redis MGET latency 71ms exceeded soft budget 50ms",
  "2026-04-02T08:14:02.233Z INFO  [auth] jwt verified sub=user_4410 scope=read:catalog exp ok",
  "2026-04-02T08:14:02.288Z ERROR [worker] retry 2/5 job=index.sync backoff=300ms cause=ETIMEDOUT",
  "2026-04-02T08:14:02.301Z DEBUG [gc] minor collection 4.8ms heapUsed=188MB heapTotal=512MB",
  "2026-04-02T08:14:02.355Z INFO  [http] POST /api/v3/search 200 33ms trace=cc02 region=us-east",
  "2026-04-02T08:14:02.390Z WARN  [ratelimit] bucket api:std near limit 880/1000 reset=41s",
  "2026-04-02T08:14:02.412Z DEBUG [pool] released connection conn-22 lifetime=1.8s reused=14",
  "2026-04-02T08:14:02.470Z INFO  [metrics] flushed 280 series to statsd in 2.9ms drops=0",
  "2026-04-02T08:14:02.501Z ERROR [db] query timeout after 5000ms statement=SELECT_catalog_by_tag",
  "2026-04-02T08:14:02.533Z INFO  [http] GET /healthz 200 0ms trace=000000 probe=kubelet",
  "2026-04-02T08:14:02.560Z DEBUG [feature] flag new_search=off for user_4410 cohort=control",
  "2026-04-02T08:14:02.611Z WARN  [tls] certificate for cdn.internal expires in 14 days renew soon",
  "2026-04-02T08:14:02.644Z INFO  [queue] depth=96 oldest=1.4s consumers=4 lag=ok",
  "2026-04-02T08:14:02.690Z DEBUG [router] matched route GET /api/v3/catalog handler=listCatalog",
  "2026-04-02T08:14:02.733Z INFO  [audit] user_4410 action=view resource=catalog_99 result=allow",
  "2026-04-02T08:14:02.781Z WARN  [memory] rss 1.1GB approaching container limit 2GB scale soon",
  "2026-04-02T08:14:02.822Z ERROR [http] 502 upstream search-svc connect refused retrying once",
  "2026-04-02T08:14:02.860Z INFO  [shutdown] SIGTERM received draining 7 in-flight requests",
];

/** A large realistic config dump used as a re-pasted block (no needle content). */
const CONFIG_DUMP = `# ---- rendered values (helm) ----
global:
  environment: production
  region: us-east-1
  imageRegistry: registry.internal
service:
  name: catalog-api
  replicas: 8
  port: 8080
  strategy: RollingUpdate
resources:
  requests: { cpu: "400m", memory: "512Mi" }
  limits:   { cpu: "2",    memory: "2Gi" }
env:
  LOG_LEVEL: info
  POOL_MIN: "8"
  POOL_MAX: "48"
  CACHE_TTL: "300"
  HTTP_TIMEOUT_MS: "5000"
probes:
  readiness: { path: /healthz, port: 8080, periodSeconds: 5 }
  liveness:  { path: /livez,   port: 8080, periodSeconds: 10 }
# ---- end rendered values ----`;

/**
 * Build a big junk blob, sized to help clear the bloat bar on its own.
 * @param {string} seed - label woven in so distinct blobs look distinct.
 * @param {number} reps - how many times to repeat the log block.
 */
function junkBlob(seed, reps = 14) {
  const parts = [];
  parts.push(`==== diagnostic capture ${seed} ====`);
  parts.push(CONFIG_DUMP);
  for (let r = 0; r < reps; r++) {
    parts.push(`--- log segment ${seed}#${r} ---`);
    for (const line of LOG_DUMP_LINES) parts.push(line);
  }
  parts.push(`==== end diagnostic capture ${seed} ====`);
  return parts.join("\n");
}

/**
 * An IDENTICAL large blob (no seed variance) for dedup bait: when the same
 * normalized text appears 3-5 times, the compactor keeps the last copy and
 * elides the earlier ones. Comfortably > 200 normalized chars.
 */
function dedupBlob() {
  const parts = [CONFIG_DUMP];
  for (let r = 0; r < 9; r++) {
    for (const line of LOG_DUMP_LINES) parts.push(line);
  }
  return parts.join("\n");
}

/** Convenience: a valid OpenAI tool call + matching tool result (big content). */
function toolPair(callId, fnName, args, resultText) {
  return [
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: callId,
          type: "function",
          function: { name: fnName, arguments: JSON.stringify(args) },
        },
      ],
    },
    { role: "tool", tool_call_id: callId, content: resultText },
  ];
}

/**
 * Produce N alternating user/assistant chatter turns (irrelevant filler).
 * Deterministic given `start`.
 */
function chatterTurns(count, start = 0) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const line = CHATTER[(start + i) % CHATTER.length];
    if (i % 2 === 0) {
      out.push({ role: "user", content: line });
    } else {
      out.push({
        role: "assistant",
        content: "Noted, thanks for the heads up. " + line.split(".")[0] + ".",
      });
    }
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// Tasks
// ───────────────────────────────────────────────────────────────────────────

const tasks = [
  // ───────────────────────────────────────────────────────────────────────
  // 1. Conference room access code. Stated early, PINNED near the end.
  // ───────────────────────────────────────────────────────────────────────
  {
    id: "ldr-room-access-code",
    category: "long-dialogue-recency",
    answerLocation: "pinned",
    build() {
      const dup = dedupBlob();
      const messages = [
        {
          role: "system",
          content:
            "You are an office-operations assistant. Answer concisely and with exact values from the conversation.",
        },
        // EARLY statement of the fact.
        {
          role: "user",
          content:
            "Setting up the executive briefing for Friday. The door access code for conference room Cedar is 8847. Keep that in mind.",
        },
        { role: "assistant", content: "Got it — Cedar access code noted. What else do you need set up?" },
        // ~20 turns of irrelevant chatter.
        ...chatterTurns(18, 0),
        // A couple of large re-pasted dumps (dedup bait).
        { role: "user", content: "Unrelated, but here is today's service log for the catalog API for reference:\n" + dup },
        { role: "assistant", content: "Logged for reference. Anything else?" },
        { role: "user", content: "Same log again so it doesn't scroll off:\n" + dup },
        { role: "assistant", content: "Confirmed, identical to the prior paste." },
        { role: "user", content: "And once more, byte-for-byte the same log:\n" + dup },
        { role: "assistant", content: "Third copy matches. Standing by." },
        ...chatterTurns(6, 7),
        // PINNED restatement near the end (kept verbatim by the sentinel).
        {
          role: "user",
          content:
            "<!--ctxgov:pin--> PIN THIS: conference room Cedar door access code is 8847. Do not lose this.",
        },
        { role: "user", content: "Remind me — what's the access code for room Cedar?" },
      ];
      return { messages, question: "What is the door access code for conference room Cedar?" };
    },
    expected: "8847",
    grade(answer) {
      if (typeof answer !== "string") return false;
      const m = answer.match(/\b(\d{3,5})\b/g);
      return Array.isArray(m) && m.includes("8847");
    },
    note: "Code stated early AND in a pin-sentinel message near the end; chatter and thrice-pasted log are irrelevant junk.",
  },

  // ───────────────────────────────────────────────────────────────────────
  // 2. Project codename. Stated early, RESTATED in the final user turn.
  // ───────────────────────────────────────────────────────────────────────
  {
    id: "ldr-project-codename",
    category: "long-dialogue-recency",
    answerLocation: "recent",
    build() {
      const messages = [
        {
          role: "system",
          content: "You are a program-management assistant. Use the exact names given in the conversation.",
        },
        // EARLY statement.
        {
          role: "user",
          content:
            "Kicking off planning. The internal codename for the new payments migration project is Project Halcyon. We'll use that name everywhere.",
        },
        { role: "assistant", content: "Understood — Project Halcyon it is. Ready when you are." },
        // Irrelevant chatter.
        ...chatterTurns(10, 2),
        // OLD tool results (elided beyond the most-recent 1).
        ...toolPair("call_1", "fetch_calendar", { team: "payments", week: "2026-W14" }, junkBlob("cal-a", 14)),
        ...toolPair("call_2", "fetch_calendar", { team: "payments", week: "2026-W15" }, junkBlob("cal-b", 14)),
        ...toolPair("call_3", "list_attendees", { event: "kickoff" }, junkBlob("attendees", 14)),
        ...chatterTurns(10, 11),
        { role: "assistant", content: "All the scheduling pulls are done. What would you like to confirm?" },
        // RECENT restatement in the final user turn.
        {
          role: "user",
          content:
            "Before we wrap: just to be totally clear, the project codename we're standardizing on is Project Halcyon. What's the codename again?",
        },
      ];
      return { messages, question: "What is the internal codename for the payments migration project?" };
    },
    expected: "Project Halcyon",
    grade(answer) {
      if (typeof answer !== "string") return false;
      return answer.toLowerCase().includes("halcyon");
    },
    note: "Codename stated early and restated in the final user turn; calendar tool dumps + chatter are irrelevant and elided.",
  },

  // ───────────────────────────────────────────────────────────────────────
  // 3. Customer's chosen plan tier. Stated early, PINNED near the end.
  // ───────────────────────────────────────────────────────────────────────
  {
    id: "ldr-plan-tier",
    category: "long-dialogue-recency",
    answerLocation: "pinned",
    build() {
      const dup = dedupBlob();
      const messages = [
        {
          role: "system",
          content: "You are a sales-ops assistant. Answer with the exact tier/plan name from the conversation.",
        },
        // EARLY statement.
        {
          role: "user",
          content:
            "Closing the Meridian account. They committed to the Enterprise-Platinum tier (annual). Lock that in for the contract.",
        },
        { role: "assistant", content: "Great — Enterprise-Platinum, annual term, noted for Meridian." },
        ...chatterTurns(8, 5),
        // Dedup bait.
        { role: "user", content: "FYI here's the raw billing-system export for unrelated accounts:\n" + dup },
        { role: "assistant", content: "Received the export." },
        { role: "user", content: "Same export again, ignore it, just keeping it handy:\n" + dup },
        { role: "assistant", content: "Same as before, noted." },
        { role: "user", content: "One more identical copy of that export:\n" + dup },
        { role: "assistant", content: "Third identical copy received." },
        ...chatterTurns(10, 3),
        // PINNED restatement near the end.
        {
          role: "user",
          content:
            "<!--ctxgov:pin--> CONTRACT FACT TO KEEP: Meridian's selected plan is Enterprise-Platinum (annual). This is the tier going on the order form.",
        },
        { role: "user", content: "Which plan tier did Meridian select?" },
      ];
      return { messages, question: "Which plan tier did the Meridian account select?" };
    },
    expected: "Enterprise-Platinum",
    grade(answer) {
      if (typeof answer !== "string") return false;
      const a = answer.toLowerCase();
      return a.includes("enterprise-platinum") || (a.includes("enterprise") && a.includes("platinum"));
    },
    note: "Tier stated early and pinned near the end; billing export pasted 3x and chatter are irrelevant junk.",
  },

  // ───────────────────────────────────────────────────────────────────────
  // 4. Shipping tracking number. Stated early, RESTATED in final assistant turn.
  // ───────────────────────────────────────────────────────────────────────
  {
    id: "ldr-tracking-number",
    category: "long-dialogue-recency",
    answerLocation: "recent",
    build() {
      const messages = [
        {
          role: "system",
          content: "You are a logistics assistant. Reply with the exact tracking identifier from the conversation.",
        },
        // EARLY statement.
        {
          role: "user",
          content:
            "The replacement server chassis shipped today. Tracking number is 1Z9X4K7782. We need to watch for delivery.",
        },
        { role: "assistant", content: "Got the tracking number 1Z9X4K7782 — I'll reference it for delivery status." },
        ...chatterTurns(12, 9),
        // OLD tool results (elided beyond the most-recent 1).
        ...toolPair("call_1", "warehouse_inventory", { dc: "us-east" }, junkBlob("inv-east", 14)),
        ...toolPair("call_2", "warehouse_inventory", { dc: "us-west" }, junkBlob("inv-west", 14)),
        ...toolPair("call_3", "carrier_rates", { lanes: "all" }, junkBlob("rates", 14)),
        ...toolPair("call_4", "open_tickets", { queue: "logistics" }, junkBlob("tickets", 14)),
        ...chatterTurns(8, 1),
        { role: "user", content: "Okay, what's the tracking number on the chassis shipment again?" },
        // RECENT restatement in the final assistant turn.
        {
          role: "assistant",
          content:
            "The chassis shipment tracking number is 1Z9X4K7782. I'll keep monitoring it until it shows delivered.",
        },
        { role: "user", content: "Perfect, confirm that tracking number one more time." },
      ];
      return { messages, question: "What is the tracking number for the chassis shipment?" };
    },
    expected: "1Z9X4K7782",
    grade(answer) {
      if (typeof answer !== "string") return false;
      return answer.toUpperCase().includes("1Z9X4K7782");
    },
    note: "Tracking number stated early and restated in a recent assistant turn; inventory/rate tool dumps are irrelevant and elided.",
  },

  // ───────────────────────────────────────────────────────────────────────
  // 5. Approved budget figure. Stated early, PINNED near the end.
  // ───────────────────────────────────────────────────────────────────────
  {
    id: "ldr-approved-budget",
    category: "long-dialogue-recency",
    answerLocation: "pinned",
    build() {
      const dup = dedupBlob();
      const messages = [
        {
          role: "system",
          content: "You are a finance assistant. Answer with the exact approved figure from the conversation.",
        },
        // EARLY statement.
        {
          role: "user",
          content:
            "Finance signed off this morning. The approved budget for the data-center refresh is $487,500. That's the hard ceiling.",
        },
        { role: "assistant", content: "Understood — approved ceiling of $487,500 for the data-center refresh." },
        ...chatterTurns(10, 12),
        // Dedup bait.
        { role: "user", content: "Side note, here's last quarter's raw usage log, unrelated to the budget:\n" + dup },
        { role: "assistant", content: "Received, unrelated to budget — noted." },
        { role: "user", content: "Same usage log again so it's not lost:\n" + dup },
        { role: "assistant", content: "Identical copy, noted." },
        { role: "user", content: "Pasting the identical usage log one final time:\n" + dup },
        { role: "assistant", content: "Third identical copy received." },
        ...chatterTurns(8, 4),
        // PINNED restatement near the end.
        {
          role: "user",
          content:
            "<!--ctxgov:pin--> BUDGET FACT: the approved data-center refresh budget is $487,500 (hard ceiling). Keep this exact.",
        },
        { role: "user", content: "What's the approved budget for the data-center refresh?" },
      ];
      return { messages, question: "What is the approved budget for the data-center refresh?" };
    },
    expected: "$487,500",
    grade(answer) {
      if (typeof answer !== "string") return false;
      const digits = answer.replace(/[^0-9]/g, "");
      return digits.includes("487500");
    },
    note: "Budget stated early and pinned near the end; usage log pasted 3x and chatter are irrelevant junk.",
  },

  // ───────────────────────────────────────────────────────────────────────
  // 6. Assigned static IP. Stated early, RESTATED in the final user turn.
  // ───────────────────────────────────────────────────────────────────────
  {
    id: "ldr-static-ip",
    category: "long-dialogue-recency",
    answerLocation: "recent",
    build() {
      const messages = [
        {
          role: "system",
          content: "You are a network-operations assistant. Answer with the exact address from the conversation.",
        },
        // EARLY statement.
        {
          role: "user",
          content:
            "We provisioned the new jump host. Its static IP is 10.42.7.118. All admin access goes through that box.",
        },
        { role: "assistant", content: "Noted — jump host static IP 10.42.7.118 for admin access." },
        ...chatterTurns(8, 6),
        // OLD tool results (elided beyond the most-recent 1).
        ...toolPair("call_1", "dump_routes", { vrf: "core" }, junkBlob("routes-core", 14)),
        ...toolPair("call_2", "dump_routes", { vrf: "edge" }, junkBlob("routes-edge", 14)),
        ...toolPair("call_3", "arp_table", { switch: "tor-12" }, junkBlob("arp", 14)),
        ...chatterTurns(12, 0),
        { role: "assistant", content: "All the network captures are loaded. Anything to confirm?" },
        // RECENT restatement in the final user turn.
        {
          role: "user",
          content:
            "Last thing — just to confirm, the jump host's static IP is 10.42.7.118, right? What's that IP again?",
        },
      ];
      return { messages, question: "What is the static IP of the new jump host?" };
    },
    expected: "10.42.7.118",
    grade(answer) {
      if (typeof answer !== "string") return false;
      return answer.includes("10.42.7.118");
    },
    note: "IP stated early and restated in the final user turn; route/ARP tool dumps and chatter are irrelevant and elided.",
  },

  // ───────────────────────────────────────────────────────────────────────
  // 7. Vendor support PIN. Stated early, PINNED near the end (mixed junk).
  // ───────────────────────────────────────────────────────────────────────
  {
    id: "ldr-vendor-support-pin",
    category: "long-dialogue-recency",
    answerLocation: "pinned",
    build() {
      const dup = dedupBlob();
      const messages = [
        {
          role: "system",
          content: "You are a vendor-management assistant. Answer with the exact code from the conversation.",
        },
        // EARLY statement.
        {
          role: "user",
          content:
            "Opened the priority case with the storage vendor. Our support PIN for the account is QX-3391. Quote it on every call.",
        },
        { role: "assistant", content: "Got it — vendor support PIN QX-3391 noted for the case." },
        ...chatterTurns(8, 13),
        // Mixed junk: an old tool result...
        ...toolPair("call_1", "vendor_case_history", { account: "stor-01" }, junkBlob("case-hist", 14)),
        ...toolPair("call_2", "vendor_case_history", { account: "stor-02" }, junkBlob("case-hist-2", 14)),
        // ...and dedup bait.
        { role: "user", content: "Here's the raw array health dump, unrelated to the PIN:\n" + dup },
        { role: "assistant", content: "Received the health dump." },
        { role: "user", content: "Same health dump again, just keeping it in view:\n" + dup },
        { role: "assistant", content: "Identical copy, noted." },
        { role: "user", content: "Final identical paste of the health dump:\n" + dup },
        { role: "assistant", content: "Third identical copy received." },
        ...chatterTurns(8, 2),
        // PINNED restatement near the end.
        {
          role: "user",
          content:
            "<!--ctxgov:pin--> KEEP THIS: storage vendor support PIN is QX-3391. Quote it on every call to the vendor.",
        },
        { role: "user", content: "What's our support PIN for the storage vendor account?" },
      ];
      return { messages, question: "What is the support PIN for the storage vendor account?" };
    },
    expected: "QX-3391",
    grade(answer) {
      if (typeof answer !== "string") return false;
      const a = answer.toLowerCase();
      return a.includes("qx-3391") || a.replace(/[^a-z0-9]/g, "").includes("qx3391");
    },
    note: "PIN stated early and pinned near the end; case-history tool dumps and thrice-pasted health dump are irrelevant junk.",
  },
];

export default tasks;
