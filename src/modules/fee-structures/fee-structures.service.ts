import type { ClientSession } from 'mongoose';
import { diffFields, writeAudit } from '../../common/audit.js';
import { AppError } from '../../common/errors.js';
import type { AuthUser } from '../../common/middleware/auth.js';
import { insertManySynced } from '../../db/syncPlugin.js';
import { withTransaction } from '../../db/transaction.js';
import { SchoolClass } from '../classes/classes.model.js';
import { AcademicSession } from '../sessions/sessions.model.js';
import { requireCurrentSession } from '../sessions/sessions.service.js';
import { FeeStructure, type FeeStructureDoc } from './fee-structures.model.js';
import type {
  CopyFeeStructuresInput,
  ListFeeStructuresQuery,
  PutFeeStructureInput,
} from './fee-structures.schemas.js';

async function assertSessionExists(id: string, session: ClientSession): Promise<void> {
  if (!(await AcademicSession.exists({ _id: id }).session(session))) {
    throw new AppError('NOT_FOUND', 'Session not found.');
  }
}

/** Fee structures of a session (the current session when none is given). */
export async function listFeeStructures(query: ListFeeStructuresQuery): Promise<FeeStructureDoc[]> {
  const sessionId = query.sessionId ?? (await requireCurrentSession())._id;
  return FeeStructure.find({ sessionId });
}

/**
 * Creates or updates the three amounts for one class in one session. Existing vouchers keep
 * the amounts copied at generation; only future vouchers use the new amounts.
 */
export async function putFeeStructure(
  user: AuthUser,
  sessionId: string,
  classId: string,
  input: PutFeeStructureInput,
): Promise<FeeStructureDoc> {
  return withTransaction(async (session) => {
    await assertSessionExists(sessionId, session);
    if (!(await SchoolClass.exists({ _id: classId }).session(session))) {
      throw new AppError('NOT_FOUND', 'Class not found.');
    }

    let structure = await FeeStructure.findOne({ sessionId, classId }).session(session);
    const before = structure
      ? {
          tuitionFee: structure.tuitionFee,
          admissionFee: structure.admissionFee,
          examFee: structure.examFee,
        }
      : {};

    if (structure) structure.set(input);
    else structure = new FeeStructure({ sessionId, classId, ...input, createdBy: user.id });
    await structure.save({ session });

    await writeAudit(session, {
      action: 'FEE_STRUCTURE_UPDATE',
      userId: user.id,
      entity: 'fee_structure',
      entityId: structure._id,
      ...diffFields(before, { ...input }),
    });
    return structure;
  });
}

/** Copies every class's amounts from one session to another; classes already set are kept. */
export async function copyFeeStructures(
  user: AuthUser,
  input: CopyFeeStructuresInput,
): Promise<{ created: number; skipped: number }> {
  return withTransaction(async (session) => {
    await assertSessionExists(input.fromSessionId, session);
    await assertSessionExists(input.toSessionId, session);

    // One at a time: a transaction session cannot run operations in parallel.
    const source = await FeeStructure.find({ sessionId: input.fromSessionId })
      .session(session)
      .lean();
    const existing = await FeeStructure.find({ sessionId: input.toSessionId }, { classId: 1 })
      .session(session)
      .lean();
    const alreadySet = new Set(existing.map((s) => s.classId));
    const toCreate = source
      .filter((s) => !alreadySet.has(s.classId))
      .map((s) => ({
        sessionId: input.toSessionId,
        classId: s.classId,
        tuitionFee: s.tuitionFee,
        admissionFee: s.admissionFee,
        examFee: s.examFee,
        createdBy: user.id,
      }));
    await insertManySynced(FeeStructure, toCreate, session);

    const result = { created: toCreate.length, skipped: source.length - toCreate.length };
    await writeAudit(session, {
      action: 'FEE_STRUCTURE_UPDATE',
      userId: user.id,
      entity: 'fee_structure',
      after: { copiedFrom: input.fromSessionId, copiedTo: input.toSessionId, ...result },
    });
    return result;
  });
}
