import { z } from 'zod';
import { dateOnlySchema, feeMonthSchema } from '../../common/utils/dates.js';
import { positiveMoneySchema } from '../../common/utils/money.js';
import { pageQuery } from '../../common/utils/pagination.js';
import { VOUCHER_STATUSES } from './voucher.calc.js';

const id = z.string().min(1).max(64);
const reason = z.string().trim().min(3).max(200);

export const voucherIdParams = z.object({ id });
export const voucherNoParams = z.object({
  voucherNo: z.string().trim().toUpperCase().min(1).max(40),
});

export const generateVouchersBody = z
  .object({
    feeMonth: feeMonthSchema,
    scope: z.enum(['ALL', 'CLASS', 'STUDENT']),
    classId: id.optional(),
    studentId: id.optional(),
    addExamFee: z.boolean().default(false),
    issueDate: dateOnlySchema.optional(),
    dueDate: dateOnlySchema.optional(),
  })
  .refine((b) => b.scope !== 'CLASS' || b.classId, {
    message: 'classId is required for scope CLASS.',
    path: ['classId'],
  })
  .refine((b) => b.scope !== 'STUDENT' || b.studentId, {
    message: 'studentId is required for scope STUDENT.',
    path: ['studentId'],
  });

export const fineBody = z.object({ amount: positiveMoneySchema, reason });
export const waiveBody = z.object({ amount: positiveMoneySchema, reason });
export const cancelBody = z.object({ reason });

export const openingBalanceRow = z.object({
  studentId: id,
  amount: positiveMoneySchema,
  asOfMonth: feeMonthSchema,
});
/** Rows are validated one by one in the service, so each error can name its row. */
export const openingBalancesBody = z.array(z.unknown()).min(1).max(2000);

export const listVouchersQuery = pageQuery(
  ['feeMonth', 'dueDate', 'voucherNo', 'createdAt', 'balance'],
  '-feeMonth',
).extend({
  feeMonth: feeMonthSchema.optional(),
  classId: id.optional(),
  sectionId: id.optional(),
  studentId: id.optional(),
  status: z.enum(VOUCHER_STATUSES).optional(),
  overdue: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  q: z.string().trim().max(40).optional(),
});

export type GenerateVouchersInput = z.infer<typeof generateVouchersBody>;
export type FineInput = z.infer<typeof fineBody>;
export type WaiveInput = z.infer<typeof waiveBody>;
export type CancelInput = z.infer<typeof cancelBody>;
export type OpeningBalanceRow = z.infer<typeof openingBalanceRow>;
export type ListVouchersQuery = z.infer<typeof listVouchersQuery>;
