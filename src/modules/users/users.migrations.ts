import mongoose from 'mongoose';
import { SchoolClass } from '../classes/classes.model.js';
import { Payment } from '../payments/payments.model.js';
import { Student } from '../students/students.model.js';
import { Voucher } from '../vouchers/vouchers.model.js';
import { User } from './users.model.js';

export interface TeacherMigrationResult {
  /** STAFF users renamed to TEACHER. */
  renamed: number;
  /** Users whose assigned classes became sections. */
  convertedSections: number;
  /** Sections not given because another teacher already had them (should be none). */
  skippedSections: { userId: string; sectionId: string }[];
  /** Payments that got sectionIdAtPayment. */
  paymentsUpdated: number;
}

interface RawUser {
  _id: string;
  role: string;
  isActive: boolean;
  assignedClassIds?: string[];
  assignedSectionIds?: string[];
}

/**
 * Attendance module, stage B1: STAFF becomes TEACHER, and each teacher's assigned classes
 * become all the active sections of those classes. Phone codes (S1, S2) are kept, so old
 * receipt numbers stay valid. Payments get the section the student was in.
 *
 * Reads raw documents (the old fields are no longer in the schema). Safe to run again: users
 * without assignedClassIds and payments that already have a section are skipped. Every write
 * goes through the sync plugin, so phones pull the change.
 */
export async function migrateStaffToTeachers(
  options: { dryRun?: boolean } = {},
): Promise<TeacherMigrationResult> {
  const result: TeacherMigrationResult = {
    renamed: 0,
    convertedSections: 0,
    skippedSections: [],
    paymentsUpdated: 0,
  };

  const classes = await SchoolClass.find().lean();
  const sectionsOf = (classIds: string[]) =>
    classes
      .filter((c) => classIds.includes(c._id))
      .flatMap((c) => c.sections.filter((s) => s.isActive).map((s) => s._id));

  const raw = mongoose.connection.collection<RawUser>('users');
  const users = await raw
    .find({ $or: [{ role: 'STAFF' }, { assignedClassIds: { $exists: true } }] })
    .sort({ isActive: -1, _id: 1 })
    .toArray();

  // Sections already owned by active teachers (each section has at most one).
  const taken = new Set(
    (await raw.find({ role: 'TEACHER', isActive: true }).toArray()).flatMap(
      (u) => u.assignedSectionIds ?? [],
    ),
  );

  for (const user of users) {
    const set: Record<string, unknown> = {};
    if (user.role === 'STAFF') {
      set.role = 'TEACHER';
      result.renamed += 1;
    }
    if (user.assignedClassIds) {
      const sections = new Set(user.assignedSectionIds ?? []);
      for (const sectionId of sectionsOf(user.assignedClassIds)) {
        if (user.isActive && taken.has(sectionId) && !sections.has(sectionId)) {
          result.skippedSections.push({ userId: user._id, sectionId });
          continue;
        }
        sections.add(sectionId);
        if (user.isActive) taken.add(sectionId);
      }
      set.assignedSectionIds = [...sections];
      result.convertedSections += 1;
    }
    if (!options.dryRun) {
      await User.updateOne(
        { _id: user._id },
        { $set: set, ...(user.assignedClassIds && { $unset: { assignedClassIds: 1 } }) },
        { strict: false },
      );
    }
  }

  const payments = Payment.find({ sectionIdAtPayment: { $exists: false } })
    .select({ studentId: 1, allocations: 1 })
    .lean()
    .cursor();
  for await (const payment of payments) {
    const voucherId = payment.allocations[0]?.voucherId;
    const voucher = voucherId ? await Voucher.findById(voucherId, { sectionId: 1 }).lean() : null;
    const sectionId =
      voucher?.sectionId ??
      (await Student.findById(payment.studentId, { 'current.sectionId': 1 }).lean())?.current
        .sectionId;
    if (!sectionId) continue;
    result.paymentsUpdated += 1;
    if (!options.dryRun) {
      await Payment.updateOne({ _id: payment._id }, { $set: { sectionIdAtPayment: sectionId } });
    }
  }
  return result;
}
