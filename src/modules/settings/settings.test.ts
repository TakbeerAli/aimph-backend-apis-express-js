import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { bearer, createUser, login, resetDatabase, type Tokens } from '../../../test/helpers.js';
import { createApp } from '../../app.js';
import { AuditLog } from '../../common/audit.js';
import { SETTINGS_ID } from '../../db/counters.js';
import { Settings } from './settings.model.js';

const api = '/api/v1/settings';

describe('settings', () => {
  let app: ReturnType<typeof createApp>;
  let adminTokens: Tokens;
  let staffTokens: Tokens;

  beforeEach(async () => {
    await resetDatabase();
    app = createApp();
    adminTokens = await login(app, await createUser({ role: 'ADMIN' }));
    staffTokens = await login(app, await createUser());
  });

  it('Staff can read settings, without the internal counters', async () => {
    const res = await request(app).get(api).set('Authorization', bearer(staffTokens));

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ voucherIssueDay: 1, voucherDueDay: 10 });
    expect(res.body.data.counters).toBeUndefined();
  });

  it('Staff cannot update settings', async () => {
    const res = await request(app)
      .patch(api)
      .set('Authorization', bearer(staffTokens))
      .send({ phone: '123' });
    expect(res.status).toBe(403);
  });

  it('Admin updates fields, merges bank details, cannot touch counters, and it is audited', async () => {
    const before = await Settings.findById(SETTINGS_ID).lean();
    const res = await request(app)
      .patch(api)
      .set('Authorization', bearer(adminTokens))
      .send({
        phone: '051-1234567',
        bank: { bankName: 'HBL' },
        counters: { admissionNo: 1 },
        currentSessionId: 'hack',
      });

    expect(res.status).toBe(200);
    const stored = await Settings.findById(SETTINGS_ID).lean();
    expect(stored).toMatchObject({
      phone: '051-1234567',
      bank: { bankName: 'HBL', accountNo: '' },
      currentSessionId: null,
    });
    expect(stored?.counters.admissionNo).toBe(1000);
    expect(stored?.version).toBe((before?.version ?? 0) + 1);

    const audit = await AuditLog.findOne({ action: 'SETTINGS_UPDATE' }).lean();
    expect(audit?.after).toMatchObject({ phone: '051-1234567' });
  });

  it('rejects a due day before the issue day', async () => {
    const res = await request(app)
      .patch(api)
      .set('Authorization', bearer(adminTokens))
      .send({ voucherIssueDay: 15, voucherDueDay: 10 });
    expect(res.status).toBe(400);
  });
});
