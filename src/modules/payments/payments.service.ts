import type { ClientSession, QueryFilter } from 'mongoose';
import { writeAudit } from '../../common/audit.js';
import { AppError } from '../../common/errors.js';
import type { AuthUser } from '../../common/middleware/auth.js';
import { businessDayEnd, businessDayStart, currentFeeMonth } from '../../common/utils/dates.js';
import { formatPkr, sumAmounts } from '../../common/utils/money.js';
import {
  pageResult,
  skipFor,
  toMongoSort,
  type PageResult,
} from '../../common/utils/pagination.js';
import { withTransaction } from '../../db/transaction.js';
import { Student } from '../students/students.model.js';
import { User } from '../users/users.model.js';
import { recalcVoucher } from '../vouchers/voucher.calc.js';
import { Voucher, type VoucherDoc } from '../vouchers/vouchers.model.js';
import {
  assertPaymentBalanced,
  Payment,
  type Allocation,
  type PaymentAttrs,
  type PaymentDoc,
} from './payments.model.js';
import type { CreatePaymentInput, ListPaymentsQuery, ResolveInput } from './payments.schemas.js';

/**
 * ONLINE: a direct API call. Asking for more than a voucher's balance is an error.
 * SYNC: an offline payment arriving through /sync/push. The cash is already collected, so the
 * server applies what fits and keeps the rest as unallocatedAmount (NEEDS_REVIEW).
 */
export type PaymentMode = 'ONLINE' | 'SYNC';

export interface CreatePaymentResult {
  payment: PaymentDoc;
  vouchers: VoucherDoc[];
  /** True when this payment `_id` was already saved; nothing was changed. */
  duplicate: boolean;
}

/** Allowed difference between the phone clock and the server clock. */
const CLOCK_SKEW_MS = 10 * 60_000;

const isDuplicateKey = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 11000;

const receiptNoFor = (deviceCode: string, seq: number) =>
  `R-${deviceCode}-${String(seq).padStart(5, '0')}`;

async function vouchersOf(payment: PaymentDoc, session?: ClientSession): Promise<VoucherDoc[]> {
  const ids = [
    ...new Set([
      ...payment.allocations.map((a) => a.voucherId),
      ...payment.requestedAllocations.map((a) => a.voucherId),
    ]),
  ];
  return Voucher.find({ _id: { $in: ids } }).session(session ?? null);
}

async function duplicateResult(payment: PaymentDoc): Promise<CreatePaymentResult> {
  return { payment, vouchers: await vouchersOf(payment), duplicate: true };
}

/**
 * Loads the student's vouchers named in `allocations` and checks they can take money:
 * same student, not cancelled, not a future month.
 */
async function loadPayableVouchers(
  studentId: string,
  allocations: readonly { voucherId: string }[],
  session: ClientSession,
): Promise<Map<string, VoucherDoc>> {
  const vouchers = await Voucher.find({
    _id: { $in: allocations.map((a) => a.voucherId) },
  }).session(session);
  const byId = new Map(vouchers.map((v) => [v._id, v]));
  const thisMonth = currentFeeMonth();

  for (const { voucherId } of allocations) {
    const voucher = byId.get(voucherId);
    if (!voucher || voucher.studentId !== studentId) {
      throw new AppError('VALIDATION_ERROR', 'A voucher does not belong to this student.', {
        voucherId,
      });
    }
    if (voucher.status === 'CANCELLED') {
      throw new AppError('VALIDATION_ERROR', `Voucher ${voucher.voucherNo} is cancelled.`);
    }
    if (voucher.feeMonth > thisMonth) {
      throw new AppError(
        'VALIDATION_ERROR',
        `Future months cannot be paid (${voucher.voucherNo} is for ${voucher.feeMonth}).`,
      );
    }
  }
  return byId;
}

/** Section 8.3. Runs in one transaction; idempotent by the phone-made `_id`. */
export async function createPayment(
  user: AuthUser,
  input: CreatePaymentInput,
  mode: PaymentMode = 'ONLINE',
): Promise<CreatePaymentResult> {
  const existing = await Payment.findById(input._id);
  if (existing) return duplicateResult(existing);

  try {
    return await withTransaction((session) => createInTransaction(user, input, mode, session));
  } catch (err) {
    // Two copies of the same payment arrived at once: the second insert hit the unique _id.
    if (isDuplicateKey(err)) {
      const saved = await Payment.findById(input._id);
      if (saved) return duplicateResult(saved);
      throw new AppError('DUPLICATE_RECEIPT', `Receipt ${input.receiptNo} was already used.`);
    }
    throw err;
  }
}

