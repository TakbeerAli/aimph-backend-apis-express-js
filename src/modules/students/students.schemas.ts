import { z } from 'zod';
import { dateOnlySchema, today } from '../../common/utils/dates.js';
import { pageQuery } from '../../common/utils/pagination.js';
import {
  DUES_ACTIONS,
  GENDERS,
  RELATIONS,
  STUDENT_STATUSES,
  WITHDRAWAL_REASONS,
} from './students.model.js';

const id = z.string().min(1).max(64);
const phone = z
  .string()
  .trim()
  .regex(/^\+?[0-9][0-9 -]{6,18}$/, 'Enter a valid phone number, e.g. 0345-1112233.');
/** B-Form and CNIC numbers share the format 00000-0000000-0. */
const nadraNo = z
  .string()
  .trim()
  .regex(/^\d{5}-\d{7}-\d$/, 'Use the format 00000-0000000-0.');
const text = (max: number) => z.string().trim().min(1).max(max);
const rollNo = z.int().min(1).max(999);

const guardianFields = {
  fatherName: text(80),
  fatherCnic: nadraNo,
  guardianName: text(80),
  relation: z.enum(RELATIONS),
  phone,
  emergencyPhone: phone,
};

const personalFields = {
  fullName: text(80),
  dateOfBirth: dateOnlySchema.refine((d) => d < today(), 'Date of birth must be in the past.'),
  gender: z.enum(GENDERS),
  bFormNo: nadraNo,
  photoUrl: z.url().max(500),
  previousSchool: text(120),
  admissionDate: dateOnlySchema,
  address: text(250),
  // Printed on certificates.
  religion: text(30),
  nationality: text(30),
  placeOfBirth: text(60),
};

export const studentIdParams = z.object({ id });

export const admitStudentBody = z
  .object({
    /** Set when the student was admitted offline on the Admin phone. */
    _id: z.uuid().optional(),
    admissionNo: z.int().min(1).optional(),
    ...personalFields,
    bFormNo: personalFields.bFormNo.optional(),
    photoUrl: personalFields.photoUrl.optional(),
    previousSchool: personalFields.previousSchool.optional(),
    admissionDate: personalFields.admissionDate.optional(),
    religion: personalFields.religion.optional(),
    nationality: personalFields.nationality.optional(),
    placeOfBirth: personalFields.placeOfBirth.optional(),
    /** Class first admitted to, when it differs from classId (e.g. typing in old records). */
    admissionClassId: id.optional(),
    guardian: z.object({
      ...guardianFields,
      fatherCnic: guardianFields.fatherCnic.optional(),
      guardianName: guardianFields.guardianName.optional(),
      emergencyPhone: guardianFields.emergencyPhone.optional(),
    }),
    classId: id,
    sectionId: id,
    rollNo: rollNo.optional(),
  })
  .refine((s) => !s.admissionDate || s.dateOfBirth < s.admissionDate, {
    message: 'Date of birth must be before the admission date.',
    path: ['dateOfBirth'],
  });

/**
 * PATCH: personal and guardian details only (class/section changes have their own endpoints).
 * `version` is required. Optional fields can be cleared with null.
 */
export const updateStudentBody = z.object({
  version: z.int().min(1),
  fullName: personalFields.fullName.optional(),
  dateOfBirth: personalFields.dateOfBirth.optional(),
  gender: personalFields.gender.optional(),
  bFormNo: personalFields.bFormNo.nullable().optional(),
  photoUrl: personalFields.photoUrl.nullable().optional(),
  previousSchool: personalFields.previousSchool.nullable().optional(),
  admissionDate: personalFields.admissionDate.optional(),
  address: personalFields.address.optional(),
  religion: personalFields.religion.nullable().optional(),
  nationality: personalFields.nationality.nullable().optional(),
  placeOfBirth: personalFields.placeOfBirth.nullable().optional(),
  admissionClassId: id.optional(),
  guardian: z
    .object({
      fatherName: guardianFields.fatherName,
      fatherCnic: guardianFields.fatherCnic.nullable(),
      guardianName: guardianFields.guardianName.nullable(),
      relation: guardianFields.relation,
      phone: guardianFields.phone,
      emergencyPhone: guardianFields.emergencyPhone.nullable(),
    })
    .partial()
    .optional(),
});

export const changeSectionBody = z.object({
  toSectionId: id,
  date: dateOnlySchema.optional(),
  reason: z.string().trim().min(3).max(200),
  rollNo: rollNo.optional(),
});

export const listStudentsQuery = pageQuery(
  ['admissionNo', 'fullName', 'createdAt', 'current.rollNo'],
  'admissionNo',
).extend({
  q: z.string().trim().max(80).optional(),
  classId: id.optional(),
  sectionId: id.optional(),
  status: z.enum(STUDENT_STATUSES).optional(),
});

export const withdrawBody = z
  .object({
    date: dateOnlySchema.optional(),
    reason: z.enum(WITHDRAWAL_REASONS),
    reasonNote: text(250).optional(),
    duesAction: z.enum(DUES_ACTIONS),
    /** Required when duesAction is WAIVED; written on each waiver. */
    waiveReason: z.string().trim().min(3).max(200).optional(),
  })
  .refine((b) => b.duesAction !== 'WAIVED' || b.waiveReason, {
    message: 'A reason is required to waive dues.',
    path: ['waiveReason'],
  })
  .refine((b) => b.reason !== 'OTHER' || b.reasonNote, {
    message: 'Please describe the reason.',
    path: ['reasonNote'],
  });

export const promoteBody = z
  .object({
    fromSessionId: id,
    toSessionId: id,
    classId: id,
    /** Promote only this section; all sections of the class when omitted. */
    sectionId: id.optional(),
    /** Section of the next class. Required unless the class is the last one (graduation). */
    toSectionId: id.optional(),
    /** Students who stay back in the same class (RETAINED). */
    excludeStudentIds: z.array(id).max(500).default([]),
  })
  .refine((b) => b.fromSessionId !== b.toSessionId, {
    message: 'Choose two different sessions.',
    path: ['toSessionId'],
  });

/** Rows are validated one by one in the service, so each error can name its row. */
export const importStudentsBody = z.array(z.unknown()).min(1).max(2000);

export type AdmitStudentInput = z.infer<typeof admitStudentBody>;
export type UpdateStudentInput = z.infer<typeof updateStudentBody>;
export type ChangeSectionInput = z.infer<typeof changeSectionBody>;
export type ListStudentsQuery = z.infer<typeof listStudentsQuery>;
export type WithdrawInput = z.infer<typeof withdrawBody>;
export type PromoteInput = z.infer<typeof promoteBody>;
