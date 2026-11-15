import { z } from 'zod';
import { dateOnlySchema, feeMonthSchema } from '../../common/utils/dates.js';
import { moneySchema, positiveMoneySchema } from '../../common/utils/money.js';
import { pageQuery } from '../../common/utils/pagination.js';
import { PAYMENT_METHODS, PAYMENT_STATUSES } from './payments.model.js';

const id = z.string().min(1).max(64);
const text = (max: number) => z.string().trim().min(1).max(max);
const allocation = z.object({ voucherId: id, amount: positiveMoneySchema });

export const paymentIdParams = z.object({ id });
export const receiptNoParams = z.object({
  receiptNo: z.string().trim().toUpperCase().min(1).max(30),
});

export const receiptSnapshotSchema = z.object({
  studentName: text(80),
  fatherName: text(80),
  admissionNo: z.int().min(1),
  className: text(40),
  rollNo: z.int().min(1).optional(),
  months: z.array(feeMonthSchema).max(24),
  previousBalance: moneySchema,
  currentFee: moneySchema,
  fine: moneySchema,
  amountPaid: moneySchema,
  remainingBalance: moneySchema,
});

export const createPaymentBody = z
  .object({
    /** UUID made on the phone; sending the same payment again is safe. */
    _id: z.uuid(),
    receiptNo: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^R-[A-Z0-9]{1,5}-\d{5,}$/, 'Receipt number must look like R-S1-00087.'),
    receiptSeq: z.int().min(1),
    deviceCode: z.string().trim().toUpperCase().max(5).optional(),
    studentId: id,
    amount: positiveMoneySchema,
    method: z.enum(PAYMENT_METHODS),
    bankDate: dateOnlySchema.optional(),
    bankReference: z.string().trim().max(60).optional(),
    paidAt: z.iso.datetime({ offset: true }).transform((value) => new Date(value)),
    allocations: z.array(allocation).min(1).max(24),
    receiptSnapshot: receiptSnapshotSchema,
  })
  .refine((p) => p.method !== 'BANK' || p.bankDate, {
    message: 'A bank payment needs the date on the bank stamp.',
    path: ['bankDate'],
  })
  .refine((p) => new Set(p.allocations.map((a) => a.voucherId)).size === p.allocations.length, {
    message: 'Each voucher can appear only once.',
    path: ['allocations'],
  });

export const reverseBody = z.object({ reason: z.string().trim().min(5).max(200) });

const note = z.string().trim().min(3).max(300);
export const resolveBody = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('ALLOCATED_TO_DUES'),
    note,
    allocations: z.array(allocation).min(1).max(24),
  }),
  z.object({ action: z.literal('REFUNDED'), note, refundMethod: z.enum(PAYMENT_METHODS) }),
  z.object({ action: z.literal('REVERSED'), note }),
]);

export const listPaymentsQuery = pageQuery(
  ['paidAt', 'amount', 'receiptNo', 'createdAt'],
  '-paidAt',
).extend({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  receivedBy: id.optional(),
  method: z.enum(PAYMENT_METHODS).optional(),
  status: z.enum(PAYMENT_STATUSES).optional(),
  studentId: id.optional(),
  q: z.string().trim().max(30).optional(),
});

export type CreatePaymentInput = z.infer<typeof createPaymentBody>;
export type ReverseInput = z.infer<typeof reverseBody>;
export type ResolveInput = z.infer<typeof resolveBody>;
export type ListPaymentsQuery = z.infer<typeof listPaymentsQuery>;
