import type { Analysis } from '../types.js';

/** Machine-readable report: a faithful JSON serialisation of the analysis. */
export function renderJson(analysis: Analysis): string {
  return `${JSON.stringify(analysis, null, 2)}\n`;
}
