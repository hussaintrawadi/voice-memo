import { localTime } from "./util";

/** Unix ms of 00:00 on `date` (YYYY-MM-DD) in the given IANA timezone. */
export function zonedDayStart(date: string, timeZone: string): number {
  const [y, m, d] = date.split("-").map(Number);
  let guess = Date.UTC(y, m - 1, d);
  // Two passes settle the offset even across a DST change.
  for (let i = 0; i < 2; i++) {
    const local = localTime(guess, timeZone);
    const [ly, lm, ld] = local.date.split("-").map(Number);
    const [lh, lmin] = local.time.split(":").map(Number);
    const offset = Date.UTC(ly, lm - 1, ld, lh, lmin) - guess;
    guess = Date.UTC(y, m - 1, d) - offset;
  }
  return guess;
}

/** YYYY-MM-DD plus `days`. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export const isIsoDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

/** Unix ms of a local wall-clock time ("YYYY-MM-DDTHH:MM") in the given IANA timezone. */
export function zonedDateTime(local: string, timeZone: string): number {
  const m = local.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/);
  if (!m) throw new Error(`Not a local date-time: ${local}`);
  const [, date, hh, mm] = m;
  const [y, mo, d] = date.split("-").map(Number);
  let guess = Date.UTC(y, mo - 1, d, Number(hh), Number(mm));
  // Same two-pass offset settling as zonedDayStart.
  for (let i = 0; i < 2; i++) {
    const lt = localTime(guess, timeZone);
    const [ly, lm, ld] = lt.date.split("-").map(Number);
    const [lh, lmin] = lt.time.split(":").map(Number);
    const offset = Date.UTC(ly, lm - 1, ld, lh, lmin) - guess;
    guess = Date.UTC(y, mo - 1, d, Number(hh), Number(mm)) - offset;
  }
  return guess;
}

export const isLocalDateTime = (s: string) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s) && !Number.isNaN(Date.parse(`${s.slice(0, 16)}:00Z`));

/**
 * Reads a time a person or model gave: an ISO timestamp with an offset or Z is taken as is;
 * a bare "YYYY-MM-DDTHH:MM" is wall-clock time in `timeZone`.
 */
export function parseWhen(value: string, timeZone: string): number {
  const v = value.trim();
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(v)) {
    const ts = Date.parse(v);
    if (Number.isNaN(ts)) throw new Error(`Couldn't read the time "${value}"`);
    return ts;
  }
  if (!isLocalDateTime(v)) throw new Error(`Couldn't read the time "${value}". Use YYYY-MM-DDTHH:MM.`);
  return zonedDateTime(v, timeZone);
}
