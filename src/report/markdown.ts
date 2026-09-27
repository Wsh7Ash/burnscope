import { budgetStateLabel } from '../budget.js';
import {
  formatBurn,
  formatDate,
  formatDuration,
  formatErrorRate,
  formatPercent,
  formatTimestamp,
  formatWindow,
} from '../format.js';
import type { AlertEvaluation, Analysis, SloResult } from '../types.js';

function alertStatus(alert: AlertEvaluation): string {
  if (alert.firing) return '**FIRING**';
  if (!alert.evaluated) return 'not evaluated';
  return 'clear';
}

function alertRow(alert: AlertEvaluation): string {
  const rule = alert.rule;
  return [
    `| \`${rule.id}\``,
    rule.severity,
    formatWindow(rule.longWindowSeconds),
    formatWindow(rule.shortWindowSeconds),
    `${rule.burnRate}x`,
    formatBurn(alert.long.burnRate),
    formatBurn(alert.short.burnRate),
    alertStatus(alert),
  ].join(' | ');
}

/** Markdown report, suitable for a PR comment or a run artifact. */
export function renderMarkdown(analysis: Analysis): string {
  const lines: string[] = [];
  lines.push('# Burnscope report');
  lines.push('');
  lines.push(
    `Analyzed at **${formatTimestamp(analysis.asOf)}** · alert profile **${analysis.profile.name}** ` +
      `(\`${analysis.profile.id}\`) · minimum window coverage ${formatPercent(analysis.minCoverage, 0)}`,
  );
  lines.push('');

  lines.push('## Summary');
  lines.push('');
  lines.push('| SLO | Objective | Burn rate | Budget used | Remaining | State | Firing |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const slo of analysis.slos) {
    lines.push(
      `| \`${slo.spec.name}\` | ${formatPercent(slo.spec.objective, 2)} | ` +
        `${slo.period.sufficient ? formatBurn(slo.period.burnRate) : 'n/a'} | ` +
        `${formatPercent(slo.budget.consumed)} | ${formatPercent(slo.budget.remaining)} | ` +
        `**${budgetStateLabel(slo.budget.state)}** | ${slo.firing.length}/${slo.alerts.length} |`,
    );
  }
  lines.push('');

  for (const slo of analysis.slos) {
    lines.push(...sloSection(slo));
  }

  if (analysis.dataQuality.length > 0) {
    lines.push('## Input data quality');
    lines.push('');
    const unique = dedupe(analysis.dataQuality.map((note) => `${note.scope}: ${note.message}`));
    for (const note of unique) lines.push(`- ${note}`);
    lines.push('');
  }

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

function sloSection(slo: SloResult): string[] {
  const lines: string[] = [];
  const budget = slo.budget;

  lines.push(`## \`${slo.spec.name}\` — ${budgetStateLabel(budget.state)}`);
  lines.push('');
  if (slo.spec.description !== undefined) lines.push(`${slo.spec.description}`);
  lines.push('');

  lines.push('| Metric | Value |');
  lines.push('|---|---|');
  lines.push(`| Objective | ${formatPercent(slo.spec.objective, 2)} (error budget ${formatErrorRate(budget.budgetRatio)}) |`);
  lines.push(
    `| Error rate | ${slo.period.sufficient ? formatErrorRate(slo.period.errorRate) : `n/a (${slo.period.note})`} |`,
  );
  lines.push(`| Burn rate | ${slo.period.sufficient ? `${formatBurn(slo.period.burnRate)} (sustainable is 1x)` : 'n/a'} |`);
  lines.push(
    `| Window | ${formatDate(budget.periodStart)} → ${formatDate(budget.periodEnd)} ` +
      `(${formatDuration(budget.elapsedSeconds)} of ${formatDuration(budget.periodSeconds)}, ` +
      `${formatPercent(budget.elapsedFraction)} elapsed) |`,
  );
  lines.push(`| Budget used | ${formatPercent(budget.consumed)} |`);
  lines.push(`| Budget remaining | ${formatPercent(budget.remaining)} |`);
  lines.push(`| Projected remaining at window end | ${formatPercent(budget.projectedRemaining)} |`);
  if (budget.neverExhausts) {
    lines.push('| Projected exhaustion | never, at the current rate |');
  } else {
    lines.push(
      `| Projected exhaustion | ${formatTimestamp(budget.exhaustsAt)} ` +
        `(${formatDuration(budget.exhaustsInSeconds)} from now) |`,
    );
  }
  lines.push(`| Series matched | ${slo.goodSeriesCount} good, ${slo.badSeriesCount} bad |`);
  lines.push(`| Intervals measured | ${slo.curve.length} |`);
  lines.push('');

  lines.push('### Observations');
  lines.push('');
  for (const observation of slo.observations) lines.push(`- ${observation}`);
  lines.push('');

  lines.push('### Multi-window multi-burn-rate alerts');
  lines.push('');
  lines.push('| Rule | Severity | Long | Short | Threshold | Long burn | Short burn | Status |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const alert of slo.alerts) lines.push(alertRow(alert));
  lines.push('');
  for (const alert of slo.firing) lines.push(`- ${alert.rule.action}`);
  if (slo.firing.length > 0) lines.push('');

  const notes = [...slo.warnings, ...budget.notes.map((note) => `Budget: ${note}`)];
  if (notes.length > 0) {
    lines.push('### Caveats');
    lines.push('');
    for (const note of dedupe(notes)) lines.push(`- ${note}`);
    lines.push('');
  }

  return lines;
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}
