import mongoose, { Schema, type HydratedDocument } from 'mongoose';
import { SETTINGS_ID } from '../../db/counters.js';
import { syncPlugin, type SyncFields } from '../../db/syncPlugin.js';

export interface BankDetails {
  bankName: string;
  accountTitle: string;
  accountNo: string;
  branch: string;
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
  counters: { admissionNo: number; syncSeq: number };
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
    // Changed only through incrementCounter() (atomic $inc), never through save().
    counters: {
      admissionNo: { type: Number, default: 1000 },
      syncSeq: { type: Number, default: 0 },
    },
  },
  {
    collection: 'settings',
    timestamps: true,
    versionKey: false,
    toJSON: {
      // Counters are internal and never leave the server.
      transform: (_doc, ret) => {
        const { counters, ...rest } = ret;
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
