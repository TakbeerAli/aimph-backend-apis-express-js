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
import { allocateSyncSeq } from '../../db/counters.js';
import { withTransaction } from '../../db/transaction.js';
import { hashPassword } from '../auth/password.js';
import { SchoolClass } from '../classes/classes.model.js';
import { User, type UserDoc } from './users.model.js';
import type { CreateTeacherInput, ListUsersQuery, UpdateTeacherInput } from './users.schemas.js';

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

/* ---------- Sections ---------- */

export interface SectionInfo {
  classId: string;
  sectionId: string;
  /** "5-A" (the class short name when it has one). */
  label: string;
}

/** Every active section of every active class, in class order. */
export async function activeSections(session?: ClientSession | null): Promise<SectionInfo[]> {
  const classes = await SchoolClass.find({ isActive: true })
    .sort({ sortOrder: 1 })
    .session(session ?? null);
  return classes.flatMap((cls) =>
    cls.sections
      .filter((s) => s.isActive)
      .map((s) => ({
        classId: cls._id,
        sectionId: s._id,
        label: `${cls.shortName ?? cls.name}-${s.name}`,
      })),
  );
}

/** Rejects ids that are not active sections. */
async function assertSectionsExist(sectionIds: string[], session: ClientSession) {
  if (sectionIds.length === 0) return;
  const known = new Set((await activeSections(session)).map((s) => s.sectionId));
  if (sectionIds.some((id) => !known.has(id))) {
    throw new AppError('VALIDATION_ERROR', 'One or more sections do not exist or are not active.');
  }
}

/**
 * A section belongs to at most one active teacher. Throws SECTION_ALREADY_ASSIGNED naming the
 * section and its teacher.
 */
async function assertSectionsFree(
  sectionIds: string[],
  exceptUserId: string | null,
  session: ClientSession,
): Promise<void> {
  if (sectionIds.length === 0) return;
  const owner = await User.findOne(
    {
      role: 'TEACHER',
      isActive: true,
      assignedSectionIds: { $in: sectionIds },
      ...(exceptUserId && { _id: { $ne: exceptUserId } }),
    },
    { fullName: 1, assignedSectionIds: 1 },
  ).session(session);
  if (!owner) return;
  const takenId = sectionIds.find((id) => owner.assignedSectionIds.includes(id));
  const label =
    (await activeSections(session)).find((s) => s.sectionId === takenId)?.label ?? 'A section';
  throw new AppError(
    'SECTION_ALREADY_ASSIGNED',
    `${label} is already assigned to ${owner.fullName}. Remove it from that teacher first.`,
    { sectionId: takenId, section: label, teacherId: owner._id, teacher: owner.fullName },
  );
}

/* ---------- Teachers ---------- */

export interface TeacherList {
  items: UserDoc[];
  /** Active sections no active teacher has: only the Admin can collect or mark there. */
  unassignedSections: SectionInfo[];
}

export async function listTeachers(): Promise<TeacherList> {
  const [items, sections] = await Promise.all([
    User.find({ role: 'TEACHER' }).sort({ isActive: -1, deviceCode: 1 }),
    activeSections(),
  ]);
  const taken = new Set(items.filter((t) => t.isActive).flatMap((t) => t.assignedSectionIds));
  return { items, unassignedSections: sections.filter((s) => !taken.has(s.sectionId)) };
}

/** Next free teacher phone code: T01, T02 … (T100 after T99). */
async function nextTeacherCode(session: ClientSession): Promise<string> {
  const users = await User.find({ deviceCode: /^T\d+$/ }, { deviceCode: 1 }).session(session);
  const max = users.reduce((n, u) => Math.max(n, Number(u.deviceCode.slice(1))), 0);
  return `T${String(max + 1).padStart(2, '0')}`;
}

