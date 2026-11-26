import type { ClientSession } from 'mongoose';
import { writeAudit } from '../../common/audit.js';
import { AppError } from '../../common/errors.js';
import type { AuthUser } from '../../common/middleware/auth.js';
import { dateOnly, todayString, toYmd } from '../../common/utils/dates.js';
import { withTransaction } from '../../db/transaction.js';
import { dayInfo, type DayInfo } from '../calendar/calendar.rules.js';
import { calendarRules, calendarRulesForRange } from '../calendar/calendar.service.js';
import { SchoolClass } from '../classes/classes.model.js';
import { AcademicSession } from '../sessions/sessions.model.js';
import { Student, type StudentAttrs } from '../students/students.model.js';
import {
  AttendanceSheet,
  type AttendanceChange,
  type AttendanceEntry,
  type AttendanceSheetDoc,
} from './attendance.model.js';
import {
  countEntries,
  sectionOnDate,
  studentDays,
  summarize,
  type AttendanceSummary,
  type HistorySpan,
} from './attendance.rules.js';
import type { SaveSheetInput, SheetQuery } from './attendance.schemas.js';

/* ---------- Sections, students and days ---------- */

export interface SectionRef {
  classId: string;
  sectionId: string;
  /** "5-A" */
  label: string;
}

export async function findSection(
  sectionId: string,
  session?: ClientSession | null,
): Promise<SectionRef> {
  const cls = await SchoolClass.findOne({ 'sections._id': sectionId }).session(session ?? null);
  const section = cls?.sections.find((s) => s._id === sectionId);
  if (!cls || !section) throw new AppError('NOT_FOUND', 'Section not found.');
  return { classId: cls._id, sectionId, label: `${cls.shortName ?? cls.name}-${section.name}` };
}

/** Teachers work only with their own sections; Admin with all. */
export function assertOwnSection(user: AuthUser, sectionId: string): void {
  if (user.role === 'TEACHER' && !user.assignedSectionIds.includes(sectionId)) {
    throw new AppError('SECTION_NOT_ASSIGNED', 'This section is not one of yours.');
  }
}

/** A student's class history with plain "YYYY-MM-DD" dates, for the shared rules. */
export const historyOf = (student: Pick<StudentAttrs, 'classHistory'>): HistorySpan[] =>
  student.classHistory.map((h) => ({
    sectionId: h.sectionId,
    startDate: toYmd(h.startDate),
    endDate: h.endDate ? toYmd(h.endDate) : null,
    sectionChanges: h.sectionChanges.map((c) => ({
      fromSectionId: c.fromSectionId,
      toSectionId: c.toSectionId,
      date: toYmd(c.date),
    })),
  }));

export interface SheetStudent {
  _id: string;
  fullName: string;
  admissionNo: number;
  gender: string;
  rollNo: number | null;
}

/**
 * Students enrolled in a section on a date (from their admission date, not after their
 * withdrawal, section changes respected), by roll number then name.
 */
export async function enrolledStudents(
  sectionId: string,
  date: string,
  session?: ClientSession | null,
): Promise<SheetStudent[]> {
  const candidates = await Student.find(
    {
      $or: [
        { 'classHistory.sectionId': sectionId },
        { 'classHistory.sectionChanges.fromSectionId': sectionId },
        { 'classHistory.sectionChanges.toSectionId': sectionId },
      ],
    },
    { fullName: 1, admissionNo: 1, gender: 1, current: 1, classHistory: 1 },
  )
    .lean()
    .session(session ?? null);
  return candidates
    .filter((s) => sectionOnDate(historyOf(s), date) === sectionId)
    .map((s) => ({
      _id: s._id,
      fullName: s.fullName,
      admissionNo: s.admissionNo,
      gender: s.gender,
      rollNo: s.current.sectionId === sectionId ? (s.current.rollNo ?? null) : null,
    }))
    .sort(
      (a, b) =>
        (a.rollNo ?? Infinity) - (b.rollNo ?? Infinity) || a.fullName.localeCompare(b.fullName),
    );
}

/** "Thu 26 Nov" for messages. */
const shortDay = (date: string) =>
  dateOnly(date).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });

/** The session a date belongs to, with that day's calendar information. */
async function dayFor(date: string, session?: ClientSession | null) {
  const academic = await AcademicSession.findOne({
    startDate: { $lte: dateOnly(date) },
    endDate: { $gte: dateOnly(date) },
  }).session(session ?? null);
  if (!academic) {
    throw new AppError('VALIDATION_ERROR', `${shortDay(date)} is not inside any session.`);
  }
  const { weeklyOffDays, events } = await calendarRules(academic._id, session);
  return { sessionId: academic._id, day: dayInfo(date, weeklyOffDays, events) };
}

function assertWorkingDay(day: DayInfo): void {
  if (day.type === 'WORKING') return;
  const message =
    day.type === 'HOLIDAY'
      ? `${shortDay(day.date)} is a holiday (${day.names.join(', ')}). Attendance can't be marked.`
      : `${shortDay(day.date)} is a weekend. Attendance can't be marked.`;
  throw new AppError('NOT_A_WORKING_DAY', message, { type: day.type, names: day.names });
}

