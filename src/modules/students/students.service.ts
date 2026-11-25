import type { ClientSession, QueryFilter } from 'mongoose';
import { diffFields, writeAudit } from '../../common/audit.js';
import { AppError } from '../../common/errors.js';
import type { AuthUser } from '../../common/middleware/auth.js';
import { today } from '../../common/utils/dates.js';
import { pageResult, skipFor, toMongoSort } from '../../common/utils/pagination.js';
import { incrementCounter, raiseCounterTo } from '../../db/counters.js';
import { insertManySynced } from '../../db/syncPlugin.js';
import { withTransaction } from '../../db/transaction.js';
import { SchoolClass } from '../classes/classes.model.js';
import { assertClassesExist, requireActivePlacement } from '../classes/classes.service.js';
import { AcademicSession } from '../sessions/sessions.model.js';
import { requireCurrentSession } from '../sessions/sessions.service.js';
import { createAdmissionVoucher } from '../vouchers/vouchers.generate.js';
import { OPEN_BALANCE, Voucher, type VoucherDoc } from '../vouchers/vouchers.model.js';
import { Student, type StudentAttrs, type StudentDoc } from './students.model.js';
import {
  admitStudentBody,
  type AdmitStudentInput,
  type ChangeSectionInput,
  type ListStudentsQuery,
  type UpdateStudentInput,
} from './students.schemas.js';

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function findStudentOrThrow(id: string, session?: ClientSession): Promise<StudentDoc> {
  const student = await Student.findById(id).session(session ?? null);
  if (!student) throw new AppError('NOT_FOUND', 'Student not found.');
  return student;
}

/** Builds a new student document with its first class-history entry (NEW_ADMISSION). */
function newStudentDoc(
  user: AuthUser,
  input: AdmitStudentInput,
  sessionId: string,
  admissionNo: number,
): Partial<StudentAttrs> {
  const admissionDate = input.admissionDate ?? today();
  const { _id, classId, sectionId, rollNo, admissionNo: _given, ...personal } = input;
  const placement = { sessionId, classId, sectionId, ...(rollNo !== undefined && { rollNo }) };
  return {
    ...(_id && { _id }),
    ...personal,
    // Normally the class the student is admitted to now; old records may name an earlier one.
    admissionClassId: personal.admissionClassId ?? classId,
    admissionNo,
    admissionDate,
    status: 'ACTIVE',
    current: placement,
    classHistory: [
      {
        ...placement,
        entryType: 'NEW_ADMISSION',
        outcome: 'IN_PROGRESS',
        startDate: admissionDate,
        endDate: null,
        sectionChanges: [],
      },
    ] as unknown as StudentAttrs['classHistory'],
    withdrawal: null,
    createdBy: user.id,
  };
}

/**
 * Next admission number from the counter, or the number the Admin phone chose offline if it
 * is unused (the counter is then raised so it is never handed out again).
 */
async function assignAdmissionNo(given: number | undefined, session: ClientSession) {
  if (given === undefined) return incrementCounter('counters.admissionNo', 1, session);
  if (await Student.exists({ admissionNo: given }).session(session)) {
    throw new AppError('CONFLICT', `Admission number ${given} is already used.`);
  }
  await raiseCounterTo('counters.admissionNo', given, session);
  return given;
}

export interface AdmitResult {
  student: StudentDoc;
  /** The admission voucher (current month: tuition + admission fee), if one was charged. */
  voucher: VoucherDoc | null;
  /** True when a student with this `_id` already existed (repeat of an offline admission). */
  duplicate: boolean;
}

