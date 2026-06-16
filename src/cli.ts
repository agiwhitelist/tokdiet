#!/usr/bin/env node
// src/cli.ts — tokdiet command-line interface (commander).
//
// Commands:
//   start                 launch the proxy (+ optional dashboard)
//   report                print or export usage telemetry
//   init                  scaffold a tokdiet.config.json from the example
//   install-claude-plugin install the Claude Code metering hook
import { readFileSync, existsSync, copyFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { Command } from 'commander';
import { loadConfig } from './config.js';
import { openStore } from './store.js';
import { InProcessEventBus } from './events.js';
import { PricingImpl } from './pricing.js';
import { startProxy } from './proxy.js';
import { startDashboard } from './dashboard.js';
import { renderTerminalReport, toCSV } from './report.js';
import { installClaudePlugin } from './plugin/install.js';
import type { GovernorConfig } from './types.js';

/** Resolve this module's directory (works in both src/ and dist/). */
function moduleDir(): string {
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
}

/** Read the package version, tolerating a missing/malformed package.json. */
function readVersion(): string {
  const here = moduleDir();
  const candidates = [
    join(here, '..', 'package.json'), // dist/cli.js -> ../package.json
    join(here, '..', '..', 'package.json'),
    join(process.cwd(), 'package.json'),
  ];
  for (const c of candidates) {
    try {
      if (!existsSync(c)) continue;
      const pkg = JSON.parse(readFileSync(c, 'utf8')) as { name?: string; version?: string };
      if (pkg && typeof pkg.version === 'string' && pkg.name === 'tokdiet') return pkg.version;
      if (pkg && typeof pkg.version === 'string') return pkg.version;
    } catch {
      // try next candidate
    }
  }
  return '0.0.0';
}

/** Locate the bundled tokdiet.config.example.json. */
function exampleConfigPath(): string {
  const here = moduleDir();
  const candidates = [
    join(here, '..', 'tokdiet.config.example.json'), // dist/cli.js -> ../tokdiet.config.example.json
    join(here, '..', '..', 'tokdiet.config.example.json'),
    join(process.cwd(), 'tokdiet.config.example.json'),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return candidates[0];
}

/** Parse a positive integer flag value, returning undefined when invalid. */
function parseIntOpt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

const program = new Command();
program
  .name('tokdiet')
  .description('Local proxy that meters tokens & cost for AI agents, compacts context, and proves quality.')
  .version(readVersion());

// ── start ────────────────────────────────────────────────────────────────────
program
  .command('start')
  .description('Start the metering/compaction proxy (and live dashboard).')
  .option('--port <n>', 'proxy port override')
  .option('--dashboard-port <n>', 'dashboard port override')
  .option('--no-dashboard', 'disable the live dashboard')
  .option('--config <path>', 'path to tokdiet.config.json')
  .action((opts: { port?: string; dashboardPort?: string; dashboard?: boolean; config?: string }) => {
    const overrides: Partial<GovernorConfig> = {};
    const port = parseIntOpt(opts.port);
    if (port !== undefined) overrides.proxyPort = port;
    const dashPort = parseIntOpt(opts.dashboardPort);
    if (dashPort !== undefined) overrides.dashboardPort = dashPort;
    // commander sets `dashboard:false` for --no-dashboard.
    if (opts.dashboard === false) overrides.dashboardEnabled = false;

    const config = loadConfig({ configPath: opts.config, overrides });

    const store = openStore(config.dataDir);
    const bus = new InProcessEventBus();
    const pricing = PricingImpl.load(config.pricingPath ?? undefined);

    const proxy = startProxy({ config, store, bus, pricing });
    const dashboard = config.dashboardEnabled
      ? startDashboard({ port: config.dashboardPort, store, bus })
      : undefined;

    printBanner(config, proxy.port);

    let closing = false;
    const shutdown = (signal: string): void => {
      if (closing) return;
      closing = true;
      process.stdout.write(`\nReceived ${signal}, shutting down tokdiet...\n`);
      try {
        dashboard?.close();
      } catch {
        /* ignore */
      }
      void Promise.resolve(proxy.close())
        .catch(() => undefined)
        .finally(() => {
          try {
            store.close();
          } catch {
            /* ignore */
          }
          process.exit(0);
        });
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  });

// ── report ─────────────────────────────────────────────────────────────────────
program
  .command('report')
  .description('Print a usage report, or export it as JSON / CSV.')
  .option('--since <days>', 'only include the last N days')
  .option('--json', 'print the raw summary as JSON')
  .option('--csv <file>', 'write recent requests to a CSV file')
  .option('--config <path>', 'path to tokdiet.config.json')
  .action((opts: { since?: string; json?: boolean; csv?: string; config?: string }) => {
    const config = loadConfig({ configPath: opts.config });
    const store = openStore(config.dataDir);
    try {
      const since = computeSince(opts.since);

      if (opts.csv) {
        const rows = store.recentRequests(100000);
        const csv = toCSV(rows);
        const out = resolve(process.cwd(), opts.csv);
        writeFileSync(out, csv, 'utf8');
        process.stdout.write(`Wrote ${rows.length} rows to ${out}\n`);
        return;
      }

      if (opts.json) {
        const summary = store.summary(since !== undefined ? { since } : undefined);
        process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
        return;
      }

      const color = process.stdout.isTTY === true;
      const reportOpts: { since?: number; color?: boolean } = { color };
      if (since !== undefined) reportOpts.since = since;
      process.stdout.write(renderTerminalReport(store, reportOpts) + '\n');
    } finally {
      store.close();
    }
  });

// ── init ─────────────────────────────────────────────────────────────────────
program
  .command('init')
  .description('Create tokdiet.config.json in the current directory from the example.')
  .option('--force', 'overwrite an existing tokdiet.config.json')
  .action((opts: { force?: boolean }) => {
    const dest = resolve(process.cwd(), 'tokdiet.config.json');
    if (existsSync(dest) && !opts.force) {
      process.stderr.write(
        `Refusing to overwrite existing ${dest}. Re-run with --force to replace it.\n`,
      );
      process.exitCode = 1;
      return;
    }
    const src = exampleConfigPath();
    try {
      copyFileSync(src, dest);
      process.stdout.write(`Wrote ${dest}\n`);
    } catch (err) {
      process.stderr.write(`Failed to write config: ${(err as Error).message}\n`);
      process.exitCode = 1;
    }
  });

// ── install-claude-plugin ──────────────────────────────────────────────────────
program
  .command('install-claude-plugin')
  .description('Install the tokdiet metering hook into Claude Code settings.')
  .option('--settings <path>', 'path to a Claude Code settings.json')
  .action((opts: { settings?: string }) => {
    const result = installClaudePlugin(opts.settings ? { settingsPath: opts.settings } : {});
    process.stdout.write(result.message + '\n');
  });

/** Convert a `--since <days>` string to an epoch-ms cutoff (undefined when absent/invalid). */
function computeSince(daysRaw: string | undefined): number | undefined {
  if (daysRaw === undefined) return undefined;
  const days = Number.parseFloat(daysRaw);
  if (!Number.isFinite(days) || days <= 0) return undefined;
  return Date.now() - days * 86_400_000;
}

/** Print the startup banner with proxy/dashboard URLs and the env exports to set. */
function printBanner(config: GovernorConfig, proxyPort: number): void {
  const proxyUrl = `http://localhost:${proxyPort}`;
  const lines: string[] = [];
  lines.push('');
  lines.push('  tokdiet is running.');
  lines.push('  ccusage that shrinks the bill — without losing quality.');
  lines.push('');
  lines.push(`  Proxy:     ${proxyUrl}`);
  if (config.dashboardEnabled) {
    lines.push(`  Dashboard: http://localhost:${config.dashboardPort}`);
  } else {
    lines.push('  Dashboard: disabled');
  }
  lines.push('');
  lines.push('  Point your agent at the proxy by exporting:');
  lines.push(`    export ANTHROPIC_BASE_URL=${proxyUrl}`);
  lines.push(`    export OPENAI_BASE_URL=${proxyUrl}/v1`);
  lines.push('');
  lines.push('  Press Ctrl+C to stop.');
  lines.push('');
  process.stdout.write(lines.join('\n') + '\n');
}

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`tokdiet: ${(err as Error).message}\n`);
  process.exit(1);
});
