// bench/run.mjs — rigorous A/B quality+savings benchmark for Context Governor on real MiniMax-M3.
// For each task: run BASELINE (compaction off) and GOVERNED (compaction on) through the proxy,
// grade both objectively against the known answer, LLM-judge governed-vs-baseline equivalence,
// and measure real tokens/$ from the governor's own metering.
//
// Run:  MINIMAX_API_KEY=... node bench/run.mjs
import { startProxy, openStore, InProcessEventBus, PricingImpl, normalizeConfig, DEFAULT_CONFIG } from '../dist/index.js';
import { readdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const KEY = process.env.MINIMAX_API_KEY;
if (!KEY) { console.error('Set MINIMAX_API_KEY'); process.exit(1); }
const here = dirname(fileURLToPath(import.meta.url));
const MODEL = process.env.BENCH_MODEL || 'MiniMax-M3';
const REPEATS = Number(process.env.BENCH_REPEATS || '1'); // >1 = paranoid mode
process.env.CTXGOV_OPENAI_UPSTREAM = 'https://api.minimax.io';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stripThink = (s) => String(s).replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^\s+/, '').trim();

// ── load task bank ───────────────────────────────────────────────────────────
const taskDir = join(here, 'tasks');
const files = readdirSync(taskDir).filter((f) => f.endsWith('.mjs')).sort();
const tasks = [];
for (const f of files) {
  const mod = await import(pathToFileURL(join(taskDir, f)).href);
  for (const t of (mod.default || [])) tasks.push(t);
}
console.log(`Loaded ${tasks.length} tasks from ${files.length} files: ${files.join(', ')}`);
if (!tasks.length) { console.error('No tasks found — is the authoring workflow done?'); process.exit(1); }

// ── two governors: governed (compaction ON) and baseline (compaction OFF) ──────
function makeGov(compactionEnabled) {
  const dataDir = mkdtempSync(join(tmpdir(), 'ctxgov-bench-'));
  const store = openStore(dataDir);
  const bus = new InProcessEventBus();
  const pricing = PricingImpl.load();
  const config = normalizeConfig({
    ...DEFAULT_CONFIG,
    proxyPort: 0,
    dashboardEnabled: false,
    dataDir,
    contextWindowTokens: 6000,
    contextUtilizationThreshold: 0.5,
    compaction: { ...DEFAULT_CONFIG.compaction, enabled: compactionEnabled, keepRecentToolResults: 1, minToolResultTokens: 200, strategies: { elision: true, dedup: true, midSummarize: false } },
    shadowEval: { ...DEFAULT_CONFIG.shadowEval, enabled: false, sampleRate: 0 },
    budgets: { perSessionUSD: null, perDayUSD: null, perRepoMonthlyUSD: null },
  });
  const proxy = startProxy({ config, store, bus, pricing });
  return { proxy, store, dataDir };
}
const governed = makeGov(true);
const baseline = makeGov(false);
const gPort = await governed.proxy.whenReady;
const bPort = await baseline.proxy.whenReady;
console.log(`governed proxy :${gPort} (compaction ON) | baseline proxy :${bPort} (compaction OFF) | model ${MODEL}\n`);

