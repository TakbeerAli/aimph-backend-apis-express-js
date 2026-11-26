import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  admit,
  bearer,
  createUser,
  login,
  resetDatabase,
  setupSchool,
  type Tokens,
} from '../../../test/helpers.js';
import { createApp } from '../../app.js';
import { dateOnly } from '../../common/utils/dates.js';
import { newId } from '../../common/utils/ids.js';
import { createEvent } from '../calendar/calendar.service.js';
import type { StudentDoc } from '../students/students.model.js';
import type { UserDoc } from '../users/users.model.js';
import type { AttendanceStatus } from './attendance.rules.js';
import { saveSheet } from './attendance.service.js';

// "Today" is Thursday 26 Nov 2026 in Karachi.
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-26T10:00:00+05:00'));
});
afterAll(() => {
  vi.useRealTimers();
});

const TODAY = '2026-11-26';

describe('attendance reports (stage B4)', () => {
  let app: ReturnType<typeof createApp>;
  let school: Awaited<ReturnType<typeof setupSchool>>;
  let teacher: UserDoc; // 5-A; 5-B has no teacher; 6-A has no students
  let adminTokens: Tokens;
  let teacherTokens: Tokens;
  let ali: StudentDoc;

  beforeEach(async () => {
    await resetDatabase();
    app = createApp();
    school = await setupSchool();
    teacher = await createUser({ fullName: 'Saima Bibi', assignedSectionIds: [school.s5A] });
    adminTokens = await login(app, school.admin);
    teacherTokens = await login(app, teacher);
    const in5A = { classId: school.class5Id, sectionId: school.s5A };
    ali = await admit(school.actor, in5A, { rollNo: 1 });
    await admit(school.actor, in5A, { fullName: 'Sara Khan', rollNo: 2 });
    await admit(
      school.actor,
      { classId: school.class5Id, sectionId: school.s5B },
      { fullName: 'Bilal Ahmed' },
    );
  });

  const get = (tokens: Tokens, path: string) =>
    request(app).get(`/api/v1/attendance${path}`).set('Authorization', bearer(tokens));
  const mark = (
    date: string,
    entries: { studentId: string; status: AttendanceStatus }[] = [],
    sectionId = school.s5A,
  ) =>
    saveSheet(school.actor, {
      id: newId(),
      sectionId,
      date,
      entries,
      ...(date < TODAY && { reason: 'From the paper register' }),
    });

  /** The Ali Raza month: holidays 9 and 25 Nov, 5-A marked every working day but 19 Nov. */
  async function aliNovember() {
    for (const [name, date] of [
      ['Iqbal Day', '2026-11-09'],
      ['Quaid Day', '2026-11-25'],
    ] as const) {
      await createEvent(school.actor, { type: 'HOLIDAY', name, startDate: date, confirm: false });
    }
    const special: Record<string, AttendanceStatus> = {
      '2026-11-04': 'ABSENT',
      '2026-11-18': 'ABSENT',
      '2026-11-10': 'LEAVE',
      '2026-11-12': 'LATE',
    };
    for (let d = 1; d <= 26; d += 1) {
      const date = `2026-11-${String(d).padStart(2, '0')}`;
      if (dateOnly(date).getUTCDay() === 0) continue;
      if (['2026-11-09', '2026-11-25', '2026-11-19'].includes(date)) continue;
      const status = special[date];
      await mark(date, status ? [{ studentId: ali._id, status }] : []);
    }
  }

  it('dashboard for a day: present %, absent, marked x of y, sections with teachers', async () => {
    await mark(TODAY, [{ studentId: ali._id, status: 'ABSENT' }]);
    const res = await get(adminTokens, `/sections-status?date=${TODAY}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      isWorkingDay: true,
      presentPercent: 50,
      absent: 1,
      markedSections: 1,
      totalSections: 2, // 6-A has no students
    });
    expect(res.body.data.sections).toEqual([
      expect.objectContaining({
        label: '5-A',
        teacher: expect.objectContaining({ fullName: 'Saima Bibi' }),
        marked: true,
        students: 2,
        percent: 50,
      }),
      expect.objectContaining({ label: '5-B', teacher: null, marked: false, percent: null }),
    ]);

    // A teacher sees only their own sections.
    const own = await get(teacherTokens, `/sections-status?date=${TODAY}`);
    expect(own.body.data.sections.map((s: { label: string }) => s.label)).toEqual(['5-A']);
    expect((await get(adminTokens, '/sections-status?date=2026-11-27')).status).toBe(400);
  });

  it('not-marked lists working days with no sheet (holidays and weekends left out)', async () => {
    await createEvent(school.actor, {
      type: 'HOLIDAY',
      name: 'Quaid Day',
      startDate: '2026-11-25',
      confirm: false,
    });
    await mark('2026-11-24');
    await mark(TODAY);
    // 22 Nov is Sunday, 25 Nov a holiday.
    const res = await get(adminTokens, '/not-marked?from=2026-11-22&to=2026-11-26');
    expect(
      res.body.data.items.map((i: { date: string; label: string }) => `${i.date} ${i.label}`),
    ).toEqual(['2026-11-26 5-B', '2026-11-24 5-B', '2026-11-23 5-A', '2026-11-23 5-B']);

    const own = await get(teacherTokens, '/not-marked?from=2026-11-22&to=2026-11-26');
    expect(own.body.data.items).toHaveLength(1);
    // Default: the last 30 days.
    const recent = await get(adminTokens, '/not-marked');
    expect(recent.body.data).toMatchObject({ from: '2026-10-28', to: TODAY });
  });

  it("a student's month: the Ali Raza example and a coloured day list", async () => {
    await aliNovember();
    const res = await get(adminTokens, `/student/${ali._id}?month=2026-11`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      workingDays: 20,
      counted: 19,
      notMarked: 1,
      present: 15,
      late: 1,
      absent: 2,
      leave: 1,
      percent: 84,
    });
    const days = res.body.data.days;
    expect(days).toHaveLength(30);
    expect(days[0]).toMatchObject({ date: '2026-11-01', type: 'WEEKEND' });
    expect(days[3]).toMatchObject({ date: '2026-11-04', status: 'ABSENT', marked: true });
    expect(days[18]).toMatchObject({ date: '2026-11-19', type: 'WORKING', marked: false });
    expect(days[26]).toMatchObject({ date: '2026-11-27', future: true });

    // Teacher of 5-A sees Ali; another teacher does not.
    expect((await get(teacherTokens, `/student/${ali._id}?month=2026-11`)).status).toBe(200);
    const other = await createUser({
      username: 'bilal',
      deviceCode: 'T02',
      assignedSectionIds: [school.s5B],
    });
    const denied = await get(await login(app, other), `/student/${ali._id}?month=2026-11`);
    expect(denied.body.error.code).toBe('SECTION_NOT_ASSIGNED');
  });

  it('monthly register: P / A / L / Lt, S, H, · and totals per student', async () => {
    await aliNovember();
    const res = await get(teacherTokens, `/register?sectionId=${school.s5A}&month=2026-11`);
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data).toMatchObject({
      section: { label: '5-A' },
      month: '2026-11',
      classTeacher: 'Saima Bibi',
      workingDays: 23, // 30 days − 5 Sundays − 2 holidays
      marked: 19,
      notMarked: 1,
    });
    expect(data.rows.map((r: { fullName: string }) => r.fullName)).toEqual([
      'Ali Raza',
      'Sara Khan',
    ]);
    const aliRow = data.rows[0] as { cells: string[]; totals: object };
    const cell = (day: number) => aliRow.cells[day - 1];
    expect([cell(1), cell(2), cell(4), cell(9), cell(10), cell(12), cell(19), cell(27)]).toEqual([
      'S',
      'P',
      'A',
      'H',
      'L',
      'Lt',
      '·',
      '',
    ]);
    expect(aliRow.totals).toMatchObject({ counted: 19, percent: 84 });
    expect(data.rows[1].totals).toMatchObject({ counted: 19, percent: 100 });
    expect(data.days[18]).toMatchObject({ date: '2026-11-19', mark: '·' });

    const denied = await get(teacherTokens, `/register?sectionId=${school.s5B}&month=2026-11`);
    expect(denied.status).toBe(403);
  });
});