/** Section 8.1: student + first class-history entry + admission voucher, in one transaction. */
export async function admitStudent(user: AuthUser, input: AdmitStudentInput): Promise<AdmitResult> {
  if (input._id) {
    const existing = await Student.findById(input._id);
    if (existing) {
      const voucher = await Voucher.findOne({ studentId: existing._id, 'lines.code': 'ADMISSION' });
      return { student: existing, voucher, duplicate: true };
    }
  }

  return withTransaction(async (session) => {
    const currentSession = await requireCurrentSession(session);
    await requireActivePlacement(input.classId, input.sectionId, session);
    if (input.admissionClassId) await assertClassesExist([input.admissionClassId], session);
    const admissionNo = await assignAdmissionNo(input.admissionNo, session);

    const [student] = await Student.create(
      [newStudentDoc(user, input, currentSession._id, admissionNo)],
      { session },
    );
    if (!student) throw new Error('Student was not created');
    const voucher = await createAdmissionVoucher(user, student, currentSession, session);

    await writeAudit(session, {
      action: 'STUDENT_CREATE',
      userId: user.id,
      deviceCode: user.deviceCode,
      entity: 'student',
      entityId: student._id,
      after: {
        admissionNo,
        fullName: student.fullName,
        current: student.current,
        voucherNo: voucher?.voucherNo ?? null,
        charged: voucher?.totalAmount ?? 0,
      },
    });
    return { student, voucher, duplicate: false };
  });
}

/** Students matching the filters; each has `currentDues` (owed on this session's vouchers). */
export async function listStudents(query: ListStudentsQuery) {
  const filter: QueryFilter<StudentAttrs> = {};
  if (query.status) filter.status = query.status;
  if (query.classId) filter['current.classId'] = query.classId;
  if (query.sectionId) filter['current.sectionId'] = query.sectionId;
  if (query.q) {
    // Every word must appear somewhere in name, father's name, admission no. or phone.
    const words = query.q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 5);
    filter.$and = words.map((w) => ({ searchText: { $regex: escapeRegex(w) } }));
  }

  const [students, total, currentSession] = await Promise.all([
    Student.find(filter).sort(toMongoSort(query.sort)).skip(skipFor(query)).limit(query.limit),
    Student.countDocuments(filter),
    AcademicSession.findOne({ isCurrent: true }, { _id: 1 }).lean(),
  ]);

  const dues = currentSession
    ? await Voucher.aggregate<{ _id: string; amount: number }>([
        {
          $match: {
            ...OPEN_BALANCE,
            sessionId: currentSession._id,
            studentId: { $in: students.map((s) => s._id) },
          },
        },
        { $group: { _id: '$studentId', amount: { $sum: '$balance' } } },
      ])
    : [];
  const duesByStudent = new Map(dues.map((d) => [d._id, d.amount]));
  const items = students.map((s) => ({
    ...s.toJSON(),
    currentDues: duesByStudent.get(s._id) ?? 0,
  }));
  return pageResult(items, total, query);
}

export const getStudent = (id: string): Promise<StudentDoc> => findStudentOrThrow(id);

/**
 * Edits personal and guardian details. `version` must match the stored version, otherwise
 * VERSION_CONFLICT is returned with the current server copy (no merging in Phase 1).
 */
export async function updateStudent(
  user: AuthUser,
  id: string,
  input: UpdateStudentInput,
): Promise<StudentDoc> {
  const { version, guardian, ...personal } = input;

  return withTransaction(async (session) => {
    const student = await findStudentOrThrow(id, session);
    if (student.version !== version) {
      throw new AppError(
        'VERSION_CONFLICT',
        'This student was changed by someone else. Reload and try again.',
        { current: student.toJSON() },
      );
    }

    const keys = [...Object.keys(personal), ...(guardian ? ['guardian'] : [])];
    const snapshot = () => {
      const all = Object.fromEntries(Object.entries(student.toObject()));
      return Object.fromEntries(keys.map((k) => [k, all[k] as unknown]));
    };
    const before = snapshot();
    if (personal.admissionClassId) {
      await assertClassesExist([personal.admissionClassId], session);
    }

    // null clears an optional field.
    for (const [key, value] of Object.entries(personal)) student.set(key, value ?? undefined);
    for (const [key, value] of Object.entries(guardian ?? {})) {
      student.set(`guardian.${key}`, value ?? undefined);
    }
    if (student.dateOfBirth >= student.admissionDate) {
      throw new AppError('VALIDATION_ERROR', 'Date of birth must be before the admission date.');
    }

    await student.save({ session });
    await writeAudit(session, {
      action: 'STUDENT_UPDATE',
      userId: user.id,
      deviceCode: user.deviceCode,
      entity: 'student',
      entityId: student._id,
      ...diffFields(before, snapshot()),
    });
    return student;
  });
}

