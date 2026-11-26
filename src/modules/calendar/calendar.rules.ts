/*
 * School calendar rules, with no database access so the app can use the same code and tests.
 *
 * A date is a WORKING day unless it is inside a holiday, or it is a weekly off day that is not
 * a make-up working day. A holiday always wins over a make-up day.
 * Dates are "YYYY-MM-DD" calendar dates in the school's time zone.
 */

export type DayType = 'WORKING' | 'WEEKEND' | 'HOLIDAY';

export interface CalendarRuleEvent {
  type: 'HOLIDAY' | 'WORKING_DAY';
  name: string;
  startDate: string;
  endDate: string;
  isDeleted?: boolean;
}

export interface DayInfo {
  date: string;
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
  type: DayType;
  /** Holiday names, or the make-up day's reason. */
  names: string[];
  /** A weekly off day made a working day. */
  isException: boolean;
}

const DAY_MS = 86_400_000;

/** 0 = Sunday … 6 = Saturday for a "YYYY-MM-DD" date. */
export const weekdayOf = (date: string): number => new Date(`${date}T00:00:00Z`).getUTCDay();

/** "2026-11-30" → "2026-12-01". */
export const nextDay = (date: string): string =>
  new Date(new Date(`${date}T00:00:00Z`).getTime() + DAY_MS).toISOString().slice(0, 10);

/** Every date from `from` to `to`, both included. */
export function eachDay(from: string, to: string): string[] {
  const days: string[] = [];
  for (let d = from; d <= to; d = nextDay(d)) days.push(d);
  return days;
}

/** First and last day of a month "YYYY-MM". */
export function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}

const covers = (e: CalendarRuleEvent, date: string) =>
  !e.isDeleted && e.startDate <= date && date <= e.endDate;

/** Everything about one date. */
export function dayInfo(
  date: string,
  weeklyOffDays: readonly number[],
  events: readonly CalendarRuleEvent[],
): DayInfo {
  const weekday = weekdayOf(date);
  const holidays = events.filter((e) => e.type === 'HOLIDAY' && covers(e, date));
  if (holidays.length > 0) {
    return {
      date,
      weekday,
      type: 'HOLIDAY',
      names: holidays.map((h) => h.name),
      isException: false,
    };
  }
  if (weeklyOffDays.includes(weekday)) {
    const exception = events.find((e) => e.type === 'WORKING_DAY' && covers(e, date));
    return exception
      ? { date, weekday, type: 'WORKING', names: [exception.name], isException: true }
      : { date, weekday, type: 'WEEKEND', names: [], isException: false };
  }
  return { date, weekday, type: 'WORKING', names: [], isException: false };
}

export const isWorkingDay = (
  date: string,
  weeklyOffDays: readonly number[],
  events: readonly CalendarRuleEvent[],
): boolean => dayInfo(date, weeklyOffDays, events).type === 'WORKING';

/** The working days from `from` to `to`, both included. */
export const getWorkingDays = (
  from: string,
  to: string,
  weeklyOffDays: readonly number[],
  events: readonly CalendarRuleEvent[],
): string[] => eachDay(from, to).filter((d) => isWorkingDay(d, weeklyOffDays, events));
