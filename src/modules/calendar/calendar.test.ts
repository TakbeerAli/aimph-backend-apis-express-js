import mongoose from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  bearer,
  createUser,
  login,
  resetDatabase,
  setupSchool,
  type Tokens,
} from '../../../test/helpers.js';
import { createApp } from '../../app.js';
import { AuditLog } from '../../common/audit.js';
import { CalendarEvent } from './calendar.model.js';

describe('school calendar', () => {
  let app: ReturnType<typeof createApp>;
  let adminTokens: Tokens;
  let teacherTokens: Tokens;

  beforeEach(async () => {
    await resetDatabase();
    app = createApp();
    const school = await setupSchool();
    adminTokens = await login(app, school.admin);
    teacherTokens = await login(app, await createUser());
  });

  const as = (tokens: Tokens) => ({
    get: (path: string) => request(app).get(`/api/v1${path}`).set('Authorization', bearer(tokens)),
    post: (path: string, body: object) =>
      request(app).post(`/api/v1${path}`).set('Authorization', bearer(tokens)).send(body),
    patch: (path: string, body: object) =>
      request(app).patch(`/api/v1${path}`).set('Authorization', bearer(tokens)).send(body),
    delete: (path: string) =>
      request(app).delete(`/api/v1${path}`).set('Authorization', bearer(tokens)),
  });
  const holiday = (name: string, startDate: string, endDate?: string, confirm?: boolean) =>
    as(adminTokens).post('/calendar/events', {
      type: 'HOLIDAY',
      name,
      startDate,
      ...(endDate && { endDate }),
      ...(confirm && { confirm }),
    });
  const makeUp = (startDate: string, endDate?: string) =>
    as(adminTokens).post('/calendar/events', {
      type: 'WORKING_DAY',
      name: 'Make-up day',
      startDate,
      ...(endDate && { endDate }),
    });
  /** An attendance sheet as stage B3 will store it. */
  const markSheet = (date: string) =>
    mongoose.connection
      .collection<{ _id: string }>('attendance_sheets')
      .insertOne({ _id: `sheet-${date}`, sectionId: 's', date } as never);

  it('weekly off days default to Sunday; Admin changes them, teachers only read', async () => {
    expect((await as(teacherTokens).get('/settings/calendar')).body.data).toEqual({
      weeklyOffDays: [0],
    });
    const denied = await as(teacherTokens).patch('/settings/calendar', { weeklyOffDays: [6, 0] });
    expect(denied.status).toBe(403);
    const res = await as(adminTokens).patch('/settings/calendar', { weeklyOffDays: [6, 0, 0] });
    expect(res.body.data).toEqual({ weeklyOffDays: [0, 6] });
    expect(await AuditLog.countDocuments({ action: 'WEEKLY_OFF_UPDATE' })).toBe(1);
    const bad = await as(adminTokens).patch('/settings/calendar', { weeklyOffDays: [7] });
    expect(bad.status).toBe(400);
  });

  it('GET /calendar shows weekends, holidays and the working-day count of a month', async () => {
    expect((await holiday('Iqbal Day', '2026-11-09')).status).toBe(201);
    await holiday('Quaid Day', '2026-11-25');
    const res = await as(teacherTokens).get('/calendar?month=2026-11');
    expect(res.status).toBe(200);
    const { days, workingDays, events, weeklyOffDays } = res.body.data;
    expect(weeklyOffDays).toEqual([0]);
    expect(days).toHaveLength(30);
    expect(days[0]).toMatchObject({ date: '2026-11-01', type: 'WEEKEND', inSession: true });
    expect(days[8]).toMatchObject({ date: '2026-11-09', type: 'HOLIDAY', names: ['Iqbal Day'] });
    // 30 days − 5 Sundays − 2 holidays.
    expect(workingDays).toBe(23);
    expect(events).toHaveLength(2);
  });

  it('days outside the session are not counted', async () => {
    const res = await as(adminTokens).get('/calendar?month=2026-03');
    expect(res.body.data.workingDays).toBe(0);
    expect(res.body.data.days[0].inSession).toBe(false);
  });

  it('a holiday range, and dates must be inside the current session', async () => {
    const winter = await holiday('Winter vacation', '2026-12-20', '2026-12-31');
    expect(winter.status).toBe(201);
    expect(winter.body.data).toMatchObject({ startDate: '2026-12-20', endDate: '2026-12-31' });
    expect((await holiday('Too early', '2026-03-30')).status).toBe(400);
    expect((await holiday('Backwards', '2026-12-10', '2026-12-01')).status).toBe(400);
    expect(await AuditLog.countDocuments({ action: 'CALENDAR_EVENT_CREATE' })).toBe(1);
  });

  it('a make-up working day must be a single weekly off day, not in a holiday', async () => {
    expect((await makeUp('2026-11-15')).status).toBe(201); // Sunday
    expect((await makeUp('2026-11-15')).status).toBe(409); // already one
    expect((await makeUp('2026-11-16')).status).toBe(400); // Monday: already working
    expect((await makeUp('2026-11-22', '2026-11-29')).status).toBe(400); // a range
    await holiday('Winter vacation', '2026-12-20', '2026-12-31');
    expect((await makeUp('2026-12-27')).body.error.message).toBe(
      '2026-12-27 is inside the holiday "Winter vacation".',
    );

    const month = await as(adminTokens).get('/calendar?month=2026-11');
    expect(month.body.data.days[14]).toMatchObject({ type: 'WORKING', isException: true });
  });

  it('warns before a holiday covers days with attendance; confirm=true goes ahead', async () => {
    await markSheet('2026-11-10');
    const warned = await holiday('Rain holiday', '2026-11-10', '2026-11-11');
    expect(warned.status).toBe(409);
    expect(warned.body.error).toMatchObject({
      code: 'ATTENDANCE_EXISTS',
      details: { dates: ['2026-11-10'] },
    });
    expect(await CalendarEvent.countDocuments()).toBe(0);

    const done = await holiday('Rain holiday', '2026-11-10', '2026-11-11', true);
    expect(done.status).toBe(201);
    // The attendance record itself is kept.
    expect(await mongoose.connection.collection('attendance_sheets').countDocuments()).toBe(1);
  });

  it('edits and deletes (kept as deleted for sync), Admin only', async () => {
    const created = (await holiday('Iqbal Day', '2026-11-09')).body.data;
    const path = `/calendar/events/${created._id}`;
    expect((await as(teacherTokens).delete(path)).status).toBe(403);

    const renamed = await as(adminTokens).patch(path, { name: 'Allama Iqbal Day' });
    expect(renamed.body.data).toMatchObject({ name: 'Allama Iqbal Day', version: 2 });

    await markSheet('2026-11-09');
    expect((await as(adminTokens).delete(path)).body.error.code).toBe('ATTENDANCE_EXISTS');
    const deleted = await as(adminTokens).delete(`${path}?confirm=true`);
    expect(deleted.status).toBe(200);
    expect(deleted.body.data.isDeleted).toBe(true);

    const month = await as(adminTokens).get('/calendar?month=2026-11');
    expect(month.body.data.events).toHaveLength(0);
    expect(month.body.data.days[8].type).toBe('WORKING');
    expect((await as(adminTokens).delete(path)).status).toBe(404);

    // Phones receive the deletion through sync.
    const pull = await as(teacherTokens).get('/sync/pull?since=0&limit=500');
    expect(pull.body.data.changes.calendar_events).toEqual([
      expect.objectContaining({ _id: created._id, isDeleted: true }),
    ]);
  });
});
