import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { bearer, createUser, login, resetDatabase, type Tokens } from '../../../test/helpers.js';
import { createApp } from '../../app.js';
import { SETTINGS_ID } from '../../db/counters.js';
import { Settings } from '../settings/settings.model.js';
import { AcademicSession } from './sessions.model.js';

const api = '/api/v1/sessions';

describe('academic sessions', () => {
  let app: ReturnType<typeof createApp>;
  let adminTokens: Tokens;
  let staffTokens: Tokens;

  beforeEach(async () => {
    await resetDatabase();
    app = createApp();
    adminTokens = await login(app, await createUser({ role: 'ADMIN' }));
    staffTokens = await login(app, await createUser());
  });

  const create = (name: string, tokens = adminTokens) =>
    request(app).post(api).set('Authorization', bearer(tokens)).send({ name });

  it('the first session runs 1 April – 31 March and becomes current', async () => {
    const res = await create('2026-27');

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      name: '2026-27',
      startDate: '2026-04-01T00:00:00.000Z',
      endDate: '2027-03-31T00:00:00.000Z',
      isCurrent: true,
      status: 'ACTIVE',
    });
    const settings = await Settings.findById(SETTINGS_ID).lean();
    expect(settings?.currentSessionId).toBe(res.body.data._id);
  });

  it('later sessions are not made current automatically', async () => {
    await create('2026-27');
    const res = await create('2027-28');

    expect(res.body.data.isCurrent).toBe(false);
    expect(await AcademicSession.countDocuments({ isCurrent: true })).toBe(1);
  });

  it('rejects bad names and duplicates', async () => {
    expect((await create('2026-28')).status).toBe(400);
    expect((await create('26-27')).status).toBe(400);
    await create('2026-27');
    expect((await create('2026-27')).status).toBe(409);
  });

  it('Staff can list sessions but not create them', async () => {
    await create('2025-26');
    await create('2026-27');

    const list = await request(app).get(api).set('Authorization', bearer(staffTokens));
    expect(list.status).toBe(200);
    expect(list.body.data.map((s: { name: string }) => s.name)).toEqual(['2026-27', '2025-26']);
    expect((await create('2027-28', staffTokens)).status).toBe(403);
  });
});
