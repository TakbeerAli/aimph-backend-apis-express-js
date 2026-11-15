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

/** Session "2026-27" → 1 Apr 2026 to 31 Mar 2027. */
export function sessionDates(name: string): { startDate: Date; endDate: Date } {
  const startYear = Number(name.slice(0, 4));
  return {
    startDate: dateOnly(`${startYear}-04-01`),
    endDate: dateOnly(`${startYear + 1}-03-31`),
  };
}
