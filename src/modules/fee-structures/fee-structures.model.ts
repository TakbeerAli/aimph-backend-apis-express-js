import mongoose, { Schema, type HydratedDocument } from 'mongoose';
import { newId } from '../../common/utils/ids.js';
import { moneyValidator } from '../../common/utils/money.js';
import { syncPlugin, type SyncFields } from '../../db/syncPlugin.js';

export interface FeeStructureAttrs extends SyncFields {
  _id: string;
  sessionId: string;
  classId: string;
  /** Monthly. */
  tuitionFee: number;
  /** One-time, charged on the admission voucher. */
  admissionFee: number;
  /** Added to a monthly voucher only when Admin ticks "add exam fee". */
  examFee: number;
}

const money = { type: Number, required: true, validate: moneyValidator };

const feeStructureSchema = new Schema<FeeStructureAttrs>(
  {
    _id: { type: String, default: newId },
    sessionId: { type: String, required: true },
    classId: { type: String, required: true },
    tuitionFee: money,
    admissionFee: money,
    examFee: money,
  },
  { collection: 'fee_structures', timestamps: true, versionKey: false },
);
feeStructureSchema.plugin(syncPlugin);
feeStructureSchema.index({ sessionId: 1, classId: 1 }, { unique: true });

export const FeeStructure = mongoose.model<FeeStructureAttrs>('FeeStructure', feeStructureSchema);
export type FeeStructureDoc = HydratedDocument<FeeStructureAttrs>;
