import type { PipelineStage } from 'mongoose';
import { addMonths, businessDayEnd, businessDayStart } from '../../common/utils/dates.js';
import { Payment, PAYMENT_METHODS, type PaymentMethod } from '../payments/payments.model.js';

/*
 * Shared rules for every collection total (reports and dashboard):
 * - REVERSED payments never count.
 * - A payment counts on its paidAt day in the school's time zone.
 * - Money refunded when resolving a NEEDS_REVIEW payment is not counted as collected.
 */

export const COUNTED_PAYMENT = { status: { $ne: 'REVERSED' } } as const;

/** Collected amount of one payment: amount minus any refund. */
export const COLLECTED_AMOUNT = {
  $subtract: ['$amount', { $ifNull: ['$review.refundAmount', 0] }],
} as const;

/** paidAt range covering one business day ("YYYY-MM-DD"). */
export const dayRange = (ymd: string) => ({
  $gte: businessDayStart(ymd),
  $lt: businessDayEnd(ymd),
});

/** paidAt range covering fee months `from`..`to` ("YYYY-MM"), in business time. */
export const monthRange = (from: string, to = from) => ({
  $gte: businessDayStart(`${from}-01`),
  $lt: businessDayStart(`${addMonths(to, 1)}-01`),
});

export interface CollectionSummary {
  total: number;
  count: number;
  byMethod: Record<PaymentMethod, number>;
}

export const emptyByMethod = (): Record<PaymentMethod, number> =>
  Object.fromEntries(PAYMENT_METHODS.map((m) => [m, 0])) as Record<PaymentMethod, number>;

/** Total, count and per-method split of counted payments matching `match`. */
export async function collectionSummary(
  match: Record<string, unknown>,
): Promise<CollectionSummary> {
  const rows = await Payment.aggregate<{ _id: PaymentMethod; total: number; count: number }>([
    { $match: { ...COUNTED_PAYMENT, ...match } },
    { $group: { _id: '$method', total: { $sum: COLLECTED_AMOUNT }, count: { $sum: 1 } } },
  ] as PipelineStage[]);

  const summary: CollectionSummary = { total: 0, count: 0, byMethod: emptyByMethod() };
  for (const row of rows) {
    summary.byMethod[row._id] = row.total;
    summary.total += row.total;
    summary.count += row.count;
  }
  return summary;
}
