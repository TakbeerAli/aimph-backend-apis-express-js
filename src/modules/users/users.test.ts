import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  bearer,
  createUser,
  login,
  PASSWORD,
  resetDatabase,
  setupSchool,
  type Tokens,
} from '../../../test/helpers.js';
import { createApp } from '../../app.js';
import { AuditLog } from '../../common/audit.js';
import { User, type UserDoc } from './users.model.js';

const teachersApi = '/api/v1/teachers';
const usersApi = '/api/v1/users';

describe('teachers and users (Admin)', () => {
  let app: ReturnType<typeof createApp>;
  let school: Awaited<ReturnType<typeof setupSchool>>;
  let teacher: UserDoc;
  let adminTokens: Tokens;
  let teacherTokens: Tokens;

  beforeEach(async () => {
    await resetDatabase();
    app = createApp();
    school = await setupSchool();
    // An existing teacher from before the rename keeps the old phone code S1.
    teacher = await createUser({ username: 'staff1', deviceCode: 'S1' });
    adminTokens = await login(app, school.admin);
    teacherTokens = await login(app, teacher);
  });

  const as = (tokens: Tokens) => ({
    get: (path: string) => request(app).get(path).set('Authorization', bearer(tokens)),
    post: (path: string, body: object = {}) =>
      request(app).post(path).set('Authorization', bearer(tokens)).send(body),
    patch: (path: string, body: object) =>
      request(app).patch(path).set('Authorization', bearer(tokens)).send(body),
  });

  const newTeacher = (over: object = {}) =>
    as(adminTokens).post(teachersApi, {
      fullName: 'Saima Bibi',
      username: 'saima',
      password: 'first-password',
      phone: '0300-0000000',
      assignedSectionIds: [school.s5A],
      ...over,
    });

  it('a teacher cannot use /teachers or /users (FORBIDDEN)', async () => {
    expect((await as(teacherTokens).get(teachersApi)).status).toBe(403);
    const res = await as(teacherTokens).get(usersApi);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('lists users with paging and no hashes or sync bookkeeping', async () => {
    const res = await as(adminTokens).get(`${usersApi}?limit=1&sort=-username`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ page: 1, limit: 1, total: 2 });
    expect(res.body.data.items[0].username).toBe('staff1');
    expect(JSON.stringify(res.body)).not.toMatch(
      /passwordHash|refreshTokenHash|revokedSections|sectionsAddedSeq/,
    );
  });

  it('creates teachers with phone codes T01, T02 … who can log in', async () => {
    const res = await newTeacher({ username: 'Saima', role: 'ADMIN', deviceCode: 'A' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      username: 'saima',
      // Role and phone code are chosen by the server, never by the request.
      role: 'TEACHER',
      deviceCode: 'T01',
      assignedSectionIds: [school.s5A],
      mustChangePassword: true,
      createdBy: school.admin._id,
    });
    const second = await newTeacher({
      username: 'bilal',
      fullName: 'Bilal Ahmed',
      assignedSectionIds: [school.s5B, school.s6A, school.s5B],
    });
    expect(second.body.data).toMatchObject({
      deviceCode: 'T02',
      assignedSectionIds: [school.s5B, school.s6A],
    });
    await expect(
      login(app, { username: 'saima', deviceCode: 'T01' }, 'first-password'),
    ).resolves.toBeTruthy();
    expect(await AuditLog.countDocuments({ action: 'TEACHER_CREATE' })).toBe(2);
  });

  it('a section belongs to one teacher: SECTION_ALREADY_ASSIGNED names the owner', async () => {
    expect((await newTeacher()).status).toBe(201);
    const second = await newTeacher({ username: 'bilal', fullName: 'Bilal Ahmed' });
    expect(second.status).toBe(409);
    expect(second.body.error).toMatchObject({
      code: 'SECTION_ALREADY_ASSIGNED',
      message: '5-A is already assigned to Saima Bibi. Remove it from that teacher first.',
      details: { section: '5-A', teacher: 'Saima Bibi' },
    });

    const bilal = await newTeacher({
      username: 'bilal',
      fullName: 'Bilal Ahmed',
      assignedSectionIds: [school.s5B],
    });
    const move = await as(adminTokens).patch(`${teachersApi}/${bilal.body.data._id}`, {
      assignedSectionIds: [school.s5B, school.s5A],
    });
    expect(move.status).toBe(409);
    expect(move.body.error.code).toBe('SECTION_ALREADY_ASSIGNED');
  });

  it('an inactive teacher frees their sections, but cannot come back over a taken one', async () => {
    const saima = await newTeacher();
    await as(adminTokens).patch(`${teachersApi}/${saima.body.data._id}`, { isActive: false });
    expect((await newTeacher({ username: 'bilal', fullName: 'Bilal Ahmed' })).status).toBe(201);
    const back = await as(adminTokens).patch(`${teachersApi}/${saima.body.data._id}`, {
      isActive: true,
    });
    expect(back.status).toBe(409);
  });

  it('lists teachers and warns about sections without a teacher', async () => {
    await newTeacher();
    const res = await as(adminTokens).get(teachersApi);
    expect(res.status).toBe(200);
    expect(res.body.data.items.map((t: { username: string }) => t.username)).toEqual([
      'staff1',
      'saima',
    ]);
    expect(res.body.data.unassignedSections.map((s: { label: string }) => s.label)).toEqual([
      '5-B',
      '6-A',
    ]);
  });

  it('changing sections is audited as SECTIONS_ASSIGN', async () => {
    const res = await as(adminTokens).patch(`${teachersApi}/${teacher._id}`, {
      assignedSectionIds: [school.s6A],
    });
    expect(res.status).toBe(200);
    const audit = await AuditLog.findOne({ action: 'SECTIONS_ASSIGN' }).lean();
    expect(audit?.after).toEqual({ assignedSectionIds: [school.s6A] });
  });

  it('rejects sections that do not exist', async () => {
    const res = await as(adminTokens).patch(`${teachersApi}/${teacher._id}`, {
      assignedSectionIds: ['no-such-section'],
    });
    expect(res.status).toBe(400);
  });

  it('rejects a duplicate username with CONFLICT', async () => {
    const res = await newTeacher({ username: 'staff1', assignedSectionIds: [] });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('deactivating a teacher logs them out and blocks their token', async () => {
    const res = await as(adminTokens).patch(`${teachersApi}/${teacher._id}`, {
      isActive: false,
    });

    expect(res.status).toBe(200);
    expect(res.body.data.version).toBe(teacher.version + 2); // +1 login, +1 this update
    const me = await as(teacherTokens).get('/api/v1/auth/me');
    expect(me.status).toBe(401);
    const refresh = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: teacherTokens.refreshToken });
    expect(refresh.status).toBe(401);

    const audit = await AuditLog.findOne({ action: 'TEACHER_UPDATE' }).lean();
    expect(audit?.before).toEqual({ isActive: true });
    expect(audit?.after).toEqual({ isActive: false });
  });

  it('Admin cannot deactivate their own account', async () => {
    const res = await as(adminTokens).patch(`${teachersApi}/${school.admin._id}`, {
      isActive: false,
    });
    expect(res.status).toBe(400);
  });

  it.each([teachersApi, usersApi])(
    '%s reset-password sets a new password and ends the session',
    async (base) => {
      const res = await as(adminTokens).post(`${base}/${teacher._id}/reset-password`, {
        newPassword: 'reset-password-1',
      });
      expect(res.status).toBe(200);
      await expect(login(app, teacher, PASSWORD)).rejects.toThrow();
      const refresh = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: teacherTokens.refreshToken });
      expect(refresh.status).toBe(401);
      await expect(login(app, teacher, 'reset-password-1')).resolves.toBeTruthy();
      expect((await User.findById(teacher._id))?.mustChangePassword).toBe(true);
    },
  );

  it('sign-out revokes the refresh token (lost phone)', async () => {
    const res = await as(adminTokens).post(`${teachersApi}/${teacher._id}/sign-out`);
    expect(res.status).toBe(200);
    const refresh = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: teacherTokens.refreshToken });
    expect(refresh.status).toBe(401);
  });

  it('returns NOT_FOUND for an unknown user id', async () => {
    const res = await as(adminTokens).post(`${teachersApi}/does-not-exist/sign-out`);
    expect(res.status).toBe(404);
  });
});