async function createInTransaction(
  user: AuthUser,
  input: CreatePaymentInput,
  mode: PaymentMode,
  session: ClientSession,
): Promise<CreatePaymentResult> {
  const sameReceipt = await Payment.findOne({ receiptNo: input.receiptNo }).session(session);
  if (sameReceipt) {
    if (sameReceipt._id === input._id) {
      return {
        payment: sameReceipt,
        vouchers: await vouchersOf(sameReceipt, session),
        duplicate: true,
      };
    }
    throw new AppError('DUPLICATE_RECEIPT', `Receipt ${input.receiptNo} was already used.`);
  }

  // The receipt must come from this user's own phone.
  if (input.deviceCode && input.deviceCode !== user.deviceCode) {
    throw new AppError('VALIDATION_ERROR', 'This payment was not made on your device.');
  }
  const expectedReceiptNo = receiptNoFor(user.deviceCode, input.receiptSeq);
  if (input.receiptNo !== expectedReceiptNo) {
    throw new AppError(
      'VALIDATION_ERROR',
      `Receipt number must be ${expectedReceiptNo} for this device and sequence.`,
    );
  }
  if (input.paidAt.getTime() > Date.now() + CLOCK_SKEW_MS) {
    throw new AppError('VALIDATION_ERROR', 'paidAt is in the future. Check the phone clock.');
  }

  const student = await Student.findById(input.studentId).session(session);
  if (!student) throw new AppError('NOT_FOUND', 'Student not found.');
  if (user.role === 'TEACHER' && !user.assignedSectionIds.includes(student.current.sectionId)) {
    throw new AppError('SECTION_NOT_ASSIGNED', 'This student is not in your sections.');
  }

  if (sumAmounts(input.allocations) !== input.amount) {
    throw new AppError(
      'VALIDATION_ERROR',
      'The amounts given to each month must add up to the amount paid.',
    );
  }
  const vouchers = await loadPayableVouchers(student._id, input.allocations, session);

  // Apply each requested allocation in order, never beyond the voucher's balance.
  const allocations: Allocation[] = [];
  let unallocatedAmount = 0;
  for (const requested of input.allocations) {
    const voucher = vouchers.get(requested.voucherId);
    if (!voucher) throw new Error('unreachable: voucher checked above');

    if (mode === 'ONLINE' && requested.amount > voucher.balance) {
      throw new AppError(
        'AMOUNT_EXCEEDS_BALANCE',
        `Amount can't be more than ${formatPkr(voucher.balance)} for ${voucher.voucherNo}.`,
        { voucherId: voucher._id, balance: voucher.balance },
      );
    }
    const applied = Math.min(requested.amount, voucher.balance);
    if (applied > 0) {
      voucher.paidAmount += applied;
      recalcVoucher(voucher);
      allocations.push({
        voucherId: voucher._id,
        voucherNo: voucher.voucherNo,
        feeMonth: voucher.feeMonth,
        amount: applied,
      });
    }
    unallocatedAmount += requested.amount - applied;
  }

  const paymentData = {
    _id: input._id,
    receiptNo: input.receiptNo,
    receiptSeq: input.receiptSeq,
    deviceCode: user.deviceCode,
    studentId: student._id,
    classIdAtPayment: student.current.classId,
    sectionIdAtPayment: student.current.sectionId,
    amount: input.amount,
    method: input.method,
    bankDate: input.bankDate ?? null,
    ...(input.bankReference && { bankReference: input.bankReference }),
    paidAt: input.paidAt,
    receivedBy: user.id,
    allocations,
    requestedAllocations: input.allocations,
    unallocatedAmount,
    status: unallocatedAmount > 0 ? ('NEEDS_REVIEW' as const) : ('CONFIRMED' as const),
    reversal: null,
    review: null,
    receiptSnapshot: input.receiptSnapshot,
    createdBy: user.id,
  };
  assertPaymentBalanced(paymentData);

  const [payment] = await Payment.create([paymentData], { session });
  if (!payment) throw new Error('Payment was not created');
  for (const voucher of vouchers.values()) {
    if (voucher.isModified()) await voucher.save({ session });
  }
  await User.updateOne(
    { _id: user.id },
    { $max: { lastReceiptSeq: input.receiptSeq } },
    { session },
  );

  await writeAudit(session, {
    action: 'PAYMENT_CREATE',
    userId: user.id,
    deviceCode: user.deviceCode,
    clientAt: input.paidAt,
    entity: 'payment',
    entityId: payment._id,
    after: {
      receiptNo: payment.receiptNo,
      amount: payment.amount,
      method: payment.method,
      allocations,
      unallocatedAmount,
      status: payment.status,
      mode,
    },
    ...(payment.status === 'NEEDS_REVIEW' && {
      reason: `NEEDS_REVIEW: ${formatPkr(unallocatedAmount)} could not be applied`,
    }),
  });

  return { payment, vouchers: [...vouchers.values()], duplicate: false };
}

