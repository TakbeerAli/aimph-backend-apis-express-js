import mongoose, { Schema, type HydratedDocument } from 'mongoose';
import { syncPlugin, type SyncFields } from '../../db/syncPlugin.js';
import { ATTENDANCE_STATUSES, type AttendanceStatus } from './attendance.rules.js';

export interface AttendanceEntry {
  studentId: string;
  status: AttendanceStatus;
}

export interface AttendanceCounts {
  present: number;
  absent: number;
  leave: number;
  late: number;
  total: number;
}

/** One correction of a past day by the Admin (or a merge from a second phone). */
export interface AttendanceChange {
  at: Date;
  by: string;
  reason: string;
  /** `from` is null when the student had no entry (e.g. the day was not marked). */
  changes: { studentId: string; from: AttendanceStatus | null; to: AttendanceStatus }[];
}

/** Another user's phone sent a sheet for the same section and day; the Admin decides. */
export interface AttendanceConflict {
  at: Date;
  by: string;
  sheetId: string;
  entries: AttendanceEntry[];
}

export interface AttendanceSheetAttrs extends SyncFields {
  /** UUID made on the phone, so a resend is recognised. */
  _id: string;
  sessionId: string;
  classId: string;
  sectionId: string;
  /** "YYYY-MM-DD" in Asia/Karachi. */
  date: string;
  markedBy: string;
  markedAt: Date;
  entries: AttendanceEntry[];
  counts: AttendanceCounts;
  changeLog: AttendanceChange[];
  conflicts: AttendanceConflict[];
  /** true while a conflict waits for the Admin. */
  needsReview: boolean;
}

const status = { type: String, enum: ATTENDANCE_STATUSES, required: true };
const entrySchema = new Schema<AttendanceEntry>(
  { studentId: { type: String, required: true }, status },
  { _id: false },
);

const sheetSchema = new Schema<AttendanceSheetAttrs>(
  {
    _id: { type: String, required: true },
    sessionId: { type: String, required: true },
    classId: { type: String, required: true },
    sectionId: { type: String, required: true },
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    markedBy: { type: String, required: true },
    markedAt: { type: Date, required: true },
    entries: { type: [entrySchema], default: [] },
    counts: {
      present: { type: Number, default: 0 },
      absent: { type: Number, default: 0 },
      leave: { type: Number, default: 0 },
      late: { type: Number, default: 0 },
      total: { type: Number, default: 0 },
    },
    changeLog: {
      type: [
        {
          _id: false,
          at: { type: Date, required: true },
          by: { type: String, required: true },
          reason: { type: String, required: true, maxlength: 250 },
          changes: [
            {
              _id: false,
              studentId: { type: String, required: true },
              from: { type: String, enum: [...ATTENDANCE_STATUSES, null], default: null },
              to: status,
            },
          ],
        },
      ],
      default: [],
    },
    conflicts: {
      type: [
        {
          _id: false,
          at: { type: Date, required: true },
          by: { type: String, required: true },
          sheetId: { type: String, required: true },
          entries: { type: [entrySchema], default: [] },
        },
      ],
      default: [],
    },
    needsReview: { type: Boolean, default: false },
  },
  { collection: 'attendance_sheets', timestamps: true, versionKey: false },
);
sheetSchema.plugin(syncPlugin);
sheetSchema.index({ sectionId: 1, date: 1 }, { unique: true });
sheetSchema.index({ sessionId: 1, date: 1 });
sheetSchema.index({ classId: 1, date: 1 });
sheetSchema.index({ 'entries.studentId': 1, date: 1 });

export const AttendanceSheet = mongoose.model<AttendanceSheetAttrs>('AttendanceSheet', sheetSchema);
export type AttendanceSheetDoc = HydratedDocument<AttendanceSheetAttrs>;
