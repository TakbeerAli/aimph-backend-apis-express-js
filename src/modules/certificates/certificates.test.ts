import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { todayString } from '../../common/utils/dates.js';
import { SETTINGS_ID } from '../../db/counters.js';
import { updateCertificateSettings } from '../settings/certificate-settings.js';
import { Settings } from '../settings/settings.model.js';
import { withdrawStudent } from '../students/students.lifecycle.js';
import { Student } from '../students/students.model.js';
import { Voucher } from '../vouchers/vouchers.model.js';
import { waive } from '../vouchers/vouchers.service.js';
import { Certificate } from './certificates.model.js';
import { issueCertificate } from './certificates.service.js';

const api = '/api/v1/certificates';
const YEAR = todayString().slice(0, 4);

const slcForm = {
  leavingDate: '2026-11-20',
  leavingReasonCode: 'SHIFTED_CITY',
  leavingReasonText: 'Shifted to Lahore',
  conduct: 'VERY_GOOD',
  classPassed: 'Class 4',
};

const counterValue = async (key: string) => {
  const raw = await Settings.collection.findOne({ _id: SETTINGS_ID } as never);
  return (raw as { counters?: { certificates?: Record<string, number> } } | null)?.counters
    ?.certificates?.[key];
};

describe('certificates: check and issue', () => {
  let app: ReturnType<typeof createApp>;
  let school: Awaited<ReturnType<typeof setupSchool>>;
  let actor: AuthUser;
  let admin: Tokens;

  /** An ACTIVE student in 5-A whose admission voucher is waived, so dues are 0. */
  const clearStudent = async (overrides: Record<string, unknown> = {}) => {
    const student = await admit(
      actor,
      { classId: school.class5Id, sectionId: school.s5A },
      {
        religion: 'Islam',
        placeOfBirth: 'Rawalpindi',
        ...overrides,
      },
    );
    for (const v of await Voucher.find({ studentId: student._id, balance: { $gt: 0 } })) {
      await waive(actor, v._id, { amount: v.balance, reason: 'Test: clear dues' });
    }
    return student;
  };

  const issue = (body: Record<string, unknown>, tokens = admin) =>
    request(app).post(api).set('Authorization', bearer(tokens)).send(body);
  const check = (body: Record<string, unknown>, tokens = admin) =>
    request(app).post(`${api}/check`).set('Authorization', bearer(tokens)).send(body);

  beforeEach(async () => {
    await resetDatabase();
    app = createApp();
    school = await setupSchool();
    actor = school.actor;
    admin = await login(app, school.admin);
    await updateCertificateSettings(actor, { principalName: 'Prof. Ahmed Ali' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('is Admin only', async () => {
    const staff = await login(app, await createUser());
    const student = await clearStudent();
    expect((await check({ type: 'CC', studentId: student._id }, staff)).status).toBe(403);
    const res = await issue(
      { type: 'CC', studentId: student._id, form: { conduct: 'GOOD' } },
      staff,
    );
    expect(res.status).toBe(403);
    expect(await Certificate.countDocuments()).toBe(0);
  });

  it('blocks issuing until the principal name is set (CERT_SETTINGS_MISSING)', async () => {
    await updateCertificateSettings(actor, { principalName: 'x' });
    await Settings.updateOne({ _id: SETTINGS_ID }, { $set: { 'certificate.principalName': '' } });
    const student = await clearStudent();

    const res = await issue({ type: 'DOB', studentId: student._id });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CERT_SETTINGS_MISSING');

    const pre = await check({ type: 'DOB', studentId: student._id });
    expect(pre.body.data).toMatchObject({ allowed: false, code: 'CERT_SETTINGS_MISSING' });
  });

  it('SLC with unpaid dues -> DUES_NOT_CLEAR with the vouchers, nothing saved', async () => {
    const student = await admit(actor, { classId: school.class5Id, sectionId: school.s5A });
    const voucher = await Voucher.findOne({ studentId: student._id });

    const res = await issue({ type: 'SLC', studentId: student._id, form: slcForm });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('DUES_NOT_CLEAR');
    expect(res.body.error.details).toEqual({
      openBalance: voucher?.balance,
      vouchers: [
        { voucherNo: voucher?.voucherNo, feeMonth: voucher?.feeMonth, balance: voucher?.balance },
      ],
    });

    const pre = await check({ type: 'SLC', studentId: student._id });
    expect(pre.status).toBe(200);
    expect(pre.body.data).toMatchObject({
      allowed: false,
      code: 'DUES_NOT_CLEAR',
      openBalance: voucher?.balance,
      prefill: { fullName: 'Ali Raza', status: 'ACTIVE' },
    });

    expect(await Certificate.countDocuments()).toBe(0);
    expect(await counterValue(`SLC-${YEAR}`)).toBeUndefined();
    expect((await Student.findById(student._id))?.status).toBe('ACTIVE');
  });

  it('SLC for an ACTIVE student with no dues: numbered, snapshot frozen, student withdrawn', async () => {
    const student = await clearStudent();

    const pre = await check({ type: 'SLC', studentId: student._id });
    expect(pre.body.data).toMatchObject({
      allowed: true,
      prefill: {
        fatherName: 'Ahmed Raza',
        dateOfBirth: '2015-05-10',
        dateOfBirthWords: 'Tenth May, Two Thousand Fifteen',
        admissionClassName: 'Class 5',
        currentOrLastClassName: 'Class 5',
        sectionName: 'A',
        sessionName: '2026-27',
        religion: 'Islam',
        nationality: 'Pakistani',
      },
    });

    const res = await issue({ type: 'SLC', studentId: student._id, form: slcForm });
    expect(res.status).toBe(201);
    const cert = res.body.data;
    expect(cert).toMatchObject({
      certificateNo: `SLC-${YEAR}-0001`,
      type: 'SLC',
      status: 'ISSUED',
      isDuplicate: false,
      reprintCount: 0,
      form: slcForm,
    });
    expect(cert.snapshot).toMatchObject({
      ...slcForm,
      school: { name: 'AL-MAHDI PUBLIC HIGH SCHOOL & COLLEGE' },
      student: {
        fullName: 'Ali Raza',
        gender: 'MALE',
        admissionNo: student.admissionNo,
        placeOfBirth: 'Rawalpindi',
        admissionDate: '2026-04-05',
      },
      principal: { name: 'Prof. Ahmed Ali', designation: 'Principal', printSignature: true },
      text: {
        pronounSubject: 'He',
        pronounObject: 'him',
        pronounPossessive: 'His',
        relation: 'son',
      },
    });

    const stored = await Student.findById(student._id);
    expect(stored?.status).toBe('WITHDRAWN');
    expect(stored?.classHistory.at(-1)?.outcome).toBe('WITHDRAWN');
    expect(stored?.withdrawal).toMatchObject({
      reason: 'SHIFTED_CITY',
      reasonNote: 'Shifted to Lahore',
      duesAction: 'COLLECTED',
      duesAtWithdrawal: 0,
    });
    expect(stored?.withdrawal?.date.toISOString().slice(0, 10)).toBe('2026-11-20');

    const actions = (
      await AuditLog.find({ entityId: { $in: [cert._id, student._id] } }).lean()
    ).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['CERT_ISSUE', 'STUDENT_WITHDRAW']));
  });

  it('rolls everything back, including the counter, when a step after numbering fails', async () => {
    const student = await clearStudent();
    vi.spyOn(Certificate.prototype, 'save').mockRejectedValueOnce(new Error('disk on fire'));

    await expect(
      issueCertificate(actor, {
        type: 'SLC',
        studentId: student._id,
        form: slcForm,
        isDuplicate: false,
      }),
    ).rejects.toThrow('disk on fire');

    expect(await Certificate.countDocuments()).toBe(0);
    expect(await counterValue(`SLC-${YEAR}`)).toBeUndefined();
    expect((await Student.findById(student._id))?.status).toBe('ACTIVE');
    expect(await AuditLog.countDocuments({ action: 'CERT_ISSUE' })).toBe(0);

    vi.restoreAllMocks();
    const res = await issue({ type: 'SLC', studentId: student._id, form: slcForm });
    expect(res.body.data.certificateNo).toBe(`SLC-${YEAR}-0001`);
  });

  it('a second SLC needs isDuplicate + reason, and gets its own "-D" number', async () => {
    const student = await clearStudent();
    const first = (await issue({ type: 'SLC', studentId: student._id, form: slcForm })).body.data;

    const again = await issue({ type: 'SLC', studentId: student._id, form: slcForm });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatchObject({
      code: 'SLC_ALREADY_ISSUED',
      details: { existingSlc: { certificateNo: first.certificateNo } },
    });

    const pre = await check({ type: 'SLC', studentId: student._id });
    expect(pre.body.data).toMatchObject({
      allowed: false,
      code: 'SLC_ALREADY_ISSUED',
      existingSlc: { id: first._id, certificateNo: first.certificateNo, form: slcForm },
      prefill: { status: 'WITHDRAWN' },
    });

    const noReason = await issue({ type: 'SLC', studentId: student._id, isDuplicate: true });
    expect(noReason.status).toBe(400);

    // The form is copied from the original; the remarks are new.
    const dup = await issue({
      type: 'SLC',
      studentId: student._id,
      isDuplicate: true,
      duplicateReason: 'Original lost by parent',
      form: { remarks: 'Duplicate copy' },
    });
    expect(dup.status).toBe(201);
    expect(dup.body.data).toMatchObject({
      certificateNo: `SLC-${YEAR}-0002-D`,
      isDuplicate: true,
      duplicateOf: first._id,
      duplicateReason: 'Original lost by parent',
      form: { ...slcForm, remarks: 'Duplicate copy' },
    });
  });

  it('a duplicate needs an existing SLC, and only SLC can be duplicated', async () => {
    const student = await clearStudent();
    const res = await issue({
      type: 'SLC',
      studentId: student._id,
      isDuplicate: true,
      duplicateReason: 'Lost it',
      form: slcForm,
    });
    expect(res.status).toBe(400);
    const cc = await issue({
      type: 'CC',
      studentId: student._id,
      isDuplicate: true,
      duplicateReason: 'Lost it',
      form: { conduct: 'GOOD' },
    });
    expect(cc.status).toBe(400);
  });

  it('SLC for an already WITHDRAWN student does not withdraw again', async () => {
    const student = await clearStudent();
    await withdrawStudent(actor, student._id, { reason: 'FINANCIAL', duesAction: 'COLLECTED' });
    const res = await issue({ type: 'SLC', studentId: student._id, form: slcForm });
    expect(res.status).toBe(201);
    expect((await Student.findById(student._id))?.withdrawal?.reason).toBe('FINANCIAL');
  });

  it('Bonafide for a WITHDRAWN student -> STUDENT_NOT_ACTIVE', async () => {
    const student = await clearStudent();
    await withdrawStudent(actor, student._id, { reason: 'FINANCIAL', duesAction: 'COLLECTED' });

    const res = await issue({
      type: 'BF',
      studentId: student._id,
      form: { purpose: 'opening a bank account' },
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('STUDENT_NOT_ACTIVE');
    expect(res.body.error.message).toBe(
      'Ali Raza is withdrawn. A Bonafide Certificate is only for current students.',
    );

    // Character and Date of Birth are allowed for withdrawn students.
    expect(
      (await issue({ type: 'CC', studentId: student._id, form: { conduct: 'GOOD' } })).status,
    ).toBe(201);
    expect((await issue({ type: 'DOB', studentId: student._id })).status).toBe(201);
  });

  it('validates the form for each type', async () => {
    const student = await clearStudent();
    const bad = [
      { type: 'SLC', form: { ...slcForm, conduct: undefined } },
      { type: 'SLC', form: { ...slcForm, leavingDate: '2099-01-01' } },
      { type: 'SLC', form: { ...slcForm, leavingDate: '2020-01-01' } },
      { type: 'SLC', form: { ...slcForm, leavingReasonCode: 'BORED' } },
      { type: 'CC', form: {} },
      { type: 'BF', form: { purpose: '' } },
    ];
    for (const body of bad) {
      const res = await issue({ ...body, studentId: student._id });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(await Certificate.countDocuments()).toBe(0);
    expect((await Student.findById(student._id))?.status).toBe('ACTIVE');
  });

  it('uses she/her/daughter for a girl and ignores unknown form fields', async () => {
    const student = await clearStudent({ fullName: 'Ayesha Khan', gender: 'FEMALE' });
    const res = await issue({
      type: 'BF',
      studentId: student._id,
      form: { purpose: 'opening a bank account', hack: 'x' },
    });
    expect(res.body.data.snapshot.text).toEqual({
      pronounSubject: 'She',
      pronounObject: 'her',
      pronounPossessive: 'Her',
      relation: 'daughter',
    });
    expect(res.body.data.form).toEqual({ purpose: 'opening a bank account' });
  });

  it('20 concurrent issues get 20 unique, sequential numbers', async () => {
    const student = await clearStudent();
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        issueCertificate(actor, {
          type: 'CC',
          studentId: student._id,
          form: { conduct: 'GOOD' },
          isDuplicate: false,
        }),
      ),
    );
    const numbers = results.map((c) => c.certificateNo).sort();
    expect(numbers).toEqual(
      Array.from({ length: 20 }, (_, i) => `CC-${YEAR}-${String(i + 1).padStart(4, '0')}`),
    );
    // Each type has its own sequence.
    const dob = await issue({ type: 'DOB', studentId: student._id });
    expect(dob.body.data.certificateNo).toBe(`DOB-${YEAR}-0001`);
  }, 60_000);

  it('a new calendar year (Asia/Karachi) restarts at 0001', async () => {
    const student = await clearStudent();
    await issue({ type: 'CC', studentId: student._id, form: { conduct: 'GOOD' } });

    // 1 Jan 2027, 00:30 in Karachi (still 31 Dec in UTC).
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-12-31T19:30:00Z'));
    const next = await issueCertificate(actor, {
      type: 'CC',
      studentId: student._id,
      form: { conduct: 'GOOD' },
      isDuplicate: false,
    });
    expect(next.certificateNo).toBe('CC-2027-0001');
    expect(next.issueDate.toISOString().slice(0, 10)).toBe('2027-01-01');
  });
});
