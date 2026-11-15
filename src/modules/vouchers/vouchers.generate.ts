import type { ClientSession } from 'mongoose';
import { writeAudit } from '../../common/audit.js';
import { AppError } from '../../common/errors.js';
import type { AuthUser } from '../../common/middleware/auth.js';
import {
  addMonths,
  currentFeeMonth,
  dayOfMonth,
  monthOf,
  today,
} from '../../common/utils/dates.js';
import { insertManySynced, type SyncFields } from '../../db/syncPlugin.js';
import { withTransaction } from '../../db/transaction.js';
import { SchoolClass } from '../classes/classes.model.js';
import { FeeStructure, type FeeStructureAttrs } from '../fee-structures/fee-structures.model.js';
import type { AcademicSessionDoc } from '../sessions/sessions.model.js';
import { requireCurrentSession } from '../sessions/sessions.service.js';
import { getSettings } from '../settings/settings.service.js';
import { Student, type StudentDoc } from '../students/students.model.js';
import { recalcVoucher } from './voucher.calc.js';
import type { GenerateVouchersInput } from './vouchers.schemas.js';
import {
  LINE_LABELS,
  monthlyVoucherNo,
  OPEN_BALANCE,
  Voucher,
  type LineCode,
  type VoucherAttrs,
  type VoucherDoc,
} from './vouchers.model.js';

const BATCH_SIZE = 500;

type NewVoucher = Omit<VoucherAttrs, keyof SyncFields | '_id' | 'lines' | 'waivers'> & {
  lines: { code: LineCode; label: string; amount: number }[];
  waivers: [];
  createdBy: string;
};

const sessionMonths = (s: AcademicSessionDoc) => ({
  first: monthOf(s.startDate),
  last: monthOf(s.endDate),
});

function lines(entries: [LineCode, number][]): NewVoucher['lines'] {
  return entries
    .filter(([, amount]) => amount > 0)
    .map(([code, amount]) => ({ code, label: LINE_LABELS[code], amount }));
}

/** A new MONTHLY voucher with its totals worked out by recalcVoucher. */
function buildMonthlyVoucher(args: {
  user: AuthUser;
  student: Pick<StudentDoc, '_id' | 'admissionNo' | 'current'>;
  feeMonth: string;
  earlierCount: number;
  lines: NewVoucher['lines'];
  issueDate: Date;
  dueDate: Date;
  previousDues: VoucherAttrs['previousDues'];
}): NewVoucher {
  return recalcVoucher<NewVoucher>({
    voucherNo: monthlyVoucherNo(args.feeMonth, args.student.admissionNo, args.earlierCount),
    type: 'MONTHLY',
    studentId: args.student._id,
    sessionId: args.student.current.sessionId,
    classId: args.student.current.classId,
    sectionId: args.student.current.sectionId,
    feeMonth: args.feeMonth,
    issueDate: args.issueDate,
    dueDate: args.dueDate,
    lines: args.lines,
    waivers: [],
    paidAmount: 0,
    totalAmount: 0,
    waivedAmount: 0,
    balance: 0,
    status: 'UNPAID',
    previousDues: args.previousDues,
    cancellation: null,
    createdBy: args.user.id,
  });
}

/** Existing monthly vouchers for a month: who already has a live one, and how many each had. */
async function existingForMonth(studentIds: string[], feeMonth: string, session?: ClientSession) {
  const existing = await Voucher.find(
    { type: 'MONTHLY', feeMonth, studentId: { $in: studentIds } },
    { studentId: 1, status: 1 },
  )
    .session(session ?? null)
    .lean();
  const live = new Set(existing.filter((v) => v.status !== 'CANCELLED').map((v) => v.studentId));
  const count = new Map<string, number>();
  for (const v of existing) count.set(v.studentId, (count.get(v.studentId) ?? 0) + 1);
  return { live, count };
}

async function feeStructuresFor(sessionId: string, classIds: string[]) {
  const structures = await FeeStructure.find({ sessionId, classId: { $in: classIds } }).lean();
  const byClass = new Map<string, FeeStructureAttrs>(structures.map((s) => [s.classId, s]));
  const missing = classIds.filter((id) => !byClass.has(id));
  if (missing.length > 0) {
    const names = (await SchoolClass.find({ _id: { $in: missing } }, { name: 1 }).lean()).map(
      (c) => c.name,
    );
    throw new AppError(
      'VALIDATION_ERROR',
      `Set the fee structure first for: ${names.join(', ')}.`,
      { classIds: missing, classes: names },
    );
  }
  return byClass;
}

