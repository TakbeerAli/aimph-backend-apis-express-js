import { describe, expect, it } from 'vitest';
import { recalcVoucher, type VoucherMoney } from './voucher.calc.js';

const voucher = (over: Partial<VoucherMoney> = {}): VoucherMoney => ({
  lines: [{ amount: 2500 }, { amount: 500 }],
  waivers: [],
  paidAmount: 0,
  cancellation: null,
  totalAmount: 0,
  waivedAmount: 0,
  balance: 0,
  status: 'UNPAID',
  ...over,
});

describe('recalcVoucher', () => {
  it.each([
    ['nothing paid', {}, { totalAmount: 3000, balance: 3000, status: 'UNPAID' }],
    ['part paid', { paidAmount: 1000 }, { balance: 2000, status: 'PARTIALLY_PAID' }],
    ['fully paid', { paidAmount: 3000 }, { balance: 0, status: 'PAID' }],
    [
      'part waived',
      { waivers: [{ amount: 500 }] },
      { waivedAmount: 500, balance: 2500, status: 'PARTIALLY_PAID' },
    ],
    ['fully waived', { waivers: [{ amount: 3000 }] }, { balance: 0, status: 'WAIVED' }],
    [
      'paid + waived to zero',
      { paidAmount: 1000, waivers: [{ amount: 2000 }] },
      { balance: 0, status: 'PAID' },
    ],
    ['cancelled', { cancellation: { reason: 'x' } }, { balance: 3000, status: 'CANCELLED' }],
  ])('%s', (_name, over, expected) => {
    expect(recalcVoucher(voucher(over))).toMatchObject(expected);
  });

  it('throws instead of letting the balance go negative', () => {
    expect(() => recalcVoucher(voucher({ paidAmount: 3001 }))).toThrow(/negative/);
    expect(() => recalcVoucher(voucher({ paidAmount: 2000, waivers: [{ amount: 1500 }] }))).toThrow(
      /negative/,
    );
  });

  it('rejects non-integer money', () => {
    expect(() => recalcVoucher(voucher({ lines: [{ amount: 10.5 }] }))).toThrow(/Invalid/);
    expect(() => recalcVoucher(voucher({ paidAmount: -1 }))).toThrow(/Invalid/);
  });
});
