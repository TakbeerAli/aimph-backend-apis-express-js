import mongoose, { Schema, type HydratedDocument, type Types } from 'mongoose';
import { today } from '../../common/utils/dates.js';
import { newId } from '../../common/utils/ids.js';
import { moneyValidator } from '../../common/utils/money.js';
import { syncPlugin, type SyncFields } from '../../db/syncPlugin.js';
import { VOUCHER_STATUSES, type VoucherStatus } from './voucher.calc.js';

export const VOUCHER_TYPES = ['MONTHLY', 'OPENING_BALANCE'] as const;
export const LINE_CODES = ['TUITION', 'ADMISSION', 'EXAM', 'FINE', 'OPENING_BALANCE'] as const;
export type LineCode = (typeof LINE_CODES)[number];

export const LINE_LABELS: Record<LineCode, string> = {
  TUITION: 'Tuition Fee',
  ADMISSION: 'Admission Fee',
  EXAM: 'Exam Fee',
  FINE: 'Late Payment Fine',
  OPENING_BALANCE: 'Previous Balance',
};

export interface VoucherLine {
  _id: string;
  code: LineCode;
  label: string;
  amount: number;
  addedBy?: string;
  addedAt?: Date;
  reason?: string;
}

export interface Waiver {
  _id: string;
  amount: number;
  reason: string;
  by: string;
  at: Date;
}

export interface VoucherAttrs extends SyncFields {
  _id: string;
  voucherNo: string;
  type: (typeof VOUCHER_TYPES)[number];
  studentId: string;
  sessionId: string;
  classId: string;
  sectionId: string;
  feeMonth: string;
  issueDate: Date;
  dueDate: Date;
  lines: Types.DocumentArray<VoucherLine>;
  waivers: Types.DocumentArray<Waiver>;
  totalAmount: number;
  paidAmount: number;
  waivedAmount: number;
  balance: number;
  status: VoucherStatus;
  /** Display only: unpaid balance of earlier vouchers in the same session. Never in totalAmount. */
  previousDues: { amount: number; months: string[] };
  cancellation: { by: string; at: Date; reason: string } | null;
}

const money = { type: Number, required: true, default: 0, validate: moneyValidator };
const positiveMoney = {
  type: Number,
  required: true,
  min: 1,
  validate: moneyValidator,
};

const lineSchema = new Schema<VoucherLine>({
  _id: { type: String, default: newId },
  code: { type: String, enum: LINE_CODES, required: true },
  label: { type: String, required: true, trim: true, maxlength: 60 },
  amount: positiveMoney,
  addedBy: { type: String },
  addedAt: { type: Date },
  reason: { type: String, trim: true, maxlength: 200 },
});

const waiverSchema = new Schema<Waiver>({
  _id: { type: String, default: newId },
  amount: positiveMoney,
  reason: { type: String, required: true, trim: true, maxlength: 200 },
  by: { type: String, required: true },
  at: { type: Date, required: true },
});

const voucherSchema = new Schema<VoucherAttrs>(
  {
    _id: { type: String, default: newId },
    voucherNo: { type: String, required: true, unique: true },
    type: { type: String, enum: VOUCHER_TYPES, required: true },
    studentId: { type: String, required: true },
    sessionId: { type: String, required: true },
    classId: { type: String, required: true },
    sectionId: { type: String, required: true },
    feeMonth: { type: String, required: true, match: /^\d{4}-\d{2}$/ },
    issueDate: { type: Date, required: true },
    dueDate: { type: Date, required: true },
    lines: {
      type: [lineSchema],
      validate: { validator: (v: unknown[]) => v.length > 0, message: 'A voucher needs a line' },
    },
    waivers: { type: [waiverSchema], default: [] },
    totalAmount: money,
    paidAmount: money,
    waivedAmount: money,
    balance: money,
    status: { type: String, enum: VOUCHER_STATUSES, required: true },
    previousDues: {
      amount: money,
      months: { type: [String], default: [] },
    },
    cancellation: {
      type: new Schema(
        { by: String, at: Date, reason: { type: String, maxlength: 200 } },
        { _id: false },
      ),
      default: null,
    },
  },
  {
    collection: 'vouchers',
    timestamps: true,
    versionKey: false,
    id: false,
    toJSON: { virtuals: true },
  },
);
voucherSchema.plugin(syncPlugin);

/** Computed, never stored (Section 2): due date passed and money still owed. */
voucherSchema.virtual('isOverdue').get(function () {
  return this.status !== 'CANCELLED' && this.balance > 0 && this.dueDate < today();
});

// One monthly voucher per student per month, ignoring cancelled ones.
voucherSchema.index(
  { studentId: 1, feeMonth: 1 },
  {
    unique: true,
    partialFilterExpression: {
      type: 'MONTHLY',
      status: { $in: VOUCHER_STATUSES.filter((s) => s !== 'CANCELLED') },
    },
  },
);
voucherSchema.index({ studentId: 1, status: 1 });
voucherSchema.index({ sessionId: 1, classId: 1, feeMonth: 1 });
voucherSchema.index({ status: 1, dueDate: 1 });

export const Voucher = mongoose.model<VoucherAttrs>('Voucher', voucherSchema);
export type VoucherDoc = HydratedDocument<VoucherAttrs>;

/** Vouchers that still have money owed on them. */
export const OPEN_BALANCE = { status: { $ne: 'CANCELLED' }, balance: { $gt: 0 } } as const;

const yymm = (feeMonth: string) => feeMonth.slice(2, 4) + feeMonth.slice(5, 7);
const suffix = (earlier: number) => (earlier > 0 ? `-${earlier + 1}` : '');

/**
 * `V-2612-1046` for a monthly voucher. `earlier` is how many vouchers (all cancelled) this
 * student already had for the month; a replacement gets `-2`, `-3`, … so numbers stay unique.
 */
export const monthlyVoucherNo = (feeMonth: string, admissionNo: number, earlier = 0): string =>
  `V-${yymm(feeMonth)}-${admissionNo}${suffix(earlier)}`;

/** `OB-1046` for an opening-balance voucher. */
export const openingVoucherNo = (admissionNo: number, earlier = 0): string =>
  `OB-${admissionNo}${suffix(earlier)}`;
