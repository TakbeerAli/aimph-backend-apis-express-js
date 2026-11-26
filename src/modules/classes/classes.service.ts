import type { ClientSession } from 'mongoose';
import { diffFields, writeAudit } from '../../common/audit.js';
import { AppError } from '../../common/errors.js';
import type { AuthUser } from '../../common/middleware/auth.js';
import { withTransaction } from '../../db/transaction.js';
import { Student } from '../students/students.model.js';
import { Voucher } from '../vouchers/vouchers.model.js';
import { SchoolClass, type ClassAttrs, type ClassDoc, type SectionAttrs } from './classes.model.js';
import type {
  AddSectionInput,
  CreateClassInput,
  UpdateClassInput,
  UpdateSectionInput,
} from './classes.schemas.js';

type ClassJson = Omit<ClassAttrs, 'sections'> & {
  activeStudents: number;
  sections: (SectionAttrs & { activeStudents: number })[];
};

async function findClassOrThrow(id: string, session: ClientSession): Promise<ClassDoc> {
  const cls = await SchoolClass.findById(id).session(session);
  if (!cls) throw new AppError('NOT_FOUND', 'Class not found.');
  return cls;
}

async function assertNextClass(
  classId: string | null,
  nextClassId: string | null | undefined,
  session: ClientSession,
): Promise<void> {
  if (!nextClassId) return;
  if (nextClassId === classId) {
    throw new AppError('VALIDATION_ERROR', 'A class cannot be promoted into itself.');
  }
  if (!(await SchoolClass.exists({ _id: nextClassId }).session(session))) {
    throw new AppError('VALIDATION_ERROR', 'The next class does not exist.');
  }
}

const countActiveStudents = (filter: Record<string, string>, session?: ClientSession) =>
  Student.countDocuments({ status: 'ACTIVE', ...filter }).session(session ?? null);

/** All classes by sortOrder, with active student counts per class and section. */
export async function listClasses(): Promise<ClassJson[]> {
  const [classes, counts] = await Promise.all([
    SchoolClass.find().sort({ sortOrder: 1 }).lean(),
    Student.aggregate<{ _id: { classId: string; sectionId: string }; count: number }>([
      { $match: { status: 'ACTIVE' } },
      {
        $group: {
          _id: { classId: '$current.classId', sectionId: '$current.sectionId' },
          count: { $sum: 1 },
        },
      },
    ]),
  ]);

  const bySection = new Map(counts.map((c) => [`${c._id.classId}:${c._id.sectionId}`, c.count]));
  return classes.map((cls) => {
    const sections = cls.sections.map((s) => ({
      ...s,
      activeStudents: bySection.get(`${cls._id}:${s._id}`) ?? 0,
    }));
    return {
      ...cls,
      sections,
      activeStudents: sections.reduce((sum, s) => sum + s.activeStudents, 0),
    };
  });
}

export async function createClass(user: AuthUser, input: CreateClassInput): Promise<ClassDoc> {
  return withTransaction(async (session) => {
    await assertNextClass(null, input.nextClassId, session);
    const [cls] = await SchoolClass.create(
      [
        {
          name: input.name,
          shortName: input.shortName,
          sortOrder: input.sortOrder,
          nextClassId: input.nextClassId,
          sections: input.sections.map((name) => ({ name })),
          createdBy: user.id,
        },
      ],
      { session },
    );
    if (!cls) throw new Error('Class was not created');
    await writeAudit(session, {
      action: 'CLASS_CREATE',
      userId: user.id,
      entity: 'class',
      entityId: cls._id,
      after: { name: cls.name, sections: input.sections },
    });
    return cls;
  });
}

export async function updateClass(
  user: AuthUser,
  id: string,
  input: UpdateClassInput,
): Promise<ClassDoc> {
  return withTransaction(async (session) => {
    const cls = await findClassOrThrow(id, session);
    await assertNextClass(cls._id, input.nextClassId, session);
    if (
      input.isActive === false &&
      cls.isActive &&
      (await countActiveStudents({ 'current.classId': cls._id }, session)) > 0
    ) {
      throw new AppError('CONFLICT', 'This class still has active students.');
    }

    const pick = () => ({
      name: cls.name,
      shortName: cls.shortName,
      sortOrder: cls.sortOrder,
      nextClassId: cls.nextClassId,
      isActive: cls.isActive,
    });
    const before = pick();
    cls.set(input);
    await cls.save({ session });

    await writeAudit(session, {
      action: 'CLASS_UPDATE',
      userId: user.id,
      entity: 'class',
      entityId: cls._id,
      ...diffFields(before, pick()),
    });
    return cls;
  });
}