export interface GenerationPlan {
  feeMonth: string;
  studentsInScope: number;
  vouchers: NewVoucher[];
  /** Students skipped because they already have this month's voucher (or owe nothing). */
  skipped: number;
  totalAmount: number;
  byClass: { classId: string; vouchers: number; totalAmount: number }[];
}

/** Works out the vouchers to create (Section 8.2). Reads only; writes nothing. */
export async function planGeneration(
  user: AuthUser,
  input: GenerateVouchersInput,
): Promise<GenerationPlan> {
  const currentSession = await requireCurrentSession();
  const { first, last } = sessionMonths(currentSession);
  if (input.feeMonth < first || input.feeMonth > last) {
    throw new AppError(
      'VALIDATION_ERROR',
      `Fee month must be inside the current session (${first} to ${last}).`,
    );
  }
  if (input.feeMonth > addMonths(currentFeeMonth(), 1)) {
    throw new AppError('VALIDATION_ERROR', 'Vouchers can be generated up to next month only.');
  }

  // Active students of the current session in scope.
  const filter: Record<string, unknown> = {
    status: 'ACTIVE',
    'current.sessionId': currentSession._id,
  };
  if (input.scope === 'CLASS') filter['current.classId'] = input.classId;
  if (input.scope === 'STUDENT') {
    const student = await Student.findById(input.studentId, { status: 1, current: 1 }).lean();
    if (!student) throw new AppError('NOT_FOUND', 'Student not found.');
    if (student.status !== 'ACTIVE') {
      throw new AppError('STUDENT_NOT_ACTIVE', 'Only active students get vouchers.');
    }
    if (student.current.sessionId !== currentSession._id) {
      throw new AppError('VALIDATION_ERROR', 'The student is not enrolled in the current session.');
    }
    filter._id = input.studentId;
  }
  const students = await Student.find(filter, { admissionNo: 1, current: 1 }).lean();
  const studentIds = students.map((s) => s._id);

  const structures = await feeStructuresFor(currentSession._id, [
    ...new Set(students.map((s) => s.current.classId)),
  ]);
  const { live, count } = await existingForMonth(studentIds, input.feeMonth);
  const toCharge = students.filter((s) => !live.has(s._id));

  // Previous dues: open balances of earlier vouchers in the same session (display only).
  const dues = await Voucher.aggregate<{ _id: string; amount: number; months: string[] }>([
    {
      $match: {
        ...OPEN_BALANCE,
        sessionId: currentSession._id,
        studentId: { $in: toCharge.map((s) => s._id) },
        feeMonth: { $lt: input.feeMonth },
      },
    },
    { $sort: { feeMonth: 1 } },
    { $group: { _id: '$studentId', amount: { $sum: '$balance' }, months: { $push: '$feeMonth' } } },
  ]);
  const duesByStudent = new Map(dues.map((d) => [d._id, d]));

  const settings = await getSettings();
  const issueDate = input.issueDate ?? dayOfMonth(input.feeMonth, settings.voucherIssueDay);
  const dueDate = input.dueDate ?? dayOfMonth(input.feeMonth, settings.voucherDueDay);
  if (dueDate < issueDate) {
    throw new AppError('VALIDATION_ERROR', 'The due date must be on or after the issue date.');
  }

  const vouchers: NewVoucher[] = [];
  for (const student of toCharge) {
    const fee = structures.get(student.current.classId);
    if (!fee) continue; // feeStructuresFor already threw for missing ones
    const voucherLines = lines([
      ['TUITION', fee.tuitionFee],
      ['EXAM', input.addExamFee ? fee.examFee : 0],
    ]);
    if (voucherLines.length === 0) continue; // nothing to charge (all fees are 0)
    const studentDues = duesByStudent.get(student._id);
    vouchers.push(
      buildMonthlyVoucher({
        user,
        student,
        feeMonth: input.feeMonth,
        earlierCount: count.get(student._id) ?? 0,
        lines: voucherLines,
        issueDate,
        dueDate,
        previousDues: {
          amount: studentDues?.amount ?? 0,
          months: [...new Set(studentDues?.months ?? [])],
        },
      }),
    );
  }

  const byClass = new Map<string, { classId: string; vouchers: number; totalAmount: number }>();
  for (const v of vouchers) {
    const row = byClass.get(v.classId) ?? { classId: v.classId, vouchers: 0, totalAmount: 0 };
    row.vouchers += 1;
    row.totalAmount += v.totalAmount;
    byClass.set(v.classId, row);
  }

  return {
    feeMonth: input.feeMonth,
    studentsInScope: students.length,
    vouchers,
    skipped: students.length - vouchers.length,
    totalAmount: vouchers.reduce((sum, v) => sum + v.totalAmount, 0),
    byClass: [...byClass.values()],
  };
}

