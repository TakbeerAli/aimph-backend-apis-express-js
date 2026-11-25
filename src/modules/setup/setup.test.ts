import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
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
import { User } from '../users/users.model.js';

/** Phase 2 (Admin set-up design A-01 … A-07) additions to the API. */

// 1×1 transparent PNG.
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe('Admin set-up additions', () => {
  let app: ReturnType<typeof createApp>;
  let school: Awaited<ReturnType<typeof setupSchool>>;
  let adminTokens: Tokens;

  beforeEach(async () => {
    await resetDatabase();
    app = createApp();
    school = await setupSchool();
    adminTokens = await login(app, school.admin);
  });

  const asAdmin = (method: 'get' | 'post' | 'put' | 'patch' | 'delete', url: string) =>
    request(app)[method](`/api/v1${url}`).set('Authorization', bearer(adminTokens));

  describe('GET /setup/status', () => {
    it('reports each of the 7 steps from the real data', async () => {
      const res = await asAdmin('get', '/setup/status');
      expect(res.status).toBe(200);
      const byKey = Object.fromEntries(
        (res.body.data.steps as { key: string; done: boolean; detail: object }[]).map((s) => [
          s.key,
          s,
        ]),
      );
      expect(res.body.data).toMatchObject({ total: 7, complete: false });
      // No address or phone yet.
      expect(byKey.schoolProfile).toMatchObject({ done: false });
      expect(byKey.session).toMatchObject({ done: true, detail: { name: '2026-27' } });
      expect(byKey.classes).toMatchObject({ done: true, detail: { classes: 2, sections: 3 } });
      expect(byKey.fees).toMatchObject({ done: true, detail: { withFees: 2, classes: 2 } });
      expect(byKey.staff).toMatchObject({ done: false, detail: { staff: 0 } });
      expect(byKey.students).toMatchObject({ done: false });
      expect(byKey.openingBalances).toMatchObject({ done: false });
    });

    it('completes when every step is done (opening balances may be skipped)', async () => {
      await asAdmin('patch', '/settings').send({
        address: 'Main Road',
        phone: '051-0000000',
        openingBalancesSkipped: true,
      });
      await createUser({ username: 'staff1', deviceCode: 'S1' });
      await admit(school.actor, { classId: school.class5Id, sectionId: school.s5A });

      const res = await asAdmin('get', '/setup/status');
      expect(res.body.data).toMatchObject({ doneCount: 7, complete: true });
    });

    it('is Admin only', async () => {
      const staff = await createUser({ username: 'staff1', deviceCode: 'S1' });
      const tokens = await login(app, staff);
      const res = await request(app)
        .get('/api/v1/setup/status')
        .set('Authorization', bearer(tokens));
      expect(res.status).toBe(403);
    });
  });

  describe('school logo', () => {
    it('is uploaded, kept out of /settings, read back and removed', async () => {
      expect((await asAdmin('get', '/settings/logo')).body.data.dataUri).toBeNull();

      const put = await asAdmin('put', '/settings/logo').send({ dataUri: PNG });
      expect(put.status).toBe(200);
      expect(put.body.data.updatedAt).toBeTruthy();

      const settings = await asAdmin('get', '/settings');
      expect(settings.body.data.logoUpdatedAt).toBeTruthy();
      expect(JSON.stringify(settings.body)).not.toContain('base64');

      expect((await asAdmin('get', '/settings/logo')).body.data.dataUri).toBe(PNG);

      await asAdmin('delete', '/settings/logo');
      expect((await asAdmin('get', '/settings/logo')).body.data.dataUri).toBeNull();
    });

    it('rejects anything that is not a PNG or JPEG data URI', async () => {
      const res = await asAdmin('put', '/settings/logo').send({
        dataUri: 'data:text/html;base64,PHNjcmlwdD4=',
      });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /sessions', () => {
    it('adds the student count and unpaid dues of each session', async () => {
      await admit(school.actor, { classId: school.class5Id, sectionId: school.s5A });
      const res = await asAdmin('get', '/sessions');
      expect(res.body.data[0]).toMatchObject({
        name: '2026-27',
        studentCount: 1,
        // Admission voucher: tuition 2,500 + admission 5,000.
        openDues: 7500,
      });
    });
  });

  describe('staff accounts', () => {
    const newStaff = (over: object = {}) =>
      asAdmin('post', '/users').send({
        fullName: 'Muhammad Asif',
        username: 'staff1',
        password: 'first-password',
        deviceCode: 'S1',
        phone: '0300-0000000',
        assignedClassIds: [school.class5Id],
        ...over,
      });

    it('a new staff member must change the password at first sign-in', async () => {
      const res = await newStaff();
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ phone: '0300-0000000', mustChangePassword: true });

      const tokens = await login(app, { username: 'staff1', deviceCode: 'S1' }, 'first-password');
      const change = await request(app)
        .post('/api/v1/auth/change-password')
        .set('Authorization', bearer(tokens))
        .send({ currentPassword: 'first-password', newPassword: 'my-own-password' });
      expect(change.status).toBe(200);
      expect((await User.findOne({ username: 'staff1' }))?.mustChangePassword).toBe(false);
    });

    it('resetting a password asks for a new one again', async () => {
      const created = await newStaff();
      await User.updateOne({ _id: created.body.data._id }, { mustChangePassword: false });
      await asAdmin('post', `/users/${created.body.data._id}/reset-password`).send({
        newPassword: 'temporary-123',
      });
      expect((await User.findById(created.body.data._id))?.mustChangePassword).toBe(true);
    });

    it('a class can belong to only one staff member', async () => {
      expect((await newStaff()).status).toBe(201);
      const second = await newStaff({ username: 'staff2', deviceCode: 'S2' });
      expect(second.status).toBe(409);
      expect(second.body.error.message).toBe(
        'Class 5 is already assigned to Muhammad Asif. A class can belong to only one staff member.',
      );

      const other = await newStaff({
        username: 'staff2',
        deviceCode: 'S2',
        assignedClassIds: [school.class6Id],
      });
      const move = await asAdmin('patch', `/users/${other.body.data._id}`).send({
        assignedClassIds: [school.class6Id, school.class5Id],
      });
      expect(move.status).toBe(409);
    });

    it('the mobile number can be changed or cleared', async () => {
      const created = await newStaff();
      const res = await asAdmin('patch', `/users/${created.body.data._id}`).send({ phone: null });
      expect(res.status).toBe(200);
      expect(res.body.data.phone).toBeNull();
    });
  });
});
