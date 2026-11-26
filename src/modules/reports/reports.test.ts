import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  admit,
  asAuthUser,
  bearer,
  collect,
  createUser,
  login,
  resetDatabase,
  setupSchool,
  type Tokens,
} from '../../../test/helpers.js';
import { createApp } from '../../app.js';
import type { AuthUser } from '../../common/middleware/auth.js';
import { today } from '../../common/utils/dates.js';
import { Payment } from '../payments/payments.model.js';
import { resolvePayment, reversePayment } from '../payments/payments.service.js';
import { createSession, setCurrentSession } from '../sessions/sessions.service.js';
import type { StudentDoc } from '../students/students.model.js';
import { generateVouchers } from '../vouchers/vouchers.generate.js';
import { Voucher } from '../vouchers/vouchers.model.js';

// "Today" is 20 Nov 2026 in Karachi. Only Date is faked, so MongoDB timers keep working.
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-20T10:00:00+05:00'));
});
afterAll(() => {
  vi.useRealTimers();
});

/*
 * The school on 20 Nov 2026:
 *   Ali (5-A)   Sep 2,500  Oct 2,500  Nov 7,500 (admission)
 *   Sara (5-A)  Sep 2,500  Oct 2,500  Nov 7,500
 *   Bilal (6-A) Sep 3,000  Oct 3,000  Nov 8,000
 * Payments:
 *   R-S2-00001  Ali Sep 1,000   CASH   19 Nov 23:30 (Karachi)  staff2
 *   R-S1-00001  Ali Sep 1,500   CASH   20 Nov 00:30            staff1
 *   R-S1-00002  Sara Sep 2,500  BANK   20 Nov 09:00            staff1
 *   R-S2-00002  Ali Oct 500     CASH   20 Nov 09:30  REVERSED  staff2
 *   R-A-00001   Bilal Nov 7,500 OTHER  20 Nov 09:45            admin
 */