async function findPaymentOrThrow(id: string, session: ClientSession): Promise<PaymentDoc> {
  const payment = await Payment.findById(id).session(session);
  if (!payment) throw new AppError('NOT_FOUND', 'Payment not found.');
  return payment;
}

/** Takes the payment's money back off its vouchers and marks it REVERSED (Section 8.4). */
async function applyReversal(
  user: AuthUser,
  payment: PaymentDoc,
  reason: string,
  session: ClientSession,
): Promise<VoucherDoc[]> {
  if (payment.status === 'REVERSED') {
    throw new AppError('CONFLICT', 'This payment is already reversed.');
  }
  const statusBefore = payment.status;
  const vouchers = await Voucher.find({
    _id: { $in: payment.allocations.map((a) => a.voucherId) },
  }).session(session);
  const byId = new Map(vouchers.map((v) => [v._id, v]));

  for (const allocation of payment.allocations) {
    const voucher = byId.get(allocation.voucherId);
    if (!voucher) throw new Error(`Voucher ${allocation.voucherId} of a payment is missing`);
    voucher.paidAmount -= allocation.amount;
    recalcVoucher(voucher); // throws if paidAmount would go below 0
  }
  for (const voucher of vouchers) await voucher.save({ session });

  // The amount and allocations stay as they were: the record shows what happened.
  payment.status = 'REVERSED';
  payment.reversal = { by: user.id, at: new Date(), reason };
  await payment.save({ session });

  await writeAudit(session, {
    action: 'PAYMENT_REVERSE',
    userId: user.id,
    entity: 'payment',
    entityId: payment._id,
    before: { status: statusBefore },
    after: {
      status: 'REVERSED',
      receiptNo: payment.receiptNo,
      amount: payment.amount,
      vouchers: payment.allocations.map((a) => ({ voucherNo: a.voucherNo, amount: a.amount })),
    },
    reason,
  });
  return vouchers;
}

export async function reversePayment(
  user: AuthUser,
  id: string,
  reason: string,
): Promise<{ payment: PaymentDoc; vouchers: VoucherDoc[] }> {
  return withTransaction(async (session) => {
    const payment = await findPaymentOrThrow(id, session);
    const vouchers = await applyReversal(user, payment, reason, session);
    return { payment, vouchers };
  });
}

/** Section 8.6: decide what happens to the money a NEEDS_REVIEW payment could not apply. */
export async function resolvePayment(
  user: AuthUser,
  id: string,
  input: ResolveInput,
): Promise<{ payment: PaymentDoc; vouchers: VoucherDoc[] }> {
  return withTransaction(async (session) => {
    const payment = await findPaymentOrThrow(id, session);
    if (payment.status !== 'NEEDS_REVIEW') {
      throw new AppError('CONFLICT', 'Only payments that need review can be resolved.');
    }
    const before = { status: payment.status, unallocatedAmount: payment.unallocatedAmount };
    const review = {
      resolvedBy: user.id,
      resolvedAt: new Date(),
      action: input.action,
      note: input.note,
    };
    let vouchers: VoucherDoc[] = [];

    if (input.action === 'ALLOCATED_TO_DUES') {
      const total = sumAmounts(input.allocations);
      if (total > payment.unallocatedAmount) {
        throw new AppError(
          'AMOUNT_EXCEEDS_BALANCE',
          `Only ${formatPkr(payment.unallocatedAmount)} is waiting to be applied.`,
        );
      }
      const byId = await loadPayableVouchers(payment.studentId, input.allocations, session);
      for (const requested of input.allocations) {
        const voucher = byId.get(requested.voucherId);
        if (!voucher) throw new Error('unreachable: voucher checked above');
        if (requested.amount > voucher.balance) {
          throw new AppError(
            'AMOUNT_EXCEEDS_BALANCE',
            `Amount can't be more than ${formatPkr(voucher.balance)} for ${voucher.voucherNo}.`,
            { voucherId: voucher._id, balance: voucher.balance },
          );
        }
        voucher.paidAmount += requested.amount;
        recalcVoucher(voucher);
        const existingAllocation = payment.allocations.find((a) => a.voucherId === voucher._id);
        if (existingAllocation) existingAllocation.amount += requested.amount;
        else {
          payment.allocations.push({
            voucherId: voucher._id,
            voucherNo: voucher.voucherNo,
            feeMonth: voucher.feeMonth,
            amount: requested.amount,
          });
        }
      }
      vouchers = [...byId.values()];
      for (const voucher of vouchers) await voucher.save({ session });

      payment.unallocatedAmount -= total;
      if (payment.unallocatedAmount === 0) {
        payment.status = 'CONFIRMED';
        payment.review = review;
      }
    } else if (input.action === 'REFUNDED') {
      // The parent got the extra money back.
      payment.review = {
        ...review,
        refundAmount: payment.unallocatedAmount,
        refundMethod: input.refundMethod,
      };
      payment.unallocatedAmount = 0;
      payment.status = 'CONFIRMED';
    } else {
      // The cash was never taken: undo the whole payment.
      vouchers = await applyReversal(user, payment, input.note, session);
      payment.review = review;
    }

    assertPaymentBalanced(payment);
    await payment.save({ session });
    await writeAudit(session, {
      action: 'PAYMENT_RESOLVE',
      userId: user.id,
      entity: 'payment',
      entityId: payment._id,
      before,
      after: {
        status: payment.status,
        unallocatedAmount: payment.unallocatedAmount,
        action: input.action,
        ...(input.action === 'ALLOCATED_TO_DUES' && { allocations: input.allocations }),
        ...(payment.review?.refundAmount !== undefined && {
          refundAmount: payment.review.refundAmount,
        }),
      },
      reason: input.note,
    });
    return { payment, vouchers };
  });
}

