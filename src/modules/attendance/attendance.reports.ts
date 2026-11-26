import { AppError } from '../../common/errors.js';
import type { AuthUser } from '../../common/middleware/auth.js';
import { todayString } from '../../common/utils/dates.js';
import { dayInfo, eachDay, monthRange, type DayInfo } from '../calendar/calendar.rules.js';
import { calendarRulesForRange } from '../calendar/calendar.service.js';
import { getSettings } from '../settings/settings.service.js';
import { Student } from '../students/students.model.js';
import { User } from '../users/users.model.js';
import { activeSections, type SectionInfo } from '../users/users.service.js';
import { AttendanceSheet, type AttendanceEntry } from './attendance.model.js';
import {
  attendancePercent,
  sectionOnDate,
  studentDays,
  summarize,
  type AttendanceStatus,
  type AttendanceSummary,
  type HistorySpan,
} from './attendance.rules.js';
import { assertOwnSection, findSection, historyOf } from './attendance.service.js';

/*
 * Attendance reports (stage B4). Admin sees every section; a teacher only their own.
 * All totals follow the shared rules in attendance.rules.ts.
 */

const MAX_RANGE_DAYS = 92;

/** The sections this user may see, with each one's teacher. */
async function visibleSections(user: AuthUser) {
  const [sections, teachers] = await Promise.all([
    activeSections(),
    User.find({ role: 'TEACHER', isActive: true }, { fullName: 1, assignedSectionIds: 1 }).lean(),
  ]);
  const teacherOf = new Map<string, { _id: string; fullName: string }>();
  for (const t of teachers) {
    for (const s of t.assignedSectionIds) teacherOf.set(s, { _id: t._id, fullName: t.fullName });
  }
  return sections
    .filter((s) => user.role === 'ADMIN' || user.assignedSectionIds.includes(s.sectionId))
    .map((s) => ({ ...s, teacher: teacherOf.get(s.sectionId) ?? null }));
}

/** Every student who was ever in one of these sections, with their history. */
async function studentsOf(sectionIds: string[]) {
  const students = await Student.find(
    {
      $or: [
        { 'classHistory.sectionId': { $in: sectionIds } },
        { 'classHistory.sectionChanges.fromSectionId': { $in: sectionIds } },
        { 'classHistory.sectionChanges.toSectionId': { $in: sectionIds } },
      ],
    },
    { fullName: 1, admissionNo: 1, current: 1, classHistory: 1 },
  ).lean();
  return students.map((s) => ({ ...s, history: historyOf(s) }));
}

const countIn = (students: { history: HistorySpan[] }[], sectionId: string, date: string): number =>
  students.filter((s) => sectionOnDate(s.history, date) === sectionId).length;

/* ---------- AT-01 · GET /attendance/sections-status?date= ---------- */

export interface SectionStatus extends SectionInfo {
  teacher: { _id: string; fullName: string } | null;
  /** Students enrolled that day. */
  students: number;
  marked: boolean;
  sheetId: string | null;
  needsReview: boolean;
  counts: { present: number; absent: number; leave: number; late: number; total: number } | null;
  /** (present + late) ÷ total of the sheet, or null when not marked. */
  percent: number | null;
}

export async function sectionsStatus(user: AuthUser, date: string) {
  if (date > todayString()) {
    throw new AppError('VALIDATION_ERROR', 'Choose today or an earlier date.');
  }
  const sections = await visibleSections(user);
  const ids = sections.map((s) => s.sectionId);
  const [{ weeklyOffDays, events }, sheets, students] = await Promise.all([
    calendarRulesForRange(date, date),
    AttendanceSheet.find({ date, sectionId: { $in: ids } }).lean(),
    studentsOf(ids),
  ]);
  const day = dayInfo(date, weeklyOffDays, events);
  const sheetOf = new Map(sheets.map((s) => [s.sectionId, s]));

  const rows: SectionStatus[] = sections
    .map((s) => {
      const sheet = sheetOf.get(s.sectionId);
      return {
        ...s,
        students: countIn(students, s.sectionId, date),
        marked: !!sheet,
        sheetId: sheet?._id ?? null,
        needsReview: sheet?.needsReview ?? false,
        counts: sheet?.counts ?? null,
        percent: sheet
          ? attendancePercent(sheet.counts.present + sheet.counts.late, sheet.counts.total)
          : null,
      };
    })
    // A section with nobody in it has nothing to mark.
    .filter((r) => r.students > 0 || r.marked);

  const marked = rows.filter((r) => r.marked);
  const sum = (key: 'present' | 'late' | 'absent' | 'leave' | 'total') =>
    marked.reduce((n, r) => n + (r.counts?.[key] ?? 0), 0);
  return {
    date,
    day,
    isWorkingDay: day.type === 'WORKING',
    /** Over the marked sections only. */
    presentPercent: attendancePercent(sum('present') + sum('late'), sum('total')),
    absent: sum('absent'),
    leave: sum('leave'),
    late: sum('late'),
    markedSections: marked.length,
    totalSections: rows.length,
    sections: rows,
  };
}

