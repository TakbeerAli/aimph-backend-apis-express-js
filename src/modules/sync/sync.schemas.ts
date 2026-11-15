import { z } from 'zod';

export const SYNC_OPERATION_TYPES = ['CREATE_PAYMENT', 'CREATE_STUDENT', 'UPDATE_STUDENT'] as const;
export type SyncOperationType = (typeof SYNC_OPERATION_TYPES)[number];

/** One queued action from the phone's outbox. The payload is validated per type in the service. */
export const syncOperation = z.object({
  opId: z.uuid(),
  type: z.string().min(1).max(40),
  payload: z.unknown(),
  clientAt: z.iso.datetime({ offset: true }).optional(),
});

export const pushBody = z.object({
  operations: z.array(syncOperation).min(1).max(100),
});

export const pullQuery = z.object({
  since: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(500),
});

/** UPDATE_STUDENT payload: the edit made offline on the Admin phone. */
export const updateStudentPayload = z.object({
  id: z.string().min(1).max(64),
  version: z.int().min(1),
  changes: z.record(z.string(), z.unknown()),
});

export type SyncOperation = z.infer<typeof syncOperation>;
export type PushInput = z.infer<typeof pushBody>;
export type PullQuery = z.infer<typeof pullQuery>;
