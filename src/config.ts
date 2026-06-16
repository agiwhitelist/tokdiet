// src/config.ts — load, validate, and merge tokdiet.config.json over defaults.
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, isAbsolute, resolve } from 'node:path';
import type { GovernorConfig } from './types.js';

export const DEFAULT_CONFIG: GovernorConfig = {
  proxyPort: 7787,
  dashboardPort: 7878,
  dashboardEnabled: true,
  contextWindowTokens: 'auto',
  contextUtilizationThreshold: 0.7,
  onBudgetExceeded: 'warn',
  budgets: {
    perSessionUSD: 5.0,
    perDayUSD: 50.0,
    perRepoMonthlyUSD: 400.0,
  },
  compaction: {
    enabled: true,
    strategies: { elision: true, dedup: true, midSummarize: false },
    keepRecentToolResults: 4,
    minToolResultTokens: 500,
    elisionPreviewChars: 240,
    elisionSalientLines: 12,
    relevanceProtect: true,
    recoverable: true,
    protectCachedPrefix: true,
    semanticDedup: true,
  },
  qualityBudget: { maxDegradationPct: 2.0 },
  shadowEval: {
    enabled: true,
    sampleRate: 0.05,
    judge: 'heuristic',
    judgeModel: 'claude-haiku-4',
  },
  safeMode: true,
  pageFault: { enabled: true, maxReinjections: 1 },
  dataDir: join(homedir(), '.tokdiet'),
  pricingPath: null,
};

/** Default window sizes per provider for utilization math when contextWindowTokens === 'auto'. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep-merge `override` onto `base` (objects merge, scalars/arrays replace). */
function deepMerge<T>(base: T, override: unknown): T {
  if (!isObject(base) || !isObject(override)) return (override ?? base) as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(override)) {
    // Defense-in-depth: never let a config key set a surprising prototype.
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    const b = (base as Record<string, unknown>)[k];
    out[k] = isObject(b) && isObject(v) ? deepMerge(b, v) : v;
  }
  return out as T;
}

export interface LoadConfigOptions {
  /** Explicit config path; otherwise searches cwd for tokdiet.config.json. */
  configPath?: string;
  cwd?: string;
  /** Inline overrides (e.g. from CLI flags), applied last. */
  overrides?: Partial<GovernorConfig>;
}

export function findConfigPath(cwd = process.cwd()): string | null {
  const p = join(cwd, 'tokdiet.config.json');
  if (existsSync(p)) return p;
  // Back-compat: fall back to the legacy filename if present.
  const legacy = join(cwd, 'governor.config.json');
  return existsSync(legacy) ? legacy : null;
}

export function loadConfig(opts: LoadConfigOptions = {}): GovernorConfig {
  const cwd = opts.cwd ?? process.cwd();
  const path = opts.configPath ?? findConfigPath(cwd) ?? undefined;
  let fileCfg: unknown = {};
  if (path && existsSync(path)) {
    try {
      fileCfg = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      throw new Error(`Failed to parse config at ${path}: ${(err as Error).message}`);
    }
  }
  let cfg = deepMerge(DEFAULT_CONFIG, fileCfg);
  if (opts.overrides) cfg = deepMerge(cfg, opts.overrides);
  return normalizeConfig(cfg, cwd);
}

export function normalizeConfig(cfg: GovernorConfig, cwd = process.cwd()): GovernorConfig {
  // Resolve dataDir to an absolute path.
  if (!isAbsolute(cfg.dataDir)) cfg.dataDir = resolve(cwd, cfg.dataDir);
  if (cfg.pricingPath && !isAbsolute(cfg.pricingPath)) {
    cfg.pricingPath = resolve(cwd, cfg.pricingPath);
  }
  // Clamp obviously invalid values.
  cfg.contextUtilizationThreshold = clamp(cfg.contextUtilizationThreshold, 0.1, 0.99);
  cfg.shadowEval.sampleRate = clamp(cfg.shadowEval.sampleRate, 0, 1);
  cfg.qualityBudget.maxDegradationPct = clamp(cfg.qualityBudget.maxDegradationPct, 0, 100);
  return cfg;
}

function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}
