import type { ClientSession, QueryFilter } from 'mongoose';
import { writeAudit } from '../../common/audit.js';
import { AppError } from '../../common/errors.js';
import type { AuthUser } from '../../common/middleware/auth.js';
import { currentFeeMonth, dayOfMonth, today } from '../../common/utils/dates.js';
import { formatPkr } from '../../common/utils/money.js';
import {
  pageResult,
  skipFor,
  toMongoSort,
  type PageResult,
} from '../../common/utils/pagination.js';
import { insertManySynced } from '../../db/syncPlugin.js';
import { withTransaction } from '../../db/transaction.js';
import { requireCurrentSession } from '../sessions/sessions.service.js';
import { Student } from '../students/students.model.js';
import { recalcVoucher } from './voucher.calc.js';
import {
  LINE_LABELS,
  openingVoucherNo,
  Voucher,
  type VoucherAttrs,
  type VoucherDoc,
} from './vouchers.model.js';
import {
  openingBalanceRow,
  type CancelInput,
  type FineInput,
  type ListVouchersQuery,
  type OpeningBalanceRow,
  type WaiveInput,
} from './vouchers.schemas.js';

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function findVoucherOrThrow(id: string, session?: ClientSession): Promise<VoucherDoc> {
  const voucher = await Voucher.findById(id).session(session ?? null);
  if (!voucher) throw new AppError('NOT_FOUND', 'Voucher not found.');
  return voucher;
}

export async function listVouchers(query: ListVouchersQuery): Promise<PageResult<VoucherDoc>> {
  const filter: QueryFilter<VoucherAttrs> = {};
  if (query.feeMonth) filter.feeMonth = query.feeMonth;
  if (query.classId) filter.classId = query.classId;
  if (query.sectionId) filter.sectionId = query.sectionId;
  if (query.studentId) filter.studentId = query.studentId;
  if (query.status) filter.status = query.status;
  if (query.overdue === true) {
    // Overdue is computed, never stored: due date passed and money still owed.
    filter.status = query.status ?? { $ne: 'CANCELLED' };
    filter.balance = { $gt: 0 };
    filter.dueDate = { $lt: today() };
  }
  if (query.q) filter.voucherNo = { $regex: escapeRegex(query.q.toUpperCase()) };

  const [items, total] = await Promise.all([
    Voucher.find(filter).sort(toMongoSort(query.sort)).skip(skipFor(query)).limit(query.limit),
    Voucher.countDocuments(filter),
  ]);
  return pageResult(items, total, query);
}

export const getVoucher = (id: string): Promise<VoucherDoc> => findVoucherOrThrow(id);

export async function getVoucherByNo(voucherNo: string): Promise<VoucherDoc> {
  const voucher = await Voucher.findOne({ voucherNo });
  if (!voucher) throw new AppError('NOT_FOUND', `Voucher ${voucherNo} not found.`);
  return voucher;
}

/** Section 8.5: a manual fine, added as a FINE line. */
export async function addFine(user: AuthUser, id: string, input: FineInput): Promise<VoucherDoc> {
  return withTransaction(async (session) => {
    const voucher = await findVoucherOrThrow(id, session);
    if (voucher.status === 'CANCELLED') {
      throw new AppError('VALIDATION_ERROR', 'A cancelled voucher cannot be fined.');
    }
    const before = { totalAmount: voucher.totalAmount, balance: voucher.balance };
    voucher.lines.push({
      code: 'FINE',
      label: LINE_LABELS.FINE,
      amount: input.amount,
      reason: input.reason,
      addedBy: user.id,
      addedAt: new Date(),
    });
    recalcVoucher(voucher);
    await voucher.save({ session });

    await writeAudit(session, {
      action: 'FINE_ADD',
      userId: user.id,
      entity: 'voucher',
      entityId: voucher._id,
      before,
      after: { fine: input.amount, totalAmount: voucher.totalAmount, balance: voucher.balance },
      reason: input.reason,
    });
    return voucher;
  });
}

/** Section 8.5: waive part or all of the balance. */
export async function waive(user: AuthUser, id: string, input: WaiveInput): Promise<VoucherDoc> {
  return withTransaction(async (session) => {
    const voucher = await findVoucherOrThrow(id, session);
    if (voucher.status === 'CANCELLED') {
      throw new AppError('VALIDATION_ERROR', 'A cancelled voucher cannot be waived.');
    }
    if (input.amount > voucher.balance) {
      throw new AppError(
        'AMOUNT_EXCEEDS_BALANCE',
        `Waiver can't be more than the balance of ${formatPkr(voucher.balance)}.`,
        { balance: voucher.balance },
      );
    }
    const before = { waivedAmount: voucher.waivedAmount, balance: voucher.balance };
    voucher.waivers.push({
      amount: input.amount,
      reason: input.reason,
      by: user.id,
      at: new Date(),
    });
    recalcVoucher(voucher);
    await voucher.save({ session });

    await writeAudit(session, {
      action: 'DUES_WAIVE',
      userId: user.id,
      entity: 'voucher',
      entityId: voucher._id,
      before,
      after: { waived: input.amount, waivedAmount: voucher.waivedAmount, balance: voucher.balance },
      reason: input.reason,
    });
    return voucher;
  });
}

