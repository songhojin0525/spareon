/**
 * Wire timestamps are RFC 3339 in UTC with exactly millisecond precision: 2026-10-09T04:36:00.000Z.
 * One spelling per instant, so TS and Go compare and hash them identically.
 */
export const TIMESTAMP_PATTERN =
  '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$';

const TIMESTAMP_RE = new RegExp(TIMESTAMP_PATTERN);

/** Formats an instant as a wire timestamp. Throws for invalid dates and years outside 0000-9999. */
export function formatTimestamp(at: Date): string {
  const ms = at.getTime();
  if (!Number.isFinite(ms)) throw new RangeError('formatTimestamp: invalid date');
  const s = at.toISOString();
  if (!TIMESTAMP_RE.test(s)) throw new RangeError('formatTimestamp: year outside 0000-9999');
  return s;
}

/**
 * Parses a wire timestamp. Returns null unless the string is exactly the canonical spelling of a real
 * calendar instant (rejects 2026-02-30, 24:00, leap seconds, offsets other than Z, missing millis).
 */
export function parseTimestamp(value: string): Date | null {
  if (!TIMESTAMP_RE.test(value)) return null;
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return null;
  return d.toISOString() === value ? d : null;
}
