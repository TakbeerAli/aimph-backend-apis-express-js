import mongoose, { Schema, type HydratedDocument } from 'mongoose';
import { SETTINGS_ID } from '../../db/counters.js';
import { syncPlugin, type SyncFields } from '../../db/syncPlugin.js';

export interface BankDetails {
  bankName: string;
  accountTitle: string;
  accountNo: string;
  branch: string;
}

/** Who signs certificates. Snapshots copy these at issue time, so later changes never alter them. */
export interface CertificateSettings {
  /** Required before the first certificate is issued. */
  principalName: string;
  designation: string;
  signatureUrl: string | null;
  stampUrl: string | null;
  /** false = print a blank line for a hand signature. */
  printSignature: boolean;
  /** Increases on every change, so phones can tell when to refresh cached images. */
  version: number;
}

export interface SettingsAttrs extends SyncFields {
  _id: string;
  schoolName: string;
  address: string;
  phone: string;
  logoUrl: string;
  bank: BankDetails;
  voucherIssueDay: number;
  voucherDueDay: number;
  receiptFooter: string;
  currentSessionId: string | null;
  /** Set-up checklist: the Admin said there are no old dues to enter. */
  openingBalancesSkipped: boolean;
  /** School logo as a data URI (image/png or image/jpeg). Fetched separately: GET /settings/logo. */
  logoData: string | null;
  logoUpdatedAt: Date | null;
  certificate: CertificateSettings;
  /** School calendar: the days off every week (0 = Sunday … 6 = Saturday). */
  calendar: { weeklyOffDays: number[] };
  /**
   * certificates: one sequence per type and calendar year, e.g. { "SLC-2026": 23 }.
   * Only ever increased with an atomic $inc inside the issue transaction.
   */
  counters: { admissionNo: number; syncSeq: number; certificates?: Map<string, number> };
}

const settingsSchema = new Schema<SettingsAttrs>(
  {
    _id: { type: String, default: SETTINGS_ID },
    schoolName: { type: String, default: 'AL-MAHDI PUBLIC HIGH SCHOOL & COLLEGE', trim: true },
    address: { type: String, default: '', trim: true },
    phone: { type: String, default: '', trim: true },
    logoUrl: { type: String, default: '', trim: true },
    bank: {
      bankName: { type: String, default: '', trim: true },
      accountTitle: { type: String, default: '', trim: true },
      accountNo: { type: String, default: '', trim: true },
      branch: { type: String, default: '', trim: true },
    },
    voucherIssueDay: { type: Number, default: 1, min: 1, max: 28 },
    voucherDueDay: { type: Number, default: 10, min: 1, max: 28 },
    receiptFooter: { type: String, default: '', trim: true },
    currentSessionId: { type: String, default: null },
    openingBalancesSkipped: { type: Boolean, default: false },
    // Up to ~500 KB; never loaded unless asked for, so settings stay small for every phone.
    logoData: { type: String, default: null, select: false },
    logoUpdatedAt: { type: Date, default: null },
    certificate: {
      principalName: { type: String, default: '', trim: true, maxlength: 80 },
      designation: { type: String, default: 'Principal', trim: true, maxlength: 60 },
      signatureUrl: { type: String, default: null },
      stampUrl: { type: String, default: null },
      printSignature: { type: Boolean, default: true },
      version: { type: Number, default: 1, min: 1 },
    },
    calendar: {
      weeklyOffDays: {
        type: [{ type: Number, min: 0, max: 6 }],
        default: [0],
      },
    },
    // Changed only through atomic $inc updates, never through save().
    counters: {
      admissionNo: { type: Number, default: 1000 },
      syncSeq: { type: Number, default: 0 },
      certificates: { type: Map, of: Number, default: undefined },
    },
  },
  {
    collection: 'settings',
    timestamps: true,
    versionKey: false,
    toJSON: {
      // Counters are internal and never leave the server.
      transform: (_doc, ret) => {
        const { counters, logoData, ...rest } = ret;
        return rest;
      },
    },
  },
);
settingsSchema.plugin(syncPlugin);

// Never let a save() write stale counter values loaded earlier in the request.
settingsSchema.pre('save', function () {
  if (!this.isNew) this.unmarkModified('counters');
});

export const Settings = mongoose.model<SettingsAttrs>('Settings', settingsSchema);
export type SettingsDoc = HydratedDocument<SettingsAttrs>;