/* ---------- Reading payments (teachers see only their own) ---------- */

const ownOnly = (user: AuthUser): QueryFilter<PaymentAttrs> =>
  user.role === 'TEACHER' ? { receivedBy: user.id } : {};

export async function listPayments(
  user: AuthUser,
  query: ListPaymentsQuery,
): Promise<PageResult<PaymentDoc>> {
  const filter: QueryFilter<PaymentAttrs> = {};
  if (query.receivedBy) filter.receivedBy = query.receivedBy;
  if (query.method) filter.method = query.method;
  if (query.status) filter.status = query.status;
  if (query.studentId) filter.studentId = query.studentId;
  if (query.q) filter.receiptNo = { $regex: query.q.toUpperCase().replace(/[^A-Z0-9-]/g, '') };
  if (query.from || query.to) {
    filter.paidAt = {
      ...(query.from && { $gte: businessDayStart(query.from) }),
      ...(query.to && { $lt: businessDayEnd(query.to) }),
    };
  }
  // Teacher: both conditions must hold, so asking for someone else's payments finds nothing.
  if (user.role === 'TEACHER') filter.$and = [ownOnly(user)];

  const [items, total] = await Promise.all([
    Payment.find(filter).sort(toMongoSort(query.sort)).skip(skipFor(query)).limit(query.limit),
    Payment.countDocuments(filter),
  ]);
  return pageResult(items, total, query);
}

export async function getPayment(user: AuthUser, id: string): Promise<PaymentDoc> {
  const payment = await Payment.findOne({ _id: id, ...ownOnly(user) });
  if (!payment) throw new AppError('NOT_FOUND', 'Payment not found.');
  return payment;
}

export async function getPaymentByReceipt(user: AuthUser, receiptNo: string): Promise<PaymentDoc> {
  const payment = await Payment.findOne({ receiptNo, ...ownOnly(user) });
  if (!payment) throw new AppError('NOT_FOUND', `Receipt ${receiptNo} not found.`);
  return payment;
}

export async function listNeedsReview(): Promise<PaymentDoc[]> {
  return Payment.find({ status: 'NEEDS_REVIEW' }).sort({ paidAt: 1 });
}

/**
 * Payments a user may see for a student's section: Admin all; a teacher their own, plus all
 * payments for their sections (the same rule the sync pull uses).
 */
const visibleFor = (user: AuthUser, sectionId: string): QueryFilter<PaymentAttrs> =>
  user.role === 'ADMIN' || user.assignedSectionIds.includes(sectionId)
    ? {}
    : { receivedBy: user.id };

/** GET /vouchers/:id: the voucher with the payments applied to it. */
export async function paymentsForVoucher(
  user: AuthUser,
  voucher: VoucherDoc,
): Promise<PaymentDoc[]> {
  return Payment.find({
    'allocations.voucherId': voucher._id,
    ...visibleFor(user, voucher.sectionId),
  }).sort({ paidAt: -1 });
}

/** GET /students/:id/fee-history: all vouchers and payments, newest first. */
export async function studentFeeHistory(
  user: AuthUser,
  studentId: string,
): Promise<{ vouchers: VoucherDoc[]; payments: PaymentDoc[] }> {
  const student = await Student.findById(studentId, { current: 1 }).lean();
  if (!student) throw new AppError('NOT_FOUND', 'Student not found.');
  const [vouchers, payments] = await Promise.all([
    Voucher.find({ studentId }).sort({ feeMonth: -1, createdAt: -1 }),
    Payment.find({ studentId, ...visibleFor(user, student.current.sectionId) }).sort({
      paidAt: -1,
    }),
  ]);
  return { vouchers, payments };
}
