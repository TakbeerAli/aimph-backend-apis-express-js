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
import { User } from '../users/users.model.js';

const api = '/api/v1/auth';

describe('auth', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    await resetDatabase();
    app = createApp(); // fresh rate-limit counters per test
  });

  describe('POST /auth/login', () => {
    it('returns tokens and the profile without any hashes, and audits LOGIN', async () => {
      const admin = await createUser({ role: 'ADMIN' });

      const res = await request(app)
        .post(`${api}/login`)
        .send({ username: 'ADMIN ', password: PASSWORD, deviceCode: 'a' });

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        accessToken: expect.any(String),
        refreshToken: expect.any(String),
        accessTokenExpiresIn: 900,
        user: { _id: admin._id, username: 'admin', role: 'ADMIN', deviceCode: 'A' },
      });
      expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|refreshTokenHash/);

      const stored = await User.findById(admin._id).select('+refreshTokenHash').lean();
      expect(stored?.refreshTokenHash).toMatch(/^[a-f0-9]{64}$/);
      expect(stored?.lastLoginAt).toBeInstanceOf(Date);
      expect(await AuditLog.countDocuments({ action: 'LOGIN', userId: admin._id })).toBe(1);
    });

    it.each([
      ['wrong password', { password: 'wrong-password' }, 'WRONG_PASSWORD'],
      ['unknown username', { username: 'ghost' }, 'UNKNOWN_USER'],
      ['another device', { deviceCode: 'S2' }, 'DEVICE_MISMATCH'],
    ])('rejects %s with UNAUTHORIZED and audits LOGIN_FAILED', async (_name, change, reason) => {
      await createUser({ username: 'staff1', deviceCode: 'S1' });

      const res = await request(app)
        .post(`${api}/login`)
        .send({ username: 'staff1', password: PASSWORD, deviceCode: 'S1', ...change });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
      const audit = await AuditLog.findOne({ action: 'LOGIN_FAILED' }).lean();
      expect(audit?.reason).toBe(reason);
      expect(JSON.stringify(audit)).not.toContain('wrong-password');
    });

    it('rejects inactive users', async () => {
      await createUser({ isActive: false });
      const res = await request(app)
        .post(`${api}/login`)
        .send({ username: 'staff1', password: PASSWORD, deviceCode: 'S1' });

      expect(res.status).toBe(401);
    });

    it('blocks the 6th failed attempt within 15 minutes', async () => {
      await createUser();
      const attempt = () =>
        request(app)
          .post(`${api}/login`)
          .send({ username: 'staff1', password: 'wrong-password', deviceCode: 'S1' });

      for (let i = 0; i < 5; i++) expect((await attempt()).status).toBe(401);
      const blocked = await attempt();

      expect(blocked.status).toBe(429);
      expect(blocked.body.error.code).toBe('RATE_LIMITED');
    });

    it('returns VALIDATION_ERROR for a missing field', async () => {
      const res = await request(app).post(`${api}/login`).send({ username: 'staff1' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('protected routes', () => {
    it('GET /auth/me needs a valid token', async () => {
      const user = await createUser();
      const tokens = await login(app, user);

      expect((await request(app).get(`${api}/me`)).status).toBe(401);
      expect(
        (await request(app).get(`${api}/me`).set('Authorization', 'Bearer not-a-token')).status,
      ).toBe(401);
      // A refresh token is not accepted as an access token.
      expect(
        (await request(app).get(`${api}/me`).set('Authorization', `Bearer ${tokens.refreshToken}`))
          .status,
      ).toBe(401);

      const res = await request(app).get(`${api}/me`).set('Authorization', bearer(tokens));
      expect(res.status).toBe(200);
      expect(res.body.data.username).toBe('staff1');
    });

    it('rejects an existing access token as soon as the user is deactivated', async () => {
      const user = await createUser();
      const tokens = await login(app, user);
      await User.updateOne({ _id: user._id }, { $set: { isActive: false } });

      const res = await request(app).get(`${api}/me`).set('Authorization', bearer(tokens));
      expect(res.status).toBe(401);
    });
  });

  describe('POST /auth/refresh', () => {
    let tokens: Tokens;

    beforeEach(async () => {
      tokens = await login(app, await createUser());
    });

    const refresh = (refreshToken: string) =>
      request(app).post(`${api}/refresh`).send({ refreshToken });

    it('rotates the refresh token', async () => {
      const res = await refresh(tokens.refreshToken);

      expect(res.status).toBe(200);
      expect(res.body.data.refreshToken).not.toBe(tokens.refreshToken);
      expect(res.body.data.accessToken).toEqual(expect.any(String));
    });

    it('treats reuse of an old token as theft and revokes the session', async () => {
      const second = ((await refresh(tokens.refreshToken)).body as { data: Tokens }).data;

      const reuse = await refresh(tokens.refreshToken);
      expect(reuse.status).toBe(401);

      // The newest token was revoked too, so the user must log in again.
      expect((await refresh(second.refreshToken)).status).toBe(401);
    });

    it('fails after logout', async () => {
      const out = await request(app).post(`${api}/logout`).set('Authorization', bearer(tokens));
      expect(out.status).toBe(200);

      expect((await refresh(tokens.refreshToken)).status).toBe(401);
    });

    it('fails for an access token or garbage', async () => {
      expect((await refresh(tokens.accessToken)).status).toBe(401);
      expect((await refresh('garbage')).status).toBe(401);
    });
  });

  describe('POST /auth/change-password', () => {
    it('changes the password and returns new tokens', async () => {
      const user = await createUser();
      const tokens = await login(app, user);

      const res = await request(app)
        .post(`${api}/change-password`)
        .set('Authorization', bearer(tokens))
        .send({ currentPassword: PASSWORD, newPassword: 'new-password-1' });

      expect(res.status).toBe(200);
      expect(res.body.data.refreshToken).toEqual(expect.any(String));
      await expect(login(app, user)).rejects.toThrow();
      await expect(login(app, user, 'new-password-1')).resolves.toBeTruthy();
      expect(await AuditLog.countDocuments({ action: 'PASSWORD_CHANGE' })).toBe(1);
    });

    it('rejects a wrong current password and a short new one', async () => {
      const tokens = await login(app, await createUser());
      const change = (body: object) =>
        request(app).post(`${api}/change-password`).set('Authorization', bearer(tokens)).send(body);

      expect(
        (await change({ currentPassword: 'nope-nope', newPassword: 'new-password-1' })).status,
      ).toBe(400);
      expect((await change({ currentPassword: PASSWORD, newPassword: 'short' })).status).toBe(400);
    });
  });
});
