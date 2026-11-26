import mongoose, { type mongo } from 'mongoose';
import { z } from 'zod';
import { AppError, type ErrorCode } from '../../common/errors.js';
import { logger } from '../../common/logger.js';
import type { AuthUser } from '../../common/middleware/auth.js';
import { saveSheetBody } from '../attendance/attendance.schemas.js';
import { saveSheet } from '../attendance/attendance.service.js';
import { createPaymentBody } from '../payments/payments.schemas.js';
import { createPayment } from '../payments/payments.service.js';
import { admitStudentBody, updateStudentBody } from '../students/students.schemas.js';
import { admitStudent, updateStudent } from '../students/students.service.js';
import { User } from '../users/users.model.js';
import {
  SYNC_OPERATION_TYPES,
  updateStudentPayload,
  type PullQuery,
  type SyncOperation,
  type SyncOperationType,
} from './sync.schemas.js';

/* ---------- Push: phone → server (Section 9.1) ---------- */

export type SyncResultStatus = 'APPLIED' | 'DUPLICATE' | 'REJECTED' | 'NEEDS_REVIEW';

export interface SyncResult {
  opId: string;
  status: SyncResultStatus;
  errorCode?: ErrorCode;
  message?: string;
  record?: unknown;
}

/** Admin only: student operations come from the Admin phone. Payments come from any phone. */
const ADMIN_ONLY: SyncOperationType[] = ['CREATE_STUDENT', 'UPDATE_STUDENT'];

const isOperationType = (type: string): type is SyncOperationType =>
  (SYNC_OPERATION_TYPES as readonly string[]).includes(type);

/** One operation. Each service call runs in its own transaction. */
async function applyOperation(user: AuthUser, op: SyncOperation): Promise<SyncResult> {
  if (!isOperationType(op.type)) {
    throw new AppError('VALIDATION_ERROR', `Unknown operation type ${op.type}.`);
  }
  if (ADMIN_ONLY.includes(op.type) && user.role !== 'ADMIN') {
    throw new AppError('FORBIDDEN', 'Only the Admin can change students.');
  }

  switch (op.type) {
    case 'CREATE_PAYMENT': {
      // Offline money is already collected: capping + NEEDS_REVIEW instead of an error.
      const result = await createPayment(user, createPaymentBody.parse(op.payload), 'SYNC');
      const status: SyncResultStatus = result.duplicate
        ? 'DUPLICATE'
        : result.payment.status === 'NEEDS_REVIEW'
          ? 'NEEDS_REVIEW'
          : 'APPLIED';
      return { opId: op.opId, status, record: result.payment.toJSON() };
    }
    case 'CREATE_STUDENT': {
      const input = admitStudentBody.parse(op.payload);
      if (!input._id) {
        throw new AppError(
          'VALIDATION_ERROR',
          'An offline admission must include the student _id.',
        );
      }
      const result = await admitStudent(user, input);
      return {
        opId: op.opId,
        status: result.duplicate ? 'DUPLICATE' : 'APPLIED',
        record: result.student.toJSON(),
      };
    }
    case 'SAVE_ATTENDANCE': {
      // Marked offline today; the same sheet id sent again is DUPLICATE.
      const { sheet, status } = await saveSheet(user, saveSheetBody.parse(op.payload));
      return {
        opId: op.opId,
        status:
          status === 'DUPLICATE'
            ? 'DUPLICATE'
            : status === 'NEEDS_REVIEW'
              ? 'NEEDS_REVIEW'
              : 'APPLIED',
        record: sheet.toJSON(),
      };
    }
    case 'UPDATE_STUDENT': {
      // A stale version is rejected with the server copy; the Admin re-applies the edit.
      const { id, version, changes } = updateStudentPayload.parse(op.payload);
      const input = updateStudentBody.parse({ ...changes, version });
      const student = await updateStudent(user, id, input);
      return { opId: op.opId, status: 'APPLIED', record: student.toJSON() };
    }
  }
}

function rejection(opId: string, err: unknown): SyncResult {
  if (err instanceof AppError) {
    return {
      opId,
      status: 'REJECTED',
      errorCode: err.code,
      message: err.message,
      // VERSION_CONFLICT carries the current server copy.
      ...(err.details?.current !== undefined && { record: err.details.current }),
    };
  }
  if (err instanceof z.ZodError) {
    const message = err.issues
      .map((issue) => `${issue.path.join('.') || 'payload'}: ${issue.message}`)
      .join('; ');
    return { opId, status: 'REJECTED', errorCode: 'VALIDATION_ERROR', message };
  }
  logger.error({ err, opId }, 'Sync operation failed');
  return {
    opId,
    status: 'REJECTED',
    errorCode: 'INTERNAL_ERROR',
    message: 'Something went wrong.',
  };
}

/** Records when the user last synced. Written directly so it does not count as a change to pull. */
async function touchLastSync(user: AuthUser): Promise<void> {
  await mongoose.connection
    .collection<{ _id: string }>('users')
    .updateOne({ _id: user.id }, { $set: { lastSyncAt: new Date() } });
}

/**
 * Applies operations in order. One failing operation never blocks the others. The phone
 * removes APPLIED, DUPLICATE and NEEDS_REVIEW operations from its outbox and shows REJECTED ones.
 */
export async function push(user: AuthUser, operations: SyncOperation[]): Promise<SyncResult[]> {
  const results: SyncResult[] = [];
  for (const op of operations) {
    try {
      results.push(await applyOperation(user, op));
    } catch (err) {
      results.push(rejection(op.opId, err));
    }
  }
  await touchLastSync(user);
  return results;
}

