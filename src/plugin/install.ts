// src/plugin/install.ts — install the tokdiet metering hook into a
// Claude Code settings.json. Idempotent: re-running never duplicates entries.
//
// The hook is a no-op PreToolUse/PostToolUse hook that logs tool I/O sizes to
// ~/.tokdiet/tool-meter.log. We embed the hook script as a string
// constant (most robust across src/ vs dist/ layouts) and write it to
// ~/.tokdiet/hooks/tool-meter.mjs.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

/**
 * Embedded copy of src/plugin/hooks/tool-meter.mjs. Kept byte-for-byte in sync
 * with the on-disk reference file. Writing this out avoids any reliance on the
 * relative location of the .mjs file (which differs between src/ and dist/).
 */
const TOOL_METER_MJS = String.raw`#!/usr/bin/env node
// tool-meter.mjs — tokdiet Claude Code hook (PreToolUse / PostToolUse).
//
// A no-op metering hook: it reads the hook JSON payload from stdin, measures the
// UTF-8 byte size of the tool input/output, appends one JSONL record to
// ~/.tokdiet/tool-meter.log, then prints "{}" so Claude Code never
// blocks. It is intentionally dependency-free, defensive, and ALWAYS exits 0.

import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

/** Read all of stdin as a string; resolves '' if nothing arrives. */
function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve(data);
    };
    try {
      if (process.stdin.isTTY) {
        done();
        return;
      }
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        data += chunk;
      });
      process.stdin.on('end', done);
      process.stdin.on('error', done);
      setTimeout(done, 2000).unref?.();
    } catch {
      done();
    }
  });
}

/** UTF-8 byte length of an arbitrary value, serializing objects to JSON. */
function byteSize(value) {
  if (value === undefined || value === null) return 0;
  try {
    const s = typeof value === 'string' ? value : JSON.stringify(value);
    if (typeof s !== 'string') return 0;
    return Buffer.byteLength(s, 'utf8');
  } catch {
    return 0;
  }
}

async function main() {
  let raw = '';
  try {
    raw = await readStdin();
  } catch {
    raw = '';
  }

  let payload = {};
  if (raw && raw.trim().length > 0) {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = {};
    }
  }
  if (typeof payload !== 'object' || payload === null) payload = {};

  const toolName =
    payload.tool_name ?? payload.toolName ?? payload.tool ?? 'unknown';
  const event =
    payload.hook_event_name ?? payload.hookEventName ?? payload.event ?? 'unknown';
  const sessionId = payload.session_id ?? payload.sessionId ?? '';
  const toolInput = payload.tool_input ?? payload.toolInput ?? payload.input;
  const toolOutput =
    payload.tool_response ?? payload.toolResponse ?? payload.tool_output ?? payload.output;

  const record = {
    ts: Date.now(),
    event: String(event),
    tool: String(toolName),
    sessionId: String(sessionId),
    inputBytes: byteSize(toolInput),
    outputBytes: byteSize(toolOutput),
  };

  try {
    const logPath = join(homedir(), '.tokdiet', 'tool-meter.log');
    await mkdir(dirname(logPath), { recursive: true });
    await appendFile(logPath, JSON.stringify(record) + '\n', 'utf8');
  } catch {
    // best-effort
  }

  try {
    process.stdout.write('{}');
  } catch {
    // ignore
  }
}

main()
  .catch(() => {
    try {
      process.stdout.write('{}');
    } catch {
      // ignore
    }
  })
  .finally(() => {
    process.exit(0);
  });
`;

/** A single hook command spec as stored in Claude Code settings.json. */
interface HookCommand {
  type: 'command';
  command: string;
}

/** A hook matcher group: an optional matcher plus a list of hook commands. */
interface HookMatcher {
  matcher?: string;
  hooks: HookCommand[];
}

/** Marker substring used to detect (and de-duplicate) our hook command. */
const HOOK_MARKER = 'tool-meter.mjs';

/** Absolute path to the installed hook script under the data dir. */
function hookScriptPath(): string {
  return join(homedir(), '.tokdiet', 'hooks', 'tool-meter.mjs');
}

/** The exact command string Claude Code should run for our hook. */
function hookCommand(scriptPath: string): string {
  return `node "${scriptPath}"`;
}

/** Read and JSON-parse a file, returning `{}` on any error or absence. */
function readJsonSafe(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through to empty object on malformed JSON
  }
  return {};
}

/** Coerce an unknown settings node into an array of hook-matcher groups. */
function asMatcherArray(value: unknown): HookMatcher[] {
  if (!Array.isArray(value)) return [];
  const out: HookMatcher[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const hooks = Array.isArray(e.hooks) ? (e.hooks as unknown[]) : [];
    const cmds: HookCommand[] = [];
    for (const h of hooks) {
      if (typeof h === 'object' && h !== null) {
        const hc = h as Record<string, unknown>;
        if (typeof hc.command === 'string') {
          cmds.push({ type: 'command', command: hc.command });
        }
      }
    }
    const matcher = typeof e.matcher === 'string' ? e.matcher : undefined;
    out.push({ matcher, hooks: cmds });
  }
  return out;
}

