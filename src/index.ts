// src/index.ts — public API barrel for the tokdiet package.
//
// Re-exports the stable surface: shared types, config/pricing helpers, the
// telemetry store, the proxy + dashboard servers, provider adapters/detection,
// the compaction & quality engines, the budget enforcer, the tokenizer, the
// event bus, the session tracker, and report rendering.

// ── Shared contracts ───────────────────────────────────────────────────────────
export type * from './types.js';

// ── Configuration ──────────────────────────────────────────────────────────────
export {
  DEFAULT_CONFIG,
  DEFAULT_CONTEXT_WINDOW,
  loadConfig,
  findConfigPath,
  normalizeConfig,
} from './config.js';
export type { LoadConfigOptions } from './config.js';

// ── Pricing ────────────────────────────────────────────────────────────────────
export { PricingImpl, loadPricingTable, bundledPricingPath } from './pricing.js';

// ── Telemetry store ────────────────────────────────────────────────────────────
export { openStore, SqliteStore } from './store.js';

// ── Proxy + dashboard ──────────────────────────────────────────────────────────
export { startProxy } from './proxy.js';
export type { StartProxyOptions, ProxyHandle } from './proxy.js';
export { startDashboard } from './dashboard.js';

// ── Provider adapters & detection ──────────────────────────────────────────────
export {
  AnthropicAdapter,
  OpenAIAdapter,
  GeminiAdapter,
  anthropic,
  openai,
  gemini,
  adapters,
  detectProvider,
} from './providers.js';

// ── Compaction ─────────────────────────────────────────────────────────────────
export {
  DefaultCompactor,
  PIN_SENTINEL,
  isPinnedText,
  applyElision,
  applyDedup,
  applyMidSummarize,
} from './compactor/index.js';

// ── Quality guard ──────────────────────────────────────────────────────────────
export { DefaultQualityGuard } from './quality/guard.js';
export { RollingAverage } from './quality/ledger.js';
export { heuristicDegradation, heuristicJudge, makeLlmJudge } from './quality/similarity.js';

// ── Budget enforcement ─────────────────────────────────────────────────────────
export { BudgetEnforcer, dayStart, monthStart } from './budget.js';
export type { BudgetDecision } from './budget.js';

// ── Tokenizer ──────────────────────────────────────────────────────────────────
export { DefaultTokenCounter, approxTokens, tokenCounter } from './tokenizer.js';

// ── Event bus ──────────────────────────────────────────────────────────────────
export { InProcessEventBus } from './events.js';

// ── Session identity ───────────────────────────────────────────────────────────
export { DefaultSessionTracker } from './session.js';

// ── Reporting ──────────────────────────────────────────────────────────────────
export {
  formatReport,
  renderTerminalReport,
  toCSV,
  formatMoney,
  formatDegradation,
} from './report.js';

// ── Plugin install ─────────────────────────────────────────────────────────────
export { installClaudePlugin } from './plugin/install.js';
export type { InstallResult } from './plugin/install.js';
