import { z } from 'zod';
import { env } from '../../config/env.js';

/*
 * Two kinds of dates:
 * - Timestamps (paidAt, createdAt): real instants, stored in UTC.
 * - Date-only business values (dateOfBirth, admissionDate, session start/end, dueDate):
 *   stored as UTC midnight of that calendar date, e.g. 1 Apr 2026 → 2026-04-01T00:00:00.000Z.
 *   The first 10 characters of the ISO string are always the calendar date.
 * "Today" and the current fee month are taken in the school's time zone (TZ_BUSINESS).
 */

const businessDayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: env.TZ_BUSINESS,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Today's calendar date in the school's time zone, "YYYY-MM-DD". */
export const todayString = (now: Date = new Date()): string => businessDayFormatter.format(now);

/** Today as a date-only value. */
export const today = (now?: Date): Date => dateOnly(todayString(now));

/** The current fee month in the school's time zone, "YYYY-MM". */
export const currentFeeMonth = (now?: Date): string => todayString(now).slice(0, 7);

/** "YYYY-MM-DD" → date-only value (UTC midnight). */
export const dateOnly = (ymd: string): Date => new Date(`${ymd.slice(0, 10)}T00:00:00.000Z`);

/** Date-only value → "YYYY-MM-DD". */
export const toYmd = (date: Date): string => date.toISOString().slice(0, 10);

/** Accepts "YYYY-MM-DD" or a UTC ISO datetime and returns the date-only value. */
export const dateOnlySchema = z
  .union([z.iso.date(), z.iso.datetime()])
  .transform((value) => dateOnly(value));

/** "2026-12" + 1 → "2027-01". */
export function addMonths(feeMonth: string, count: number): string {
  const index = Number(feeMonth.slice(0, 4)) * 12 + Number(feeMonth.slice(5, 7)) - 1 + count;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}

/** Day `day` of a fee month as a date-only value. */
export const dayOfMonth = (feeMonth: string, day: number): Date =>
  dateOnly(`${feeMonth}-${String(day).padStart(2, '0')}`);

/** Date-only value → its fee month "YYYY-MM". */
export const monthOf = (date: Date): string => toYmd(date).slice(0, 7);

export const feeMonthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use the format YYYY-MM, e.g. 2026-12.');

const offsetFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: env.TZ_BUSINESS,
  timeZoneName: 'longOffset',
});

/** The school time zone's UTC offset at an instant, in ms ("GMT+05:00" → 5h). */
function businessOffsetMs(at: Date): number {
  const name = offsetFormatter.formatToParts(at).find((p) => p.type === 'timeZoneName')?.value;
  const match = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name ?? '');
  if (!match) return 0; // "GMT" means UTC
  const minutes = Number(match[2]) * 60 + Number(match[3] ?? 0);
  return (match[1] === '-' ? -1 : 1) * minutes * 60_000;
}

/** The instant a business day starts: "2026-11-20" → 2026-11-19T19:00:00Z in Karachi. */
export function businessDayStart(ymd: string): Date {
  const utcMidnight = dateOnly(ymd);
  return new Date(utcMidnight.getTime() - businessOffsetMs(utcMidnight));
}

/** The instant the next business day starts (exclusive end of `ymd`). */
export function businessDayEnd(ymd: string): Date {
  const next = new Date(dateOnly(ymd).getTime() + 86_400_000);
  return businessDayStart(toYmd(next));
}

/** Session "2026-27" → 1 Apr 2026 to 31 Mar 2027. */
export function sessionDates(name: string): { startDate: Date; endDate: Date } {
  const startYear = Number(name.slice(0, 4));
  return {
    startDate: dateOnly(`${startYear}-04-01`),
    endDate: dateOnly(`${startYear + 1}-03-31`),
  };
}