/** True if any matcher group already contains our hook command. */
function hasOurHook(matchers: HookMatcher[]): boolean {
  return matchers.some((m) => m.hooks.some((h) => h.command.includes(HOOK_MARKER)));
}

/**
 * Ensure `matchers` contains our hook exactly once, returning a possibly-new
 * array and whether it was modified. We reuse an empty-matcher (matcher: '*')
 * group when one exists, otherwise append a new wildcard group.
 */
function ensureHook(
  matchers: HookMatcher[],
  command: string,
): { matchers: HookMatcher[]; changed: boolean } {
  if (hasOurHook(matchers)) return { matchers, changed: false };
  const cmd: HookCommand = { type: 'command', command };
  // Prefer attaching to an existing wildcard ('' or '*') matcher group.
  const wildcard = matchers.find((m) => m.matcher === undefined || m.matcher === '' || m.matcher === '*');
  if (wildcard) {
    wildcard.hooks.push(cmd);
  } else {
    matchers.push({ matcher: '*', hooks: [cmd] });
  }
  return { matchers, changed: true };
}

export interface InstallResult {
  settingsPath: string;
  changed: boolean;
  message: string;
}

/**
 * Install (or update) the tokdiet metering hook into Claude Code
 * settings. Writes the hook script to ~/.tokdiet/hooks/tool-meter.mjs
 * and registers PreToolUse + PostToolUse entries. Merges without clobbering
 * unrelated settings, and is safe to run repeatedly.
 */
export function installClaudePlugin(opts: { settingsPath?: string } = {}): InstallResult {
  const settingsPath = opts.settingsPath ?? join(homedir(), '.claude', 'settings.json');
  const scriptPath = hookScriptPath();
  const command = hookCommand(scriptPath);

  // 1) Write the hook script to disk (mkdir -p).
  let scriptWritten = false;
  try {
    mkdirSync(dirname(scriptPath), { recursive: true });
    const existing = existsSync(scriptPath) ? readFileSync(scriptPath, 'utf8') : null;
    if (existing !== TOOL_METER_MJS) {
      writeFileSync(scriptPath, TOOL_METER_MJS, 'utf8');
      scriptWritten = true;
    }
  } catch (err) {
    // If we cannot write the script, surface it but do not throw.
    return {
      settingsPath,
      changed: false,
      message: `Failed to write hook script to ${scriptPath}: ${(err as Error).message}`,
    };
  }

  // 2) Load and merge settings.
  const settings = readJsonSafe(settingsPath);
  const hooksRaw =
    typeof settings.hooks === 'object' && settings.hooks !== null && !Array.isArray(settings.hooks)
      ? (settings.hooks as Record<string, unknown>)
      : {};

  const pre = asMatcherArray(hooksRaw.PreToolUse);
  const post = asMatcherArray(hooksRaw.PostToolUse);

  const preRes = ensureHook(pre, command);
  const postRes = ensureHook(post, command);

  const settingsChanged = preRes.changed || postRes.changed;

  if (settingsChanged) {
    const nextHooks: Record<string, unknown> = { ...hooksRaw };
    nextHooks.PreToolUse = preRes.matchers;
    nextHooks.PostToolUse = postRes.matchers;
    const next: Record<string, unknown> = { ...settings, hooks: nextHooks };
    try {
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(settingsPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
    } catch (err) {
      return {
        settingsPath,
        changed: false,
        message: `Failed to write settings to ${settingsPath}: ${(err as Error).message}`,
      };
    }
  }

  const changed = settingsChanged || scriptWritten;
  const message = buildMessage({
    settingsPath,
    scriptPath,
    settingsChanged,
    scriptWritten,
  });

  return { settingsPath, changed, message };
}

/** Compose a human-readable summary of what the installer did. */
function buildMessage(args: {
  settingsPath: string;
  scriptPath: string;
  settingsChanged: boolean;
  scriptWritten: boolean;
}): string {
  const lines: string[] = [];
  if (args.scriptWritten) {
    lines.push(`Wrote metering hook to ${args.scriptPath}.`);
  } else {
    lines.push(`Metering hook already up to date at ${args.scriptPath}.`);
  }
  if (args.settingsChanged) {
    lines.push(`Registered PreToolUse + PostToolUse hooks in ${args.settingsPath}.`);
  } else {
    lines.push(`Claude Code hooks already registered in ${args.settingsPath} (no changes).`);
  }
  lines.push(
    'Reminder: to route traffic through the proxy, set ANTHROPIC_BASE_URL to the tokdiet proxy URL (e.g. http://127.0.0.1:7787) before launching Claude Code.',
  );
  return lines.join('\n');
}
