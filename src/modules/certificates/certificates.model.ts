import mongoose, { Schema, type HydratedDocument } from 'mongoose';
import { newId } from '../../common/utils/ids.js';
import { syncPlugin, type SyncFields } from '../../db/syncPlugin.js';

export const CERTIFICATE_TYPES = ['SLC', 'CC', 'BF', 'DOB'] as const;
export const CERTIFICATE_STATUSES = ['ISSUED', 'CANCELLED'] as const;
export const CONDUCTS = ['EXCELLENT', 'VERY_GOOD', 'GOOD', 'SATISFACTORY'] as const;

export type CertificateType = (typeof CERTIFICATE_TYPES)[number];
export type CertificateStatus = (typeof CERTIFICATE_STATUSES)[number];

/** Everything printed, frozen at issue time. Built only by the server. */
export interface CertificateSnapshot {
  school: { name: string; address: string; phone: string; logoUrl: string | null };
  student: {
    fullName: string;
    gender: 'MALE' | 'FEMALE';
    fatherName: string;
    admissionNo: number;
    dateOfBirth: string;
    dateOfBirthWords: string;
    religion: string | null;
    nationality: string | null;
    placeOfBirth: string | null;
    admissionDate: string;
    admissionClassName: string | null;
    currentOrLastClassName: string | null;
    sectionName: string | null;
    sessionName: string | null;
  };
  principal: {
    name: string;
    designation: string;
    signatureUrl: string | null;
    stampUrl: string | null;
    printSignature: boolean;
  };
  text: {
    pronounSubject: 'He' | 'She';
    pronounObject: 'him' | 'her';
    pronounPossessive: 'His' | 'Her';
    relation: 'son' | 'daughter';
  };
  /** The form values are copied in as well (leavingDate, conduct, purpose, ...). */
  [formField: string]: unknown;
}

export interface CertificateAttrs extends SyncFields {
  _id: string;
  certificateNo: string;
  type: CertificateType;
  studentId: string;
  /** Calendar date of issue in Asia/Karachi (stored as UTC midnight, like other dates). */
  issueDate: Date;
  issuedBy: string;
  status: CertificateStatus;
  isDuplicate: boolean;
  duplicateOf: string | null;
  duplicateReason: string | null;
  form: Record<string, unknown>;
  snapshot: CertificateSnapshot;
  cancellation: { by: string; at: Date; reason: string } | null;
  reprints: { by: string; at: Date }[];
  reprintCount: number;
}

const certificateSchema = new Schema<CertificateAttrs>(
  {
    _id: { type: String, default: newId },
    certificateNo: { type: String, required: true, unique: true },
    type: { type: String, enum: CERTIFICATE_TYPES, required: true },
    studentId: { type: String, required: true },
    issueDate: { type: Date, required: true },
    issuedBy: { type: String, required: true },
    status: { type: String, enum: CERTIFICATE_STATUSES, required: true, default: 'ISSUED' },
    isDuplicate: { type: Boolean, default: false },
    duplicateOf: { type: String, default: null },
    duplicateReason: { type: String, default: null, trim: true, maxlength: 250 },
    form: { type: Schema.Types.Mixed, required: true },
    snapshot: { type: Schema.Types.Mixed, required: true },
    cancellation: {
      type: new Schema(
        {
          by: { type: String, required: true },
          at: { type: Date, required: true },
          reason: { type: String, required: true, trim: true, maxlength: 250 },
        },
        { _id: false },
      ),
      default: null,
    },
    reprints: {
      type: [
        new Schema(
          { by: { type: String, required: true }, at: { type: Date, required: true } },
          { _id: false },
        ),
      ],
      default: [],
    },
    reprintCount: { type: Number, default: 0, min: 0 },
  },
  // minimize: false keeps empty objects (e.g. a DOB certificate's empty form).
  { collection: 'certificates', timestamps: true, versionKey: false, minimize: false },
);
certificateSchema.plugin(syncPlugin);

certificateSchema.index({ studentId: 1, type: 1, status: 1 });
certificateSchema.index({ type: 1, issueDate: -1 });
certificateSchema.index({ issueDate: -1 });

export const Certificate = mongoose.model<CertificateAttrs>('Certificate', certificateSchema);
export type CertificateDoc = HydratedDocument<CertificateAttrs>;
