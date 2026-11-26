import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  admit,
  bearer,
  createUser,
  login,
  resetDatabase,
  setupSchool,
  studentBody,
  type Tokens,
} from '../../../test/helpers.js';
import { createApp } from '../../app.js';
import { AuditLog } from '../../common/audit.js';
import { createClass } from '../classes/classes.service.js';
import { FeeStructure } from '../fee-structures/fee-structures.model.js';
import { putFeeStructure } from '../fee-structures/fee-structures.service.js';
import type { StudentDoc } from '../students/students.model.js';
import { Student } from '../students/students.model.js';
import { Voucher } from './vouchers.model.js';

const api = '/api/v1/vouchers';

// "Today" is 20 Nov 2026 in Karachi. Only Date is faked, so MongoDB timers keep working.
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-20T10:00:00+05:00'));
});
afterAll(() => {
  vi.useRealTimers();
});

describe('vouchers', () => {
  let app: ReturnType<typeof createApp>;
  let school: Awaited<ReturnType<typeof setupSchool>>;
  let adminTokens: Tokens;
  let staffTokens: Tokens;
  let in5A: { classId: string; sectionId: string };
  let ali: StudentDoc;

  beforeEach(async () => {
    await resetDatabase();
    app = createApp();
    school = await setupSchool();
    in5A = { classId: school.class5Id, sectionId: school.s5A };
    adminTokens = await login(app, school.admin);
    staffTokens = await login(app, await createUser());
    ali = await admit(school.actor, in5A, { rollNo: 12 }); // Adm 1001, Nov voucher 7,500
  });

  const as = (tokens: Tokens) => ({
    get: (path: string) => request(app).get(path).set('Authorization', bearer(tokens)),
    post: (path: string, body: unknown) =>
      request(app)
        .post(path)
        .set('Authorization', bearer(tokens))
        .send(body as object),
  });
  const generate = (body: Record<string, unknown>) =>
    as(adminTokens).post(`${api}/generate`, { scope: 'ALL', ...body });
  const voucherFor = (studentId: string, feeMonth: string) =>
    Voucher.findOne({ studentId, feeMonth, status: { $ne: 'CANCELLED' } }).orFail();

  describe('admission charge (#16)', () => {
    it('admission creates the current month voucher with tuition + admission fee', async () => {
      const res = await as(adminTokens).post('/api/v1/students', studentBody(in5A));

      expect(res.status).toBe(201);
      const { student, voucher } = res.body.data;
      expect(voucher).toMatchObject({
        voucherNo: `V-2611-${student.admissionNo}`,
        type: 'MONTHLY',
        studentId: student._id,
        feeMonth: '2026-11',
        lines: [
          { code: 'TUITION', label: 'Tuition Fee', amount: 2500 },
          { code: 'ADMISSION', label: 'Admission Fee', amount: 5000 },
        ],
        totalAmount: 7500,
        paidAmount: 0,
        balance: 7500,
        status: 'UNPAID',
        issueDate: '2026-11-20T00:00:00.000Z',
        // Usual due day (10th) has passed, so it is due on the admission day.
        dueDate: '2026-11-20T00:00:00.000Z',
        isOverdue: false,
      });
    });

    it('without a fee structure nothing is saved', async () => {
      const actor = school.actor;
      const class7 = await createClass(actor, {
        name: 'Class 7',
        shortName: '7',
        sortOrder: 10,
        nextClassId: null,
        sections: ['A'],
      });
      const res = await as(adminTokens).post(
        '/api/v1/students',
        studentBody({ classId: class7._id, sectionId: class7.sections[0]?._id ?? '' }),
      );

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/fee structure for Class 7/);
      expect(await Student.countDocuments()).toBe(1); // only Ali
    });
  });

  describe('generation', () => {
    it('preview shows counts and totals and writes nothing', async () => {
      await admit(school.actor, { classId: school.class6Id, sectionId: school.s6A });

      const res = await as(adminTokens).post(`${api}/generate/preview`, {
        feeMonth: '2026-12',
        scope: 'ALL',
        addExamFee: true,
      });

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        feeMonth: '2026-12',
        studentsInScope: 2,
        toCreate: 2,
        skipped: 0,
        totalAmount: 3000 + 3500,
      });
      expect(await Voucher.countDocuments({ feeMonth: '2026-12' })).toBe(0);
    });

    it('running the same month twice creates nothing the second time (#11)', async () => {
      await admit(school.actor, in5A);

      const first = await generate({ feeMonth: '2026-12' });
      const second = await generate({ feeMonth: '2026-12' });

      expect(first.body.data).toEqual({ created: 2, skipped: 0, totalAmount: 5000 });
      expect(second.body.data).toEqual({ created: 0, skipped: 2, totalAmount: 0 });
      expect(await Voucher.countDocuments({ feeMonth: '2026-12' })).toBe(2);
      const dec = await voucherFor(ali._id, '2026-12');
      expect(dec).toMatchObject({
        voucherNo: 'V-2612-1001',
        issueDate: new Date('2026-12-01T00:00:00.000Z'),
        dueDate: new Date('2026-12-10T00:00:00.000Z'),
      });
      expect(await AuditLog.countDocuments({ action: 'VOUCHERS_GENERATE' })).toBe(1);
    });

    it('scope CLASS and STUDENT only charge those students', async () => {
      const bilal = await admit(school.actor, { classId: school.class6Id, sectionId: school.s6A });

      const byClass = await generate({
        feeMonth: '2026-12',
        scope: 'CLASS',
        classId: school.class6Id,
      });
      expect(byClass.body.data.created).toBe(1);
      expect(await Voucher.exists({ studentId: bilal._id, feeMonth: '2026-12' })).toBeTruthy();

      const one = await generate({ feeMonth: '2026-12', scope: 'STUDENT', studentId: ali._id });
      expect(one.body.data.created).toBe(1);
    });

    it('only ACTIVE students get vouchers', async () => {
      await Student.updateOne({ _id: ali._id }, { $set: { status: 'WITHDRAWN' } });

      expect((await generate({ feeMonth: '2026-12' })).body.data.created).toBe(0);
      const one = await generate({ feeMonth: '2026-12', scope: 'STUDENT', studentId: ali._id });
      expect(one.body.error.code).toBe('STUDENT_NOT_ACTIVE');
    });

    it('rejects months outside the session or beyond next month', async () => {
      expect((await generate({ feeMonth: '2026-03' })).status).toBe(400); // before the session
      expect((await generate({ feeMonth: '2027-01' })).status).toBe(400); // beyond next month
      expect((await generate({ feeMonth: '2026-13' })).status).toBe(400); // not a month
    });

    it('stops and lists classes that have no fee structure', async () => {
      await FeeStructure.deleteOne({ classId: school.class5Id });

      const res = await generate({ feeMonth: '2026-12' });
      expect(res.status).toBe(400);
      expect(res.body.error.details.classes).toEqual(['Class 5']);
      expect(await Voucher.countDocuments({ feeMonth: '2026-12' })).toBe(0);
    });

    it('adds the exam fee only when asked', async () => {
      await generate({ feeMonth: '2026-12', addExamFee: true });
      const dec = await voucherFor(ali._id, '2026-12');
      expect(dec.lines.map((l) => [l.code, l.amount])).toEqual([
        ['TUITION', 2500],
        ['EXAM', 500],
      ]);
      expect(dec.totalAmount).toBe(3000);
    });

    it('shows previous dues of the same session but never adds them to the total (#12)', async () => {
      await generate({ feeMonth: '2026-09' });
      await generate({ feeMonth: '2026-10' });
      // Partly settle September (waiver stands in for a payment until Stage 5).
      const sep = await voucherFor(ali._id, '2026-09');
      await as(adminTokens).post(`${api}/${sep._id}/waive`, { amount: 1000, reason: 'Testing' });

      await generate({ feeMonth: '2026-12' });
      const dec = await voucherFor(ali._id, '2026-12');

      // Sep 1,500 + Oct 2,500 + Nov 7,500 (admission voucher).
      expect(dec.previousDues).toEqual({
        amount: 11500,
        months: ['2026-09', '2026-10', '2026-11'],
      });
      expect(dec.totalAmount).toBe(2500);
      expect(dec.balance).toBe(2500);

      const oct = await voucherFor(ali._id, '2026-10');
      expect(oct.previousDues).toEqual({ amount: 2500, months: ['2026-09'] });
    });

    it('a cancelled month can be generated again with a new voucher number', async () => {
      await generate({ feeMonth: '2026-12' });
      const dec = await voucherFor(ali._id, '2026-12');
      await as(adminTokens).post(`${api}/${dec._id}/cancel`, { reason: 'Wrong month' });

      const again = await generate({ feeMonth: '2026-12' });
      expect(again.body.data.created).toBe(1);
      expect((await voucherFor(ali._id, '2026-12')).voucherNo).toBe('V-2612-1001-2');
    });

    it('is Admin only', async () => {
      expect(
        (await as(staffTokens).post(`${api}/generate`, { feeMonth: '2026-12', scope: 'ALL' }))
          .status,
      ).toBe(403);
    });
  });

  describe('fine, waiver and cancel (#13, #14)', () => {
    it('a fine raises total and balance', async () => {
      const nov = await voucherFor(ali._id, '2026-11');
      const res = await as(adminTokens).post(`${api}/${nov._id}/fine`, {
        amount: 200,
        reason: 'Paid late',
      });

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ totalAmount: 7700, balance: 7700, status: 'UNPAID' });
      expect(res.body.data.lines.at(-1)).toMatchObject({
        code: 'FINE',
        label: 'Late Payment Fine',
        amount: 200,
        reason: 'Paid late',
        addedBy: school.admin._id,
      });
      expect(await AuditLog.countDocuments({ action: 'FINE_ADD', reason: 'Paid late' })).toBe(1);
    });

    it('a waiver lowers the balance; more than the balance is rejected', async () => {
      const nov = await voucherFor(ali._id, '2026-11');

      const part = await as(adminTokens).post(`${api}/${nov._id}/waive`, {
        amount: 500,
        reason: 'Hardship',
      });
      expect(part.body.data).toMatchObject({
        waivedAmount: 500,
        balance: 7000,
        status: 'PARTIALLY_PAID',
      });

      const tooMuch = await as(adminTokens).post(`${api}/${nov._id}/waive`, {
        amount: 7001,
        reason: 'Hardship',
      });
      expect(tooMuch.status).toBe(422);
      expect(tooMuch.body.error.code).toBe('AMOUNT_EXCEEDS_BALANCE');

      const rest = await as(adminTokens).post(`${api}/${nov._id}/waive`, {
        amount: 7000,
        reason: 'Withdrawal',
      });
      expect(rest.body.data).toMatchObject({ balance: 0, status: 'WAIVED' });
    });

    it('a voucher with payments cannot be cancelled', async () => {
      const nov = await voucherFor(ali._id, '2026-11');
      // Payments arrive in Stage 5; simulate one already applied.
      await Voucher.updateOne({ _id: nov._id }, { $set: { paidAmount: 1000, balance: 6500 } });

      const res = await as(adminTokens).post(`${api}/${nov._id}/cancel`, { reason: 'Mistake' });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VOUCHER_HAS_PAYMENTS');
    });

    it('cancel marks the voucher CANCELLED; it cannot be fined afterwards', async () => {
      const nov = await voucherFor(ali._id, '2026-11');

      const res = await as(adminTokens).post(`${api}/${nov._id}/cancel`, { reason: 'Mistake' });
      expect(res.body.data).toMatchObject({
        status: 'CANCELLED',
        cancellation: { by: school.admin._id, reason: 'Mistake' },
      });
      const fine = await as(adminTokens).post(`${api}/${nov._id}/fine`, {
        amount: 100,
        reason: 'Late',
      });
      expect(fine.status).toBe(400);
    });

    it('fine/waive/cancel are Admin only', async () => {
      const nov = await voucherFor(ali._id, '2026-11');
      const body = { amount: 100, reason: 'Late' };
      expect((await as(staffTokens).post(`${api}/${nov._id}/fine`, body)).status).toBe(403);
      expect((await as(staffTokens).post(`${api}/${nov._id}/waive`, body)).status).toBe(403);
      expect((await as(staffTokens).post(`${api}/${nov._id}/cancel`, body)).status).toBe(403);
    });
  });

  it('changing the fee structure does not change existing vouchers (#15)', async () => {
    await generate({ feeMonth: '2026-12' });

    await putFeeStructure(school.actor, school.sessionId, school.class5Id, {
      tuitionFee: 2800,
      admissionFee: 6000,
      examFee: 600,
    });

    expect((await voucherFor(ali._id, '2026-11')).totalAmount).toBe(7500);
    expect((await voucherFor(ali._id, '2026-12')).totalAmount).toBe(2500);
    // New vouchers use the new amounts.
    const newcomer = await admit(school.actor, in5A);
    expect((await voucherFor(newcomer._id, '2026-11')).totalAmount).toBe(8800);
  });

  describe('viewing', () => {
    beforeEach(async () => {
      await generate({ feeMonth: '2026-09' });
      await generate({ feeMonth: '2026-12' });
    });

    it('Staff can list with filters, including computed overdue', async () => {
      const all = await as(staffTokens).get(`${api}?studentId=${ali._id}&sort=feeMonth`);
      expect(all.body.data.items.map((v: { feeMonth: string }) => v.feeMonth)).toEqual([
        '2026-09',
        '2026-11',
        '2026-12',
      ]);

      // Sep was due 10 Sep; Nov is due today (not overdue yet); Dec is due in December.
      const overdue = await as(staffTokens).get(`${api}?overdue=true`);
      expect(overdue.body.data.items.map((v: { feeMonth: string }) => v.feeMonth)).toEqual([
        '2026-09',
      ]);
      expect(overdue.body.data.items[0].isOverdue).toBe(true);

      const byMonth = await as(staffTokens).get(`${api}?feeMonth=2026-12&status=UNPAID`);
      expect(byMonth.body.data.total).toBe(1);

      const byNo = await as(staffTokens).get(`${api}?q=2612`);
      expect(byNo.body.data.items[0].voucherNo).toBe('V-2612-1001');
    });

    it('finds a voucher by id or by number', async () => {
      const dec = await voucherFor(ali._id, '2026-12');

      expect((await as(staffTokens).get(`${api}/${dec._id}`)).body.data.voucherNo).toBe(
        'V-2612-1001',
      );
      expect((await as(staffTokens).get(`${api}/by-no/v-2612-1001`)).body.data._id).toBe(dec._id);
      expect((await as(staffTokens).get(`${api}/by-no/V-0000-1`)).status).toBe(404);
    });

    it('the student list shows each student current-session dues', async () => {
      const res = await as(adminTokens).get(`/api/v1/students?q=1001`);
      // Sep 2,500 + Nov 7,500 + Dec 2,500
      expect(res.body.data.items[0].currentDues).toBe(12500);
    });
  });

  describe('opening balances', () => {
    it('creates one OB voucher per student, already due, and it shows as previous dues', async () => {
      const res = await as(adminTokens).post(`${api}/opening-balances`, [
        { studentId: ali._id, amount: 4000, asOfMonth: '2026-03' },
      ]);

      expect(res.body.data).toEqual({ created: 1, errors: [] });
      const ob = await Voucher.findOne({ type: 'OPENING_BALANCE' }).orFail();
      expect(ob).toMatchObject({
        voucherNo: 'OB-1001',
        feeMonth: '2026-03',
        totalAmount: 4000,
        balance: 4000,
        status: 'UNPAID',
        sessionId: school.sessionId,
        dueDate: new Date('2026-03-01T00:00:00.000Z'),
      });
      expect(ob.lines.map((l) => l.code)).toEqual(['OPENING_BALANCE']);

      await generate({ feeMonth: '2026-12' });
      expect((await voucherFor(ali._id, '2026-12')).previousDues).toEqual({
        amount: 4000 + 7500,
        months: ['2026-03', '2026-11'],
      });
    });

    it('saves nothing when a row is bad', async () => {
      const sara = await admit(school.actor, in5A);
      await as(adminTokens).post(`${api}/opening-balances`, [
        { studentId: ali._id, amount: 100, asOfMonth: '2026-03' },
      ]);

      const res = await as(adminTokens).post(`${api}/opening-balances`, [
        { studentId: sara._id, amount: 500, asOfMonth: '2026-04' },
        { studentId: ali._id, amount: 100, asOfMonth: '2026-03' }, // already has one
        { studentId: sara._id, amount: 100, asOfMonth: '2026-04' }, // repeated
        { studentId: 'missing', amount: 100, asOfMonth: '2026-04' },
        { studentId: sara._id, amount: 0, asOfMonth: '2026-04' }, // amount must be > 0
        { studentId: sara._id, amount: 100, asOfMonth: '2027-01' }, // future
      ]);

      expect(res.body.data.created).toBe(0);
      expect([...new Set(res.body.data.errors.map((e: { row: number }) => e.row))]).toEqual([
        2, 3, 4, 5, 6,
      ]);
      expect(await Voucher.countDocuments({ type: 'OPENING_BALANCE' })).toBe(1);
    });
  });
});
