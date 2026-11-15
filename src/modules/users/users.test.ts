import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  bearer,
  createUser,
  login,
  PASSWORD,
  resetDatabase,
  type Tokens,
} from '../../../test/helpers.js';
import { createApp } from '../../app.js';
import { AuditLog } from '../../common/audit.js';
import type { UserDoc } from './users.model.js';

const api = '/api/v1/users';

describe('users (Admin)', () => {
  let app: ReturnType<typeof createApp>;
  let admin: UserDoc;
  let staff: UserDoc;
  let adminTokens: Tokens;
  let staffTokens: Tokens;

  beforeEach(async () => {
    await resetDatabase();
    app = createApp();
    admin = await createUser({ role: 'ADMIN' });
    staff = await createUser({ username: 'staff1', deviceCode: 'S1' });
    adminTokens = await login(app, admin);
    staffTokens = await login(app, staff);
  });

  it('Staff cannot use any /users route (FORBIDDEN)', async () => {
    const res = await request(app).get(api).set('Authorization', bearer(staffTokens));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('lists users with paging and no hashes', async () => {
    const res = await request(app)
      .get(`${api}?limit=1&sort=-username`)
      .set('Authorization', bearer(adminTokens));

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ page: 1, limit: 1, total: 2 });
    expect(res.body.data.items[0].username).toBe('staff1');
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|refreshTokenHash/);
  });

  it('creates a Staff user who can then log in', async () => {
    const res = await request(app)
      .post(api)
      .set('Authorization', bearer(adminTokens))
      .send({
        fullName: 'Second Staff',
        username: 'Staff2',
        password: 'staff2-password',
        deviceCode: 's2',
        assignedClassIds: ['c1', 'c1', 'c2'],
        role: 'ADMIN', // ignored: only Staff can be created here
      });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      username: 'staff2',
      deviceCode: 'S2',
      role: 'STAFF',
      assignedClassIds: ['c1', 'c2'],
      version: 1,
      createdBy: admin._id,
    });
    await expect(
      login(app, { username: 'staff2', deviceCode: 'S2' }, 'staff2-password'),
    ).resolves.toBeTruthy();
    expect(await AuditLog.countDocuments({ action: 'USER_CREATE' })).toBe(1);
  });

  it('rejects a duplicate username or device code with CONFLICT', async () => {
    const create = (body: object) =>
      request(app)
        .post(api)
        .set('Authorization', bearer(adminTokens))
        .send({ fullName: 'X', password: 'password-123', ...body });

    expect((await create({ username: 'staff1', deviceCode: 'S9' })).body.error.code).toBe(
      'CONFLICT',
    );
    expect((await create({ username: 'other', deviceCode: 'S1' })).status).toBe(409);
  });

  it('deactivating a user logs them out and blocks their token', async () => {
    const res = await request(app)
      .patch(`${api}/${staff._id}`)
      .set('Authorization', bearer(adminTokens))
      .send({ isActive: false });

    expect(res.status).toBe(200);
    expect(res.body.data.version).toBe(staff.version + 2); // +1 login, +1 this update
    const me = await request(app).get('/api/v1/auth/me').set('Authorization', bearer(staffTokens));
    expect(me.status).toBe(401);
    const refresh = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: staffTokens.refreshToken });
    expect(refresh.status).toBe(401);

    const audit = await AuditLog.findOne({ action: 'USER_UPDATE' }).lean();
    expect(audit?.before).toEqual({ isActive: true });
    expect(audit?.after).toEqual({ isActive: false });
  });

  it('Admin cannot deactivate their own account', async () => {
    const res = await request(app)
      .patch(`${api}/${admin._id}`)
      .set('Authorization', bearer(adminTokens))
      .send({ isActive: false });
    expect(res.status).toBe(400);
  });

  it('reset-password sets a new password and ends the user session', async () => {
    const res = await request(app)
      .post(`${api}/${staff._id}/reset-password`)
      .set('Authorization', bearer(adminTokens))
      .send({ newPassword: 'reset-password-1' });

    expect(res.status).toBe(200);
    await expect(login(app, staff, PASSWORD)).rejects.toThrow();
    const refresh = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: staffTokens.refreshToken });
    expect(refresh.status).toBe(401);
    await expect(login(app, staff, 'reset-password-1')).resolves.toBeTruthy();
  });

  it('sign-out revokes the refresh token (lost phone)', async () => {
    const res = await request(app)
      .post(`${api}/${staff._id}/sign-out`)
      .set('Authorization', bearer(adminTokens));

    expect(res.status).toBe(200);
    const refresh = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: staffTokens.refreshToken });
    expect(refresh.status).toBe(401);
  });

  it('returns NOT_FOUND for an unknown user id', async () => {
    const res = await request(app)
      .post(`${api}/does-not-exist/sign-out`)
      .set('Authorization', bearer(adminTokens));
    expect(res.status).toBe(404);
  });
});
