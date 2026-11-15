import mongoose, { Schema, type HydratedDocument, type Types } from 'mongoose';
import { newId } from '../../common/utils/ids.js';
import { syncPlugin, type SyncFields } from '../../db/syncPlugin.js';

export const STUDENT_STATUSES = ['ACTIVE', 'WITHDRAWN', 'GRADUATED'] as const;
export const GENDERS = ['MALE', 'FEMALE'] as const;
export const RELATIONS = ['FATHER', 'MOTHER', 'UNCLE', 'GRANDFATHER', 'BROTHER', 'OTHER'] as const;
export const ENTRY_TYPES = ['NEW_ADMISSION', 'PROMOTED', 'RETAINED'] as const;
export const OUTCOMES = ['IN_PROGRESS', 'PROMOTED', 'RETAINED', 'WITHDRAWN', 'GRADUATED'] as const;
export const WITHDRAWAL_REASONS = [
  'SHIFTED_CITY',
  'ADMISSION_ELSEWHERE',
  'FINANCIAL',
  'OTHER',
] as const;
export const DUES_ACTIONS = ['COLLECTED', 'KEPT_AS_DUES', 'WAIVED'] as const;

export type StudentStatus = (typeof STUDENT_STATUSES)[number];

export interface Guardian {
  fatherName: string;
  fatherCnic?: string;
  guardianName?: string;
  relation: (typeof RELATIONS)[number];
  phone: string;
  emergencyPhone?: string;
}

export interface Placement {
  sessionId: string;
  classId: string;
  sectionId: string;
  rollNo?: number;
}

export interface SectionChange {
  fromSectionId: string;
  toSectionId: string;
  date: Date;
  by: string;
  reason: string;
}

export interface ClassHistoryEntry extends Placement {
  entryType: (typeof ENTRY_TYPES)[number];
  outcome: (typeof OUTCOMES)[number];
  startDate: Date;
  endDate: Date | null;
  sectionChanges: SectionChange[];
}

export interface Withdrawal {
  date: Date;
  reason: (typeof WITHDRAWAL_REASONS)[number];
  reasonNote?: string;
  duesAction: (typeof DUES_ACTIONS)[number];
  duesAtWithdrawal: number;
  processedBy: string;
}

export interface StudentAttrs extends SyncFields {
  _id: string;
  admissionNo: number;
  fullName: string;
  dateOfBirth: Date;
  gender: (typeof GENDERS)[number];
  bFormNo?: string;
  photoUrl?: string;
  previousSchool?: string;
  admissionDate: Date;
  address: string;
  guardian: Guardian;
  status: StudentStatus;
  current: Placement;
  classHistory: Types.DocumentArray<ClassHistoryEntry>;
  withdrawal: Withdrawal | null;
  searchText: string;
}

const int = { validator: Number.isInteger, message: '{PATH} must be a whole number' };

const placementFields = {
  sessionId: { type: String, required: true },
  classId: { type: String, required: true },
  sectionId: { type: String, required: true },
  rollNo: { type: Number, min: 1, validate: int },
} as const;

const sectionChangeSchema = new Schema<SectionChange>(
  {
    fromSectionId: { type: String, required: true },
    toSectionId: { type: String, required: true },
    date: { type: Date, required: true },
    by: { type: String, required: true },
    reason: { type: String, required: true, trim: true, maxlength: 200 },
  },
  { _id: false },
);

const historySchema = new Schema<ClassHistoryEntry>(
  {
    ...placementFields,
    entryType: { type: String, enum: ENTRY_TYPES, required: true },
    outcome: { type: String, enum: OUTCOMES, required: true },
    startDate: { type: Date, required: true },
    endDate: { type: Date, default: null },
    sectionChanges: { type: [sectionChangeSchema], default: [] },
  },
  { _id: false },
);

const guardianSchema = new Schema<Guardian>(
  {
    fatherName: { type: String, required: true, trim: true, maxlength: 80 },
    fatherCnic: { type: String, trim: true },
    guardianName: { type: String, trim: true, maxlength: 80 },
    relation: { type: String, enum: RELATIONS, required: true },
    phone: { type: String, required: true, trim: true },
    emergencyPhone: { type: String, trim: true },
  },
  { _id: false },
);

const withdrawalSchema = new Schema<Withdrawal>(
  {
    date: { type: Date, required: true },
    reason: { type: String, enum: WITHDRAWAL_REASONS, required: true },
    reasonNote: { type: String, trim: true, maxlength: 250 },
    duesAction: { type: String, enum: DUES_ACTIONS, required: true },
    duesAtWithdrawal: { type: Number, required: true, min: 0, validate: int },
    processedBy: { type: String, required: true },
  },
  { _id: false },
);

const studentSchema = new Schema<StudentAttrs>(
  {
    _id: { type: String, default: newId },
    admissionNo: { type: Number, required: true, unique: true, min: 1, validate: int },
    fullName: { type: String, required: true, trim: true, maxlength: 80 },
    dateOfBirth: { type: Date, required: true },
    gender: { type: String, enum: GENDERS, required: true },
    bFormNo: { type: String, trim: true },
    photoUrl: { type: String, trim: true },
    previousSchool: { type: String, trim: true, maxlength: 120 },
    admissionDate: { type: Date, required: true },
    address: { type: String, required: true, trim: true, maxlength: 250 },
    guardian: { type: guardianSchema, required: true },
    status: { type: String, enum: STUDENT_STATUSES, required: true, default: 'ACTIVE' },
    current: { type: new Schema<Placement>(placementFields, { _id: false }), required: true },
    classHistory: { type: [historySchema], required: true },
    withdrawal: { type: withdrawalSchema, default: null },
    searchText: { type: String, required: true },
  },
  { collection: 'students', timestamps: true, versionKey: false },
);
studentSchema.plugin(syncPlugin);

studentSchema.index({ status: 1, 'current.classId': 1, 'current.sectionId': 1 });
studentSchema.index({ 'guardian.phone': 1 });
studentSchema.index({ searchText: 1 });
// A roll number is unique within a section for active students of a session.
studentSchema.index(
  { 'current.sessionId': 1, 'current.sectionId': 1, 'current.rollNo': 1 },
  {
    unique: true,
    partialFilterExpression: { 'current.rollNo': { $type: 'number' }, status: 'ACTIVE' },
  },
);

/** Lowercase text for the search box: name, father's name, admission no. and phone. */
export function buildSearchText(
  student: Pick<StudentAttrs, 'fullName' | 'admissionNo'> & {
    guardian: Pick<Guardian, 'fatherName' | 'phone'>;
  },
): string {
  const phone = student.guardian.phone;
  return [
    student.fullName,
    student.guardian.fatherName,
    String(student.admissionNo),
    phone,
    phone.replace(/\D/g, ''),
  ]
    .join(' ')
    .toLowerCase();
}

// pre('validate') also runs for insertMany (import), unlike pre('save').
studentSchema.pre('validate', function () {
  this.searchText = buildSearchText(this);
});

export const Student = mongoose.model<StudentAttrs>('Student', studentSchema);
export type StudentDoc = HydratedDocument<StudentAttrs>;
