// Offline sanity check of the task bank — NO API calls.
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const taskDir = join(here, 'tasks');
const files = readdirSync(taskDir).filter((f) => f.endsWith('.mjs')).sort();
const approx = (s) => Math.ceil(String(s).length / 4);

let total = 0, bad = 0;
for (const f of files) {
  const mod = await import(pathToFileURL(join(taskDir, f)).href);
  const arr = mod.default || [];
  for (const t of arr) {
    total++;
    const issues = [];
    let built;
    try { built = t.build(); } catch (e) { issues.push(`build() threw: ${e.message}`); }
    let toks = 0;
    if (built) {
      if (!Array.isArray(built.messages)) issues.push('messages not array');
      else toks = approx(JSON.stringify(built.messages));
      if (!built.question) issues.push('no question');
    }
    // grader must accept the expected answer and reject empty
    try { if (t.grade(String(t.expected)) !== true) issues.push('grade(expected)!=true'); } catch (e) { issues.push('grade(expected) threw'); }
    try { if (t.grade('') === true) issues.push('grade("")==true (too loose)'); } catch {}
    if (toks < 3000) issues.push(`only ~${toks} tok (compaction may not fire)`);
    if (issues.length) bad++;
    console.log(`${issues.length ? '✗' : '✓'} ${t.id.padEnd(26)} ${String(t.category).padEnd(16)} ~${String(toks).padStart(6)}tok  ${issues.join('; ')}`);
  }
}
console.log(`\n${total} tasks, ${bad} with issues.`);
process.exit(bad ? 1 : 0);
