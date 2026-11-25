import { z } from 'zod';
import { pageQuery } from '../../common/utils/pagination.js';
import { WITHDRAWAL_REASONS } from '../students/students.model.js';
import {
  CERTIFICATE_STATUSES,
  CERTIFICATE_TYPES,
  CONDUCTS,
  type CertificateType,
} from './certificates.model.js';

const id = z.string().min(1).max(64);
const text = (min: number, max: number) => z.string().trim().min(min).max(max);
const optionalText = (max: number) => z.string().trim().max(max).optional();

/** What the Admin fills in, per type. Unknown fields are dropped. */
export const FORM_SCHEMAS = {
  SLC: z.object({
    leavingDate: z.iso.date(),
    leavingReasonCode: z.enum(WITHDRAWAL_REASONS),
    /** The printed reason, e.g. "Shifted to Lahore". */
    leavingReasonText: text(3, 120),
    conduct: z.enum(CONDUCTS),
    classPassed: optionalText(60),
    remarks: optionalText(250),
  }),
  CC: z.object({
    conduct: z.enum(CONDUCTS),
    remarks: optionalText(250),
  }),
  BF: z.object({
    purpose: text(3, 120),
    remarks: optionalText(250),
  }),
  DOB: z.object({
    remarks: optionalText(250),
  }),
} satisfies Record<CertificateType, z.ZodType>;

export const checkCertificateBody = z.object({
  type: z.enum(CERTIFICATE_TYPES),
  studentId: id,
});

export const issueCertificateBody = z
  .object({
    type: z.enum(CERTIFICATE_TYPES),
    studentId: id,
    /** Checked against FORM_SCHEMAS[type] in the service (a duplicate may leave fields out). */
    form: z.record(z.string(), z.unknown()).default({}),
    isDuplicate: z.boolean().default(false),
    duplicateReason: text(5, 250).optional(),
  })
  .refine((b) => !b.isDuplicate || b.duplicateReason, {
    message: 'Give a reason for the duplicate (at least 5 characters).',
    path: ['duplicateReason'],
  })
  .refine((b) => !b.isDuplicate || b.type === 'SLC', {
    message: 'Only a Leaving Certificate can be issued as a duplicate.',
    path: ['isDuplicate'],
  });

export type CheckCertificateInput = z.infer<typeof checkCertificateBody>;
export type IssueCertificateInput = z.infer<typeof issueCertificateBody>;

export const certificateIdParams = z.object({ id });

export const listCertificatesQuery = pageQuery(
  ['issueDate', 'certificateNo', 'createdAt'],
  '-issueDate',
).extend({
  type: z.enum(CERTIFICATE_TYPES).optional(),
  status: z.enum(CERTIFICATE_STATUSES).optional(),
  studentId: id.optional(),
  /** Issue date range, "YYYY-MM-DD" (inclusive). */
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  /** Certificate no., student name or admission no. */
  q: z.string().trim().max(40).optional(),
  /** Only certificates changed after this instant (the Admin phone's catch-up). */
  updatedSince: z.iso.datetime().optional(),
});

export const reprintBody = z
  .object({
    /** When the copy was printed, if it was printed offline and reported later. */
    at: z.iso.datetime().optional(),
  })
  .default({});

export const cancelCertificateBody = z.object({
  reason: text(5, 250),
});

export type ListCertificatesQuery = z.infer<typeof listCertificatesQuery>;
export type ReprintInput = z.infer<typeof reprintBody>;
export type CancelCertificateInput = z.infer<typeof cancelCertificateBody>;
