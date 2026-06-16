// tests/plugin.test.ts — Claude Code plugin install integration.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installClaudePlugin } from '../src/plugin/install.js';

/** Walk a hooks matcher array and collect every command string. */
function commandsOf(matchers: unknown): string[] {
  if (!Array.isArray(matchers)) return [];
  const out: string[] = [];
  for (const m of matchers) {
    const hooks = (m as { hooks?: unknown }).hooks;
    if (!Array.isArray(hooks)) continue;
    for (const h of hooks) {
      const cmd = (h as { command?: unknown }).command;
      if (typeof cmd === 'string') out.push(cmd);
    }
  }
  return out;
}

describe('installClaudePlugin', () => {
  let dir: string;
  let settingsPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ctxgov-plugin-'));
    settingsPath = join(dir, 'settings.json');
  });

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('creates settings with PreToolUse + PostToolUse hooks referencing tool-meter', () => {
    const res = installClaudePlugin({ settingsPath });

    expect(res.settingsPath).toBe(settingsPath);
    expect(res.changed).toBe(true);
    expect(existsSync(settingsPath)).toBe(true);

    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      hooks?: { PreToolUse?: unknown; PostToolUse?: unknown };
    };
    expect(settings.hooks).toBeTruthy();

    const preCmds = commandsOf(settings.hooks?.PreToolUse);
    const postCmds = commandsOf(settings.hooks?.PostToolUse);

    expect(preCmds.some((c) => c.includes('tool-meter'))).toBe(true);
    expect(postCmds.some((c) => c.includes('tool-meter'))).toBe(true);
  });

  it('mentions ANTHROPIC_BASE_URL in the returned message', () => {
    const res = installClaudePlugin({ settingsPath });
    expect(res.message).toContain('ANTHROPIC_BASE_URL');
  });

  it('does not duplicate the hook entry when run twice', () => {
    installClaudePlugin({ settingsPath });
    const second = installClaudePlugin({ settingsPath });

    // Settings did not need re-registering; the hook is idempotent.
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      hooks?: { PreToolUse?: unknown; PostToolUse?: unknown };
    };

    const preMatches = commandsOf(settings.hooks?.PreToolUse).filter((c) => c.includes('tool-meter'));
    const postMatches = commandsOf(settings.hooks?.PostToolUse).filter((c) => c.includes('tool-meter'));

    expect(preMatches.length).toBe(1);
    expect(postMatches.length).toBe(1);
    // The second run reports no settings change for the hook registration.
    expect(second.message).toContain('already registered');
  });

  it('preserves unrelated settings when merging', () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({ theme: 'dark', model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } }, null, 2),
      'utf8',
    );

    installClaudePlugin({ settingsPath });

    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      theme?: string;
      model?: string;
      hooks?: { Stop?: unknown; PreToolUse?: unknown; PostToolUse?: unknown };
    };

    expect(settings.theme).toBe('dark');
    expect(settings.model).toBe('opus');
    // Pre-existing unrelated hook event survives.
    expect(commandsOf(settings.hooks?.Stop)).toContain('echo hi');
    // Our hooks were added.
    expect(commandsOf(settings.hooks?.PreToolUse).some((c) => c.includes('tool-meter'))).toBe(true);
    expect(commandsOf(settings.hooks?.PostToolUse).some((c) => c.includes('tool-meter'))).toBe(true);
  });

  it('writes the hook script under .context-governor/hooks', () => {
    const res = installClaudePlugin({ settingsPath });
    // The script path is reported indirectly via the message text.
    expect(res.message).toContain('tool-meter.mjs');
  });

  it('tolerates a malformed settings file by overwriting hooks safely', () => {
    writeFileSync(settingsPath, '{ this is not valid json', 'utf8');
    const res = installClaudePlugin({ settingsPath });
    expect(res.changed).toBe(true);
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      hooks?: { PreToolUse?: unknown };
    };
    expect(commandsOf(settings.hooks?.PreToolUse).some((c) => c.includes('tool-meter'))).toBe(true);
  });
});
