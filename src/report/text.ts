import { budgetStateLabel } from '../budget.js';
import {
  formatBurn,
  formatDuration,
  formatErrorRate,
  formatPercent,
  formatTimestamp,
  formatWindow,
  pad,
} from '../format.js';
import type { Analysis } from '../types.js';

/** Plain-text report for a terminal or a CI log. Contains no escape codes. */
export function renderText(analysis: Analysis): string {
  const lines: string[] = [];
  lines.push('burnscope');
  lines.push(`  analysed at  ${formatTimestamp(analysis.asOf)}`);
  lines.push(`  profile      ${analysis.profile.name} (${analysis.profile.id})`);
  lines.push(`  min coverage ${formatPercent(analysis.minCoverage, 0)}`);
  lines.push('');

  for (const slo of analysis.slos) {
    const budget = slo.budget;
    lines.push(`${slo.spec.name}  [${budgetStateLabel(budget.state)}]`);
    if (slo.spec.description !== undefined) lines.push(`  ${slo.spec.description}`);
    lines.push(`  objective    ${formatPercent(slo.spec.objective, 2)} (budget ${formatErrorRate(budget.budgetRatio)})`);
    lines.push(
      `  error rate   ${slo.period.sufficient ? formatErrorRate(slo.period.errorRate) : `n/a — ${slo.period.note}`}`,
    );
    lines.push(`  burn rate    ${slo.period.sufficient ? formatBurn(slo.period.burnRate) : 'n/a'}`);
    lines.push(
      `  window       ${formatDuration(budget.elapsedSeconds)} of ${formatDuration(budget.periodSeconds)} elapsed ` +
        `(${formatPercent(budget.elapsedFraction)})`,
    );
    lines.push(
      `  budget       ${formatPercent(budget.consumed)} used, ${formatPercent(budget.remaining)} left`,
    );
    if (budget.neverExhausts) {
      lines.push('  exhaustion   never at this rate');
    } else {
      lines.push(
        `  exhaustion   ${formatTimestamp(budget.exhaustsAt)} (in ${formatDuration(budget.exhaustsInSeconds)})`,
      );
    }
    lines.push('');
    lines.push(`  ${pad('RULE', 22)}${pad('SEV', 8)}${pad('LONG', 7)}${pad('SHORT', 7)}${pad('NEED', 8)}${pad('GOT', 14)}STATUS`);
    for (const alert of slo.alerts) {
      const status = alert.firing ? 'FIRING' : alert.evaluated ? 'clear' : 'not evaluated';
      lines.push(
        `  ${pad(alert.rule.id, 22)}${pad(alert.rule.severity, 8)}` +
          `${pad(formatWindow(alert.rule.longWindowSeconds), 7)}` +
          `${pad(formatWindow(alert.rule.shortWindowSeconds), 7)}` +
          `${pad(`${alert.rule.burnRate}x`, 8)}` +
          `${pad(`${formatBurn(alert.long.burnRate)}/${formatBurn(alert.short.burnRate)}`, 14)}` +
          status,
      );
    }
    lines.push('');
    for (const observation of slo.observations) lines.push(`  - ${observation}`);
    for (const warning of [...new Set(slo.warnings)]) lines.push(`  ! ${warning}`);
    for (const note of budget.notes) lines.push(`  ~ ${note}`);
    lines.push('');
  }

  const skipped = new Map<string, number>();
  for (const skip of analysis.skipped) {
    const key = skip.reason;
    skipped.set(key, (skipped.get(key) ?? 0) + 1);
  }
  if (skipped.size > 0) {
    lines.push('skipped input lines');
    for (const [reason, count] of [...skipped.entries()].sort()) {
      lines.push(`  ${pad(String(count), 6)}${reason}`);
    }
    lines.push('');
  }

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}
