import mongoose, { Schema, type ClientSession } from 'mongoose';
import { newId } from './utils/ids.js';

export type AuditAction =
  | 'LOGIN'
  | 'LOGIN_FAILED'
  | 'PASSWORD_CHANGE'
  | 'PASSWORD_RESET'
  | 'USER_CREATE'
  | 'USER_UPDATE'
  | 'USER_SIGN_OUT'
  | 'SETTINGS_UPDATE'
  | 'SESSION_CREATE'
  | 'CLASS_CREATE'
  | 'CLASS_UPDATE'
  | 'SECTION_CREATE'
  | 'SECTION_UPDATE'
  | 'STUDENT_CREATE'
  | 'STUDENTS_IMPORT'
  | 'STUDENT_UPDATE'
  | 'STUDENT_WITHDRAW'
  | 'SECTION_CHANGE'
  | 'CLASS_PROMOTE'
  | 'PAYMENT_CREATE'
  | 'PAYMENT_REVERSE'
  | 'FINE_ADD'
  | 'DUES_WAIVE'
  | 'VOUCHER_CANCEL'
  | 'VOUCHERS_GENERATE'
  | 'OPENING_BALANCES_CREATE'
  | 'FEE_STRUCTURE_UPDATE';

export interface AuditEntry {
  action: AuditAction;
  userId: string | null;
  entity: string;
  entityId?: string | null;
  deviceCode?: string;
  clientAt?: Date;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  reason?: string;
}

const auditSchema = new Schema(
  {
    _id: { type: String, default: newId },
    at: { type: Date, default: () => new Date(), required: true },
    clientAt: { type: Date },
    userId: { type: String, default: null },
    deviceCode: { type: String },
    action: { type: String, required: true },
    entity: { type: String, required: true },
    entityId: { type: String, default: null },
    before: { type: Schema.Types.Mixed },
    after: { type: Schema.Types.Mixed },
    reason: { type: String },
  },
  { collection: 'audit_logs', versionKey: false, minimize: true },
);

auditSchema.index({ entity: 1, entityId: 1, at: -1 });
auditSchema.index({ userId: 1, at: -1 });
auditSchema.index({ action: 1, at: -1 });

// Insert-only: block every update and delete path.
const blocked = () => {
  throw new Error('audit_logs is insert-only.');
};
auditSchema.pre(
  [
    'updateOne',
    'updateMany',
    'findOneAndUpdate',
    'replaceOne',
    'findOneAndReplace',
    'deleteOne',
    'deleteMany',
    'findOneAndDelete',
  ],
  blocked,
);
auditSchema.pre('save', function () {
  if (!this.isNew) blocked();
});

export const AuditLog = mongoose.model('AuditLog', auditSchema);

/** Writes one audit entry, in the caller's transaction when a session is given. */
export async function writeAudit(session: ClientSession | null, entry: AuditEntry): Promise<void> {
  await AuditLog.create([entry], { session });
}

/** Returns `{ before, after }` holding only the keys whose values differ. */
export function diffFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const changedBefore: Record<string, unknown> = {};
  const changedAfter: Record<string, unknown> = {};
  for (const key of Object.keys(after)) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      changedBefore[key] = before[key];
      changedAfter[key] = after[key];
    }
  }
  return { before: changedBefore, after: changedAfter };
}
