/** Display helpers. All pure, all covered by unit tests. */

export function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export function trimZeros(text: string): string {
  if (!text.includes('.')) return text;
  return text.replace(/\.?0+$/, '');
}

/** `0.25` -> `25.00%`. */
export function formatPercent(fraction: number, digits = 2): string {
  if (!Number.isFinite(fraction)) return 'n/a';
  return `${(fraction * 100).toFixed(digits)}%`;
}

/** `14.4` -> `14.4x`, `0.98` -> `0.98x`, `0` -> `0x`. */
export function formatBurn(rate: number): string {
  if (!Number.isFinite(rate)) return 'n/a';
  if (rate === 0) return '0x';
  const abs = Math.abs(rate);
  const digits = abs >= 100 ? 1 : abs >= 1 ? 2 : 3;
  return `${trimZeros(rate.toFixed(digits))}x`;
}

/** Error rate with enough precision for the small rates SLOs care about. */
export function formatErrorRate(rate: number): string {
  if (!Number.isFinite(rate)) return 'n/a';
  if (rate === 0) return '0%';
  const percent = rate * 100;
  if (percent >= 1) return `${percent.toFixed(2)}%`;
  if (percent >= 0.01) return `${percent.toFixed(3)}%`;
  return `${percent.toExponential(2)}%`;
}

/** `90000` -> `1d 1h`; at most two units, seconds only when they fit. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return 'n/a';
  const total = Math.max(0, Math.round(seconds));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const secs = total % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  // Seconds only earn a place when nothing bigger is already shown.
  if (parts.length < 2 && secs > 0) parts.push(`${secs}s`);
  if (parts.length === 0) parts.push('0s');
  return parts.slice(0, 2).join(' ');
}

/** Compact single-unit window label: `2592000` -> `30d`, `21600` -> `6h`. */
export function formatWindow(seconds: number): string {
  if (!Number.isFinite(seconds)) return 'n/a';
  for (const [unit, size] of [
    ['d', 86_400],
    ['h', 3_600],
    ['m', 60],
  ] as const) {
    if (seconds >= size && seconds % size === 0) return `${seconds / size}${unit}`;
  }
  return `${seconds}s`;
}

export function formatTimestamp(epochMs: number | null | undefined): string {
  if (epochMs === null || epochMs === undefined || !Number.isFinite(epochMs)) return 'n/a';
  return new Date(epochMs).toISOString().replace('.000Z', 'Z');
}

export function formatDate(epochMs: number | null | undefined): string {
  if (epochMs === null || epochMs === undefined || !Number.isFinite(epochMs)) return 'n/a';
  return new Date(epochMs).toISOString().slice(0, 10);
}

/** `1234567` -> `1.23M`. */
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return 'n/a';
  const abs = Math.abs(value);
  for (const [suffix, size] of [
    ['G', 1e9],
    ['M', 1e6],
    ['k', 1e3],
  ] as const) {
    if (abs >= size) return `${trimZeros((value / size).toFixed(2))}${suffix}`;
  }
  return trimZeros(value.toFixed(abs < 10 && !Number.isInteger(value) ? 2 : 0));
}

export function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}
