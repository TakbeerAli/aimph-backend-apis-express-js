/*
 * Attendance rules with no database access, shared with the app (same code, same tests).
 *
 * COUNTED DAYS for a student in a period = working days on which their section's sheet exists
 * and the student is enrolled (and on the sheet). Weekends, holidays and working days with no
 * sheet ("not marked") are never counted: not present and not absent.
 * LATE counts as present; LEAVE counts as not present.
 * Attendance % = (PRESENT + LATE) ÷ COUNTED × 100, rounded; null ("—") when nothing is counted.
 */
import { eachDay, isWorkingDay, type CalendarRuleEvent } from '../calendar/calendar.rules.js';

export const ATTENDANCE_STATUSES = ['PRESENT', 'ABSENT', 'LEAVE', 'LATE'] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

/* ---------- Enrolment ---------- */

/** The parts of a class-history entry that decide where a student was. Dates "YYYY-MM-DD". */
export interface HistorySpan {
  sectionId: string;
  startDate: string;
  endDate: string | null;
  sectionChanges: { fromSectionId: string; toSectionId: string; date: string }[];
}

/**
 * The section a student was in on a date, or null when not enrolled that day (before
 * admission, after withdrawal, or between sessions). A section change applies from its date.
 */
export function sectionOnDate(history: readonly HistorySpan[], date: string): string | null {
  const entry = history.find(
    (h) => h.startDate <= date && (h.endDate === null || date <= h.endDate),
  );
  if (!entry) return null;
  const changes = [...entry.sectionChanges].sort((a, b) => a.date.localeCompare(b.date));
  let section = changes[0]?.fromSectionId ?? entry.sectionId;
  for (const change of changes) {
    if (change.date <= date) section = change.toSectionId;
  }
  return section;
}

/* ---------- Counting ---------- */

export function countEntries(entries: readonly { status: AttendanceStatus }[]) {
  const counts = { present: 0, absent: 0, leave: 0, late: 0, total: entries.length };
  for (const e of entries) {
    if (e.status === 'PRESENT') counts.present += 1;
    else if (e.status === 'ABSENT') counts.absent += 1;
    else if (e.status === 'LEAVE') counts.leave += 1;
    else counts.late += 1;
  }
  return counts;
}

/** Rounded whole percent, or null when there is nothing to count. */
export const attendancePercent = (attended: number, counted: number): number | null =>
  counted === 0 ? null : Math.round((attended / counted) * 100);

export interface StudentDay {
  date: string;
  /** Is the student enrolled in the section that day? */
  enrolled: boolean;
  /** Does the section have a sheet that day? */
  marked: boolean;
  /** The student's status on that sheet (null: not on it). */
  status: AttendanceStatus | null;
}

export interface AttendanceSummary {
  /** Working days in the period while the student was enrolled. */
  workingDays: number;
  /** Of those, the days with a sheet that has the student. */
  counted: number;
  /** Working, enrolled days with no sheet. */
  notMarked: number;
  present: number;
  late: number;
  absent: number;
  leave: number;
  percent: number | null;
}

/** A student's attendance over some days (see the rules at the top of this file). */
export function summarize(
  days: readonly StudentDay[],
  weeklyOffDays: readonly number[],
  events: readonly CalendarRuleEvent[],
): AttendanceSummary {
  const s = { workingDays: 0, counted: 0, notMarked: 0, present: 0, late: 0, absent: 0, leave: 0 };
  for (const day of days) {
    if (!day.enrolled || !isWorkingDay(day.date, weeklyOffDays, events)) continue;
    s.workingDays += 1;
    if (!day.marked) {
      s.notMarked += 1;
      continue;
    }
    if (day.status === null) continue;
    s.counted += 1;
    if (day.status === 'PRESENT') s.present += 1;
    else if (day.status === 'LATE') s.late += 1;
    else if (day.status === 'ABSENT') s.absent += 1;
    else s.leave += 1;
  }
  return { ...s, percent: attendancePercent(s.present + s.late, s.counted) };
}

/**
 * Builds the days of a period for one student from their history and their section's sheets.
 * `sheets` maps a section id to its sheets by date.
 */
export function studentDays(
  from: string,
  to: string,
  history: readonly HistorySpan[],
  studentId: string,
  sheets: ReadonlyMap<
    string,
    ReadonlyMap<string, readonly { studentId: string; status: AttendanceStatus }[]>
  >,
): StudentDay[] {
  return eachDay(from, to).map((date) => {
    const sectionId = sectionOnDate(history, date);
    const entries = sectionId ? sheets.get(sectionId)?.get(date) : undefined;
    return {
      date,
      enrolled: sectionId !== null,
      marked: entries !== undefined,
      status: entries?.find((e) => e.studentId === studentId)?.status ?? null,
    };
  });
}