const LOCKED_MESSAGE = "Only today's attendance can be changed. Ask Admin to correct earlier days.";

/* ---------- GET /attendance/sheet ---------- */

export interface SheetView {
  /** The saved sheet, or a draft (isDraft, no _id) with every enrolled student PRESENT. */
  sheet: (Record<string, unknown> & { isDraft: boolean }) | null;
  students: SheetStudent[];
  section: SectionRef;
  day: DayInfo;
  isWorkingDay: boolean;
  /** Can this user save this sheet now? */
  canEdit: boolean;
  /** Admin changing a past day must give a reason. */
  reasonRequired: boolean;
  /** Why it cannot be edited, when canEdit is false. */
  lockedReason: 'NOT_A_WORKING_DAY' | 'ATTENDANCE_LOCKED' | null;
}

export async function getSheet(user: AuthUser, query: SheetQuery): Promise<SheetView> {
  assertOwnSection(user, query.sectionId);
  const today = todayString();
  if (query.date > today) {
    throw new AppError('VALIDATION_ERROR', 'Attendance cannot be marked for a future date.');
  }
  const [section, { day }, students, saved] = await Promise.all([
    findSection(query.sectionId),
    dayFor(query.date),
    enrolledStudents(query.sectionId, query.date),
    AttendanceSheet.findOne({ sectionId: query.sectionId, date: query.date }),
  ]);

  const isWorkingDay = day.type === 'WORKING';
  const lockedReason = !isWorkingDay
    ? 'NOT_A_WORKING_DAY'
    : user.role !== 'ADMIN' && query.date !== today
      ? 'ATTENDANCE_LOCKED'
      : null;

  return {
    sheet: saved
      ? { ...saved.toJSON(), isDraft: false }
      : isWorkingDay
        ? {
            isDraft: true,
            _id: null,
            sectionId: query.sectionId,
            classId: section.classId,
            date: query.date,
            entries: students.map((s) => ({ studentId: s._id, status: 'PRESENT' })),
            counts: countEntries(students.map(() => ({ status: 'PRESENT' as const }))),
          }
        : null,
    students,
    section,
    day,
    isWorkingDay,
    canEdit: lockedReason === null,
    reasonRequired: user.role === 'ADMIN' && query.date < today,
    lockedReason,
  };
}

/* ---------- PUT /attendance/sheet ---------- */

export type SaveStatus = 'CREATED' | 'UPDATED' | 'DUPLICATE' | 'NEEDS_REVIEW';

export interface SaveResult {
  sheet: AttendanceSheetDoc;
  status: SaveStatus;
}

const statusMap = (entries: readonly AttendanceEntry[]) =>
  new Map(entries.map((e) => [e.studentId, e.status]));

const diffEntries = (
  before: readonly AttendanceEntry[],
  after: readonly AttendanceEntry[],
): AttendanceChange['changes'] => {
  const old = statusMap(before);
  return after
    .filter((e) => old.get(e.studentId) !== e.status)
    .map((e) => ({ studentId: e.studentId, from: old.get(e.studentId) ?? null, to: e.status }));
};

/**
 * Creates or updates the sheet of a section and day.
 * - Teachers: only their sections, only today. Admin: any day up to today; a past day needs
 *   a reason and every change to it goes in the change log.
 * - Never on a weekend or holiday, never in the future.
 * - The same sheet id sent again is saved once. A second phone's sheet for the same day is
 *   merged when it comes from the same user, otherwise kept for the Admin to review.
 */
export async function saveSheet(user: AuthUser, input: SaveSheetInput): Promise<SaveResult> {
  try {
    return await saveOnce(user, input);
  } catch (error) {
    // Two phones created the same section+day at the same moment: the second one now merges.
    if ((error as { code?: number }).code === 11000) return saveOnce(user, input);
    throw error;
  }
}