/** Section 8.5: cancel, only when nothing has been paid on it. */
export async function cancel(user: AuthUser, id: string, input: CancelInput): Promise<VoucherDoc> {
  return withTransaction(async (session) => {
    const voucher = await findVoucherOrThrow(id, session);
    if (voucher.status === 'CANCELLED') {
      throw new AppError('VALIDATION_ERROR', 'This voucher is already cancelled.');
    }
    if (voucher.paidAmount > 0) {
      throw new AppError(
        'VOUCHER_HAS_PAYMENTS',
        'This voucher has payments. Reverse the payments before cancelling it.',
      );
    }
    const before = { status: voucher.status };
    voucher.cancellation = { by: user.id, at: new Date(), reason: input.reason };
    recalcVoucher(voucher);
    await voucher.save({ session });

    await writeAudit(session, {
      action: 'VOUCHER_CANCEL',
      userId: user.id,
      entity: 'voucher',
      entityId: voucher._id,
      before,
      after: { status: voucher.status },
      reason: input.reason,
    });
    return voucher;
  });
}

export interface OpeningBalancesResult {
  created: number;
  errors: { row: number; message: string }[];
}

/**
 * Go-live: one OPENING_BALANCE voucher per student for the dues in the paper register.
 * All rows are checked first; if any row has an error nothing is saved. Rows are numbered from 1.
 */
export async function createOpeningBalances(
  user: AuthUser,
  rows: unknown[],
): Promise<OpeningBalancesResult> {
  const errors: OpeningBalancesResult['errors'] = [];
  const valid: { row: number; input: OpeningBalanceRow }[] = [];
  rows.forEach((raw, i) => {
    const parsed = openingBalanceRow.safeParse(raw);
    if (parsed.success) valid.push({ row: i + 1, input: parsed.data });
    else {
      errors.push({
        row: i + 1,
        message: parsed.error.issues
          .map((issue) => `${issue.path.join('.') || 'row'}: ${issue.message}`)
          .join('; '),
      });
    }
  });

  const currentSession = await requireCurrentSession();
  const studentIds = valid.map((v) => v.input.studentId);
  const [students, existing] = await Promise.all([
    Student.find({ _id: { $in: studentIds } }, { admissionNo: 1, status: 1, current: 1 }).lean(),
    Voucher.find(
      { type: 'OPENING_BALANCE', studentId: { $in: studentIds } },
      { studentId: 1, status: 1 },
    ).lean(),
  ]);
  const studentById = new Map(students.map((s) => [s._id, s]));
  const live = new Set(existing.filter((v) => v.status !== 'CANCELLED').map((v) => v.studentId));
  const earlierCount = new Map<string, number>();
  for (const v of existing) earlierCount.set(v.studentId, (earlierCount.get(v.studentId) ?? 0) + 1);

  const thisMonth = currentFeeMonth();
  const firstRowOf = new Map<string, number>();
  for (const { row, input } of valid) {
    const student = studentById.get(input.studentId);
    const repeatOf = firstRowOf.get(input.studentId);
    if (repeatOf) errors.push({ row, message: `Student is repeated (same as row ${repeatOf}).` });
    else firstRowOf.set(input.studentId, row);

    if (!student) errors.push({ row, message: 'Student not found.' });
    else if (student.status !== 'ACTIVE') errors.push({ row, message: 'Student is not active.' });
    else if (student.current.sessionId !== currentSession._id) {
      errors.push({ row, message: 'Student is not enrolled in the current session.' });
    }
    if (live.has(input.studentId)) {
      errors.push({ row, message: 'Student already has an opening balance.' });
    }
    if (input.asOfMonth > thisMonth) {
      errors.push({ row, message: 'asOfMonth cannot be in the future.' });
    }
  }
  if (errors.length > 0) return { created: 0, errors: errors.sort((a, b) => a.row - b.row) };

  const vouchers = valid.map(({ input }) => {
    const student = studentById.get(input.studentId);
    if (!student) throw new Error('unreachable: student checked above');
    // Old dues are already due: issue and due date are the 1st of asOfMonth.
    const date = dayOfMonth(input.asOfMonth, 1);
    return recalcVoucher({
      voucherNo: openingVoucherNo(student.admissionNo, earlierCount.get(student._id) ?? 0),
      type: 'OPENING_BALANCE' as const,
      studentId: student._id,
      sessionId: currentSession._id,
      classId: student.current.classId,
      sectionId: student.current.sectionId,
      feeMonth: input.asOfMonth,
      issueDate: date,
      dueDate: date,
      lines: [
        {
          code: 'OPENING_BALANCE' as const,
          label: LINE_LABELS.OPENING_BALANCE,
          amount: input.amount,
        },
      ],
      waivers: [],
      paidAmount: 0,
      totalAmount: 0,
      waivedAmount: 0,
      balance: 0,
      status: 'UNPAID' as const,
      previousDues: { amount: 0, months: [] },
      cancellation: null,
      createdBy: user.id,
    });
  });

  await withTransaction(async (session) => {
    await insertManySynced(Voucher, vouchers, session);
    await writeAudit(session, {
      action: 'OPENING_BALANCES_CREATE',
      userId: user.id,
      entity: 'voucher',
      after: {
        count: vouchers.length,
        totalAmount: vouchers.reduce((sum, v) => sum + v.totalAmount, 0),
      },
    });
  });
  return { created: vouchers.length, errors: [] };
}
