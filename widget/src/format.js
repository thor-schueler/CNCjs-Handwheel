/**
 * Formats an age in milliseconds as a short "2s ago" / "3m ago" string.
 *
 * @param {?number} ms - age in milliseconds, null if it never happened
 * @returns {string}
 */
export function ago(ms) {
  if (ms === null || ms === undefined) return 'never';
  const s = Math.round(ms / 1000);
  if (s < 2) return 'just now';
  if (s < 90) return s + 's ago';
  const m = Math.round(s / 60);
  if (m < 90) return m + 'm ago';
  return Math.round(m / 60) + 'h ago';
}

/**
 * Formats a duration in milliseconds as "3d 4h", "2h 5m" or "45s".
 *
 * @param {number} ms
 * @returns {string}
 */
export function duration(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return d + 'd ' + h + 'h';
  if (h) return h + 'h ' + m + 'm';
  if (m) return m + 'm ' + (s % 60) + 's';
  return s + 's';
}

/**
 * Formats a coordinate (CNCjs sends strings such as "12.500") with three decimals.
 *
 * @param {*} v
 * @returns {string}
 */
export function coord(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(3) : '–';
}

/**
 * Formats a log entry's time as HH:MM:SS.
 *
 * @param {number} t - epoch milliseconds
 * @returns {string}
 */
export function clock(t) {
  return new Date(t).toLocaleTimeString([], { hour12: false });
}
