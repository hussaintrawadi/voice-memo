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

const WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0, ravivar: 0, raviwar: 0, itwar: 0, itvaar: 0, itvar: 0,
  monday: 1, mon: 1, somvar: 1, somwar: 1,
  tuesday: 2, tue: 2, tues: 2, mangalvar: 2, mangalwar: 2,
  wednesday: 3, wed: 3, budhvar: 3, budhwar: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4, guruvar: 4, guruwar: 4, brihaspativar: 4, veervar: 4,
  friday: 5, fri: 5, shukravar: 5, shukrawar: 5,
  saturday: 6, sat: 6, shanivar: 6, shaniwar: 6,
};

const weekdayOf = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();

/**
 * Turns the words someone used for a day ("by Thursday", "tomorrow", "kal", "next Monday",
 * "in 3 days") into a date, counted from the day they spoke. Models are unreliable at this
 * arithmetic, so their answer is only used when this returns null (an explicit date, "next month").
 * Weeks start on Monday: "next Thursday" is the Thursday of the following week.
 */
export function resolveDayPhrase(phrase: string, recordedDate: string): string | null {
  const p = ` ${phrase.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim()} `;
  if (/ (day after tomorrow|parso|parson) /.test(p)) return addDays(recordedDate, 2);
  if (/ (tomorrow|tmrw|tmr|kal) /.test(p)) return addDays(recordedDate, 1);
  if (/ (today|tonight|aaj|this morning|this afternoon|this evening) /.test(p)) return recordedDate;
  const inDays = p.match(/ in (\d{1,2}) days? /);
  if (inDays) return addDays(recordedDate, Number(inDays[1]));
  for (const [name, day] of Object.entries(WEEKDAYS)) {
    if (!p.includes(` ${name} `)) continue;
    const today = weekdayOf(recordedDate);
    if (/ next /.test(p)) {
      const toNextMonday = (1 - today + 7) % 7 || 7;
      return addDays(recordedDate, toNextMonday + ((day - 1 + 7) % 7));
    }
    // "Thursday", "by Thursday", "on Thursday", "this Thursday": the nearest one, today included.
    return addDays(recordedDate, (day - today + 7) % 7);
  }
  return null;
}
