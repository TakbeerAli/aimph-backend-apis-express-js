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
import { SchoolClass } from '../classes/classes.model.js';
import { assertClassesExist } from '../classes/classes.service.js';
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

/**
 * A class belongs to at most one Staff user, so two phones never collect for the same class.
 * Throws CONFLICT naming the class and its current owner.
 */
async function assertClassesFree(
  classIds: string[],
  exceptUserId: string | null,
  session: ClientSession,
): Promise<void> {
  if (classIds.length === 0) return;
  const owners = await User.find(
    {
      role: 'STAFF',
      isActive: true,
      assignedClassIds: { $in: classIds },
      ...(exceptUserId && { _id: { $ne: exceptUserId } }),
    },
    { fullName: 1, assignedClassIds: 1 },
  ).session(session);
  const owner = owners[0];
  if (!owner) return;
  const takenId = classIds.find((id) => owner.assignedClassIds.includes(id));
  const cls = await SchoolClass.findById(takenId, { name: 1 }).session(session);
  throw new AppError(
    'CONFLICT',
    `${cls?.name ?? 'A class'} is already assigned to ${owner.fullName}. A class can belong to only one staff member.`,
    { classId: takenId, userId: owner._id },
  );
}

/** Admin creates a Staff user. The single Admin is created with scripts/create-admin.ts. */
export async function createStaff(admin: AuthUser, input: CreateUserInput): Promise<UserDoc> {
  const passwordHash = await hashPassword(input.password);
  return withTransaction(async (session) => {
    await assertClassesExist(input.assignedClassIds, session);
    await assertClassesFree(input.assignedClassIds, null, session);
    const [user] = await User.create(
      [
        {
          fullName: input.fullName,
          username: input.username,
          passwordHash,
          role: 'STAFF',
          deviceCode: input.deviceCode,
          phone: input.phone ?? null,
          assignedClassIds: input.assignedClassIds,
          // The Admin chose this password, so the staff member replaces it at first sign-in.
          mustChangePassword: true,
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
    if (input.assignedClassIds) {
      await assertClassesExist(input.assignedClassIds, session);
      if (user.role === 'STAFF') await assertClassesFree(input.assignedClassIds, user._id, session);
    }
    // Turning a Staff user back on must not give two people the same class.
    if (input.isActive === true && !user.isActive && user.role === 'STAFF') {
      await assertClassesFree(input.assignedClassIds ?? user.assignedClassIds, user._id, session);
    }
    const before = {
      fullName: user.fullName,
      isActive: user.isActive,
      phone: user.phone,
      assignedClassIds: [...user.assignedClassIds],
    };

    user.set(input);
    // A deactivated user is logged out everywhere.
    if (input.isActive === false) user.refreshTokenHash = null;
    await user.save({ session });

    const changes = diffFields(before, {
      fullName: user.fullName,
      isActive: user.isActive,
      phone: user.phone,
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

/**
 * Sets a new password and logs the user out. They sign in with it once and are then asked to
 * choose their own (mustChangePassword).
 */
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
    user.mustChangePassword = true;
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
