import type { ClientSession } from 'mongoose';
import { diffFields, writeAudit } from '../../common/audit.js';
import { AppError } from '../../common/errors.js';
import type { AuthUser } from '../../common/middleware/auth.js';
import {
  pageResult,
  skipFor,
  toMongoSort,
  type PageResult,
} from '../../common/utils/pagination.js';
import { withTransaction } from '../../db/transaction.js';
import { hashPassword } from '../auth/password.js';
import { User, type UserDoc } from './users.model.js';
import type { CreateUserInput, ListUsersQuery, UpdateUserInput } from './users.schemas.js';

async function findUserOrThrow(id: string, session: ClientSession): Promise<UserDoc> {
  const user = await User.findById(id).session(session);
  if (!user) throw new AppError('NOT_FOUND', 'User not found.');
  return user;
}

export async function listUsers(query: ListUsersQuery): Promise<PageResult<UserDoc>> {
  const [items, total] = await Promise.all([
    User.find().sort(toMongoSort(query.sort)).skip(skipFor(query)).limit(query.limit),
    User.countDocuments(),
  ]);
  return pageResult(items, total, query);
}

/** Admin creates a Staff user. The single Admin is created with scripts/create-admin.ts. */
export async function createStaff(admin: AuthUser, input: CreateUserInput): Promise<UserDoc> {
  const passwordHash = await hashPassword(input.password);
  return withTransaction(async (session) => {
    const [user] = await User.create(
      [
        {
          fullName: input.fullName,
          username: input.username,
          passwordHash,
          role: 'STAFF',
          deviceCode: input.deviceCode,
          assignedClassIds: input.assignedClassIds,
          createdBy: admin.id,
        },
      ],
      { session },
    );
    if (!user) throw new Error('User was not created');
    await writeAudit(session, {
      action: 'USER_CREATE',
      userId: admin.id,
      entity: 'user',
      entityId: user._id,
      after: {
        fullName: user.fullName,
        username: user.username,
        role: user.role,
        deviceCode: user.deviceCode,
        assignedClassIds: user.assignedClassIds,
      },
    });
    return user;
  });
}

export async function updateUser(
  admin: AuthUser,
  id: string,
  input: UpdateUserInput,
): Promise<UserDoc> {
  if (id === admin.id && input.isActive === false) {
    throw new AppError('VALIDATION_ERROR', 'You cannot deactivate your own account.');
  }
  return withTransaction(async (session) => {
    const user = await findUserOrThrow(id, session);
    const before = {
      fullName: user.fullName,
      isActive: user.isActive,
      assignedClassIds: [...user.assignedClassIds],
    };

    user.set(input);
    // A deactivated user is logged out everywhere.
    if (input.isActive === false) user.refreshTokenHash = null;
    await user.save({ session });

    const changes = diffFields(before, {
      fullName: user.fullName,
      isActive: user.isActive,
      assignedClassIds: [...user.assignedClassIds],
    });
    await writeAudit(session, {
      action: 'USER_UPDATE',
      userId: admin.id,
      entity: 'user',
      entityId: user._id,
      ...changes,
    });
    return user;
  });
}

/** Sets a new password and logs the user out (they must log in with the new one). */
export async function resetPassword(
  admin: AuthUser,
  id: string,
  newPassword: string,
): Promise<void> {
  const passwordHash = await hashPassword(newPassword);
  await withTransaction(async (session) => {
    const user = await findUserOrThrow(id, session);
    user.passwordHash = passwordHash;
    user.refreshTokenHash = null;
    await user.save({ session });
    await writeAudit(session, {
      action: 'PASSWORD_RESET',
      userId: admin.id,
      entity: 'user',
      entityId: user._id,
    });
  });
}

/** Clears the refresh token, e.g. for a lost phone. */
export async function signOutUser(admin: AuthUser, id: string): Promise<void> {
  await withTransaction(async (session) => {
    const user = await findUserOrThrow(id, session);
    user.refreshTokenHash = null;
    await user.save({ session });
    await writeAudit(session, {
      action: 'USER_SIGN_OUT',
      userId: admin.id,
      entity: 'user',
      entityId: user._id,
    });
  });
}