async function ask(port, messages) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}`, 'user-agent': 'ctxgov-bench/1.0' },
      body: JSON.stringify({ model: MODEL, messages, stream: false }),
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch {}
    return { status: res.status, answer: stripThink(json?.choices?.[0]?.message?.content ?? ''), usage: json?.usage ?? {}, raw: text };
  } catch (e) { return { status: 0, answer: '', usage: {}, raw: String(e.message) }; }
}

async function judge(question, baseAns, govAns) {
  if (!baseAns || !govAns) return { equivalent: null, similarity: null };
  const messages = [{ role: 'user', content:
    `You are grading two AI answers to the SAME question for equivalence of MEANING and CORRECTNESS (ignore wording/length).\n` +
    `QUESTION: """${question}"""\n\nANSWER_A (reference): """${baseAns.slice(0, 1500)}"""\n\nANSWER_B (test): """${govAns.slice(0, 1500)}"""\n\n` +
    `Reply with STRICT JSON only: {"equivalent": true|false, "similarity": <0-100 integer>}` }];
  const r = await ask(bPort, messages);
  try { const o = JSON.parse(r.answer.match(/\{[\s\S]*\}/)[0]); return { equivalent: !!o.equivalent, similarity: Number(o.similarity) || 0 }; }
  catch { return { equivalent: null, similarity: null }; }
}

// ── run ────────────────────────────────────────────────────────────────────
const rows = [];
let i = 0;
for (const t of tasks) {
  i++;
  for (let rep = 1; rep <= REPEATS; rep++) {
    let built; try { built = t.build(); } catch (e) { console.log(`  ${t.id}: build() threw: ${e.message}`); continue; }
    const msgs = built.messages;
    const question = built.question || t.expected || '';
    const [b, g] = await Promise.all([ask(bPort, msgs), ask(gPort, msgs)]);
    await sleep(60);
    const bRec = baseline.store.recentRequests(1)[0] || {};
    const gRec = governed.store.recentRequests(1)[0] || {};
    let gradeB = null, gradeG = null;
    if (b.status === 200) { try { gradeB = !!t.grade(b.answer); } catch {} }
    if (g.status === 200) { try { gradeG = !!t.grade(g.answer); } catch {} }
    const j = await judge(question, b.answer, g.answer);
    const row = {
      id: t.id + (REPEATS > 1 ? `#${rep}` : ''), category: t.category, answerLocation: t.answerLocation,
      statusB: b.status, statusG: g.status, gradeB, gradeG,
      inB: bRec.inputTokens ?? null, inG: gRec.inputTokens ?? null,
      outB: bRec.outputTokens ?? null, outG: gRec.outputTokens ?? null,
      costB: bRec.costUSD ?? 0, costG: gRec.costUSD ?? 0,
      savedTok: gRec.tokensSaved ?? 0, compacted: !!gRec.compacted, strategies: gRec.strategies || '',
      judgeEq: j.equivalent, judgeSim: j.similarity,
      expected: t.expected, ansB: b.answer.slice(0, 140), ansG: g.answer.slice(0, 140),
    };
    rows.push(row);
    const mark = (v) => v === true ? '✓' : v === false ? '✗' : '?';
    console.log(`  [${String(i).padStart(2)}] ${row.id.padEnd(24)} ${t.category.padEnd(16)} B=${mark(gradeB)} G=${mark(gradeG)} | in ${row.inB}→${row.inG} comp=${row.compacted?'Y':'n'} judge=${mark(j.equivalent)}(${j.judgeSim ?? j.similarity ?? '-'})`);
  }
}

// ── aggregate ────────────────────────────────────────────────────────────────
const ok = rows.filter((r) => r.statusB === 200 && r.statusG === 200);
const sum = (a, f) => a.reduce((s, r) => s + (Number(f(r)) || 0), 0);
const accB = ok.filter((r) => r.gradeB).length;
const accG = ok.filter((r) => r.gradeG).length;
const totInB = sum(ok, (r) => r.inB), totInG = sum(ok, (r) => r.inG);
const totCostB = sum(ok, (r) => r.costB), totCostG = sum(ok, (r) => r.costG);
const compacted = ok.filter((r) => r.compacted).length;
const judged = ok.filter((r) => r.judgeEq !== null);
const judgeEqv = judged.filter((r) => r.judgeEq).length;
const avgSim = judged.length ? sum(judged, (r) => r.judgeSim) / judged.length : null;
const pct = (n, d) => d ? (100 * n / d) : 0;

const byCat = {};
for (const r of ok) {
  const c = byCat[r.category] ||= { n: 0, accB: 0, accG: 0, inB: 0, inG: 0, comp: 0 };
  c.n++; if (r.gradeB) c.accB++; if (r.gradeG) c.accG++; c.inB += r.inB || 0; c.inG += r.inG || 0; if (r.compacted) c.comp++;
}

