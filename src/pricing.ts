// src/pricing.ts — load pricing.json and compute USD cost. Prices are per 1e6 tokens.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Pricing, PricingTable, ModelPrice, ProviderId, UsageCounts, CostBreakdown } from './types.js';

const PER_MILLION = 1_000_000;

/** Locate the bundled pricing.json — works from both dist/ and src/ (one level under package root). */
export function bundledPricingPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '..', 'pricing.json'),       // dist/pricing.js -> ../pricing.json ; src/pricing.ts -> ../pricing.json
    join(here, 'pricing.json'),
    join(process.cwd(), 'pricing.json'),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return candidates[0];
}

export function loadPricingTable(path?: string): PricingTable {
  const p = path ?? bundledPricingPath();
  const raw = JSON.parse(readFileSync(p, 'utf8')) as PricingTable;
  if (!raw.models) throw new Error(`Invalid pricing table at ${p}: missing "models"`);
  return raw;
}

export class PricingImpl implements Pricing {
  readonly version: string;
  private readonly table: PricingTable;

  constructor(table: PricingTable) {
    this.table = table;
    this.version = table.version ?? 'unknown';
  }

  static load(path?: string): PricingImpl {
    return new PricingImpl(loadPricingTable(path));
  }

  priceFor(provider: ProviderId, model: string | undefined): ModelPrice | undefined {
    if (!model) return undefined;
    const byModel = this.table.models[provider];
    if (!byModel) return undefined;
    // Exact match.
    if (byModel[model]) return byModel[model];
    // Longest-prefix match (e.g. "claude-opus-4-8-20260101" -> "claude-opus-4").
    let best: { key: string; price: ModelPrice } | undefined;
    for (const [key, price] of Object.entries(byModel)) {
      if (model.startsWith(key) && (!best || key.length > best.key.length)) {
        best = { key, price };
      }
    }
    return best?.price;
  }

  cost(provider: ProviderId, model: string | undefined, usage: UsageCounts): CostBreakdown {
    const price = this.priceFor(provider, model);
    const zero: CostBreakdown = { inputUSD: 0, outputUSD: 0, cacheReadUSD: 0, cacheWriteUSD: 0, totalUSD: 0 };
    if (!price) return zero;
    const inputUSD = (usage.inputTokens / PER_MILLION) * price.input;
    const outputUSD = (usage.outputTokens / PER_MILLION) * price.output;
    const cacheReadUSD = ((usage.cacheReadTokens ?? 0) / PER_MILLION) * (price.cacheRead ?? price.input);
    const cacheWriteUSD = ((usage.cacheWriteTokens ?? 0) / PER_MILLION) * (price.cacheWrite ?? price.input);
    const totalUSD = inputUSD + outputUSD + cacheReadUSD + cacheWriteUSD;
    return { inputUSD, outputUSD, cacheReadUSD, cacheWriteUSD, totalUSD };
  }
}
