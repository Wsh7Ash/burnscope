/**
 * burnscope — SLO burn-rate and error-budget explorer.
 *
 * Public API. Import the pieces you need, or use `analyze()` for the whole
 * pipeline in one call.
 */

export { VERSION } from './version.js';
export { BurnscopeError, ParseError, SpecError, UsageError } from './errors.js';

export type {
  AlertEvaluation,
  AlertProfile,
  AlertRule,
  Analysis,
  BudgetState,
  BudgetStatus,
  DataQualityNote,
  IntervalRate,
  MetricsDocument,
  Sample,
  Selector,
  Severity,
  SkippedLine,
  SloResult,
  SloSeries,
  SloSpec,
  Series,
  WindowRate,
} from './types.js';

export { parsePrometheus, parseLabels } from './parse/prometheus.js';
export { parseTabular, parseTimestamp, splitCsvLine } from './parse/tabular.js';
export type { TabularDocument, TabularFormat } from './parse/tabular.js';

export { parseSpec, parseSpecValue, parseDuration } from './spec.js';
export type { SpecFile } from './spec.js';

export {
  DEFAULT_MIN_COVERAGE,
  counterDelta,
  increase,
  intervalRates,
  windowRate,
} from './series.js';
export type { Increase, IncreaseOptions, WindowRateInput } from './series.js';

export { AT_RISK_REMAINING, budgetState, budgetStateLabel, budgetStatus } from './budget.js';
export type { BudgetInput } from './budget.js';

export {
  ALERT_PROFILES,
  GOOGLE_SRE_PROFILE,
  evaluateAlerts,
  expectedConsumed,
  getProfile,
} from './mwmb.js';
export type { EvaluateInput } from './mwmb.js';

export { collectSloSeries, compileMatcher, matchLabels, mergeCounters } from './select.js';

export { analyze } from './scope.js';
export type { AnalyzeInput } from './scope.js';

export { renderText } from './report/text.js';
export { renderMarkdown } from './report/markdown.js';
export { renderJson } from './report/json.js';
export { decimate, escapeHtml, renderHtml } from './report/html.js';

export {
  clamp01 as clampFraction,
  formatBurn,
  formatCount,
  formatDate,
  formatDuration,
  formatErrorRate,
  formatPercent,
  formatTimestamp,
  formatWindow,
} from './format.js';