export async function addSection(
  user: AuthUser,
  classId: string,
  input: AddSectionInput,
): Promise<ClassDoc> {
  return withTransaction(async (session) => {
    const cls = await findClassOrThrow(classId, session);
    if (cls.sections.some((s) => s.name === input.name)) {
      throw new AppError('CONFLICT', `Section ${input.name} already exists in ${cls.name}.`);
    }
    cls.sections.push({ name: input.name });
    await cls.save({ session });

    const section = cls.sections.at(-1);
    await writeAudit(session, {
      action: 'SECTION_CREATE',
      userId: user.id,
      entity: 'class',
      entityId: cls._id,
      after: { sectionId: section?._id, name: input.name },
    });
    return cls;
  });
}

export async function updateSection(
  user: AuthUser,
  classId: string,
  sectionId: string,
  input: UpdateSectionInput,
): Promise<ClassDoc> {
  return withTransaction(async (session) => {
    const cls = await findClassOrThrow(classId, session);
    const section = cls.sections.id(sectionId);
    if (!section) throw new AppError('NOT_FOUND', 'Section not found.');

    if (input.name && cls.sections.some((s) => s.name === input.name && s._id !== sectionId)) {
      throw new AppError('CONFLICT', `Section ${input.name} already exists in ${cls.name}.`);
    }
    if (
      input.isActive === false &&
      section.isActive &&
      (await countActiveStudents({ 'current.sectionId': sectionId }, session)) > 0
    ) {
      throw new AppError('CONFLICT', 'This section still has active students.');
    }

    const before = { name: section.name, isActive: section.isActive };
    section.set(input);
    await cls.save({ session });

    await writeAudit(session, {
      action: 'SECTION_UPDATE',
      userId: user.id,
      entity: 'class',
      entityId: cls._id,
      ...diffFields(before, { name: section.name, isActive: section.isActive }),
      reason: `Section ${sectionId}`,
    });
    return cls;
  });
}

/** Loads a class and one of its sections; both must exist and be active. */
export interface DeleteSectionResult {
  /** true: removed from the class; false: it has records, so it was only hidden (inactive). */
  deleted: boolean;
  class: ClassDoc;
}

/**
 * Deletes a section. One with active students cannot be deleted. One that students or vouchers
 * ever used is kept for their history and only hidden (isActive = false); an unused one is
 * removed from the class.
 */
export async function deleteSection(
  user: AuthUser,
  classId: string,
  sectionId: string,
): Promise<DeleteSectionResult> {
  return withTransaction(async (session) => {
    const cls = await findClassOrThrow(classId, session);
    const section = cls.sections.id(sectionId);
    if (!section) throw new AppError('NOT_FOUND', 'Section not found.');

    if ((await countActiveStudents({ 'current.sectionId': sectionId }, session)) > 0) {
      throw new AppError(
        'CONFLICT',
        `Section ${section.name} still has active students. Move them to another section first.`,
      );
    }

    const usedByStudents = await Student.exists({
      $or: [
        { 'current.sectionId': sectionId },
        { 'classHistory.sectionId': sectionId },
        { 'classHistory.sectionChanges.fromSectionId': sectionId },
        { 'classHistory.sectionChanges.toSectionId': sectionId },
      ],
    }).session(session);
    const usedByVouchers =
      !usedByStudents && (await Voucher.exists({ sectionId }).session(session));
    const deleted = !usedByStudents && !usedByVouchers;

    const before = { name: section.name, isActive: section.isActive };
    if (deleted) {
      cls.sections.pull({ _id: sectionId });
    } else {
      section.isActive = false;
    }
    await cls.save({ session });

    await writeAudit(session, {
      action: 'SECTION_DELETE',
      userId: user.id,
      entity: 'class',
      entityId: cls._id,
      before: { sectionId, ...before },
      ...(!deleted && { after: { sectionId, name: section.name, isActive: false } }),
      reason: deleted ? 'Deleted (never used)' : 'Hidden: kept for old records',
    });
    return { deleted, class: cls };
  });
}

export async function requireActivePlacement(
  classId: string,
  sectionId: string,
  session: ClientSession,
): Promise<{ cls: ClassDoc; section: SectionAttrs }> {
  const cls = await SchoolClass.findById(classId).session(session);
  const section = cls?.sections.id(sectionId);
  if (!cls || !section) throw new AppError('VALIDATION_ERROR', 'Class or section not found.');
  if (!cls.isActive || !section.isActive) {
    throw new AppError('VALIDATION_ERROR', `${cls.name} section ${section.name} is not active.`);
  }
  return { cls, section };
}

/** Throws VALIDATION_ERROR unless every id is an existing class. */
export async function assertClassesExist(ids: string[], session: ClientSession): Promise<void> {
  if (ids.length === 0) return;
  const found = await SchoolClass.countDocuments({ _id: { $in: ids } }).session(session);
  if (found !== ids.length) {
    throw new AppError('VALIDATION_ERROR', 'One or more assigned classes do not exist.');
  }
}