/** Admin creates a teacher; the phone code is given automatically. */
export async function createTeacher(admin: AuthUser, input: CreateTeacherInput): Promise<UserDoc> {
  const passwordHash = await hashPassword(input.password);
  return withTransaction(async (session) => {
    await assertSectionsExist(input.assignedSectionIds, session);
    await assertSectionsFree(input.assignedSectionIds, null, session);
    const [user] = await User.create(
      [
        {
          fullName: input.fullName,
          username: input.username,
          passwordHash,
          role: 'TEACHER',
          deviceCode: await nextTeacherCode(session),
          phone: input.phone ?? null,
          assignedSectionIds: input.assignedSectionIds,
          // The Admin chose this password, so the teacher replaces it at first sign-in.
          mustChangePassword: true,
          createdBy: admin.id,
        },
      ],
      { session },
    );
    if (!user) throw new Error('User was not created');
    await writeAudit(session, {
      action: 'TEACHER_CREATE',
      userId: admin.id,
      entity: 'user',
      entityId: user._id,
      after: {
        fullName: user.fullName,
        username: user.username,
        role: user.role,
        deviceCode: user.deviceCode,
        assignedSectionIds: user.assignedSectionIds,
      },
    });
    return user;
  });
}

export async function updateTeacher(
  admin: AuthUser,
  id: string,
  input: UpdateTeacherInput,
): Promise<UserDoc> {
  if (id === admin.id && input.isActive === false) {
    throw new AppError('VALIDATION_ERROR', 'You cannot deactivate your own account.');
  }
  return withTransaction(async (session) => {
    const user = await findUserOrThrow(id, session);
    if (input.assignedSectionIds && user.role !== 'TEACHER') {
      throw new AppError('VALIDATION_ERROR', 'Only teachers have sections.');
    }
    const sections = input.assignedSectionIds ?? user.assignedSectionIds;
    if (input.assignedSectionIds) {
      await assertSectionsExist(input.assignedSectionIds, session);
    }
    // Checked when sections change, and when a teacher is turned back on.
    const staysActive = input.isActive ?? user.isActive;
    if (user.role === 'TEACHER' && staysActive && (input.assignedSectionIds || !user.isActive)) {
      await assertSectionsFree(sections, user._id, session);
    }

    const before = {
      fullName: user.fullName,
      isActive: user.isActive,
      phone: user.phone,
      assignedSectionIds: [...user.assignedSectionIds],
    };

    if (input.assignedSectionIds) {
      const added = sections.filter((s) => !before.assignedSectionIds.includes(s));
      const removed = before.assignedSectionIds.filter((s) => !sections.includes(s));
      if (added.length > 0 || removed.length > 0) {
        // A number between the phone's last pull and this change, so the next pull sees it.
        const seq = await allocateSyncSeq(1, session);
        if (added.length > 0) user.sectionsAddedSeq = seq;
        user.revokedSections = [
          ...user.revokedSections.filter((r) => !sections.includes(r.sectionId)),
          ...removed.map((sectionId) => ({ sectionId, seq })),
        ].slice(-100);
      }
    }

    user.set({
      ...(input.fullName !== undefined && { fullName: input.fullName }),
      ...(input.isActive !== undefined && { isActive: input.isActive }),
      ...(input.phone !== undefined && { phone: input.phone }),
      ...(input.assignedSectionIds && { assignedSectionIds: input.assignedSectionIds }),
    });
    // A deactivated user is logged out everywhere.
    if (input.isActive === false) user.refreshTokenHash = null;
    await user.save({ session });

    const after = {
      fullName: user.fullName,
      isActive: user.isActive,
      phone: user.phone,
      assignedSectionIds: [...user.assignedSectionIds],
    };
    const sectionsChanged =
      JSON.stringify(before.assignedSectionIds) !== JSON.stringify(after.assignedSectionIds);
    await writeAudit(session, {
      action: sectionsChanged ? 'SECTIONS_ASSIGN' : 'TEACHER_UPDATE',
      userId: admin.id,
      entity: 'user',
      entityId: user._id,
      ...diffFields(before, after),
    });
    return user;
  });
}

/** Takes a deleted section away from every teacher (their phones drop its data). */
export async function unassignSection(sectionId: string, session: ClientSession): Promise<void> {
  const owners = await User.find({ assignedSectionIds: sectionId }).session(session);
  for (const owner of owners) {
    owner.assignedSectionIds = owner.assignedSectionIds.filter((s) => s !== sectionId);
    owner.revokedSections.push({ sectionId, seq: await allocateSyncSeq(1, session) });
    await owner.save({ session });
  }
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
