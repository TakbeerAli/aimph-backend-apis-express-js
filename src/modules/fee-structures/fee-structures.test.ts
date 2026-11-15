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
import { createSession } from '../sessions/sessions.service.js';
import { FeeStructure } from './fee-structures.model.js';

const api = '/api/v1/fee-structures';

describe('fee structures', () => {
  let app: ReturnType<typeof createApp>;
  let school: Awaited<ReturnType<typeof setupSchool>>;
  let adminTokens: Tokens;
  let staffTokens: Tokens;

  beforeEach(async () => {
    await resetDatabase();
    app = createApp();
    school = await setupSchool();
    adminTokens = await login(app, school.admin);
    staffTokens = await login(app, await createUser());
  });

  it('Staff can list the current session structures', async () => {
    const res = await request(app).get(api).set('Authorization', bearer(staffTokens));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          classId: school.class5Id,
          tuitionFee: 2500,
          admissionFee: 5000,
          examFee: 500,
        }),
      ]),
    );
  });

  it('PUT updates the amounts and audits the old values', async () => {
    const res = await request(app)
      .put(`${api}/${school.sessionId}/${school.class5Id}`)
      .set('Authorization', bearer(adminTokens))
      .send({ tuitionFee: 2700, admissionFee: 5000, examFee: 500 });

    expect(res.status).toBe(200);
    expect(res.body.data.tuitionFee).toBe(2700);
    const audit = await AuditLog.findOne({
      action: 'FEE_STRUCTURE_UPDATE',
      entityId: res.body.data._id,
      'before.tuitionFee': 2500,
    }).lean();
    expect(audit?.after).toEqual({ tuitionFee: 2700 });
  });

  it('PUT rejects non-integer or negative money, and Staff', async () => {
    const put = (body: object, tokens = adminTokens) =>
      request(app)
        .put(`${api}/${school.sessionId}/${school.class5Id}`)
        .set('Authorization', bearer(tokens))
        .send(body);

    expect((await put({ tuitionFee: 2500.5, admissionFee: 0, examFee: 0 })).status).toBe(400);
    expect((await put({ tuitionFee: -1, admissionFee: 0, examFee: 0 })).status).toBe(400);
    expect((await put({ tuitionFee: 1, admissionFee: 0, examFee: 0 }, staffTokens)).status).toBe(
      403,
    );
  });

  it('copies structures into another session without overwriting existing ones', async () => {
    const next = await createSession(school.actor, { name: '2027-28' });
    const copy = () =>
      request(app)
        .post(`${api}/copy`)
        .set('Authorization', bearer(adminTokens))
        .send({ fromSessionId: school.sessionId, toSessionId: next._id });

    expect((await copy()).body.data).toEqual({ created: 2, skipped: 0 });
    expect((await copy()).body.data).toEqual({ created: 0, skipped: 2 });
    expect(await FeeStructure.countDocuments({ sessionId: next._id })).toBe(2);
  });
});
