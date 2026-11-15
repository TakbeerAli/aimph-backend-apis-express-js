import { z } from 'zod';
import { feeMonthSchema } from '../../common/utils/dates.js';

const id = z.string().min(1).max(64);
const monthIndex = (m: string) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7));

export const dailyCollectionQuery = z.object({ date: z.iso.date().optional() });

export const collectionQuery = z
  .object({
    from: feeMonthSchema,
    to: feeMonthSchema,
    groupBy: z.enum(['month', 'year']).default('month'),
  })
  .refine((q) => q.from <= q.to, { message: '`from` must not be after `to`.', path: ['to'] })
  .refine((q) => monthIndex(q.to) - monthIndex(q.from) < 60, {
    message: 'Choose at most 5 years.',
    path: ['to'],
  });

export const classWiseQuery = z.object({
  sessionId: id.optional(),
  feeMonth: feeMonthSchema.optional(),
});

export const defaultersQuery = z.object({
  sessionId: id.optional(),
  classId: id.optional(),
  sectionId: id.optional(),
  /** Only students with at least this many overdue vouchers. */
  minMonths: z.coerce.number().int().min(1).max(24).default(1),
});

export const statusListQuery = z.object({
  feeMonth: feeMonthSchema,
  classId: id.optional(),
  sectionId: id.optional(),
  status: z.enum(['PAID', 'PARTIALLY_PAID', 'UNPAID']).optional(),
});

export const previousSessionDuesQuery = z.object({ sessionId: id.optional() });

export type DailyCollectionQuery = z.infer<typeof dailyCollectionQuery>;
export type CollectionQuery = z.infer<typeof collectionQuery>;
export type ClassWiseQuery = z.infer<typeof classWiseQuery>;
export type DefaultersQuery = z.infer<typeof defaultersQuery>;
export type StatusListQuery = z.infer<typeof statusListQuery>;
export type PreviousSessionDuesQuery = z.infer<typeof previousSessionDuesQuery>;
