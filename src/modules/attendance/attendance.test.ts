import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  admit,
  asAuthUser,
  bearer,
  createUser,
  login,
  resetDatabase,
  setupSchool,
  type Tokens,
} from '../../../test/helpers.js';
import { createApp } from '../../app.js';
import { AuditLog } from '../../common/audit.js';
import type { AuthUser } from '../../common/middleware/auth.js';
import { dateOnly } from '../../common/utils/dates.js';
import { newId } from '../../common/utils/ids.js';
import { createEvent } from '../calendar/calendar.service.js';
import { withdrawStudent } from '../students/students.lifecycle.js';
import type { StudentDoc } from '../students/students.model.js';
import { User, type UserDoc } from '../users/users.model.js';
import { AttendanceSheet } from './attendance.model.js';
import type { AttendanceStatus } from './attendance.rules.js';
import { saveSheet, studentAttendance } from './attendance.service.js';

// "Today" is Thursday 26 Nov 2026 in Karachi. Only Date is faked, so MongoDB timers keep working.
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-26T10:00:00+05:00'));
});
afterAll(() => {
  vi.useRealTimers();
});

const TODAY = '2026-11-26';

describe('attendance sheets', () => {
  let app: ReturnType<typeof createApp>;
  let school: Awaited<ReturnType<typeof setupSchool>>;
  let teacher: UserDoc; // 5-A
  let adminTokens: Tokens;
  let teacherTokens: Tokens;
  let ali: StudentDoc; // 5-A
  let sara: StudentDoc; // 5-A

  beforeEach(async () => {
    await resetDatabase();
    app = createApp();
    school = await setupSchool();
    teacher = await createUser({ assignedSectionIds: [school.s5A] });
    adminTokens = await login(app, school.admin);
    teacherTokens = await login(app, teacher);
    const in5A = { classId: school.class5Id, sectionId: school.s5A };
    ali = await admit(school.actor, in5A, { rollNo: 1 });
    sara = await admit(school.actor, in5A, { fullName: 'Sara Khan', gender: 'FEMALE', rollNo: 2 });
    await admit(school.actor, { classId: school.class5Id, sectionId: school.s5B });
  });

  const as = (tokens: Tokens) => ({
    get: (path: string) => request(app).get(`/api/v1${path}`).set('Authorization', bearer(tokens)),
    put: (body: object) =>
      request(app).put('/api/v1/attendance/sheet').set('Authorization', bearer(tokens)).send(body),
  });
  const sheetBody = (
    date: string,
    entries: { studentId: string; status: AttendanceStatus }[] = [],
    extra: object = {},
  ) => ({
    id: newId(),
    sectionId: school.s5A,
    date,
    entries,
    ...extra,
  });
  const holiday = (name: string, startDate: string, confirm = false) =>
    createEvent(school.actor, { type: 'HOLIDAY', name, startDate, confirm });

  describe('opening a sheet', () => {
    it('gives a draft with every enrolled student PRESENT, by roll number', async () => {
      const res = await as(teacherTokens).get(
        `/attendance/sheet?sectionId=${school.s5A}&date=${TODAY}`,
      );
      expect(res.status).toBe(200);
      const data = res.body.data;
      expect(data).toMatchObject({
        isWorkingDay: true,
        canEdit: true,
        reasonRequired: false,
        lockedReason: null,
        section: { label: '5-A' },
        sheet: { isDraft: true, _id: null, counts: { present: 2, total: 2 } },
      });
      expect(data.students.map((s: { fullName: string }) => s.fullName)).toEqual([
        'Ali Raza',
        'Sara Khan',
      ]);
    });

    it('tells a teacher an earlier day is locked, and a weekend cannot be marked', async () => {
      const yesterday = await as(teacherTokens).get(
        `/attendance/sheet?sectionId=${school.s5A}&date=2026-11-25`,
      );
      expect(yesterday.body.data).toMatchObject({
        canEdit: false,
        lockedReason: 'ATTENDANCE_LOCKED',
      });
      const sunday = await as(adminTokens).get(
        `/attendance/sheet?sectionId=${school.s5A}&date=2026-11-22`,
      );
      expect(sunday.body.data).toMatchObject({
        isWorkingDay: false,
        lockedReason: 'NOT_A_WORKING_DAY',
        sheet: null,
      });
      const other = await as(teacherTokens).get(
        `/attendance/sheet?sectionId=${school.s5B}&date=${TODAY}`,
      );
      expect(other.body.error.code).toBe('SECTION_NOT_ASSIGNED');
    });
  });

  describe('saving (#1, #2)', () => {
    it('cannot mark on a weekend or holiday; can on a make-up working day (#1)', async () => {
      const sunday = await as(adminTokens).put(
        sheetBody('2026-11-22', [], { reason: 'Late entry' }),
      );
      expect(sunday.status).toBe(422);
      expect(sunday.body.error).toMatchObject({
        code: 'NOT_A_WORKING_DAY',
        message: "Sun 22 Nov is a weekend. Attendance can't be marked.",
      });

      await holiday('Iqbal Day', '2026-11-09');
      const off = await as(adminTokens).put(sheetBody('2026-11-09', [], { reason: 'Late entry' }));
      expect(off.body.error.message).toBe(
        "Mon 9 Nov is a holiday (Iqbal Day). Attendance can't be marked.",
      );

      await createEvent(school.actor, {
        type: 'WORKING_DAY',
        name: 'Make-up day',
        startDate: '2026-11-15',
        confirm: false,
      });
      const makeUp = await as(adminTokens).put(
        sheetBody('2026-11-15', [], { reason: 'Late entry' }),
      );
      expect(makeUp.status).toBe(201);
    });

    it('a teacher marks only today and only their own sections (#2)', async () => {
      const res = await as(teacherTokens).put(
        sheetBody(TODAY, [{ studentId: ali._id, status: 'ABSENT' }]),
      );
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({
        status: 'CREATED',
        sheet: {
          markedBy: teacher._id,
          counts: { present: 1, absent: 1, leave: 0, late: 0, total: 2 },
          changeLog: [],
        },
      });

      // Changing it again today is fine (no change log for today's edits).
      const again = await as(teacherTokens).put({
        ...sheetBody(TODAY, [{ studentId: ali._id, status: 'LATE' }]),
        id: res.body.data.sheet._id,
        version: res.body.data.sheet.version,
      });
      expect(again.body.data).toMatchObject({ status: 'UPDATED', sheet: { counts: { late: 1 } } });

      const yesterday = await as(teacherTokens).put(sheetBody('2026-11-25'));
      expect(yesterday.status).toBe(422);
      expect(yesterday.body.error).toMatchObject({
        code: 'ATTENDANCE_LOCKED',
        message: "Only today's attendance can be changed. Ask Admin to correct earlier days.",
      });
      const otherSection = await as(teacherTokens).put({
        ...sheetBody(TODAY),
        sectionId: school.s5B,
      });
      expect(otherSection.body.error.code).toBe('SECTION_NOT_ASSIGNED');
      expect((await as(adminTokens).put(sheetBody('2026-11-27'))).status).toBe(400);
    });

    it('Admin corrects a past day only with a reason; the change log records it (#2)', async () => {
      const first = await as(adminTokens).put(
        sheetBody('2026-11-20', [], { reason: 'Teacher was absent' }),
      );
      expect(first.status).toBe(201);
      expect(first.body.data.sheet.changeLog).toHaveLength(1);

      const id = first.body.data.sheet._id;
      const noReason = await as(adminTokens).put({
        ...sheetBody('2026-11-20', [{ studentId: sara._id, status: 'LEAVE' }]),
        id,
      });
      expect(noReason.status).toBe(400);

      const fixed = await as(adminTokens).put({
        ...sheetBody('2026-11-20', [{ studentId: sara._id, status: 'LEAVE' }]),
        id,
        version: first.body.data.sheet.version,
        reason: 'Parent sent a leave note',
      });
      expect(fixed.status).toBe(200);
      expect(fixed.body.data.sheet.changeLog[1]).toMatchObject({
        by: school.admin._id,
        reason: 'Parent sent a leave note',
        changes: [{ studentId: sara._id, from: 'PRESENT', to: 'LEAVE' }],
      });
      expect(await AuditLog.countDocuments({ action: 'ATTENDANCE_ADMIN_CORRECTION' })).toBe(2);

      // An old version is rejected with the current copy.
      const stale = await as(adminTokens).put({
        ...sheetBody('2026-11-20', [{ studentId: sara._id, status: 'ABSENT' }]),
        id,
        version: first.body.data.sheet.version,
        reason: 'Second try',
      });
      expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    });

    it('rejects students who are not in the section that day', async () => {
      const res = await as(adminTokens).put(
        sheetBody(TODAY, [{ studentId: 'someone-else', status: 'ABSENT' }]),
      );
      expect(res.status).toBe(400);
    });
  });

  describe('offline phones (#3)', () => {
    const push = (tokens: Tokens, payload: object) =>
      request(app)
        .post('/api/v1/sync/push')
        .set('Authorization', bearer(tokens))
        .send({ operations: [{ opId: newId(), type: 'SAVE_ATTENDANCE', payload }] });

    it('the same sheet pushed twice is saved once', async () => {
      const body = sheetBody(TODAY, [{ studentId: ali._id, status: 'ABSENT' }]);
      const first = await push(teacherTokens, body);
      expect(first.body.data.results[0].status).toBe('APPLIED');
      const second = await push(teacherTokens, body);
      expect(second.body.data.results[0].status).toBe('DUPLICATE');
      expect(await AttendanceSheet.countDocuments()).toBe(1);
    });

    it("merges the same teacher's second phone; another user's sheet waits for review", async () => {
      await push(teacherTokens, sheetBody(TODAY, [{ studentId: ali._id, status: 'ABSENT' }]));
      const secondPhone = await push(
        teacherTokens,
        sheetBody(TODAY, [{ studentId: sara._id, status: 'LATE' }]),
      );
      expect(secondPhone.body.data.results[0].status).toBe('APPLIED');
      const merged = await AttendanceSheet.findOne().orFail();
      expect(merged.counts).toMatchObject({ absent: 1, late: 1, total: 2 });

      // The section moved to another teacher during the day.
      const other = await createUser({ username: 'bilal', deviceCode: 'T02' });
      await User.updateOne({ _id: other._id }, { $set: { assignedSectionIds: [school.s5A] } });
      const res = await push(
        await login(app, other),
        sheetBody(TODAY, [{ studentId: ali._id, status: 'PRESENT' }]),
      );
      expect(res.body.data.results[0].status).toBe('NEEDS_REVIEW');
      const sheet = await AttendanceSheet.findOne().orFail();
      expect(sheet).toMatchObject({ needsReview: true, counts: { absent: 1, late: 1 } });
      expect(sheet.conflicts).toHaveLength(1);
      expect(await AttendanceSheet.countDocuments()).toBe(1);
    });

    it("a teacher's pull has only their own sections' sheets", async () => {
      await saveSheet(asAuthUser(teacher), sheetBody(TODAY));
      await saveSheet(school.actor, { ...sheetBody(TODAY), sectionId: school.s5B });
      const pull = await as(teacherTokens).get('/sync/pull?since=0&limit=500');
      expect(
        pull.body.data.changes.attendance_sheets.map((s: { sectionId: string }) => s.sectionId),
      ).toEqual([school.s5A]);
    });
  });

  describe('calculation (#6, #7, #8)', () => {
    const NOV = { from: '2026-11-01', to: TODAY };
    const special: Record<string, AttendanceStatus> = {
      '2026-11-04': 'ABSENT',
      '2026-11-18': 'ABSENT',
      '2026-11-10': 'LEAVE',
      '2026-11-12': 'LATE',
    };

    /** Admin marks 5-A for every working day of 1–26 Nov except 19 Nov (not marked). */
    async function markNovember(admin: AuthUser) {
      for (let d = 1; d <= 26; d += 1) {
        const date = `2026-11-${String(d).padStart(2, '0')}`;
        const sunday = dateOnly(date).getUTCDay() === 0;
        if (sunday || ['2026-11-09', '2026-11-25', '2026-11-19'].includes(date)) continue;
        const status = special[date];
        await saveSheet(admin, {
          id: newId(),
          sectionId: school.s5A,
          date,
          entries: status ? [{ studentId: ali._id, status }] : [],
          ...(date < TODAY && { reason: 'Entered from the paper register' }),
        });
      }
    }

    it('Ali Raza, 1–26 Nov: 20 working days, 19 counted, 84% (#6)', async () => {
      await holiday('Iqbal Day', '2026-11-09');
      await holiday('Quaid Day', '2026-11-25');
      await markNovember(school.actor);

      expect(await studentAttendance(ali._id, NOV.from, NOV.to)).toMatchObject({
        workingDays: 20,
        counted: 19,
        notMarked: 1,
        present: 15,
        late: 1,
        absent: 2,
        leave: 1,
        percent: 84,
      });
    });

    it('a holiday added over marked days removes them from totals; records are kept (#7)', async () => {
      await holiday('Iqbal Day', '2026-11-09');
      await holiday('Quaid Day', '2026-11-25');
      await markNovember(school.actor);
      await holiday('Rain day', '2026-11-04', true);

      expect(await studentAttendance(ali._id, NOV.from, NOV.to)).toMatchObject({
        workingDays: 19,
        counted: 18,
        absent: 1,
        percent: 89, // (15 + 1) / 18
      });
      expect(await AttendanceSheet.countDocuments({ date: '2026-11-04' })).toBe(1);
    });

    it('counts a student from admission, and not after withdrawal (#8)', async () => {
      await holiday('Iqbal Day', '2026-11-09');
      await holiday('Quaid Day', '2026-11-25');
      const late = await admit(
        school.actor,
        { classId: school.class5Id, sectionId: school.s5A },
        { fullName: 'Hamza Late', admissionDate: '2026-11-16' },
      );
      await withdrawStudent(school.actor, sara._id, {
        date: dateOnly('2026-11-12'),
        reason: 'SHIFTED_CITY',
        duesAction: 'WAIVED',
        waiveReason: 'Family moved away',
      });
      await markNovember(school.actor);

      // 16–26 Nov: 16, 17, 18, 19 (not marked), 20, 21, 23, 24, 26.
      expect(await studentAttendance(late._id, NOV.from, NOV.to)).toMatchObject({
        workingDays: 9,
        counted: 8,
        percent: 100,
      });
      // 2–12 Nov: 2, 3, 4, 5, 6, 7, 10, 11, 12 (withdrawn on the 12th).
      expect(await studentAttendance(sara._id, NOV.from, NOV.to)).toMatchObject({
        workingDays: 9,
        counted: 9,
      });
      const after = await AttendanceSheet.findOne({ date: '2026-11-13' }).orFail();
      expect(after.entries.map((e) => e.studentId)).not.toContain(sara._id);
    });
  });
});
