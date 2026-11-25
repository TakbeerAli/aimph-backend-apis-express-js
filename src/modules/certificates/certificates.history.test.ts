import sharp from 'sharp';
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
import { AuditLog } from '../../common/audit.js';
import type { AuthUser } from '../../common/middleware/auth.js';
import { storage, type MemoryStorage } from '../../common/storage/storage.js';
import { todayString } from '../../common/utils/dates.js';
import { updateCertificateSettings } from '../settings/certificate-settings.js';
import { Settings } from '../settings/settings.model.js';
import { SETTINGS_ID } from '../../db/counters.js';
import { Student } from '../students/students.model.js';
import { Voucher } from '../vouchers/vouchers.model.js';
import { waive } from '../vouchers/vouchers.service.js';
import { Certificate } from './certificates.model.js';

const api = '/api/v1/certificates';
const YEAR = todayString().slice(0, 4);
const TODAY = todayString();

const slcForm = {
  leavingDate: '2026-11-20',
  leavingReasonCode: 'SHIFTED_CITY',
  leavingReasonText: 'Shifted to Lahore',
  conduct: 'GOOD',
};

describe('certificates: history, reprint, cancel, sync', () => {
  let app: ReturnType<typeof createApp>;
  let school: Awaited<ReturnType<typeof setupSchool>>;
  let actor: AuthUser;
  let admin: Tokens;
  let staff: Tokens;

  const clearStudent = async (overrides: Record<string, unknown> = {}) => {
    const student = await admit(
      actor,
      { classId: school.class5Id, sectionId: school.s5A },
      overrides,
    );
    for (const v of await Voucher.find({ studentId: student._id, balance: { $gt: 0 } })) {
      await waive(actor, v._id, { amount: v.balance, reason: 'Test: clear dues' });
    }
    return student;
  };

  const as = (tokens: Tokens) => ({ Authorization: bearer(tokens) });
  const issue = async (body: Record<string, unknown>) => {
    const res = await request(app).post(api).set(as(admin)).send(body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.data as {
      _id: string;
      certificateNo: string;
      snapshot: { principal: unknown; student: { fullName: string } };
    };
  };
  const list = (query: Record<string, string | number> = {}) =>
    request(app).get(api).query(query).set(as(admin));

  beforeEach(async () => {
    await resetDatabase();
    app = createApp();
    school = await setupSchool();
    actor = school.actor;
    admin = await login(app, school.admin);
    staff = await login(app, await createUser());
    await updateCertificateSettings(actor, { principalName: 'Prof. Ahmed Ali' });
  });

  it('lists newest first with filters and search', async () => {
    const ali = await clearStudent();
    const sara = await clearStudent({ fullName: 'Sara Bibi', gender: 'FEMALE' });
    const cc = await issue({ type: 'CC', studentId: ali._id, form: { conduct: 'GOOD' } });
    const dob = await issue({ type: 'DOB', studentId: sara._id });
    const bf = await issue({ type: 'BF', studentId: ali._id, form: { purpose: 'bank account' } });

    const all = await list();
    expect(all.status).toBe(200);
    expect(all.body.data.total).toBe(3);
    expect(all.body.data.items.map((c: { _id: string }) => c._id)).toEqual([
      bf._id,
      dob._id,
      cc._id,
    ]);

    const ids = async (query: Record<string, string | number>): Promise<string[]> =>
      ((await list(query)).body.data.items as { _id: string }[]).map((c) => c._id);
    expect(await ids({ type: 'DOB' })).toEqual([dob._id]);
    expect(await ids({ studentId: ali._id })).toEqual([bf._id, cc._id]);
    expect(await ids({ q: cc.certificateNo.toLowerCase() })).toEqual([cc._id]);
    expect(await ids({ q: 'sara' })).toEqual([dob._id]);
    expect(await ids({ q: String(ali.admissionNo) })).toEqual([bf._id, cc._id]);
    expect(await ids({ q: '(.*' })).toEqual([]); // regex characters are literal
    expect(await ids({ from: TODAY, to: TODAY })).toHaveLength(3);
    expect(await ids({ to: '2020-01-01' })).toEqual([]);
    expect(await ids({ page: 2, limit: 2 })).toEqual([cc._id]);

    await request(app)
      .post(`${api}/${cc._id}/cancel`)
      .set(as(admin))
      .send({ reason: 'Wrong conduct' });
    expect(await ids({ status: 'CANCELLED' })).toEqual([cc._id]);
    expect(await ids({ status: 'ISSUED' })).toEqual([bf._id, dob._id]);
  });

  it('updatedSince returns only certificates changed after that instant', async () => {
    const ali = await clearStudent();
    const first = await issue({ type: 'CC', studentId: ali._id, form: { conduct: 'GOOD' } });
    const mark = new Date().toISOString();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await issue({ type: 'DOB', studentId: ali._id });
    await request(app).post(`${api}/${first._id}/reprint`).set(as(admin)).send({});

    const res = await list({ updatedSince: mark });
    const got = res.body.data.items.map((c: { _id: string }) => c._id).sort();
    expect(got).toEqual([first._id, second._id].sort());

    const later = await list({ updatedSince: new Date(Date.now() + 60_000).toISOString() });
    expect(later.body.data.items).toEqual([]);
  });

  it('returns one certificate with its snapshot, or 404', async () => {
    const ali = await clearStudent();
    const cc = await issue({ type: 'CC', studentId: ali._id, form: { conduct: 'GOOD' } });
    const res = await request(app).get(`${api}/${cc._id}`).set(as(admin));
    expect(res.status).toBe(200);
    expect(res.body.data.snapshot.student.fullName).toBe('Ali Raza');
    expect((await request(app).get(`${api}/nope`).set(as(admin))).status).toBe(404);
  });

  it('reprint increments reprintCount without changing the snapshot', async () => {
    const ali = await clearStudent();
    const cc = await issue({ type: 'CC', studentId: ali._id, form: { conduct: 'GOOD' } });

    const first = await request(app).post(`${api}/${cc._id}/reprint`).set(as(admin));
    expect(first.status).toBe(200);
    // Printed offline an hour ago and reported now.
    const offlineAt = new Date(Date.now() - 3_600_000).toISOString();
    const second = await request(app)
      .post(`${api}/${cc._id}/reprint`)
      .set(as(admin))
      .send({ at: offlineAt });
    // A time in the future is not trusted.
    const third = await request(app)
      .post(`${api}/${cc._id}/reprint`)
      .set(as(admin))
      .send({ at: '2099-01-01T00:00:00Z' });

    expect(third.body.data.reprintCount).toBe(3);
    expect(third.body.data.snapshot).toEqual(cc.snapshot);
    expect(third.body.data.certificateNo).toBe(cc.certificateNo);
    const reprints = third.body.data.reprints as { at: string; by: string }[];
    expect(reprints[1]?.at).toBe(offlineAt);
    expect(new Date(reprints[2]!.at).getTime()).toBeLessThanOrEqual(Date.now());
    expect(second.body.data.reprints[1].by).toBe(school.admin._id);

    expect(await AuditLog.countDocuments({ action: 'CERT_REPRINT', entityId: cc._id })).toBe(3);
  });

  it('cancel: needs a reason, keeps the number, does not re-activate the student', async () => {
    const ali = await clearStudent();
    const slc = await issue({ type: 'SLC', studentId: ali._id, form: slcForm });
    expect(slc.certificateNo).toBe(`SLC-${YEAR}-0001`);

    const noReason = await request(app)
      .post(`${api}/${slc._id}/cancel`)
      .set(as(admin))
      .send({ reason: 'oops' });
    expect(noReason.status).toBe(400);

    const res = await request(app)
      .post(`${api}/${slc._id}/cancel`)
      .set(as(admin))
      .send({ reason: 'Wrong leaving date' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      status: 'CANCELLED',
      certificateNo: `SLC-${YEAR}-0001`,
      cancellation: { by: school.admin._id, reason: 'Wrong leaving date' },
    });
    expect((await Student.findById(ali._id))?.status).toBe('WITHDRAWN');

    const again = await request(app)
      .post(`${api}/${slc._id}/cancel`)
      .set(as(admin))
      .send({ reason: 'Wrong leaving date' });
    expect(again.status).toBe(409);
    const reprint = await request(app).post(`${api}/${slc._id}/reprint`).set(as(admin));
    expect(reprint.status).toBe(409);

    // After cancelling, a new original SLC can be issued, with the next number.
    const next = await issue({ type: 'SLC', studentId: ali._id, form: slcForm });
    expect(next.certificateNo).toBe(`SLC-${YEAR}-0002`);

    const audit = await AuditLog.findOne({ action: 'CERT_CANCEL' }).lean();
    expect(audit).toMatchObject({ entityId: slc._id, reason: 'Wrong leaving date' });
  });

  it('old snapshots keep the principal and signature they were issued with', async () => {
    const ali = await clearStudent();
    await Settings.updateOne(
      { _id: SETTINGS_ID },
      { $set: { 'certificate.signatureUrl': 'https://img.test/old-signature.png' } },
    );
    const old = await issue({ type: 'CC', studentId: ali._id, form: { conduct: 'GOOD' } });

    await updateCertificateSettings(actor, {
      principalName: 'Dr. Fatima Noor',
      designation: 'Head',
    });
    await Settings.updateOne(
      { _id: SETTINGS_ID },
      { $set: { 'certificate.signatureUrl': 'https://img.test/new-signature.png' } },
    );
    await Student.updateOne({ _id: ali._id }, { $set: { fullName: 'Ali Raza Khan' } });

    const stored = await Certificate.findById(old._id).lean();
    expect(stored?.snapshot.principal).toMatchObject({
      name: 'Prof. Ahmed Ali',
      designation: 'Principal',
      signatureUrl: 'https://img.test/old-signature.png',
    });
    expect(stored?.snapshot.student.fullName).toBe('Ali Raza');

    const fresh = await issue({ type: 'CC', studentId: ali._id, form: { conduct: 'GOOD' } });
    expect(fresh.snapshot.principal).toMatchObject({
      name: 'Dr. Fatima Noor',
      designation: 'Head',
      signatureUrl: 'https://img.test/new-signature.png',
    });
    expect(fresh.snapshot.student.fullName).toBe('Ali Raza Khan');
  });

  it('a new signature upload keeps the old file, which old certificates still use', async () => {
    const photo = (shade: string) =>
      sharp({ create: { width: 900, height: 300, channels: 3, background: '#ffffff' } })
        .composite([
          {
            input: {
              create: { width: 450, height: 80, channels: 3, background: shade },
            },
            top: 110,
            left: 225,
          },
        ])
        .png()
        .toBuffer();
    const uploadSignature = async (file: Buffer) => {
      const res = await request(app)
        .post('/api/v1/settings/certificate/signature')
        .set(as(admin))
        .attach('file', file, { filename: 'signature.png', contentType: 'image/png' });
      expect(res.status).toBe(200);
      return res.body.data.signatureUrl as string;
    };
    const files = (storage as MemoryStorage).files;
    files.clear();

    const ali = await clearStudent();
    const oldUrl = await uploadSignature(await photo('#111111'));
    const old = await issue({ type: 'CC', studentId: ali._id, form: { conduct: 'GOOD' } });

    const newUrl = await uploadSignature(await photo('#333333'));
    expect(newUrl).not.toBe(oldUrl);
    const fresh = await issue({ type: 'CC', studentId: ali._id, form: { conduct: 'GOOD' } });

    const stored = await Certificate.findById(old._id).lean();
    expect(stored?.snapshot.principal.signatureUrl).toBe(oldUrl);
    expect(fresh.snapshot.principal).toMatchObject({ signatureUrl: newUrl });
    // Both files still exist: nothing is ever deleted.
    expect(files.size).toBe(2);
  });

  it('Staff can use no certificate endpoint and never receive certificates in sync', async () => {
    const ali = await clearStudent();
    const cc = await issue({ type: 'CC', studentId: ali._id, form: { conduct: 'GOOD' } });

    const calls = [
      request(app).get(api).set(as(staff)),
      request(app).get(`${api}/${cc._id}`).set(as(staff)),
      request(app).post(`${api}/check`).set(as(staff)).send({ type: 'CC', studentId: ali._id }),
      request(app).post(`${api}/${cc._id}/reprint`).set(as(staff)),
      request(app).post(`${api}/${cc._id}/cancel`).set(as(staff)).send({ reason: 'Staff try' }),
      request(app).get('/api/v1/settings/certificate').set(as(staff)),
    ];
    for (const res of await Promise.all(calls)) {
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }

    const staffPull = await request(app).get('/api/v1/sync/pull').set(as(staff));
    expect(staffPull.status).toBe(200);
    expect(staffPull.body.data.changes.certificates).toEqual([]);
    // Staff still get the settings, including who signs certificates (no counters).
    const settings = staffPull.body.data.changes.settings[0];
    expect(settings.certificate.principalName).toBe('Prof. Ahmed Ali');
    expect(settings.counters).toBeUndefined();

    const adminPull = await request(app).get('/api/v1/sync/pull').set(as(admin));
    expect(adminPull.body.data.changes.certificates.map((c: { _id: string }) => c._id)).toEqual([
      cc._id,
    ]);
  });
});