/** Section 8.7: same class, current session. Fees do not change. */
export async function changeSection(
  user: AuthUser,
  id: string,
  input: ChangeSectionInput,
): Promise<StudentDoc> {
  return withTransaction(async (session) => {
    const student = await findStudentOrThrow(id, session);
    if (student.status !== 'ACTIVE') {
      throw new AppError('STUDENT_NOT_ACTIVE', 'Only active students can change section.');
    }
    const currentSession = await requireCurrentSession(session);
    const entry = student.classHistory.findLast(
      (h) => h.sessionId === currentSession._id && h.outcome === 'IN_PROGRESS',
    );
    if (student.current.sessionId !== currentSession._id || !entry) {
      throw new AppError('VALIDATION_ERROR', 'The student is not enrolled in the current session.');
    }
    const fromSectionId = student.current.sectionId;
    if (input.toSectionId === fromSectionId) {
      throw new AppError('VALIDATION_ERROR', 'The student is already in this section.');
    }
    await requireActivePlacement(student.current.classId, input.toSectionId, session);

    const before = { sectionId: fromSectionId, rollNo: student.current.rollNo };
    entry.sectionChanges.push({
      fromSectionId,
      toSectionId: input.toSectionId,
      date: input.date ?? today(),
      by: user.id,
      reason: input.reason,
    });
    // Roll numbers belong to a section, so the old one is not carried over.
    entry.sectionId = input.toSectionId;
    entry.rollNo = input.rollNo;
    student.set('current.sectionId', input.toSectionId);
    student.set('current.rollNo', input.rollNo);
    await student.save({ session });

    await writeAudit(session, {
      action: 'SECTION_CHANGE',
      userId: user.id,
      entity: 'student',
      entityId: student._id,
      before,
      after: { sectionId: input.toSectionId, rollNo: input.rollNo },
      reason: input.reason,
    });
    return student;
  });
}

export interface ImportResult {
  created: number;
  errors: { row: number; message: string }[];
}

/**
 * Imports students from a JSON array (the app converts Excel to JSON). Rows are numbered from 1.
 * All rows are checked first; if any row has an error nothing is saved.
 */
