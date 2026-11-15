import mongoose, { Schema, type HydratedDocument, type Types } from 'mongoose';
import { moneyValidator, sumAmounts } from '../../common/utils/money.js';
import { syncPlugin, type SyncFields } from '../../db/syncPlugin.js';

export const PAYMENT_METHODS = ['CASH', 'BANK', 'OTHER'] as const;
export const PAYMENT_STATUSES = ['CONFIRMED', 'NEEDS_REVIEW', 'REVERSED'] as const;
export const REVIEW_ACTIONS = ['ALLOCATED_TO_DUES', 'REFUNDED', 'REVERSED'] as const;

export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export interface Allocation {
  voucherId: string;
  voucherNo: string;
  feeMonth: string;
  amount: number;
}

export interface RequestedAllocation {
  voucherId: string;
  amount: number;
}

export interface Review {
  resolvedBy: string;
  resolvedAt: Date;
  action: (typeof REVIEW_ACTIONS)[number];
  note: string;
  refundAmount?: number;
  refundMethod?: PaymentMethod;
}

/** What the phone printed on the receipt. Kept as a record; never used for money maths. */
export interface ReceiptSnapshot {
  studentName: string;
  fatherName: string;
  admissionNo: number;
  className: string;
  rollNo?: number;
  months: string[];
  previousBalance: number;
  currentFee: number;
  fine: number;
  amountPaid: number;
  remainingBalance: number;
}

export interface PaymentAttrs extends SyncFields {
  /** Created on the phone; doubles as the idempotency key. */
  _id: string;
  receiptNo: string;
  receiptSeq: number;
  deviceCode: string;
  studentId: string;
  classIdAtPayment: string;
  amount: number;
  method: PaymentMethod;
  bankDate: Date | null;
  bankReference?: string;
  /** Phone time when the money was received. */
  paidAt: Date;
  receivedBy: string;
  /** What was actually applied, after server capping. */
  allocations: Types.DocumentArray<Allocation>;
  /** What the phone asked for (kept for audit). */
  requestedAllocations: RequestedAllocation[];
  unallocatedAmount: number;
  status: PaymentStatus;
  reversal: { by: string; at: Date; reason: string } | null;
  review: Review | null;
  receiptSnapshot: ReceiptSnapshot;
}

const positiveMoney = { type: Number, required: true, min: 1, validate: moneyValidator };
const money = { type: Number, required: true, default: 0, validate: moneyValidator };

const allocationSchema = new Schema<Allocation>(
  {
    voucherId: { type: String, required: true },
    voucherNo: { type: String, required: true },
    feeMonth: { type: String, required: true },
    amount: positiveMoney,
  },
  { _id: false },
);

const paymentSchema = new Schema<PaymentAttrs>(
  {
    _id: { type: String, required: true },
    receiptNo: { type: String, required: true, unique: true },
    receiptSeq: { type: Number, required: true, min: 1 },
    deviceCode: { type: String, required: true },
    studentId: { type: String, required: true },
    classIdAtPayment: { type: String, required: true },
    amount: positiveMoney,
    method: { type: String, enum: PAYMENT_METHODS, required: true },
    bankDate: { type: Date, default: null },
    bankReference: { type: String, trim: true, maxlength: 60 },
    paidAt: { type: Date, required: true },
    receivedBy: { type: String, required: true },
    allocations: { type: [allocationSchema], default: [] },
    requestedAllocations: {
      type: [
        new Schema<RequestedAllocation>(
          { voucherId: { type: String, required: true }, amount: positiveMoney },
          { _id: false },
        ),
      ],
      required: true,
    },
    unallocatedAmount: money,
    status: { type: String, enum: PAYMENT_STATUSES, required: true },
    reversal: {
      type: new Schema({ by: String, at: Date, reason: String }, { _id: false }),
      default: null,
    },
    review: {
      type: new Schema<Review>(
        {
          resolvedBy: { type: String, required: true },
          resolvedAt: { type: Date, required: true },
          action: { type: String, enum: REVIEW_ACTIONS, required: true },
          note: { type: String, required: true, maxlength: 300 },
          refundAmount: { type: Number, validate: moneyValidator },
          refundMethod: { type: String, enum: PAYMENT_METHODS },
        },
        { _id: false },
      ),
      default: null,
    },
    receiptSnapshot: { type: Schema.Types.Mixed, required: true },
  },
  { collection: 'payments', timestamps: true, versionKey: false },
);
paymentSchema.plugin(syncPlugin);

paymentSchema.index({ deviceCode: 1, receiptSeq: 1 }, { unique: true });
paymentSchema.index({ studentId: 1, paidAt: -1 });
paymentSchema.index({ paidAt: -1 });
paymentSchema.index({ receivedBy: 1, paidAt: -1 });
paymentSchema.index({ 'allocations.voucherId': 1 });
paymentSchema.index({ status: 1 });

/**
 * Every rupee of a payment is somewhere: applied to vouchers, waiting for review, or refunded.
 * (A REFUNDED review sets unallocatedAmount to 0 and records the money as refundAmount.)
 */
export function assertPaymentBalanced(
  payment: Pick<PaymentAttrs, 'amount' | 'unallocatedAmount' | 'review'> & {
    allocations: readonly { amount: number }[];
  },
): void {
  const accounted =
    sumAmounts(payment.allocations) +
    payment.unallocatedAmount +
    (payment.review?.refundAmount ?? 0);
  if (accounted !== payment.amount) {
    throw new Error(
      `Payment does not add up: amount ${payment.amount}, accounted for ${accounted}`,
    );
  }
}

// Safety net: services check this too, but no save may ever break it.
paymentSchema.pre('validate', function () {
  assertPaymentBalanced(this);
});

export const Payment = mongoose.model<PaymentAttrs>('Payment', paymentSchema);
export type PaymentDoc = HydratedDocument<PaymentAttrs>;
