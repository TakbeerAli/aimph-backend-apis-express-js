import { z } from 'zod';
import { moneySchema } from '../../common/utils/money.js';

const id = z.string().min(1).max(64);

export const listFeeStructuresQuery = z.object({ sessionId: id.optional() });

export const feeStructureParams = z.object({ sessionId: id, classId: id });

export const putFeeStructureBody = z.object({
  tuitionFee: moneySchema,
  admissionFee: moneySchema,
  examFee: moneySchema,
});

export const copyFeeStructuresBody = z
  .object({ fromSessionId: id, toSessionId: id })
  .refine((b) => b.fromSessionId !== b.toSessionId, {
    message: 'Choose two different sessions.',
    path: ['toSessionId'],
  });

export type ListFeeStructuresQuery = z.infer<typeof listFeeStructuresQuery>;
export type PutFeeStructureInput = z.infer<typeof putFeeStructureBody>;
export type CopyFeeStructuresInput = z.infer<typeof copyFeeStructuresBody>;
