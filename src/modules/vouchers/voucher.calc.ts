import { sumAmounts } from '../../common/utils/money.js';

export const VOUCHER_STATUSES = [
  'UNPAID',
  'PARTIALLY_PAID',
  'PAID',
  'WAIVED',
  'CANCELLED',
] as const;
export type VoucherStatus = (typeof VOUCHER_STATUSES)[number];

/** The fields recalcVoucher reads and writes. Works on plain objects and Mongoose documents. */
export interface VoucherMoney {
  lines: readonly { amount: number }[];
  waivers: readonly { amount: number }[];
  paidAmount: number;
  cancellation: unknown;
  totalAmount: number;
  waivedAmount: number;
  balance: number;
  status: VoucherStatus;
}

/**
 * The single place that derives a voucher's totals and status (Section 8.2).
 * Call it after every change to lines, waivers, paidAmount or cancellation.
 * Throws if the balance would go below 0: that would mean money was counted twice.
 */
export function recalcVoucher<T extends VoucherMoney>(voucher: T): T {
  const totalAmount = sumAmounts(voucher.lines);
  const waivedAmount = sumAmounts(voucher.waivers);
  const paidAmount = voucher.paidAmount;
  if (!Number.isSafeInteger(paidAmount) || paidAmount < 0) {
    throw new Error(`Invalid paidAmount ${paidAmount}`);
  }

  const balance = totalAmount - paidAmount - waivedAmount;
  if (balance < 0) {
    throw new Error(
      `Voucher balance would be negative (total ${totalAmount}, paid ${paidAmount}, waived ${waivedAmount})`,
    );
  }

  let status: VoucherStatus;
  if (voucher.cancellation) status = 'CANCELLED';
  else if (balance === 0 && paidAmount > 0) status = 'PAID';
  else if (balance === 0 && waivedAmount > 0) status = 'WAIVED';
  else if (paidAmount > 0 || waivedAmount > 0) status = 'PARTIALLY_PAID';
  else status = 'UNPAID';

  voucher.totalAmount = totalAmount;
  voucher.waivedAmount = waivedAmount;
  voucher.balance = balance;
  voucher.status = status;
  return voucher;
}
