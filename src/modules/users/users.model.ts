import mongoose, { Schema, type HydratedDocument } from 'mongoose';
import { newId } from '../../common/utils/ids.js';
import { syncPlugin, type SyncFields } from '../../db/syncPlugin.js';

/** STAFF was renamed to TEACHER (scripts/migrate-teachers.ts converts old users). */
export const ROLES = ['ADMIN', 'TEACHER'] as const;
export type Role = (typeof ROLES)[number];

/** Device codes appear in receipt numbers (`R-T01-00087`), so no dashes. */
export const DEVICE_CODE_REGEX = /^[A-Z][A-Z0-9]{0,4}$/;

export interface UserAttrs extends SyncFields {
  _id: string;
  fullName: string;
  username: string;
  passwordHash: string;
  role: Role;
  deviceCode: string;
  lastReceiptSeq: number;
  /** Teacher: the class-sections they collect fees and mark attendance for. */
  assignedSectionIds: string[];
  /**
   * Sync bookkeeping (never sent to phones). sectionsAddedSeq: when a section was last given
   * to this teacher; their phone must pull again from 0 to get its older records.
   * revokedSections: sections taken away, so the phone deletes their local data.
   */
  sectionsAddedSeq: number;
  revokedSections: { sectionId: string; seq: number }[];
  isActive: boolean;
  /** Optional mobile number, for the Admin's reference. */
  phone: string | null;
  /** Set when the Admin creates the user or resets the password; cleared by change-password. */
  mustChangePassword: boolean;
  refreshTokenHash: string | null;
  lastLoginAt: Date | null;
  lastSyncAt: Date | null;
}

const userSchema = new Schema<UserAttrs>(
  {
    _id: { type: String, default: newId },
    fullName: { type: String, required: true, trim: true, maxlength: 80 },
    username: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      minlength: 3,
      maxlength: 30,
      unique: true,
    },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ROLES, required: true },
    deviceCode: { type: String, required: true, unique: true, match: DEVICE_CODE_REGEX },
    lastReceiptSeq: {
      type: Number,
      default: 0,
      min: 0,
      validate: { validator: Number.isInteger, message: 'lastReceiptSeq must be an integer' },
    },
    assignedSectionIds: { type: [String], default: [] },
    sectionsAddedSeq: { type: Number, default: 0 },
    revokedSections: {
      type: [{ _id: false, sectionId: { type: String, required: true }, seq: Number }],
      default: [],
    },
    isActive: { type: Boolean, default: true },
    phone: { type: String, default: null, trim: true, maxlength: 25 },
    mustChangePassword: { type: Boolean, default: false },
    refreshTokenHash: { type: String, default: null, select: false },
    lastLoginAt: { type: Date, default: null },
    lastSyncAt: { type: Date, default: null },
  },
  {
    collection: 'users',
    timestamps: true,
    versionKey: false,
    toJSON: {
      // Hashes and sync bookkeeping never leave the server, even when selected explicitly.
      transform: (_doc, ret) => {
        const { passwordHash, refreshTokenHash, sectionsAddedSeq, revokedSections, ...rest } = ret;
        return rest;
      },
    },
  },
);
userSchema.plugin(syncPlugin);

export const User = mongoose.model<UserAttrs>('User', userSchema);
export type UserDoc = HydratedDocument<UserAttrs>;
