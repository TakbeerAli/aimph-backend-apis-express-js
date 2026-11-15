import { z } from 'zod';

/*
 * Money is whole Pakistani rupees, stored as integers. No paisa, no floats.
 */

/** Zod: an amount of money that may be 0. */
export const moneySchema = z.int().min(0).max(100_000_000);

/** Zod: an amount of money that must be at least 1 rupee. */
export const positiveMoneySchema = z.int().min(1).max(100_000_000);

export const isMoney = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

/** Sums `amount` over a list, checking every amount is a whole, non-negative number. */
export function sumAmounts(items: readonly { amount: number }[]): number {
  return items.reduce((total, item) => {
    if (!isMoney(item.amount)) throw new Error(`Invalid money amount: ${item.amount}`);
    return total + item.amount;
  }, 0);
}

const pkr = new Intl.NumberFormat('en-PK', { maximumFractionDigits: 0 });

/** 4000 → "PKR 4,000" (for messages). */
export const formatPkr = (amount: number): string => `PKR ${pkr.format(amount)}`;

/** Mongoose validator for integer money fields. */
export const moneyValidator = {
  validator: isMoney,
  message: '{PATH} must be a whole number of rupees, 0 or more',
};
