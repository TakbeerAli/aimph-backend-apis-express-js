import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  admit,
  bearer,
  collect,
  createUser,
  login,
  resetDatabase,
  setupSchool,
  type Tokens,
} from '../../../test/helpers.js';
import { createApp } from '../../app.js';
import { AuditLog } from '../../common/audit.js';
import { SETTINGS_ID } from '../../db/counters.js';
import { AcademicSession } from '../sessions/sessions.model.js';
import { createSession } from '../sessions/sessions.service.js';
import { Settings } from '../settings/settings.model.js';
import { generateVouchers } from '../vouchers/vouchers.generate.js';
import { Voucher } from '../vouchers/vouchers.model.js';
import { Student, type StudentDoc } from './students.model.js';

const api = '/api/v1/students';

// "Today" is 20 Nov 2026 in Karachi. Only Date is faked, so MongoDB timers keep working.
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-20T10:00:00+05:00'));
});
afterAll(() => {
  vi.useRealTimers();
});

describe('student lifecycle', () => {
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
    ali = await admit(school.actor, in5A, { rollNo: 12 }); // Nov voucher 7,500
  });

  const post = (tokens: Tokens, path: string, body: object) =>
    request(app).post(path).set('Authorization', bearer(tokens)).send(body);
  const student = (id: string) => Student.findById(id).orFail().lean();

  describe('withdrawal', () => {
    beforeEach(async () => {
      await generateVouchers(school.actor, {
        feeMonth: '2026-09',
        scope: 'ALL',
        addExamFee: false,
      });
      const sep = await Voucher.findOne({ studentId: ali._id, feeMonth: '2026-09' }).orFail();
      await collect(school.actor, 1, ali._id, [{ voucherId: sep._id, amount: 1000 }]);
      // Ali now owes Sep 1,500 + Nov 7,500 = 9,000.
    });

    const withdraw = (body: object, tokens = adminTokens) =>
      post(tokens, `${api}/${ali._id}/withdraw`, body);

    it('WAIVED clears every open balance with waivers (#19)', async () => {
      const res = await withdraw({
        date: '2026-11-20',
        reason: 'SHIFTED_CITY',
        duesAction: 'WAIVED',
        waiveReason: 'Family moved to Lahore',
      });

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ duesAtWithdrawal: 9000, waivedVouchers: 2 });
      const vouchers = await Voucher.find({ studentId: ali._id }).sort({ feeMonth: 1 }).lean();
      expect(vouchers.map((v) => [v.feeMonth, v.balance, v.status])).toEqual([
        ['2026-09', 0, 'PAID'], // 1,000 paid + 1,500 waived
        ['2026-11', 0, 'WAIVED'],
      ]);
      expect(vouchers[0]?.waivers[0]).toMatchObject({
        amount: 1500,
        reason: 'Family moved to Lahore',
      });

      const stored = await student(ali._id);
      expect(stored.status).toBe('WITHDRAWN');
      expect(stored.withdrawal).toMatchObject({
        reason: 'SHIFTED_CITY',
        duesAction: 'WAIVED',
        duesAtWithdrawal: 9000,
        processedBy: school.admin._id,
      });
      expect(stored.classHistory[0]).toMatchObject({
        outcome: 'WITHDRAWN',
        endDate: new Date('2026-11-20T00:00:00.000Z'),
      });
      expect(await AuditLog.countDocuments({ action: 'DUES_WAIVE' })).toBe(2);
      expect(await AuditLog.countDocuments({ action: 'STUDENT_WITHDRAW' })).toBe(1);
    });

    it('KEPT_AS_DUES leaves the balances, which can still be collected later', async () => {
      const res = await withdraw({ reason: 'FINANCIAL', duesAction: 'KEPT_AS_DUES' });
      expect(res.status).toBe(200);

      const nov = await Voucher.findOne({ studentId: ali._id, feeMonth: '2026-11' }).orFail();
      expect(nov.balance).toBe(7500);
      const paid = await collect(school.actor, 2, ali._id, [{ voucherId: nov._id, amount: 7500 }]);
      expect(paid.payment.status).toBe('CONFIRMED');
    });

    it('COLLECTED is only allowed once the balance is 0', async () => {
      const early = await withdraw({ reason: 'ADMISSION_ELSEWHERE', duesAction: 'COLLECTED' });
      expect(early.status).toBe(400);
      expect(early.body.error.message).toMatch(/PKR 9,000 is still due/);

      const open = await Voucher.find({ studentId: ali._id, balance: { $gt: 0 } }).lean();
      await collect(
        school.actor,
        2,
        ali._id,
        open.map((v) => ({ voucherId: v._id, amount: v.balance })),
      );
      const done = await withdraw({ reason: 'ADMISSION_ELSEWHERE', duesAction: 'COLLECTED' });
      expect(done.status).toBe(200);
    });

    it('a withdrawn student gets no more vouchers and frees the roll number', async () => {
      await withdraw({ reason: 'FINANCIAL', duesAction: 'KEPT_AS_DUES' });

      const result = await generateVouchers(school.actor, {
        feeMonth: '2026-12',
        scope: 'ALL',
        addExamFee: false,
      });
      expect(result.created).toBe(0);
      const sameRoll = await admit(school.actor, in5A, { rollNo: 12 });
      expect(sameRoll.current.rollNo).toBe(12);
    });

    it('validates the request and the student state', async () => {
      expect((await withdraw({ reason: 'FINANCIAL', duesAction: 'WAIVED' })).status).toBe(400);
      expect((await withdraw({ reason: 'OTHER', duesAction: 'KEPT_AS_DUES' })).status).toBe(400);
      expect(
        (await withdraw({ reason: 'FINANCIAL', duesAction: 'KEPT_AS_DUES' }, staffTokens)).status,
      ).toBe(403);

      await withdraw({ reason: 'FINANCIAL', duesAction: 'KEPT_AS_DUES' });
      const again = await withdraw({ reason: 'FINANCIAL', duesAction: 'KEPT_AS_DUES' });
      expect(again.status).toBe(422);
      expect(again.body.error.code).toBe('STUDENT_NOT_ACTIVE');
    });
  });

  describe('promotion (#18)', () => {
    let nextSessionId: string;
    let bilal: StudentDoc;

    beforeEach(async () => {
      nextSessionId = (await createSession(school.actor, { name: '2027-28' }))._id;
      await admit(school.actor, in5A); // Sara, 5-A
      bilal = await admit(school.actor, { classId: school.class5Id, sectionId: school.s5B });
    });

    const promote = (body: object, tokens = adminTokens) =>
      post(tokens, `${api}/promote`, {
        fromSessionId: school.sessionId,
        toSessionId: nextSessionId,
        ...body,
      });

    it('moves the class, keeps old history, and retains excluded students', async () => {
      const res = await promote({
        classId: school.class5Id,
        toSectionId: school.s6A,
        excludeStudentIds: [bilal._id],
      });

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ promoted: 2, graduated: 0, retained: 1, skipped: 0 });

      const promoted = await student(ali._id);
      expect(promoted.status).toBe('ACTIVE');
      expect(promoted.current).toEqual({
        sessionId: nextSessionId,
        classId: school.class6Id,
        sectionId: school.s6A,
      });
      expect(promoted.classHistory).toHaveLength(2);
      expect(promoted.classHistory[0]).toMatchObject({
        sessionId: school.sessionId,
        classId: school.class5Id,
        sectionId: school.s5A,
        rollNo: 12,
        entryType: 'NEW_ADMISSION',
        outcome: 'PROMOTED',
        endDate: new Date('2027-03-31T00:00:00.000Z'),
      });
      expect(promoted.classHistory[1]).toMatchObject({
        sessionId: nextSessionId,
        classId: school.class6Id,
        sectionId: school.s6A,
        entryType: 'PROMOTED',
        outcome: 'IN_PROGRESS',
        startDate: new Date('2027-04-01T00:00:00.000Z'),
        endDate: null,
      });

      const retained = await student(bilal._id);
      expect(retained.classHistory.map((h) => [h.outcome, h.entryType])).toEqual([
        ['RETAINED', 'NEW_ADMISSION'],
        ['IN_PROGRESS', 'RETAINED'],
      ]);
      expect(retained.current).toEqual({
        sessionId: nextSessionId,
        classId: school.class5Id,
        sectionId: school.s5B,
      });
      expect(await AuditLog.countDocuments({ action: 'CLASS_PROMOTE' })).toBe(1);
    });

    it('running it twice changes nothing the second time', async () => {
      const body = { classId: school.class5Id, toSectionId: school.s6A };
      await promote(body);
      const second = await promote(body);

      expect(second.body.data).toEqual({ promoted: 0, graduated: 0, retained: 0, skipped: 0 });
      expect((await student(ali._id)).classHistory).toHaveLength(2);
    });

    it('can promote one section only', async () => {
      const res = await promote({
        classId: school.class5Id,
        sectionId: school.s5A,
        toSectionId: school.s6A,
      });
      expect(res.body.data.promoted).toBe(2);
      expect((await student(bilal._id)).current.sessionId).toBe(school.sessionId);
    });

    it('the last class (Class 6 here, Class 10 in the school) graduates', async () => {
      const zara = await admit(school.actor, { classId: school.class6Id, sectionId: school.s6A });

      const res = await promote({ classId: school.class6Id });

      expect(res.body.data).toEqual({ promoted: 0, graduated: 1, retained: 0, skipped: 0 });
      const graduated = await student(zara._id);
      expect(graduated.status).toBe('GRADUATED');
      expect(graduated.classHistory).toHaveLength(1);
      expect(graduated.classHistory[0]?.outcome).toBe('GRADUATED');
    });

    it('validates sessions, the next section and permissions', async () => {
      expect((await promote({ classId: school.class5Id })).status).toBe(400); // no toSectionId
      expect((await promote({ classId: school.class5Id, toSectionId: school.s5B })).status).toBe(
        400,
      ); // section is not in the next class
      const earlier = await createSession(school.actor, { name: '2025-26' });
      expect(
        (
          await promote({
            classId: school.class5Id,
            toSectionId: school.s6A,
            toSessionId: earlier._id,
          })
        ).status,
      ).toBe(400);
      expect(
        (await promote({ classId: school.class5Id, toSectionId: school.s6A }, staffTokens)).status,
      ).toBe(403);
    });
  });

  describe('set current session', () => {
    let nextSessionId: string;

    beforeEach(async () => {
      nextSessionId = (await createSession(school.actor, { name: '2027-28' }))._id;
    });

    const setCurrent = (id: string, tokens = adminTokens) =>
      post(tokens, `/api/v1/sessions/${id}/set-current`, {});

    it('switches the current session and closes the old one', async () => {
      const res = await setCurrent(nextSessionId);

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ name: '2027-28', isCurrent: true, status: 'ACTIVE' });
      const old = await AcademicSession.findById(school.sessionId).lean();
      expect(old).toMatchObject({ isCurrent: false, status: 'CLOSED' });
      expect(await AcademicSession.countDocuments({ isCurrent: true })).toBe(1);
      expect((await Settings.findById(SETTINGS_ID).lean())?.currentSessionId).toBe(nextSessionId);
      expect(await AuditLog.countDocuments({ action: 'SESSION_SET_CURRENT' })).toBe(1);
    });

    it('old unpaid vouchers stay and can still be collected', async () => {
      await setCurrent(nextSessionId);

      const nov = await Voucher.findOne({ studentId: ali._id, feeMonth: '2026-11' }).orFail();
      expect(nov.balance).toBe(7500);
      const paid = await collect(school.actor, 1, ali._id, [{ voucherId: nov._id, amount: 7500 }]);
      expect(paid.payment.status).toBe('CONFIRMED');
    });

    it('rejects the current, a closed or an earlier session, and Staff', async () => {
      expect((await setCurrent(school.sessionId)).status).toBe(409);
      const earlier = await createSession(school.actor, { name: '2025-26' });
      expect((await setCurrent(earlier._id)).status).toBe(400);
      expect((await setCurrent(nextSessionId, staffTokens)).status).toBe(403);

      await setCurrent(nextSessionId);
      expect((await setCurrent(school.sessionId)).status).toBe(400); // closed
    });
  });
});
