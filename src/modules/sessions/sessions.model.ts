import mongoose, { Schema, type HydratedDocument } from 'mongoose';
import { newId } from '../../common/utils/ids.js';
import { syncPlugin, type SyncFields } from '../../db/syncPlugin.js';

export const SESSION_STATUSES = ['ACTIVE', 'CLOSED'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export interface AcademicSessionAttrs extends SyncFields {
  _id: string;
  name: string;
  startDate: Date;
  endDate: Date;
  isCurrent: boolean;
  status: SessionStatus;
}

const sessionSchema = new Schema<AcademicSessionAttrs>(
  {
    _id: { type: String, default: newId },
    name: { type: String, required: true, unique: true, trim: true },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    isCurrent: { type: Boolean, required: true, default: false },
    status: { type: String, enum: SESSION_STATUSES, required: true, default: 'ACTIVE' },
  },
  { collection: 'academic_sessions', timestamps: true, versionKey: false },
);
sessionSchema.plugin(syncPlugin);

// Only one session can be current.
sessionSchema.index(
  { isCurrent: 1 },
  { unique: true, partialFilterExpression: { isCurrent: true } },
);

export const AcademicSession = mongoose.model<AcademicSessionAttrs>(
  'AcademicSession',
  sessionSchema,
);
export type AcademicSessionDoc = HydratedDocument<AcademicSessionAttrs>;