/* ---------- GET /attendance/not-marked?from=&to= ---------- */

export async function notMarked(user: AuthUser, from?: string, to?: string) {
  const today = todayString();
  const end = !to || to > today ? today : to;
  const start =
    from ??
    new Date(new Date(`${end}T00:00:00Z`).getTime() - 29 * 86_400_000).toISOString().slice(0, 10);
  if (start > end) throw new AppError('VALIDATION_ERROR', 'The start date is after the end date.');
  const dates = eachDay(start, end);
  if (dates.length > MAX_RANGE_DAYS) {
    throw new AppError('VALIDATION_ERROR', `Choose at most ${MAX_RANGE_DAYS} days.`);
  }

  const sections = await visibleSections(user);
  const ids = sections.map((s) => s.sectionId);
  const [{ weeklyOffDays, events }, sheets, students] = await Promise.all([
    calendarRulesForRange(start, end),
    AttendanceSheet.find(
      { date: { $gte: start, $lte: end }, sectionId: { $in: ids } },
      { sectionId: 1, date: 1 },
    ).lean(),
    studentsOf(ids),
  ]);
  const done = new Set(sheets.map((s) => `${s.sectionId}|${s.date}`));

  const items: {
    date: string;
    sectionId: string;
    classId: string;
    label: string;
    teacher: { _id: string; fullName: string } | null;
    students: number;
  }[] = [];
  for (const date of dates.reverse()) {
    if (dayInfo(date, weeklyOffDays, events).type !== 'WORKING') continue;
    for (const s of sections) {
      if (done.has(`${s.sectionId}|${date}`)) continue;
      const count = countIn(students, s.sectionId, date);
      if (count === 0) continue;
      items.push({
        date,
        sectionId: s.sectionId,
        classId: s.classId,
        label: s.label,
        teacher: s.teacher,
        students: count,
      });
    }
  }
  return { from: start, to: end, total: items.length, items };
}

/* ---------- AT-03 · GET /attendance/student/:id?month= ---------- */

export interface StudentMonth extends AttendanceSummary {
  studentId: string;
  month: string;
  days: (DayInfo & {
    enrolled: boolean;
    marked: boolean;
    status: AttendanceStatus | null;
    /** After today: nothing to show yet. */
    future: boolean;
  })[];
}

export async function studentMonth(
  user: AuthUser,
  studentId: string,
  month: string,
): Promise<StudentMonth> {
  const student = await Student.findById(studentId, { current: 1, classHistory: 1 }).lean();
  if (!student) throw new AppError('NOT_FOUND', 'Student not found.');
  assertOwnSection(user, student.current.sectionId);

  const today = todayString();
  const { from, to } = monthRange(month);
  const history = historyOf(student);
  const sectionIds = [
    ...new Set(
      history.flatMap((h) => [
        h.sectionId,
        ...h.sectionChanges.flatMap((c) => [c.fromSectionId, c.toSectionId]),
      ]),
    ),
  ];
  const [{ weeklyOffDays, events }, sheets] = await Promise.all([
    calendarRulesForRange(from, to),
    AttendanceSheet.find(
      { sectionId: { $in: sectionIds }, date: { $gte: from, $lte: to } },
      { sectionId: 1, date: 1, entries: 1 },
    ).lean(),
  ]);
  const bySection = new Map<string, Map<string, AttendanceEntry[]>>();
  for (const sheet of sheets) {
    const dates = bySection.get(sheet.sectionId) ?? new Map<string, AttendanceEntry[]>();
    dates.set(sheet.date, sheet.entries);
    bySection.set(sheet.sectionId, dates);
  }
  // Totals only up to today; later days of the month are shown but not counted.
  const upTo = to < today ? to : today;
  const counted = from <= upTo ? studentDays(from, upTo, history, studentId, bySection) : [];
  const all = studentDays(from, to, history, studentId, bySection);

  return {
    studentId,
    month,
    ...summarize(counted, weeklyOffDays, events),
    days: all.map((d) => ({
      ...dayInfo(d.date, weeklyOffDays, events),
      enrolled: d.enrolled,
      marked: d.marked,
      status: d.status,
      future: d.date > today,
    })),
  };
}