async function saveOnce(user: AuthUser, input: SaveSheetInput): Promise<SaveResult> {
  return withTransaction(async (session) => {
    const today = todayString();
    if (input.date > today) {
      throw new AppError('VALIDATION_ERROR', 'Attendance cannot be marked for a future date.');
    }
    assertOwnSection(user, input.sectionId);
    if (user.role !== 'ADMIN' && input.date !== today) {
      throw new AppError('ATTENDANCE_LOCKED', LOCKED_MESSAGE);
    }
    const section = await findSection(input.sectionId, session);
    const { sessionId, day } = await dayFor(input.date, session);
    assertWorkingDay(day);

    const correction = user.role === 'ADMIN' && input.date < today;
    if (correction && !input.reason) {
      throw new AppError(
        'VALIDATION_ERROR',
        'Give a reason for changing attendance of an earlier day.',
      );
    }

    const students = await enrolledStudents(input.sectionId, input.date, session);
    const enrolled = new Set(students.map((s) => s._id));
    const unknown = input.entries.filter((e) => !enrolled.has(e.studentId));
    if (unknown.length > 0) {
      throw new AppError(
        'VALIDATION_ERROR',
        `${unknown.length} student(s) are not in ${section.label} on this day.`,
        { studentIds: unknown.map((e) => e.studentId) },
      );
    }
    const requested = statusMap(input.entries);
    /** Everyone enrolled: the requested status, else `fallback` (current or PRESENT). */
    const entriesFrom = (current: readonly AttendanceEntry[]): AttendanceEntry[] => {
      const known = statusMap(current);
      return students.map((s) => ({
        studentId: s._id,
        status: requested.get(s._id) ?? known.get(s._id) ?? 'PRESENT',
      }));
    };

    const byId = await AttendanceSheet.findById(input.id).session(session);
    if (byId && (byId.sectionId !== input.sectionId || byId.date !== input.date)) {
      throw new AppError('VALIDATION_ERROR', 'This sheet id belongs to another section or day.');
    }
    const existing =
      byId ??
      (await AttendanceSheet.findOne({ sectionId: input.sectionId, date: input.date }).session(
        session,
      ));

    /* New sheet. */
    if (!existing) {
      const entries = entriesFrom([]);
      const [sheet] = await AttendanceSheet.create(
        [
          {
            _id: input.id,
            sessionId,
            classId: section.classId,
            sectionId: input.sectionId,
            date: input.date,
            markedBy: user.id,
            markedAt: new Date(),
            entries,
            counts: countEntries(entries),
            changeLog:
              correction && input.reason
                ? [
                    {
                      at: new Date(),
                      by: user.id,
                      reason: input.reason,
                      changes: diffEntries([], entries),
                    },
                  ]
                : [],
            createdBy: user.id,
          },
        ],
        { session },
      );
      if (!sheet) throw new Error('Sheet was not created');
      await writeAudit(session, {
        action: correction ? 'ATTENDANCE_ADMIN_CORRECTION' : 'ATTENDANCE_CREATE',
        userId: user.id,
        deviceCode: user.deviceCode,
        entity: 'attendance_sheet',
        entityId: sheet._id,
        after: { sectionId: sheet.sectionId, date: sheet.date, counts: sheet.counts },
        ...(input.reason && { reason: input.reason }),
      });
      return { sheet, status: 'CREATED' };
    }

    /* Another user's phone made a different sheet for the same day: the Admin decides. */
    if (!byId && existing.markedBy !== user.id && user.role !== 'ADMIN') {
      existing.conflicts.push({
        at: new Date(),
        by: user.id,
        sheetId: input.id,
        entries: entriesFrom(existing.entries),
      });
      existing.needsReview = true;
      await existing.save({ session });
      await writeAudit(session, {
        action: 'ATTENDANCE_CONFLICT',
        userId: user.id,
        deviceCode: user.deviceCode,
        entity: 'attendance_sheet',
        entityId: existing._id,
        reason: `Second sheet ${input.id} for ${section.label} ${input.date}`,
      });
      return { sheet: existing, status: 'NEEDS_REVIEW' };
    }

    /* Update (or a resend / the same user's second phone). */
    if (input.version !== undefined && byId && input.version !== existing.version) {
      throw new AppError(
        'VERSION_CONFLICT',
        'This attendance was changed on another phone. Check it and save again.',
        { current: existing.toJSON() },
      );
    }
    const entries = entriesFrom(existing.entries);
    const changes = diffEntries(existing.entries, entries);
    if (changes.length === 0 && entries.length === existing.entries.length) {
      return { sheet: existing, status: 'DUPLICATE' };
    }
    existing.entries = entries;
    existing.counts = countEntries(entries);
    if (correction && input.reason) {
      existing.changeLog.push({ at: new Date(), by: user.id, reason: input.reason, changes });
    }
    await existing.save({ session });
    await writeAudit(session, {
      action: correction ? 'ATTENDANCE_ADMIN_CORRECTION' : 'ATTENDANCE_UPDATE',
      userId: user.id,
      deviceCode: user.deviceCode,
      entity: 'attendance_sheet',
      entityId: existing._id,
      after: { counts: existing.counts, changes },
      ...(input.reason && { reason: input.reason }),
    });
    return { sheet: existing, status: 'UPDATED' };
  });
}

/* ---------- Calculation ---------- */

/** A student's attendance from `from` to `to` (dates "YYYY-MM-DD"), by the shared rules. */
export async function studentAttendance(
  studentId: string,
  from: string,
  to: string,
): Promise<AttendanceSummary & { days: ReturnType<typeof studentDays> }> {
  const student = await Student.findById(studentId, { classHistory: 1 }).lean();
  if (!student) throw new AppError('NOT_FOUND', 'Student not found.');
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
  const days = studentDays(from, to, history, studentId, bySection);
  return { ...summarize(days, weeklyOffDays, events), days };
}
