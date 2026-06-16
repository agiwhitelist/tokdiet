#!/usr/bin/env node
// tool-meter.mjs — tokdiet Claude Code plugin hook (PreToolUse / PostToolUse).
//
// This is the copy shipped INSIDE the tokdiet Claude Code plugin. It is kept in
// sync with the reference implementation at src/plugin/hooks/tool-meter.mjs.
// The plugin manifest (.claude-plugin/plugin.json) references this file via
// "${CLAUDE_PLUGIN_ROOT}/hooks/tool-meter.mjs" for both PreToolUse and
// PostToolUse events.
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
      // If stdin is a TTY (run interactively), there is no payload to read.
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
      // Safety valve: never hang the agent waiting on stdin.
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

  // Claude Code hook payloads vary by event; pull fields defensively.
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
    // Logging is best-effort; swallow all errors so we never block the tool.
  }

  // Emit an empty object so Claude Code treats this as a non-blocking no-op.
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
