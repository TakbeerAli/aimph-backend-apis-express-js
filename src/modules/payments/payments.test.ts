import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  admit,
  asAuthUser,
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
import { newId } from '../../common/utils/ids.js';
import type { StudentDoc } from '../students/students.model.js';
import { User, type UserDoc } from '../users/users.model.js';
import { generateVouchers } from '../vouchers/vouchers.generate.js';
import { Voucher } from '../vouchers/vouchers.model.js';
import { cancel } from '../vouchers/vouchers.service.js';
import { Payment } from './payments.model.js';
import { createPaymentBody } from './payments.schemas.js';
import { createPayment } from './payments.service.js';

const api = '/api/v1/payments';

// "Today" is 20 Nov 2026 in Karachi. Only Date is faked, so MongoDB timers keep working.
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-20T10:00:00+05:00'));
});
afterAll(() => {
  vi.useRealTimers();
});

describe('payments', () => {
  let app: ReturnType<typeof createApp>;
  let school: Awaited<ReturnType<typeof setupSchool>>;
  let adminTokens: Tokens;
  let staff1: UserDoc;
  let staff2: UserDoc;
  let staff1Tokens: Tokens;
  let staff2Tokens: Tokens;
  let ali: StudentDoc;
  /** Ali's vouchers: Aug, Sep, Oct 2,500 each; Nov 7,500 (admission). */
  let v: Record<'aug' | 'sep' | 'oct' | 'nov', string>;
  const seq: Record<string, number> = {};

  beforeEach(async () => {
    await resetDatabase();
    app = createApp();
    school = await setupSchool();
    staff1 = await createUser({
      username: 'staff1',
      deviceCode: 'S1',
      assignedSectionIds: [school.s5A, school.s5B],
    });
    staff2 = await createUser({
      username: 'staff2',
      deviceCode: 'S2',
      assignedSectionIds: [school.s5A, school.s5B],
    });
    adminTokens = await login(app, school.admin);
    staff1Tokens = await login(app, staff1);
    staff2Tokens = await login(app, staff2);
    for (const key of Object.keys(seq)) delete seq[key];

    ali = await admit(
      school.actor,
      { classId: school.class5Id, sectionId: school.s5A },
      { rollNo: 12 },
    );
    for (const feeMonth of ['2026-08', '2026-09', '2026-10']) {
      await generateVouchers(school.actor, { feeMonth, scope: 'ALL', addExamFee: false });
    }
    const id = async (feeMonth: string) =>
      (await Voucher.findOne({ studentId: ali._id, feeMonth }).orFail())._id;
    v = {
      aug: await id('2026-08'),
      sep: await id('2026-09'),
      oct: await id('2026-10'),
      nov: await id('2026-11'),
    };
  });

  /** A payment body as the phone sends it. The receipt number follows the device sequence. */
  function payBody(
    deviceCode: string,
    allocations: { voucherId: string; amount: number }[],
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    const receiptSeq = (seq[deviceCode] = (seq[deviceCode] ?? 0) + 1);
    const amount = allocations.reduce((sum, a) => sum + a.amount, 0);
    return {
      _id: newId(),
      receiptNo: `R-${deviceCode}-${String(receiptSeq).padStart(5, '0')}`,
      receiptSeq,
      studentId: ali._id,
      amount,
      method: 'CASH',
      paidAt: '2026-11-20T09:00:00+05:00',
      allocations,
      receiptSnapshot: {
        studentName: 'Ali Raza',
        fatherName: 'Ahmed Raza',
        admissionNo: 1001,
        className: '5-A',
        rollNo: 12,
        months: [],
        previousBalance: 0,
        currentFee: amount,
        fine: 0,
        amountPaid: amount,
        remainingBalance: 0,
      },
      ...overrides,
    };
  }

  const pay = (tokens: Tokens, body: Record<string, unknown>) =>
    request(app).post(api).set('Authorization', bearer(tokens)).send(body);
  const get = (tokens: Tokens, path: string) =>
    request(app).get(path).set('Authorization', bearer(tokens));
  const post = (tokens: Tokens, path: string, body: object) =>
    request(app).post(path).set('Authorization', bearer(tokens)).send(body);
  const voucher = (id: string) => Voucher.findById(id).orFail().lean();
  /** The sync path (Stage 8 will call this from /sync/push). */
  const syncPay = (user: AuthUser, body: Record<string, unknown>) =>
    createPayment(user, createPaymentBody.parse(body), 'SYNC');

  describe('collecting', () => {
    it('full payment of one voucher → PAID, balance 0 (#1)', async () => {
      const res = await pay(staff1Tokens, payBody('S1', [{ voucherId: v.aug, amount: 2500 }]));

      expect(res.status).toBe(201);
      expect(res.body.data.duplicate).toBe(false);
      expect(res.body.data.payment).toMatchObject({
        receiptNo: 'R-S1-00001',
        deviceCode: 'S1',
        receivedBy: staff1._id,
        classIdAtPayment: school.class5Id,
        amount: 2500,
        status: 'CONFIRMED',
        unallocatedAmount: 0,
        allocations: [
          { voucherId: v.aug, voucherNo: 'V-2608-1001', feeMonth: '2026-08', amount: 2500 },
        ],
      });
      expect(await voucher(v.aug)).toMatchObject({ paidAmount: 2500, balance: 0, status: 'PAID' });
      expect((await User.findById(staff1._id).lean())?.lastReceiptSeq).toBe(1);
      expect(await AuditLog.countDocuments({ action: 'PAYMENT_CREATE' })).toBe(1);
    });

    it('partial payment → PARTIALLY_PAID with the right balance (#2)', async () => {
      await pay(staff1Tokens, payBody('S1', [{ voucherId: v.sep, amount: 1000 }]));
      expect(await voucher(v.sep)).toMatchObject({
        paidAmount: 1000,
        balance: 1500,
        status: 'PARTIALLY_PAID',
      });
    });

    it('one payment across Aug + Sep → two allocations, both vouchers updated (#3)', async () => {
      const res = await pay(
        staff1Tokens,
        payBody('S1', [
          { voucherId: v.aug, amount: 2500 },
          { voucherId: v.sep, amount: 2000 },
        ]),
      );

      expect(res.body.data.payment.allocations).toHaveLength(2);
      expect(res.body.data.vouchers).toHaveLength(2);
      expect(await voucher(v.aug)).toMatchObject({ balance: 0, status: 'PAID' });
      expect(await voucher(v.sep)).toMatchObject({ balance: 500, status: 'PARTIALLY_PAID' });
    });

    it('online payment above the balance → AMOUNT_EXCEEDS_BALANCE and nothing saved (#4)', async () => {
      const res = await pay(
        staff1Tokens,
        payBody('S1', [
          { voucherId: v.aug, amount: 2000 },
          { voucherId: v.sep, amount: 3000 },
        ]),
      );

      expect(res.status).toBe(422);
      expect(res.body.error).toMatchObject({
        code: 'AMOUNT_EXCEEDS_BALANCE',
        message: "Amount can't be more than PKR 2,500 for V-2609-1001.",
      });
      expect(await Payment.countDocuments()).toBe(0);
      expect(await voucher(v.aug)).toMatchObject({ paidAmount: 0, balance: 2500 });
      expect((await User.findById(staff1._id).lean())?.lastReceiptSeq).toBe(0);
    });

    it('the same payment _id sent twice is saved once (#5)', async () => {
      const body = payBody('S1', [{ voucherId: v.aug, amount: 2500 }]);

      const first = await pay(staff1Tokens, body);
      const second = await pay(staff1Tokens, body);

      expect(first.status).toBe(201);
      expect(second.status).toBe(200);
      expect(second.body.data.duplicate).toBe(true);
      expect(second.body.data.payment._id).toBe(first.body.data.payment._id);
      expect(await Payment.countDocuments()).toBe(1);
      expect(await voucher(v.aug)).toMatchObject({ paidAmount: 2500 });
    });

    it('the same payment sent twice at the same moment is still saved once', async () => {
      const input = createPaymentBody.parse(payBody('S1', [{ voucherId: v.aug, amount: 2500 }]));
      const results = await Promise.all([
        createPayment(asAuthUser(staff1), input),
        createPayment(asAuthUser(staff1), input),
      ]);

      expect(results.map((r) => r.duplicate).sort()).toEqual([false, true]);
      expect(await Payment.countDocuments()).toBe(1);
      expect(await voucher(v.aug)).toMatchObject({ paidAmount: 2500 });
    });

    it('a receipt number reused with a different _id → DUPLICATE_RECEIPT', async () => {
      const body = payBody('S1', [{ voucherId: v.aug, amount: 1000 }]);
      await pay(staff1Tokens, body);

      const res = await pay(staff1Tokens, { ...body, _id: newId() });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('DUPLICATE_RECEIPT');
    });

    it('a teacher cannot collect for a student outside their sections (#9)', async () => {
      const other = await createUser({
        username: 'staff3',
        deviceCode: 'S3',
        assignedSectionIds: [school.s6A],
      });
      const res = await pay(
        await login(app, other),
        payBody('S3', [{ voucherId: v.aug, amount: 2500 }]),
      );

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('SECTION_NOT_ASSIGNED');
      expect(await Payment.countDocuments()).toBe(0);
    });

    it.each([
      ['a receipt from another device', () => payBody('S2', [{ voucherId: 'AUG', amount: 2500 }])],
      [
        'amounts not adding up',
        () => payBody('S1', [{ voucherId: 'AUG', amount: 2500 }], { amount: 2000 }),
      ],
      [
        'a bank payment without the bank date',
        () => payBody('S1', [{ voucherId: 'AUG', amount: 2500 }], { method: 'BANK' }),
      ],
      [
        'paidAt in the future',
        () =>
          payBody('S1', [{ voucherId: 'AUG', amount: 2500 }], {
            paidAt: '2026-11-21T09:00:00+05:00',
          }),
      ],
      [
        'a voucher listed twice',
        () =>
          payBody('S1', [
            { voucherId: 'AUG', amount: 1000 },
            { voucherId: 'AUG', amount: 1000 },
          ]),
      ],
      ['a voucher of another student', () => payBody('S1', [{ voucherId: 'OTHER', amount: 2500 }])],
    ])('rejects %s', async (_name, makeBody) => {
      const other = await admit(school.actor, { classId: school.class5Id, sectionId: school.s5A });
      const otherVoucher = (await Voucher.findOne({ studentId: other._id }).orFail())._id;
      const body = JSON.parse(
        JSON.stringify(makeBody())
          .replaceAll('"AUG"', `"${v.aug}"`)
          .replaceAll('"OTHER"', `"${otherVoucher}"`),
      ) as Record<string, unknown>;

      const res = await pay(staff1Tokens, body);
      expect(res.status).toBe(400);
      expect(await Payment.countDocuments()).toBe(0);
    });

    it('rejects future months and cancelled vouchers', async () => {
      await generateVouchers(school.actor, {
        feeMonth: '2026-12',
        scope: 'ALL',
        addExamFee: false,
      });
      const dec = (await Voucher.findOne({ studentId: ali._id, feeMonth: '2026-12' }).orFail())._id;
      const future = await pay(staff1Tokens, payBody('S1', [{ voucherId: dec, amount: 2500 }]));
      expect(future.status).toBe(400);
      expect(future.body.error.message).toMatch(/Future months/);

      await cancel(school.actor, v.oct, { reason: 'Mistake' });
      const cancelled = await pay(
        staff1Tokens,
        payBody('S1', [{ voucherId: v.oct, amount: 2500 }]),
      );
      expect(cancelled.status).toBe(400);
    });

    it('a BANK payment keeps the bank date', async () => {
      const res = await pay(
        staff1Tokens,
        payBody('S1', [{ voucherId: v.aug, amount: 2500 }], {
          method: 'BANK',
          bankDate: '2026-11-18',
          bankReference: 'HBL-778',
        }),
      );
      expect(res.body.data.payment).toMatchObject({
        method: 'BANK',
        bankDate: '2026-11-18T00:00:00.000Z',
        bankReference: 'HBL-778',
      });
    });
  });

  describe('offline double payment (sync)', () => {
    beforeEach(async () => {
      // Sep already has 1,000 paid, so Aug 2,500 + Sep 1,500 = 4,000 is owed.
      await pay(adminTokens, payBody('A', [{ voucherId: v.sep, amount: 1000 }]));
    });

    const both = () => [
      { voucherId: v.aug, amount: 2500 },
      { voucherId: v.sep, amount: 1500 },
    ];

    it('first is CONFIRMED, second NEEDS_REVIEW with 4,000 kept; balances never negative (#6)', async () => {
      const first = await syncPay(asAuthUser(staff1), payBody('S1', both()));
      const second = await syncPay(asAuthUser(staff2), payBody('S2', both()));

      expect(first.payment.status).toBe('CONFIRMED');
      expect(second.payment).toMatchObject({
        status: 'NEEDS_REVIEW',
        unallocatedAmount: 4000,
        amount: 4000,
      });
      expect(second.payment.allocations).toHaveLength(0);
      expect(second.payment.requestedAllocations).toHaveLength(2);
      expect(await voucher(v.aug)).toMatchObject({ paidAmount: 2500, balance: 0 });
      expect(await voucher(v.sep)).toMatchObject({ paidAmount: 2500, balance: 0 });
      expect(
        await AuditLog.countDocuments({ action: 'PAYMENT_CREATE', reason: /NEEDS_REVIEW/ }),
      ).toBe(1);
    });

    it('applies what fits and keeps only the rest unallocated', async () => {
      await pay(staff1Tokens, payBody('S1', [{ voucherId: v.aug, amount: 2000 }]));
      const late = await syncPay(asAuthUser(staff2), payBody('S2', both()));

      expect(late.payment.allocations.map((a) => [a.feeMonth, a.amount])).toEqual([
        ['2026-08', 500],
        ['2026-09', 1500],
      ]);
      expect(late.payment.unallocatedAmount).toBe(2000);
      expect(late.payment.status).toBe('NEEDS_REVIEW');
    });

    describe('resolving', () => {
      let reviewId: string;

      beforeEach(async () => {
        await syncPay(asAuthUser(staff1), payBody('S1', both()));
        reviewId = (await syncPay(asAuthUser(staff2), payBody('S2', both()))).payment._id;
      });

      const resolve = (body: object, tokens = adminTokens) =>
        post(tokens, `${api}/${reviewId}/resolve`, body);

      it('is listed for Admin under needs-review', async () => {
        const res = await get(adminTokens, `${api}/needs-review`);
        expect(res.body.data.map((p: { _id: string }) => p._id)).toEqual([reviewId]);
        expect((await get(staff1Tokens, `${api}/needs-review`)).status).toBe(403);
      });

      it('ALLOCATED_TO_DUES moves the money to Oct + Nov (#7)', async () => {
        const res = await resolve({
          action: 'ALLOCATED_TO_DUES',
          note: 'Parent agreed',
          allocations: [
            { voucherId: v.oct, amount: 2500 },
            { voucherId: v.nov, amount: 1500 },
          ],
        });

        expect(res.status).toBe(200);
        expect(res.body.data.payment).toMatchObject({
          status: 'CONFIRMED',
          unallocatedAmount: 0,
          review: {
            action: 'ALLOCATED_TO_DUES',
            note: 'Parent agreed',
            resolvedBy: school.admin._id,
          },
        });
        expect(
          res.body.data.payment.allocations.map((a: { feeMonth: string }) => a.feeMonth),
        ).toEqual(['2026-10', '2026-11']);
        expect(await voucher(v.oct)).toMatchObject({ balance: 0, status: 'PAID' });
        expect(await voucher(v.nov)).toMatchObject({ balance: 6000, status: 'PARTIALLY_PAID' });
        expect(await AuditLog.countDocuments({ action: 'PAYMENT_RESOLVE' })).toBe(1);
      });

      it('a partial allocation keeps it in review', async () => {
        const res = await resolve({
          action: 'ALLOCATED_TO_DUES',
          note: 'Part now',
          allocations: [{ voucherId: v.oct, amount: 1000 }],
        });
        expect(res.body.data.payment).toMatchObject({
          status: 'NEEDS_REVIEW',
          unallocatedAmount: 3000,
        });
      });

      it('cannot allocate more than is waiting, or more than a voucher balance', async () => {
        const tooMuch = await resolve({
          action: 'ALLOCATED_TO_DUES',
          note: 'Try',
          allocations: [{ voucherId: v.nov, amount: 4001 }],
        });
        expect(tooMuch.body.error.code).toBe('AMOUNT_EXCEEDS_BALANCE');

        const overVoucher = await resolve({
          action: 'ALLOCATED_TO_DUES',
          note: 'Try',
          allocations: [{ voucherId: v.oct, amount: 3000 }],
        });
        expect(overVoucher.body.error.code).toBe('AMOUNT_EXCEEDS_BALANCE');
        expect(await voucher(v.oct)).toMatchObject({ balance: 2500 });
      });

      it('REFUNDED records the refund and confirms the payment', async () => {
        const res = await resolve({
          action: 'REFUNDED',
          note: 'Cash returned',
          refundMethod: 'CASH',
        });

        expect(res.body.data.payment).toMatchObject({
          status: 'CONFIRMED',
          unallocatedAmount: 0,
          review: { action: 'REFUNDED', refundAmount: 4000, refundMethod: 'CASH' },
        });
      });

      it('REVERSED undoes the payment; only Admin can resolve; only once', async () => {
        expect(
          (await resolve({ action: 'REVERSED', note: 'Not taken' }, staff1Tokens)).status,
        ).toBe(403);

        const res = await resolve({ action: 'REVERSED', note: 'Cash never taken' });
        expect(res.body.data.payment).toMatchObject({
          status: 'REVERSED',
          reversal: { reason: 'Cash never taken' },
          review: { action: 'REVERSED' },
        });
        expect((await resolve({ action: 'REVERSED', note: 'Again' })).status).toBe(409);
      });
    });
  });

  describe('reversal (#8)', () => {
    it('puts the money back on the vouchers and keeps the payment as REVERSED', async () => {
      const paid = await pay(
        staff1Tokens,
        payBody('S1', [
          { voucherId: v.aug, amount: 2500 },
          { voucherId: v.sep, amount: 1000 },
        ]),
      );
      const id = paid.body.data.payment._id as string;

      const res = await post(adminTokens, `${api}/${id}/reverse`, { reason: 'Entered by mistake' });

      expect(res.status).toBe(200);
      expect(res.body.data.payment).toMatchObject({
        status: 'REVERSED',
        amount: 3500,
        reversal: { by: school.admin._id, reason: 'Entered by mistake' },
      });
      expect(res.body.data.payment.allocations).toHaveLength(2); // never changed
      expect(await voucher(v.aug)).toMatchObject({
        paidAmount: 0,
        balance: 2500,
        status: 'UNPAID',
      });
      expect(await voucher(v.sep)).toMatchObject({
        paidAmount: 0,
        balance: 2500,
        status: 'UNPAID',
      });
      expect(
        await AuditLog.countDocuments({ action: 'PAYMENT_REVERSE', reason: 'Entered by mistake' }),
      ).toBe(1);
    });

    it('needs a reason of 5+ characters, is Admin only, and works once', async () => {
      const paid = await pay(staff1Tokens, payBody('S1', [{ voucherId: v.aug, amount: 2500 }]));
      const path = `${api}/${paid.body.data.payment._id}/reverse`;

      expect((await post(adminTokens, path, { reason: 'oops' })).status).toBe(400);
      expect((await post(staff1Tokens, path, { reason: 'Mistake made' })).status).toBe(403);
      expect((await post(adminTokens, path, { reason: 'Mistake made' })).status).toBe(200);
      expect((await post(adminTokens, path, { reason: 'Mistake made' })).status).toBe(409);
    });

    it('after reversal the voucher can be paid again', async () => {
      const paid = await pay(staff1Tokens, payBody('S1', [{ voucherId: v.aug, amount: 2500 }]));
      await post(adminTokens, `${api}/${paid.body.data.payment._id}/reverse`, {
        reason: 'Wrong student',
      });

      const again = await pay(staff1Tokens, payBody('S1', [{ voucherId: v.aug, amount: 2500 }]));
      expect(again.status).toBe(201);
    });
  });

  describe('viewing', () => {
    beforeEach(async () => {
      await pay(staff1Tokens, payBody('S1', [{ voucherId: v.aug, amount: 2500 }]));
      await pay(
        staff2Tokens,
        payBody('S2', [{ voucherId: v.sep, amount: 500 }], { paidAt: '2026-11-19T23:30:00+05:00' }),
      );
    });

    it('Staff only see their own payments (#10)', async () => {
      const own = await get(staff1Tokens, api);
      expect(own.body.data.items.map((p: { receiptNo: string }) => p.receiptNo)).toEqual([
        'R-S1-00001',
      ]);

      // Asking for another staff member's payments still returns only their own.
      const widened = await get(staff1Tokens, `${api}?receivedBy=${staff2._id}`);
      expect(widened.body.data.total).toBe(0);

      const theirs = await Payment.findOne({ receiptNo: 'R-S2-00001' }).orFail();
      expect((await get(staff1Tokens, `${api}/${theirs._id}`)).status).toBe(404);
      expect((await get(staff1Tokens, `${api}/by-receipt/R-S2-00001`)).status).toBe(404);
      expect((await get(staff1Tokens, `${api}/by-receipt/r-s1-00001`)).status).toBe(200);

      const adminView = await get(adminTokens, api);
      expect(adminView.body.data.total).toBe(2);
    });

    it('filters by Karachi business day', async () => {
      // R-S2 was paid at 23:30 on 19 Nov in Karachi (18:30Z), R-S1 on 20 Nov.
      const day20 = await get(adminTokens, `${api}?from=2026-11-20&to=2026-11-20`);
      expect(day20.body.data.items.map((p: { receiptNo: string }) => p.receiptNo)).toEqual([
        'R-S1-00001',
      ]);
      const day19 = await get(adminTokens, `${api}?from=2026-11-19&to=2026-11-19`);
      expect(day19.body.data.items.map((p: { receiptNo: string }) => p.receiptNo)).toEqual([
        'R-S2-00001',
      ]);
    });

    it('GET /vouchers/:id includes its payments', async () => {
      const res = await get(adminTokens, `/api/v1/vouchers/${v.aug}`);
      expect(res.body.data.voucherNo).toBe('V-2608-1001');
      expect(res.body.data.payments.map((p: { receiptNo: string }) => p.receiptNo)).toEqual([
        'R-S1-00001',
      ]);
    });

    it('fee history lists vouchers and payments newest first', async () => {
      const res = await get(staff1Tokens, `/api/v1/students/${ali._id}/fee-history`);

      expect(res.status).toBe(200);
      expect(res.body.data.vouchers.map((x: { feeMonth: string }) => x.feeMonth)).toEqual([
        '2026-11',
        '2026-10',
        '2026-09',
        '2026-08',
      ]);
      // Class 5 is assigned to staff1, so they see both payments for this student.
      expect(res.body.data.payments.map((p: { receiptNo: string }) => p.receiptNo)).toEqual([
        'R-S1-00001',
        'R-S2-00001',
      ]);
    });

    it('Staff without the class see only their own payments in fee history', async () => {
      await User.updateOne({ _id: staff1._id }, { $set: { assignedSectionIds: [school.s6A] } });
      const res = await get(staff1Tokens, `/api/v1/students/${ali._id}/fee-history`);
      expect(res.body.data.payments.map((p: { receiptNo: string }) => p.receiptNo)).toEqual([
        'R-S1-00001',
      ]);
    });
  });
});