const line = '─'.repeat(78);
console.log(`\n${line}\n  CONTEXT GOVERNOR — A/B BENCHMARK   (model ${MODEL}, ${ok.length}/${rows.length} runs OK)\n${line}`);
console.log(`  QUALITY (objective grading vs known answers)`);
console.log(`    baseline (no compaction) accuracy : ${accB}/${ok.length}  (${pct(accB, ok.length).toFixed(1)}%)`);
console.log(`    governed (compaction on) accuracy : ${accG}/${ok.length}  (${pct(accG, ok.length).toFixed(1)}%)`);
console.log(`    accuracy delta                    : ${(pct(accG, ok.length) - pct(accB, ok.length)).toFixed(1)} pts`);
console.log(`  QUALITY (LLM-judge, governed vs baseline)`);
console.log(`    judged equivalent                 : ${judgeEqv}/${judged.length}  (${pct(judgeEqv, judged.length).toFixed(1)}%)`);
console.log(`    avg semantic similarity           : ${avgSim === null ? 'n/a' : avgSim.toFixed(1) + '%'}`);
console.log(`  SAVINGS (real metered tokens/$)`);
console.log(`    compaction fired                  : ${compacted}/${ok.length} runs`);
console.log(`    input tokens  baseline → governed : ${totInB.toLocaleString()} → ${totInG.toLocaleString()}   (-${pct(totInB - totInG, totInB).toFixed(1)}%)`);
console.log(`    input cost    baseline → governed : $${totCostB.toFixed(5)} → $${totCostG.toFixed(5)}   (-$${(totCostB - totCostG).toFixed(5)})`);
console.log(`${line}\n  BY CATEGORY`);
for (const [c, v] of Object.entries(byCat)) {
  console.log(`    ${c.padEnd(16)} acc ${v.accB}/${v.n}→${v.accG}/${v.n}  in -${pct(v.inB - v.inG, v.inB).toFixed(0)}%  comp ${v.comp}/${v.n}`);
}
console.log(`${line}`);
const regressions = ok.filter((r) => r.gradeB && !r.gradeG);
if (regressions.length) {
  console.log(`  ⚠ QUALITY REGRESSIONS (baseline right, governed wrong) — ${regressions.length}:`);
  for (const r of regressions) console.log(`    - ${r.id} [${r.category}/${r.answerLocation}] expected="${r.expected}" governed="${r.ansG}"`);
} else {
  console.log(`  ✓ NO quality regressions: every task the baseline got right, the governed run also got right.`);
}
console.log(`  HEADLINE: tokens -${pct(totInB - totInG, totInB).toFixed(0)}% / accuracy ${pct(accB, ok.length).toFixed(0)}%→${pct(accG, ok.length).toFixed(0)}% / judge-equivalent ${pct(judgeEqv, judged.length).toFixed(0)}%\n${line}`);

// Repeats: per-task MAJORITY vote denoises M3 nondeterminism (a task counts
// correct if >= half its runs were correct). This is the publishable quality metric.
let majSummary = null;
if (REPEATS > 1) {
  const byTask = new Map();
  for (const r of ok) {
    const base = r.id.replace(/#\d+$/, '');
    const e = byTask.get(base) || { cat: r.category, b: [], g: [] };
    e.b.push(r.gradeB === true);
    e.g.push(r.gradeG === true);
    byTask.set(base, e);
  }
  const maj = (arr) => arr.filter(Boolean).length * 2 >= arr.length;
  let tasks = 0, mB = 0, mG = 0;
  const flips = [];
  for (const [id, e] of byTask) {
    tasks++;
    const b = maj(e.b), g = maj(e.g);
    if (b) mB++; if (g) mG++;
    if (b && !g) flips.push(`${id} [${e.cat}]`);
  }
  majSummary = { tasks, baselineMajority: mB, governedMajority: mG, regressions: flips };
  console.log(`${line}\n  MAJORITY VOTE over ${REPEATS} repeats (${tasks} tasks)`);
  console.log(`    baseline majority-correct : ${mB}/${tasks}  (${pct(mB, tasks).toFixed(1)}%)`);
  console.log(`    governed majority-correct : ${mG}/${tasks}  (${pct(mG, tasks).toFixed(1)}%)`);
  console.log(`    majority accuracy delta   : ${(pct(mG, tasks) - pct(mB, tasks)).toFixed(1)} pts`);
  console.log(`    persistent regressions    : ${flips.length ? flips.join(', ') : 'none'}`);
  console.log(line);
}

writeFileSync(join(here, 'results.json'), JSON.stringify({
  majoritySummary: majSummary,
  model: MODEL, runs: rows.length, ok: ok.length,
  accuracyBaseline: accB, accuracyGoverned: accG,
  judgeEquivalent: judgeEqv, judged: judged.length, avgSimilarity: avgSim,
  inputTokensBaseline: totInB, inputTokensGoverned: totInG,
  costBaseline: totCostB, costGoverned: totCostG, compactedRuns: compacted,
  byCategory: byCat, regressions, rows,
}, null, 2));
console.log(`results.json written to ${join(here, 'results.json')}`);

await governed.proxy.close(); await baseline.proxy.close();
governed.store.close(); baseline.store.close();
rmSync(governed.dataDir, { recursive: true, force: true });
rmSync(baseline.dataDir, { recursive: true, force: true });
console.log('cleaned up.');
