import { z } from 'zod';
import { dateOnlySchema, today } from '../../common/utils/dates.js';
import { pageQuery } from '../../common/utils/pagination.js';
import { GENDERS, RELATIONS, STUDENT_STATUSES } from './students.model.js';

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

/** Rows are validated one by one in the service, so each error can name its row. */
export const importStudentsBody = z.array(z.unknown()).min(1).max(2000);

export type AdmitStudentInput = z.infer<typeof admitStudentBody>;
export type UpdateStudentInput = z.infer<typeof updateStudentBody>;
export type ChangeSectionInput = z.infer<typeof changeSectionBody>;
export type ListStudentsQuery = z.infer<typeof listStudentsQuery>;