export async function importStudents(user: AuthUser, rows: unknown[]): Promise<ImportResult> {
  const errors: ImportResult['errors'] = [];
  const valid: { row: number; input: AdmitStudentInput }[] = [];

  rows.forEach((raw, i) => {
    const parsed = admitStudentBody.safeParse(raw);
    if (parsed.success) valid.push({ row: i + 1, input: parsed.data });
    else {
      const message = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'row'}: ${issue.message}`)
        .join('; ');
      errors.push({ row: i + 1, message });
    }
  });

  const currentSession = await requireCurrentSession();
  const classes = new Map((await SchoolClass.find().lean()).map((cls) => [cls._id, cls] as const));

  // Checks inside the file: placement, and values that must not repeat.
  const firstRowOf = new Map<string, number>();
  for (const { row, input } of valid) {
    const cls = classes.get(input.classId);
    const section = cls?.sections.find((s) => s._id === input.sectionId);
    if (!cls || !section) errors.push({ row, message: 'Class or section not found.' });
    else if (!cls.isActive || !section.isActive) {
      errors.push({ row, message: `${cls.name} section ${section.name} is not active.` });
    }
    if (input.admissionClassId && !classes.has(input.admissionClassId)) {
      errors.push({ row, message: 'Admission class not found.' });
    }

    const unique: [string | undefined, string][] = [
      [input.admissionNo === undefined ? undefined : `no:${input.admissionNo}`, 'Admission number'],
      [input._id && `id:${input._id}`, 'Student id'],
      [
        input.rollNo === undefined ? undefined : `roll:${input.sectionId}:${input.rollNo}`,
        'Roll number',
      ],
    ];
    for (const [key, label] of unique) {
      if (!key) continue;
      const firstRow = firstRowOf.get(key);
      if (firstRow)
        errors.push({ row, message: `${label} is repeated (same as row ${firstRow}).` });
      else firstRowOf.set(key, row);
    }
  }

  // Checks against students already in the database.
  const givenNos = valid.flatMap((v) =>
    v.input.admissionNo === undefined ? [] : [v.input.admissionNo],
  );
  const givenIds = valid.flatMap((v) => (v.input._id ? [v.input._id] : []));
  const withRoll = valid.filter((v) => v.input.rollNo !== undefined);
  const [usedNos, usedIds, usedRolls] = await Promise.all([
    Student.find({ admissionNo: { $in: givenNos } }, { admissionNo: 1 }).lean(),
    Student.find({ _id: { $in: givenIds } }, { _id: 1 }).lean(),
    withRoll.length === 0
      ? []
      : Student.find(
          {
            status: 'ACTIVE',
            'current.sessionId': currentSession._id,
            $or: withRoll.map((v) => ({
              'current.sectionId': v.input.sectionId,
              'current.rollNo': v.input.rollNo,
            })),
          },
          { current: 1 },
        ).lean(),
  ]);
  const usedNoSet = new Set(usedNos.map((s) => s.admissionNo));
  const usedIdSet = new Set(usedIds.map((s) => s._id));
  const usedRollSet = new Set(usedRolls.map((s) => `${s.current.sectionId}:${s.current.rollNo}`));
  for (const { row, input } of valid) {
    if (input.admissionNo !== undefined && usedNoSet.has(input.admissionNo)) {
      errors.push({ row, message: `Admission number ${input.admissionNo} is already used.` });
    }
    if (input._id && usedIdSet.has(input._id)) {
      errors.push({ row, message: 'A student with this id already exists.' });
    }
    if (input.rollNo !== undefined && usedRollSet.has(`${input.sectionId}:${input.rollNo}`)) {
      errors.push({
        row,
        message: `Roll number ${input.rollNo} is already taken in this section.`,
      });
    }
  }

  if (errors.length > 0) {
    return { created: 0, errors: errors.sort((a, b) => a.row - b.row) };
  }

  // All rows are valid: save them in one transaction (unique indexes still guard races).
  const created = await withTransaction(async (session) => {
    const current = await requireCurrentSession(session);
    if (givenNos.length > 0) {
      await raiseCounterTo('counters.admissionNo', Math.max(...givenNos), session);
    }
    const needNumbers = valid.filter((v) => v.input.admissionNo === undefined).length;
    let nextNo =
      needNumbers > 0
        ? (await incrementCounter('counters.admissionNo', needNumbers, session)) - needNumbers + 1
        : 0;

    const docs = valid.map(({ input }) =>
      newStudentDoc(user, input, current._id, input.admissionNo ?? nextNo++),
    );
    const inserted = await insertManySynced(Student, docs, session);

    const numbers = inserted.map((s) => s.admissionNo);
    await writeAudit(session, {
      action: 'STUDENTS_IMPORT',
      userId: user.id,
      entity: 'student',
      after: {
        count: inserted.length,
        firstAdmissionNo: Math.min(...numbers),
        lastAdmissionNo: Math.max(...numbers),
      },
    });
    return inserted.length;
  });

  return { created, errors: [] };
}