describe('reports and dashboard', () => {
  let app: ReturnType<typeof createApp>;
  let school: Awaited<ReturnType<typeof setupSchool>>;
  let adminTokens: Tokens;
  let staff1Tokens: Tokens;
  let staff2Tokens: Tokens;
  let staff1: AuthUser;
  let staff2: AuthUser;
  let ali: StudentDoc;
  let sara: StudentDoc;
  let bilal: StudentDoc;

  const voucherId = async (student: StudentDoc, feeMonth: string) =>
    (await Voucher.findOne({ studentId: student._id, feeMonth }).orFail())._id;

  beforeEach(async () => {
    await resetDatabase();
    app = createApp();
    school = await setupSchool();
    const s1 = await createUser({
      username: 'staff1',
      deviceCode: 'S1',
      assignedSectionIds: [school.s5A, school.s5B],
    });
    const s2 = await createUser({
      username: 'staff2',
      deviceCode: 'S2',
      assignedSectionIds: [school.s5A, school.s5B],
    });
    staff1 = asAuthUser(s1);
    staff2 = asAuthUser(s2);
    adminTokens = await login(app, school.admin);
    staff1Tokens = await login(app, s1);
    staff2Tokens = await login(app, s2);

    ali = await admit(
      school.actor,
      { classId: school.class5Id, sectionId: school.s5A },
      { rollNo: 1 },
    );
    sara = await admit(
      school.actor,
      { classId: school.class5Id, sectionId: school.s5A },
      { rollNo: 2, fullName: 'Sara Khan', gender: 'FEMALE' },
    );
    bilal = await admit(
      school.actor,
      { classId: school.class6Id, sectionId: school.s6A },
      {
        fullName: 'Bilal Ahmed',
        guardian: { fatherName: 'Raza Ahmed', relation: 'FATHER', phone: '0333-9998877' },
      },
    );
    for (const feeMonth of ['2026-09', '2026-10']) {
      await generateVouchers(school.actor, { feeMonth, scope: 'ALL', addExamFee: false });
    }

    await collect(
      staff2,
      1,
      ali._id,
      [{ voucherId: await voucherId(ali, '2026-09'), amount: 1000 }],
      {
        paidAt: '2026-11-19T23:30:00+05:00',
      },
    );
    await collect(
      staff1,
      1,
      ali._id,
      [{ voucherId: await voucherId(ali, '2026-09'), amount: 1500 }],
      {
        paidAt: '2026-11-20T00:30:00+05:00',
      },
    );
    await collect(
      staff1,
      2,
      sara._id,
      [{ voucherId: await voucherId(sara, '2026-09'), amount: 2500 }],
      {
        method: 'BANK',
        bankDate: '2026-11-20',
        paidAt: '2026-11-20T09:00:00+05:00',
      },
    );
    const wrong = await collect(
      staff2,
      2,
      ali._id,
      [{ voucherId: await voucherId(ali, '2026-10'), amount: 500 }],
      { paidAt: '2026-11-20T09:30:00+05:00' },
    );
    await reversePayment(school.actor, wrong.payment._id, 'Wrong student');
    await collect(
      school.actor,
      1,
      bilal._id,
      [{ voucherId: await voucherId(bilal, '2026-11'), amount: 7500 }],
      {
        method: 'OTHER',
        paidAt: '2026-11-20T09:45:00+05:00',
      },
    );
  });

  const get = (tokens: Tokens, path: string) =>
    request(app).get(path).set('Authorization', bearer(tokens));

  describe('daily collection (#21)', () => {
    it('equals the sum of non-reversed payments within Karachi day boundaries', async () => {
      const res = await get(adminTokens, '/api/v1/reports/daily-collection?date=2026-11-20');

      // Independent check: 20 Nov in Karachi is 19 Nov 19:00Z to 20 Nov 19:00Z.
      const all = await Payment.find().lean();
      const expected = all
        .filter(
          (p) =>
            p.status !== 'REVERSED' &&
            p.paidAt >= new Date('2026-11-19T19:00:00Z') &&
            p.paidAt < new Date('2026-11-20T19:00:00Z'),
        )
        .reduce((sum, p) => sum + p.amount, 0);

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        date: '2026-11-20',
        total: expected,
        count: 3,
        byMethod: { CASH: 1500, BANK: 2500, OTHER: 7500 },
      });
      expect(expected).toBe(11500);
      expect(res.body.data.receipts.map((r: { receiptNo: string }) => r.receiptNo)).toEqual([
        'R-S1-00001',
        'R-S1-00002',
        'R-A-00001',
      ]);
      expect(res.body.data.receipts[0]).toMatchObject({ fullName: 'Ali Raza', admissionNo: 1001 });
      const byStaff = Object.fromEntries(
        res.body.data.byStaff.map((s: { deviceCode: string; total: number; count: number }) => [
          s.deviceCode,
          [s.total, s.count],
        ]),
      );
      expect(byStaff).toEqual({ S1: [4000, 2], A: [7500, 1] });
    });

    it('the day before only has the late-evening payment', async () => {
      const res = await get(adminTokens, '/api/v1/reports/daily-collection?date=2026-11-19');
      expect(res.body.data).toMatchObject({ total: 1000, count: 1 });
    });

    it('Staff see only their own receipts', async () => {
      const own = await get(staff1Tokens, '/api/v1/reports/daily-collection?date=2026-11-20');
      expect(own.body.data).toMatchObject({ total: 4000, count: 2 });
      // staff2's only payment today was reversed.
      const other = await get(staff2Tokens, '/api/v1/reports/daily-collection');
      expect(other.body.data).toMatchObject({ date: '2026-11-20', total: 0, count: 0 });
    });

    it('counts NEEDS_REVIEW money as collected until it is refunded', async () => {
      const oct = await voucherId(sara, '2026-10');
      await collect(staff1, 3, sara._id, [{ voucherId: oct, amount: 2500 }], {}, 'SYNC');
      const review = await collect(
        staff2,
        3,
        sara._id,
        [{ voucherId: oct, amount: 2500 }],
        {},
        'SYNC',
      );
      expect(review.payment.status).toBe('NEEDS_REVIEW');

      const before = await get(adminTokens, '/api/v1/reports/daily-collection');
      expect(before.body.data.total).toBe(11500 + 5000);

      await resolvePayment(school.actor, review.payment._id, {
        action: 'REFUNDED',
        note: 'Cash returned',
        refundMethod: 'CASH',
      });
      const after = await get(adminTokens, '/api/v1/reports/daily-collection');
      expect(after.body.data.total).toBe(11500 + 2500);
    });
  });

  describe('defaulters (#22)', () => {
    it('matches vouchers with dueDate before today and balance > 0', async () => {
      const res = await get(adminTokens, '/api/v1/reports/defaulters');

      // Independent check straight from the vouchers.
      const overdue = await Voucher.find({
        status: { $ne: 'CANCELLED' },
        balance: { $gt: 0 },
        dueDate: { $lt: today() },
      }).lean();
      const expected = new Map<string, number>();
      for (const v of overdue)
        expected.set(v.studentId, (expected.get(v.studentId) ?? 0) + v.balance);

      expect(res.status).toBe(200);
      const rows = res.body.data.students as { studentId: string; amount: number }[];
      expect(new Map(rows.map((r) => [r.studentId, r.amount]))).toEqual(expected);
      expect(res.body.data.students[0]).toMatchObject({
        fullName: 'Bilal Ahmed',
        admissionNo: 1003,
        fatherName: 'Raza Ahmed',
        phone: '0333-9998877',
        amount: 6000,
        months: ['2026-09', '2026-10'],
        monthsCount: 2,
      });
      expect(res.body.data.totalAmount).toBe(6000 + 2500 + 2500);
    });

    it('filters by class and minimum overdue months', async () => {
      const class5 = await get(
        adminTokens,
        `/api/v1/reports/defaulters?classId=${school.class5Id}`,
      );
      expect(
        class5.body.data.students.map((s: { studentId: string }) => s.studentId).sort(),
      ).toEqual([ali._id, sara._id].sort());
      const twoMonths = await get(adminTokens, '/api/v1/reports/defaulters?minMonths=2');
      expect(twoMonths.body.data.students.map((s: { studentId: string }) => s.studentId)).toEqual([
        bilal._id,
      ]);
    });
  });

  describe('dashboard', () => {
    it('Admin sees school totals', async () => {
      const res = await get(adminTokens, '/api/v1/dashboard');

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        date: '2026-11-20',
        feeMonth: '2026-11',
        todayCollection: { total: 11500, count: 3, byMethod: { CASH: 1500, BANK: 2500 } },
        monthCollection: { total: 12500, count: 4 },
        totalPending: 26500,
        activeStudents: 3,
        defaulters: 3,
      });
      expect(res.body.data.recentPayments).toHaveLength(5);
      expect(res.body.data.recentPayments[0].receiptNo).toBe('R-A-00001');
    });

    it('Staff see their own collections and their classes only', async () => {
      const res = await get(staff1Tokens, '/api/v1/dashboard');

      expect(res.body.data).toMatchObject({
        todayCollection: { total: 4000, count: 2 },
        monthCollection: { total: 4000, count: 2 },
        totalPending: 20000, // Class 5 only
        activeStudents: 2,
        defaulters: 2,
      });
      expect(res.body.data.recentPayments.map((p: { receiptNo: string }) => p.receiptNo)).toEqual([
        'R-S1-00002',
        'R-S1-00001',
      ]);
    });
  });

  describe('Admin reports', () => {
    it('collection by month: generated vs collected vs pending', async () => {
      const res = await get(adminTokens, '/api/v1/reports/collection?from=2026-09&to=2026-11');

      expect(res.body.data.rows).toEqual([
        { period: '2026-09', generated: 8000, collected: 0, pending: 3000 },
        { period: '2026-10', generated: 8000, collected: 0, pending: 8000 },
        { period: '2026-11', generated: 23000, collected: 12500, pending: 15500 },
      ]);
      expect(res.body.data.totals).toEqual({ generated: 39000, collected: 12500, pending: 26500 });
    });

    it('collection by year', async () => {
      const res = await get(
        adminTokens,
        '/api/v1/reports/collection?from=2026-04&to=2027-03&groupBy=year',
      );
      expect(res.body.data.rows).toEqual([
        { period: '2026', generated: 39000, collected: 12500, pending: 26500 },
        { period: '2027', generated: 0, collected: 0, pending: 0 },
      ]);
    });

    it('class-wise totals with % collected', async () => {
      const res = await get(adminTokens, '/api/v1/reports/class-wise');

      expect(res.body.data.classes).toEqual([
        expect.objectContaining({
          className: 'Class 5',
          students: 2,
          generated: 25000,
          collected: 5000,
          pending: 20000,
          percentCollected: 20,
        }),
        expect.objectContaining({
          className: 'Class 6',
          students: 1,
          generated: 14000,
          collected: 7500,
          pending: 6500,
          percentCollected: 53.6,
        }),
      ]);
      const sep = await get(adminTokens, '/api/v1/reports/class-wise?feeMonth=2026-09');
      expect(sep.body.data.classes[0]).toMatchObject({
        generated: 5000,
        collected: 5000,
        percentCollected: 100,
      });
    });

    it('status list for a month, by class and status', async () => {
      const sep = await get(
        adminTokens,
        `/api/v1/reports/status-list?feeMonth=2026-09&classId=${school.class5Id}`,
      );
      expect(
        sep.body.data.vouchers.map((v: { fullName: string; status: string; rollNo: number }) => [
          v.rollNo,
          v.status,
        ]),
      ).toEqual([
        [1, 'PAID'],
        [2, 'PAID'],
      ]);

      const unpaid = await get(
        adminTokens,
        '/api/v1/reports/status-list?feeMonth=2026-10&status=UNPAID',
      );
      expect(unpaid.body.data.count).toBe(3);
    });

    it('previous-session dues list unpaid vouchers of closed sessions', async () => {
      const next = await createSession(school.actor, { name: '2027-28' });
      await setCurrentSession(school.actor, next._id);

      const res = await get(adminTokens, '/api/v1/reports/previous-session-dues');

      expect(res.body.data.sessions.map((s: { name: string }) => s.name)).toEqual(['2026-27']);
      expect(res.body.data.totalAmount).toBe(26500);
      expect(
        res.body.data.students.map((s: { studentId: string; amount: number }) => [
          s.studentId,
          s.amount,
        ]),
      ).toEqual([
        [ali._id, 10000],
        [sara._id, 10000],
        [bilal._id, 6500],
      ]);
    });

    it('are Admin only', async () => {
      for (const path of [
        '/api/v1/reports/collection?from=2026-09&to=2026-11',
        '/api/v1/reports/class-wise',
        '/api/v1/reports/defaulters',
        '/api/v1/reports/status-list?feeMonth=2026-09',
        '/api/v1/reports/previous-session-dues',
      ]) {
        expect((await get(staff1Tokens, path)).status).toBe(403);
      }
    });
  });
});
