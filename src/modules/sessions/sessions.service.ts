import type { ClientSession } from 'mongoose';
import { writeAudit } from '../../common/audit.js';
import { AppError } from '../../common/errors.js';
import type { AuthUser } from '../../common/middleware/auth.js';
import { sessionDates } from '../../common/utils/dates.js';
import { withTransaction } from '../../db/transaction.js';
import { getSettings } from '../settings/settings.service.js';
import { Student } from '../students/students.model.js';
import { OPEN_BALANCE, Voucher } from '../vouchers/vouchers.model.js';
import { AcademicSession, type AcademicSessionDoc } from './sessions.model.js';
import type { CreateSessionInput } from './sessions.schemas.js';

export interface SessionListItem {
  [key: string]: unknown;
  /** Students who studied in the session (any class, any outcome). */
  studentCount: number;
  /** Unpaid balance of the session's vouchers (for a closed session: old dues). */
  openDues: number;
}

/** Newest first, each with its student count and unpaid dues (Academic Sessions screen). */
export async function listSessions(): Promise<SessionListItem[]> {
  const [sessions, students, dues] = await Promise.all([
    AcademicSession.find().sort({ startDate: -1 }),
    Student.aggregate<{ _id: string; count: number }>([
      { $unwind: '$classHistory' },
      { $group: { _id: { s: '$classHistory.sessionId', st: '$_id' } } },
      { $group: { _id: '$_id.s', count: { $sum: 1 } } },
    ]),
    Voucher.aggregate<{ _id: string; amount: number }>([
      { $match: OPEN_BALANCE },
      { $group: { _id: '$sessionId', amount: { $sum: '$balance' } } },
    ]),
  ]);
  const studentsBy = new Map(students.map((s) => [s._id, s.count]));
  const duesBy = new Map(dues.map((d) => [d._id, d.amount]));
  return sessions.map((s) => ({
    ...s.toJSON(),
    studentCount: studentsBy.get(s._id) ?? 0,
    openDues: duesBy.get(s._id) ?? 0,
  }));
}

/**
 * Creates a session (1 April to 31 March). The very first session becomes the current one;
 * later sessions are switched to with set-current.
 */
export async function createSession(
  user: AuthUser,
  input: CreateSessionInput,
): Promise<AcademicSessionDoc> {
  return withTransaction(async (session) => {
    const hasCurrent = await AcademicSession.exists({ isCurrent: true }).session(session);
    const [created] = await AcademicSession.create(
      [
        {
          name: input.name,
          ...sessionDates(input.name),
          isCurrent: !hasCurrent,
          status: 'ACTIVE',
          createdBy: user.id,
        },
      ],
      { session },
    );
    if (!created) throw new Error('Session was not created');

    if (!hasCurrent) {
      const settings = await getSettings(session);
      settings.currentSessionId = created._id;
      await settings.save({ session });
    }

    await writeAudit(session, {
      action: 'SESSION_CREATE',
      userId: user.id,
      entity: 'academic_session',
      entityId: created._id,
      after: { name: created.name, isCurrent: created.isCurrent },
    });
    return created;
  });
}

/**
 * Section 8.10: the old current session is CLOSED and the new one becomes current, in one
 * transaction. Old unpaid vouchers stay as they are (previous-session dues).
 */
export async function setCurrentSession(user: AuthUser, id: string): Promise<AcademicSessionDoc> {
  return withTransaction(async (session) => {
    const target = await AcademicSession.findById(id).session(session);
    if (!target) throw new AppError('NOT_FOUND', 'Session not found.');
    if (target.isCurrent) throw new AppError('CONFLICT', `${target.name} is already current.`);
    if (target.status === 'CLOSED') {
      throw new AppError('VALIDATION_ERROR', `${target.name} is closed and cannot be reopened.`);
    }

    const old = await AcademicSession.findOne({ isCurrent: true }).session(session);
    if (old && target.startDate <= old.startDate) {
      throw new AppError(
        'VALIDATION_ERROR',
        `The new session must start after the current one (${old.name}).`,
      );
    }
    // Unset the old one first: only one session may have isCurrent = true.
    if (old) {
      old.isCurrent = false;
      old.status = 'CLOSED';
      await old.save({ session });
    }
    target.isCurrent = true;
    await target.save({ session });

    const settings = await getSettings(session);
    settings.currentSessionId = target._id;
    await settings.save({ session });

    await writeAudit(session, {
      action: 'SESSION_SET_CURRENT',
      userId: user.id,
      entity: 'academic_session',
      entityId: target._id,
      before: { currentSession: old?.name ?? null },
      after: { currentSession: target.name, closed: old?.name ?? null },
    });
    return target;
  });
}

/** The current session, or a clear error if none has been created yet. */
export async function requireCurrentSession(session?: ClientSession): Promise<AcademicSessionDoc> {
  const current = await AcademicSession.findOne({ isCurrent: true }).session(session ?? null);
  if (!current) {
    throw new AppError('VALIDATION_ERROR', 'There is no current session. Create a session first.');
  }
  return current;
}