/* ---------- AT-04 · GET /attendance/register?sectionId=&month= ---------- */

/** P / A / L / Lt for statuses; S weekend, H holiday, · not marked, "" not enrolled or future. */
const CELL: Record<AttendanceStatus, string> = {
  PRESENT: 'P',
  ABSENT: 'A',
  LEAVE: 'L',
  LATE: 'Lt',
};

export async function register(user: AuthUser, sectionId: string, month: string) {
  assertOwnSection(user, sectionId);
  const today = todayString();
  const { from, to } = monthRange(month);
  const [section, settings, teacher, { weeklyOffDays, events }, sheets, students] =
    await Promise.all([
      findSection(sectionId),
      getSettings(),
      User.findOne(
        { role: 'TEACHER', isActive: true, assignedSectionIds: sectionId },
        { fullName: 1 },
      ).lean(),
      calendarRulesForRange(from, to),
      AttendanceSheet.find({ sectionId, date: { $gte: from, $lte: to } }).lean(),
      studentsOf([sectionId]),
    ]);
  const sheetOf = new Map(sheets.map((s) => [s.date, s]));

  const days = eachDay(from, to).map((date) => {
    const info = dayInfo(date, weeklyOffDays, events);
    const future = date > today;
    const marked = sheetOf.has(date);
    return {
      date,
      weekday: info.weekday,
      type: info.type,
      names: info.names,
      future,
      marked,
      /** Header mark: S weekend, H holiday, · working day not marked. */
      mark:
        info.type === 'WEEKEND'
          ? 'S'
          : info.type === 'HOLIDAY'
            ? 'H'
            : !future && !marked
              ? '·'
              : '',
    };
  });

  const enrolledInMonth = students.filter((s) =>
    days.some((d) => sectionOnDate(s.history, d.date) === sectionId),
  );
  const rows = enrolledInMonth
    .map((s) => {
      const statusOn = (date: string) =>
        sheetOf.get(date)?.entries.find((e) => e.studentId === s._id)?.status ?? null;
      const cells = days.map((d) => {
        if (sectionOnDate(s.history, d.date) !== sectionId || d.future) return '';
        if (d.type === 'WEEKEND') return 'S';
        if (d.type === 'HOLIDAY') return 'H';
        if (!d.marked) return '·';
        const status = statusOn(d.date);
        return status ? CELL[status] : '';
      });
      const totals = summarize(
        days
          .filter((d) => !d.future)
          .map((d) => ({
            date: d.date,
            enrolled: sectionOnDate(s.history, d.date) === sectionId,
            marked: d.marked,
            status: statusOn(d.date),
          })),
        weeklyOffDays,
        events,
      );
      return {
        studentId: s._id,
        fullName: s.fullName,
        admissionNo: s.admissionNo,
        rollNo: s.current.sectionId === sectionId ? (s.current.rollNo ?? null) : null,
        cells,
        totals,
      };
    })
    .sort(
      (a, b) =>
        (a.rollNo ?? Infinity) - (b.rollNo ?? Infinity) || a.fullName.localeCompare(b.fullName),
    );

  const pastWorking = days.filter((d) => !d.future && d.type === 'WORKING');
  return {
    school: { name: settings.schoolName, address: settings.address, phone: settings.phone },
    section,
    month,
    classTeacher: teacher?.fullName ?? null,
    /** Working days of the whole month. */
    workingDays: days.filter((d) => d.type === 'WORKING').length,
    /** Working days up to today with no sheet. */
    notMarked: pastWorking.filter((d) => !d.marked).length,
    marked: pastWorking.filter((d) => d.marked).length,
    days,
    rows,
  };
}
