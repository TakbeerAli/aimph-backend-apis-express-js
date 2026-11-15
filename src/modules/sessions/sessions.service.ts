import type { ClientSession } from 'mongoose';
import { writeAudit } from '../../common/audit.js';
import { AppError } from '../../common/errors.js';
import type { AuthUser } from '../../common/middleware/auth.js';
import { sessionDates } from '../../common/utils/dates.js';
import { withTransaction } from '../../db/transaction.js';
import { getSettings } from '../settings/settings.service.js';
import { AcademicSession, type AcademicSessionDoc } from './sessions.model.js';
import type { CreateSessionInput } from './sessions.schemas.js';

export async function listSessions(): Promise<AcademicSessionDoc[]> {
  return AcademicSession.find().sort({ startDate: -1 });
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

/** The current session, or a clear error if none has been created yet. */
export async function requireCurrentSession(session?: ClientSession): Promise<AcademicSessionDoc> {
  const current = await AcademicSession.findOne({ isCurrent: true }).session(session ?? null);
  if (!current) {
    throw new AppError('VALIDATION_ERROR', 'There is no current session. Create a session first.');
  }
  return current;
}