export async function previewGeneration(user: AuthUser, input: GenerateVouchersInput) {
  const { vouchers, ...summary } = await planGeneration(user, input);
  return { ...summary, toCreate: vouchers.length };
}

/**
 * Creates the month's vouchers in batches of 500, each batch in its own transaction.
 * Safe to run again: students who already have the month's voucher are skipped, and the
 * unique index (studentId + feeMonth) prevents duplicates even if two runs overlap.
 */
export async function generateVouchers(
  user: AuthUser,
  input: GenerateVouchersInput,
): Promise<{ created: number; skipped: number; totalAmount: number }> {
  const plan = await planGeneration(user, input);
  let created = 0;
  let totalAmount = 0;

  for (let i = 0; i < plan.vouchers.length; i += BATCH_SIZE) {
    const batch = plan.vouchers.slice(i, i + BATCH_SIZE);
    const result = await withTransaction(async (session) => {
      // Re-check inside the transaction in case another run created some meanwhile.
      const { live } = await existingForMonth(
        batch.map((v) => v.studentId),
        input.feeMonth,
        session,
      );
      const fresh = batch.filter((v) => !live.has(v.studentId));
      await insertManySynced(Voucher, fresh, session);
      const amount = fresh.reduce((sum, v) => sum + v.totalAmount, 0);
      if (fresh.length > 0) {
        await writeAudit(session, {
          action: 'VOUCHERS_GENERATE',
          userId: user.id,
          entity: 'voucher',
          after: {
            feeMonth: input.feeMonth,
            scope: input.scope,
            addExamFee: input.addExamFee,
            created: fresh.length,
            totalAmount: amount,
          },
        });
      }
      return { created: fresh.length, amount };
    });
    created += result.created;
    totalAmount += result.amount;
  }

  return { created, skipped: plan.studentsInScope - created, totalAmount };
}

/**
 * Admission charge (Section 8.1 step 4): the current month's voucher with tuition + admission
 * fee. The full month is charged even mid-month. Runs inside the admission transaction.
 */
export async function createAdmissionVoucher(
  user: AuthUser,
  student: StudentDoc,
  currentSession: AcademicSessionDoc,
  session: ClientSession,
): Promise<VoucherDoc | null> {
  const fee = await FeeStructure.findOne({
    sessionId: currentSession._id,
    classId: student.current.classId,
  }).session(session);
  if (!fee) {
    const cls = await SchoolClass.findById(student.current.classId, { name: 1 }).session(session);
    throw new AppError(
      'VALIDATION_ERROR',
      `Set the fee structure for ${cls?.name ?? 'this class'} (${currentSession.name}) before admitting students.`,
    );
  }

  // The current month, kept inside the session (e.g. admitted in March for an April session).
  const { first, last } = sessionMonths(currentSession);
  const month = currentFeeMonth();
  const feeMonth = month < first ? first : month > last ? last : month;

  const { live, count } = await existingForMonth([student._id], feeMonth, session);
  if (live.has(student._id)) return null;

  const voucherLines = lines([
    ['TUITION', fee.tuitionFee],
    ['ADMISSION', fee.admissionFee],
  ]);
  if (voucherLines.length === 0) return null;

  const settings = await getSettings(session);
  const issueDate = today();
  const standardDue = dayOfMonth(feeMonth, settings.voucherDueDay);
  const [voucher] = await Voucher.create(
    [
      buildMonthlyVoucher({
        user,
        student,
        feeMonth,
        earlierCount: count.get(student._id) ?? 0,
        lines: voucherLines,
        issueDate,
        // Admitted after the usual due day: due on the admission day, not already overdue.
        dueDate: standardDue < issueDate ? issueDate : standardDue,
        previousDues: { amount: 0, months: [] },
      }),
    ],
    { session },
  );
  return voucher ?? null;
}
