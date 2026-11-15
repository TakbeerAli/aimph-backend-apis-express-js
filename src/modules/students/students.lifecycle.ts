import { writeAudit } from '../../common/audit.js';
import { AppError } from '../../common/errors.js';
import type { AuthUser } from '../../common/middleware/auth.js';
import { today } from '../../common/utils/dates.js';
import { formatPkr } from '../../common/utils/money.js';
import { withTransaction } from '../../db/transaction.js';
import { SchoolClass, type ClassDoc } from '../classes/classes.model.js';
import { requireActivePlacement } from '../classes/classes.service.js';
import { AcademicSession } from '../sessions/sessions.model.js';
import { recalcVoucher } from '../vouchers/voucher.calc.js';
import { OPEN_BALANCE, Voucher } from '../vouchers/vouchers.model.js';
import { Student, type StudentDoc } from './students.model.js';
import type { PromoteInput, WithdrawInput } from './students.schemas.js';

/**
 * Section 8.8. Open dues (any session) are COLLECTED (must already be 0), KEPT_AS_DUES
 * (still collectable later) or WAIVED (each open voucher waived in the same transaction).
 * A withdrawn student gets no more vouchers; history is kept.
 */
export async function withdrawStudent(
  user: AuthUser,
  id: string,
  input: WithdrawInput,
): Promise<{ student: StudentDoc; duesAtWithdrawal: number; waivedVouchers: number }> {
  return withTransaction(async (session) => {
    const student = await Student.findById(id).session(session);
    if (!student) throw new AppError('NOT_FOUND', 'Student not found.');
    if (student.status !== 'ACTIVE') {
      throw new AppError('STUDENT_NOT_ACTIVE', 'Only active students can be withdrawn.');
    }

    const openVouchers = await Voucher.find({ studentId: student._id, ...OPEN_BALANCE })
      .sort({ feeMonth: 1 })
      .session(session);
    const duesAtWithdrawal = openVouchers.reduce((sum, v) => sum + v.balance, 0);

    if (input.duesAction === 'COLLECTED' && duesAtWithdrawal > 0) {
      throw new AppError(
        'VALIDATION_ERROR',
        `${formatPkr(duesAtWithdrawal)} is still due. Collect the payment first, or keep or waive the dues.`,
        { duesAtWithdrawal },
      );
    }
    if (input.duesAction === 'WAIVED') {
      const reason = input.waiveReason ?? 'Waived at withdrawal';
      for (const voucher of openVouchers) {
        const amount = voucher.balance;
        voucher.waivers.push({ amount, reason, by: user.id, at: new Date() });
        recalcVoucher(voucher);
        await voucher.save({ session });
        await writeAudit(session, {
          action: 'DUES_WAIVE',
          userId: user.id,
          entity: 'voucher',
          entityId: voucher._id,
          before: { balance: amount },
          after: { waived: amount, balance: voucher.balance },
          reason,
        });
      }
    }

    const date = input.date ?? today();
    const entry = student.classHistory.findLast((h) => h.outcome === 'IN_PROGRESS');
    if (entry) {
      entry.outcome = 'WITHDRAWN';
      entry.endDate = date;
    }
    student.status = 'WITHDRAWN';
    student.withdrawal = {
      date,
      reason: input.reason,
      ...(input.reasonNote && { reasonNote: input.reasonNote }),
      duesAction: input.duesAction,
      duesAtWithdrawal,
      processedBy: user.id,
    };
    await student.save({ session });

    await writeAudit(session, {
      action: 'STUDENT_WITHDRAW',
      userId: user.id,
      entity: 'student',
      entityId: student._id,
      before: { status: 'ACTIVE' },
      after: { status: 'WITHDRAWN', duesAction: input.duesAction, duesAtWithdrawal },
      ...(input.waiveReason && { reason: input.waiveReason }),
    });
    return {
      student,
      duesAtWithdrawal,
      waivedVouchers: input.duesAction === 'WAIVED' ? openVouchers.length : 0,
    };
  });
}

export interface PromotionResult {
  promoted: number;
  graduated: number;
  retained: number;
  /** Students already moved to the new session (running it again changes nothing). */
  skipped: number;
}

/**
 * Section 8.9: moves a whole class (or one section) from one session to the next.
 * History entries are closed and new ones added; nothing is overwritten.
 */
export async function promoteClass(user: AuthUser, input: PromoteInput): Promise<PromotionResult> {
  return withTransaction(async (session) => {
    // One at a time: a transaction session cannot run operations in parallel.
    const from = await AcademicSession.findById(input.fromSessionId).session(session);
    const to = await AcademicSession.findById(input.toSessionId).session(session);
    const cls = await SchoolClass.findById(input.classId).session(session);
    if (!from || !to) throw new AppError('NOT_FOUND', 'Session not found.');
    if (!cls) throw new AppError('NOT_FOUND', 'Class not found.');
    if (to.startDate <= from.startDate) {
      throw new AppError('VALIDATION_ERROR', 'Students can only be promoted into a later session.');
    }
    if (input.sectionId && !cls.sections.id(input.sectionId)) {
      throw new AppError('VALIDATION_ERROR', `That section is not part of ${cls.name}.`);
    }

    // The last class (no next class) graduates; others need a section in the next class.
    let nextClass: ClassDoc | null = null;
    if (cls.nextClassId) {
      if (!input.toSectionId) {
        throw new AppError('VALIDATION_ERROR', 'Choose the section in the next class.');
      }
      nextClass = (await requireActivePlacement(cls.nextClassId, input.toSectionId, session)).cls;
    }

    const students = await Student.find({
      status: 'ACTIVE',
      'current.sessionId': from._id,
      'current.classId': cls._id,
      ...(input.sectionId && { 'current.sectionId': input.sectionId }),
    }).session(session);
    const excluded = new Set(input.excludeStudentIds);
    const result: PromotionResult = { promoted: 0, graduated: 0, retained: 0, skipped: 0 };

    for (const student of students) {
      const entry = student.classHistory.findLast(
        (h) => h.sessionId === from._id && h.outcome === 'IN_PROGRESS',
      );
      if (!entry || student.classHistory.some((h) => h.sessionId === to._id)) {
        result.skipped += 1;
        continue;
      }
      entry.endDate = from.endDate;

      const moveTo = (classId: string, sectionId: string, entryType: 'PROMOTED' | 'RETAINED') => {
        student.classHistory.push({
          sessionId: to._id,
          classId,
          sectionId,
          entryType,
          outcome: 'IN_PROGRESS',
          startDate: to.startDate,
          endDate: null,
          sectionChanges: [],
        });
        // Roll numbers are given again in the new session.
        student.set('current', { sessionId: to._id, classId, sectionId });
      };

      if (excluded.has(student._id)) {
        entry.outcome = 'RETAINED';
        moveTo(cls._id, student.current.sectionId, 'RETAINED');
        result.retained += 1;
      } else if (!nextClass || !input.toSectionId) {
        entry.outcome = 'GRADUATED';
        student.status = 'GRADUATED';
        result.graduated += 1;
      } else {
        entry.outcome = 'PROMOTED';
        moveTo(nextClass._id, input.toSectionId, 'PROMOTED');
        result.promoted += 1;
      }
      await student.save({ session });
    }

    await writeAudit(session, {
      action: 'CLASS_PROMOTE',
      userId: user.id,
      entity: 'class',
      entityId: cls._id,
      after: {
        fromSession: from.name,
        toSession: to.name,
        sectionId: input.sectionId ?? null,
        toClassId: nextClass?._id ?? null,
        toSectionId: input.toSectionId ?? null,
        ...result,
      },
    });
    return result;
  });
}