/* ---------- Pull: server → phone (Section 9.2) ---------- */

const PULLED = [
  'academic_sessions',
  'classes',
  'students',
  'fee_structures',
  'vouchers',
  'payments',
  'settings',
  'users',
  'certificates',
  'calendar_events',
  'attendance_sheets',
] as const;
type PulledCollection = (typeof PULLED)[number];

interface PulledDoc {
  _id: string;
  syncSeq: number;
  [key: string]: unknown;
}

export interface PullResult {
  changes: Record<PulledCollection, PulledDoc[]>;
  nextSince: number;
  hasMore: boolean;
  /**
   * Teacher: sections taken away since `since`. The phone deletes their local students,
   * vouchers, payments (and attendance sheets).
   */
  revokedSectionIds: string[];
  /**
   * Teacher: a section was added since `since`; its older records were never sent to this
   * phone, so it must pull again from 0.
   */
  resetRequired: boolean;
}

/**
 * Each collection and what this user may receive from it. Pull reads raw documents, so
 * anything secret must be excluded here explicitly.
 */
function sources(user: AuthUser): {
  name: PulledCollection;
  filter: mongo.Filter<PulledDoc>;
  projection?: Record<string, 0>;
}[] {
  const teacher = user.role === 'TEACHER';
  const mine = { $in: user.assignedSectionIds };
  const all: {
    name: PulledCollection;
    filter: mongo.Filter<PulledDoc>;
    projection?: Record<string, 0>;
  }[] = [
    { name: 'academic_sessions', filter: {} },
    { name: 'classes', filter: {} },
    // A teacher's phone gets only their sections' students, vouchers and payments.
    {
      name: 'students',
      filter: teacher
        ? {
            $or: [
              { 'current.sectionId': mine },
              // Moved to another section: sent once more so the phone sees it has left.
              { 'classHistory.sectionChanges.fromSectionId': mine },
            ],
          }
        : {},
    },
    { name: 'fee_structures', filter: {} },
    { name: 'vouchers', filter: teacher ? { sectionId: mine } : {} },
    {
      name: 'payments',
      // Teacher: their own receipts plus payments for students in their sections.
      filter: teacher ? { $or: [{ receivedBy: user.id }, { sectionIdAtPayment: mine }] } : {},
    },
    // Counters are internal and never leave the server.
    { name: 'settings', filter: {}, projection: { counters: 0 } },
    // Only the user's own record, never the password or refresh-token hashes.
    {
      name: 'users',
      filter: { _id: user.id },
      projection: {
        passwordHash: 0,
        refreshTokenHash: 0,
        sectionsAddedSeq: 0,
        revokedSections: 0,
      },
    },
    // Certificates live only on the Admin phone; teachers' phones never receive them.
    { name: 'certificates', filter: {} },
    // Holidays and make-up days, including deleted ones (isDeleted) so phones remove them.
    { name: 'calendar_events', filter: {} },
    // Teacher: only their own sections' sheets.
    { name: 'attendance_sheets', filter: teacher ? { sectionId: mine } : {} },
  ];
  return user.role === 'ADMIN' ? all : all.filter((source) => source.name !== 'certificates');
}

/** Teacher only: sections removed or added since the phone's last pull. */
async function sectionChanges(
  user: AuthUser,
  since: number,
): Promise<Pick<PullResult, 'revokedSectionIds' | 'resetRequired'>> {
  if (user.role !== 'TEACHER' || since === 0) {
    return { revokedSectionIds: [], resetRequired: false };
  }
  const record = await User.findById(user.id, { sectionsAddedSeq: 1, revokedSections: 1 }).lean();
  const revoked = (record?.revokedSections ?? [])
    .filter((r) => r.seq > since && !user.assignedSectionIds.includes(r.sectionId))
    .map((r) => r.sectionId);
  return {
    revokedSectionIds: [...new Set(revoked)],
    resetRequired: (record?.sectionsAddedSeq ?? 0) > since,
  };
}

/**
 * Every document with syncSeq > since, oldest change first, at most `limit` in total.
 * syncSeq values are unique across collections, so the page can be cut cleanly anywhere and
 * the next call continues from `nextSince` without missing or repeating anything.
 */
export async function pull(user: AuthUser, query: PullQuery): Promise<PullResult> {
  const batches = await Promise.all(
    sources(user).map(async ({ name, filter, projection }) => {
      const docs = await mongoose.connection
        .collection<PulledDoc>(name)
        .find({ ...filter, syncSeq: { $gt: query.since } }, { projection: projection ?? {} })
        .sort({ syncSeq: 1 })
        .limit(query.limit + 1)
        .toArray();
      return docs.map((doc) => ({ name, doc }));
    }),
  );

  const merged = batches.flat().sort((a, b) => a.doc.syncSeq - b.doc.syncSeq);
  const page = merged.slice(0, query.limit);

  const changes = Object.fromEntries(PULLED.map((name) => [name, [] as PulledDoc[]])) as Record<
    PulledCollection,
    PulledDoc[]
  >;
  for (const { name, doc } of page) changes[name].push(doc);

  await touchLastSync(user);
  return {
    changes,
    nextSince: page.at(-1)?.doc.syncSeq ?? query.since,
    hasMore: merged.length > query.limit,
    ...(await sectionChanges(user, query.since)),
  };
}
