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
  studentBody,
  type Tokens,
} from '../../../test/helpers.js';
import { createApp } from '../../app.js';
import type { AuthUser } from '../../common/middleware/auth.js';
import { newId } from '../../common/utils/ids.js';
import { Payment } from '../payments/payments.model.js';
import type { StudentDoc } from '../students/students.model.js';
import { Student } from '../students/students.model.js';
import { updateStudent } from '../students/students.service.js';
import { User, type UserDoc } from '../users/users.model.js';
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

interface PullBody {
  changes: Record<string, { _id: string; syncSeq: number; [key: string]: unknown }[]>;
  nextSince: number;
  hasMore: boolean;
}

describe('sync', () => {
  let app: ReturnType<typeof createApp>;
  let school: Awaited<ReturnType<typeof setupSchool>>;
  let adminTokens: Tokens;
  let staff1: UserDoc;
  let staff2: UserDoc;
  let staff1Tokens: Tokens;
  let staff2Tokens: Tokens;
  let ali: StudentDoc; // Class 5
  let bilal: StudentDoc; // Class 6

  beforeEach(async () => {
    await resetDatabase();
    app = createApp();
    school = await setupSchool();
    staff1 = await createUser({
      username: 'staff1',
      deviceCode: 'S1',
      assignedClassIds: [school.class5Id],
    });
    staff2 = await createUser({
      username: 'staff2',
      deviceCode: 'S2',
      assignedClassIds: [school.class6Id],
    });
    adminTokens = await login(app, school.admin);
    staff1Tokens = await login(app, staff1);
    staff2Tokens = await login(app, staff2);
    ali = await admit(school.actor, { classId: school.class5Id, sectionId: school.s5A });
    bilal = await admit(school.actor, { classId: school.class6Id, sectionId: school.s6A });
  });

  const pullAs = async (tokens: Tokens, since = 0, limit = 500) => {
    const res = await request(app)
      .get(`/api/v1/sync/pull?since=${since}&limit=${limit}`)
      .set('Authorization', bearer(tokens));
    expect(res.status).toBe(200);
    return res.body.data as PullBody;
  };
  const pushAs = (tokens: Tokens, operations: object[]) =>
    request(app)
      .post('/api/v1/sync/push')
      .set('Authorization', bearer(tokens))
      .send({ operations });

  const ids = (docs: { _id: string }[] | undefined) => (docs ?? []).map((d) => d._id).sort();

  describe('pull (#23)', () => {
    let aliPayment: string;
    let bilalPayment: string;
    let adminPaymentForAli: string;

    beforeEach(async () => {
      const aliNov = (await Voucher.findOne({ studentId: ali._id }).orFail())._id;
      const bilalNov = (await Voucher.findOne({ studentId: bilal._id }).orFail())._id;
      aliPayment = (
        await collect(asAuthUser(staff1), 1, ali._id, [{ voucherId: aliNov, amount: 1000 }])
      ).payment._id;
      bilalPayment = (
        await collect(asAuthUser(staff2), 1, bilal._id, [{ voucherId: bilalNov, amount: 1000 }])
      ).payment._id;
      adminPaymentForAli = (
        await collect(school.actor, 1, ali._id, [{ voucherId: aliNov, amount: 500 }])
      ).payment._id;
    });

    it('since=0 returns everything the user may see, without secrets', async () => {
      const { changes, hasMore, nextSince } = await pullAs(adminTokens);

      expect(hasMore).toBe(false);
      expect(changes.academic_sessions).toHaveLength(1);
      expect(changes.classes).toHaveLength(2);
      expect(changes.fee_structures).toHaveLength(2);
      expect(ids(changes.students)).toEqual([ali._id, bilal._id].sort());
      expect(changes.vouchers).toHaveLength(2);
      expect(changes.payments).toHaveLength(3);
      expect(changes.settings).toHaveLength(1);
      expect(changes.settings?.[0]?.counters).toBeUndefined();
      // Only the user's own record, never hashes.
      expect(ids(changes.users)).toEqual([school.admin._id]);
      expect(JSON.stringify(changes)).not.toMatch(/passwordHash|refreshTokenHash/);
      const maxSeq = Math.max(
        ...Object.values(changes)
          .flat()
          .map((d) => d.syncSeq),
      );
      expect(nextSince).toBe(maxSeq);
    });

    it('Staff get all students and vouchers but only their own and their classes payments', async () => {
      const s1 = await pullAs(staff1Tokens);
      expect(s1.changes.students).toHaveLength(2);
      expect(s1.changes.vouchers).toHaveLength(2);
      // Own payment + Admin's payment for a Class 5 student; not staff2's Class 6 payment.
      expect(ids(s1.changes.payments)).toEqual([aliPayment, adminPaymentForAli].sort());
      expect(ids(s1.changes.users)).toEqual([staff1._id]);

      const s2 = await pullAs(staff2Tokens);
      expect(ids(s2.changes.payments)).toEqual([bilalPayment]);
    });

    it('pages by syncSeq without missing or repeating anything', async () => {
      const full = await pullAs(adminTokens);
      const all = Object.values(full.changes).flat();

      const seen: number[] = [];
      let since = 0;
      let calls = 0;
      for (;;) {
        const page = await pullAs(adminTokens, since, 4);
        const pageSeqs = Object.values(page.changes)
          .flat()
          .map((d) => d.syncSeq);
        expect(pageSeqs.length).toBeLessThanOrEqual(4);
        // Everything on this page comes after the previous page, and nextSince is its last item.
        expect(pageSeqs.every((s) => s > since)).toBe(true);
        expect(page.nextSince).toBe(Math.max(...pageSeqs));
        seen.push(...pageSeqs);
        since = page.nextSince;
        calls += 1;
        if (!page.hasMore) break;
      }

      expect(calls).toBe(Math.ceil(all.length / 4));
      const bySeq = (a: number, b: number) => a - b;
      expect(new Set(seen).size).toBe(seen.length); // nothing repeated
      expect(seen.sort(bySeq)).toEqual(all.map((d) => d.syncSeq).sort(bySeq)); // nothing missed
    });

    it('since=<last> returns only what changed afterwards', async () => {
      const { nextSince } = await pullAs(adminTokens);

      const nothing = await pullAs(adminTokens, nextSince);
      expect(Object.values(nothing.changes).flat()).toHaveLength(0);
      expect(nothing).toMatchObject({ nextSince, hasMore: false });

      await updateStudent(school.actor, ali._id, { version: ali.version, address: 'New address' });
      const later = await pullAs(adminTokens, nextSince);
      expect(
        Object.values(later.changes)
          .flat()
          .map((d) => d._id),
      ).toEqual([ali._id]);
      expect(later.changes.students?.[0]).toMatchObject({ address: 'New address', version: 2 });
    });

    it('records lastSyncAt without creating a change to pull', async () => {
      const { nextSince } = await pullAs(staff1Tokens);
      expect((await User.findById(staff1._id).lean())?.lastSyncAt).toBeInstanceOf(Date);
      expect(Object.values((await pullAs(staff1Tokens, nextSince)).changes).flat()).toHaveLength(0);
    });
  });

  describe('push', () => {
    let aug: string;
    let sep: string;
    const seq: Record<string, number> = {};

    beforeEach(async () => {
      for (const feeMonth of ['2026-08', '2026-09']) {
        await generateVouchers(school.actor, { feeMonth, scope: 'ALL', addExamFee: false });
      }
      aug = (await Voucher.findOne({ studentId: ali._id, feeMonth: '2026-08' }).orFail())._id;
      sep = (await Voucher.findOne({ studentId: ali._id, feeMonth: '2026-09' }).orFail())._id;
      for (const key of Object.keys(seq)) delete seq[key];
    });

    /** A CREATE_PAYMENT operation as a phone would queue it. */
    function paymentOp(
      user: AuthUser,
      allocations: { voucherId: string; amount: number }[],
      studentId = ali._id,
    ) {
      const receiptSeq = (seq[user.deviceCode] = (seq[user.deviceCode] ?? 0) + 1);
      const amount = allocations.reduce((sum, a) => sum + a.amount, 0);
      return {
        opId: newId(),
        type: 'CREATE_PAYMENT',
        clientAt: '2026-11-20T09:00:00+05:00',
        payload: {
          _id: newId(),
          receiptNo: `R-${user.deviceCode}-${String(receiptSeq).padStart(5, '0')}`,
          receiptSeq,
          studentId,
          amount,
          method: 'CASH',
          paidAt: '2026-11-20T09:00:00+05:00',
          allocations,
          receiptSnapshot: {
            studentName: 'Ali Raza',
            fatherName: 'Ahmed Raza',
            admissionNo: 1001,
            className: '5-A',
            months: [],
            previousBalance: 0,
            currentFee: amount,
            fine: 0,
            amountPaid: amount,
            remainingBalance: 0,
          },
        },
      };
    }

    it('applies a payment and treats a resend as DUPLICATE', async () => {
      const op = paymentOp(asAuthUser(staff1), [{ voucherId: aug, amount: 2500 }]);

      const first = await pushAs(staff1Tokens, [op]);
      const again = await pushAs(staff1Tokens, [op]);

      expect(first.status).toBe(200);
      expect(first.body.data.results).toEqual([
        expect.objectContaining({
          opId: op.opId,
          status: 'APPLIED',
          record: expect.objectContaining({ status: 'CONFIRMED' }),
        }),
      ]);
      expect(again.body.data.results[0]).toMatchObject({ opId: op.opId, status: 'DUPLICATE' });
      expect(await Payment.countDocuments()).toBe(1);
    });

    it('two phones paying the same months offline: second is NEEDS_REVIEW, money kept (#6)', async () => {
      const staff3 = await createUser({
        username: 'staff3',
        deviceCode: 'S3',
        assignedClassIds: [school.class5Id],
      });
      const both = [
        { voucherId: aug, amount: 2500 },
        { voucherId: sep, amount: 2500 },
      ];

      const first = await pushAs(staff1Tokens, [paymentOp(asAuthUser(staff1), both)]);
      const second = await pushAs(await login(app, staff3), [paymentOp(asAuthUser(staff3), both)]);

      expect(first.body.data.results[0].status).toBe('APPLIED');
      expect(second.body.data.results[0]).toMatchObject({
        status: 'NEEDS_REVIEW',
        record: { status: 'NEEDS_REVIEW', unallocatedAmount: 5000 },
      });
      const vouchers = await Voucher.find({ _id: { $in: [aug, sep] } }).lean();
      expect(vouchers.every((v) => v.balance === 0)).toBe(true);
    });

    it('processes in order; a bad operation does not block the others', async () => {
      const bad = { opId: newId(), type: 'CREATE_PAYMENT', payload: { amount: 'lots' } };
      const unknown = { opId: newId(), type: 'DELETE_EVERYTHING', payload: {} };
      const notMine = paymentOp(asAuthUser(staff1), [{ voucherId: aug, amount: 100 }], bilal._id);
      const good = paymentOp(asAuthUser(staff1), [{ voucherId: aug, amount: 1000 }]);

      const res = await pushAs(staff1Tokens, [bad, unknown, notMine, good]);

      expect(
        res.body.data.results.map((r: { status: string; errorCode?: string }) => [
          r.status,
          r.errorCode,
        ]),
      ).toEqual([
        ['REJECTED', 'VALIDATION_ERROR'],
        ['REJECTED', 'VALIDATION_ERROR'],
        ['REJECTED', 'CLASS_NOT_ASSIGNED'],
        ['APPLIED', undefined],
      ]);
      expect(await Payment.countDocuments()).toBe(1);
    });

    it('Staff cannot push student changes', async () => {
      const res = await pushAs(staff1Tokens, [
        {
          opId: newId(),
          type: 'CREATE_STUDENT',
          payload: studentBody(
            { classId: school.class5Id, sectionId: school.s5A },
            { _id: newId() },
          ),
        },
      ]);
      expect(res.body.data.results[0]).toMatchObject({
        status: 'REJECTED',
        errorCode: 'FORBIDDEN',
      });
    });

    it('Admin creates a student offline; a resend is DUPLICATE; _id is required', async () => {
      const studentId = newId();
      const op = {
        opId: newId(),
        type: 'CREATE_STUDENT',
        payload: studentBody(
          { classId: school.class5Id, sectionId: school.s5A },
          { _id: studentId, fullName: 'Offline Kid' },
        ),
      };

      expect((await pushAs(adminTokens, [op])).body.data.results[0]).toMatchObject({
        status: 'APPLIED',
        record: { _id: studentId, fullName: 'Offline Kid' },
      });
      expect((await pushAs(adminTokens, [op])).body.data.results[0].status).toBe('DUPLICATE');
      expect(await Student.countDocuments({ _id: studentId })).toBe(1);

      const noId = {
        opId: newId(),
        type: 'CREATE_STUDENT',
        payload: studentBody({ classId: school.class5Id, sectionId: school.s5A }),
      };
      expect((await pushAs(adminTokens, [noId])).body.data.results[0]).toMatchObject({
        status: 'REJECTED',
        errorCode: 'VALIDATION_ERROR',
      });
    });

    it('UPDATE_STUDENT with an old version is rejected with the server copy (#20)', async () => {
      await updateStudent(school.actor, ali._id, { version: 1, address: 'Changed online' });

      const res = await pushAs(adminTokens, [
        {
          opId: newId(),
          type: 'UPDATE_STUDENT',
          payload: { id: ali._id, version: 1, changes: { fullName: 'Offline edit' } },
        },
      ]);

      expect(res.body.data.results[0]).toMatchObject({
        status: 'REJECTED',
        errorCode: 'VERSION_CONFLICT',
        record: { _id: ali._id, version: 2, address: 'Changed online', fullName: 'Ali Raza' },
      });

      const ok = await pushAs(adminTokens, [
        {
          opId: newId(),
          type: 'UPDATE_STUDENT',
          payload: { id: ali._id, version: 2, changes: { fullName: 'Offline edit' } },
        },
      ]);
      expect(ok.body.data.results[0]).toMatchObject({
        status: 'APPLIED',
        record: { fullName: 'Offline edit', version: 3 },
      });
    });

    it('accepts at most 100 operations per request', async () => {
      const ops = Array.from({ length: 101 }, () => ({
        opId: newId(),
        type: 'CREATE_PAYMENT',
        payload: {},
      }));
      expect((await pushAs(staff1Tokens, ops)).status).toBe(400);
    });

    it('inactive users cannot sync', async () => {
      await User.updateOne({ _id: staff1._id }, { $set: { isActive: false } });
      expect(
        (
          await pushAs(staff1Tokens, [
            paymentOp(asAuthUser(staff1), [{ voucherId: aug, amount: 1 }]),
          ])
        ).status,
      ).toBe(401);
      const pull = await request(app)
        .get('/api/v1/sync/pull')
        .set('Authorization', bearer(staff1Tokens));
      expect(pull.status).toBe(401);
    });
  });
});
