import mongoose from 'mongoose';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  admit,
  asAuthUser,
  collect,
  createUser,
  resetDatabase,
  setupSchool,
} from '../../../test/helpers.js';
import { newId } from '../../common/utils/ids.js';
import { Payment } from '../payments/payments.model.js';
import { Voucher } from '../vouchers/vouchers.model.js';
import { migrateStaffToTeachers } from './users.migrations.js';
import { User } from './users.model.js';

describe('migration STAFF → TEACHER, classes → sections (#10)', () => {
  let school: Awaited<ReturnType<typeof setupSchool>>;
  const users = () => mongoose.connection.collection<{ _id: string }>('users');

  /** A user as stored before the Attendance module. */
  const legacyStaff = async (over: Record<string, unknown>) => {
    const _id = newId();
    await users().insertOne({
      _id,
      fullName: 'Old Staff',
      username: `old${_id.slice(-6)}`,
      passwordHash: 'x',
      role: 'STAFF',
      deviceCode: 'S1',
      lastReceiptSeq: 3,
      assignedClassIds: [],
      isActive: true,
      version: 1,
      syncSeq: 1,
      ...over,
    } as never);
    return _id;
  };

  beforeEach(async () => {
    await resetDatabase();
    school = await setupSchool();
  });

  it('renames STAFF, turns classes into their active sections, keeps phone codes', async () => {
    const s1 = await legacyStaff({ assignedClassIds: [school.class5Id] });
    const s2 = await legacyStaff({
      deviceCode: 'S2',
      username: 'staff2',
      assignedClassIds: [school.class6Id],
    });

    const dry = await migrateStaffToTeachers({ dryRun: true });
    expect(dry).toMatchObject({ renamed: 2, convertedSections: 2 });
    expect(await users().countDocuments({ role: 'STAFF' })).toBe(2);

    const result = await migrateStaffToTeachers();
    expect(result).toMatchObject({ renamed: 2, convertedSections: 2, skippedSections: [] });

    const one = await users().findOne({ _id: s1 });
    expect(one).toMatchObject({
      role: 'TEACHER',
      deviceCode: 'S1',
      lastReceiptSeq: 3,
      assignedSectionIds: [school.s5A, school.s5B],
    });
    expect(one).not.toHaveProperty('assignedClassIds');
    // Changed through the sync plugin, so phones pull it.
    expect(one).toMatchObject({ version: 2 });
    expect((await User.findById(s2).lean())?.assignedSectionIds).toEqual([school.s6A]);

    // Running it again changes nothing.
    expect(await migrateStaffToTeachers()).toMatchObject({
      renamed: 0,
      convertedSections: 0,
      paymentsUpdated: 0,
    });
  });

  it('never gives a section to two active teachers', async () => {
    await createUser({
      username: 'saima',
      deviceCode: 'T01',
      assignedSectionIds: [school.s5A],
    });
    const old = await legacyStaff({ assignedClassIds: [school.class5Id] });
    const result = await migrateStaffToTeachers();
    expect(result.skippedSections).toEqual([{ userId: old, sectionId: school.s5A }]);
    expect((await User.findById(old).lean())?.assignedSectionIds).toEqual([school.s5B]);
  });

  it('gives old payments the section of the voucher they paid', async () => {
    const teacher = await createUser({ assignedSectionIds: [school.s5B] });
    const student = await admit(school.actor, { classId: school.class5Id, sectionId: school.s5B });
    const voucher = await Voucher.findOne({ studentId: student._id }).orFail();
    const { payment } = await collect(asAuthUser(teacher), 1, student._id, [
      { voucherId: voucher._id, amount: 1000 },
    ]);
    expect(payment.sectionIdAtPayment).toBe(school.s5B);
    await mongoose.connection
      .collection<{ _id: string }>('payments')
      .updateOne({ _id: payment._id }, { $unset: { sectionIdAtPayment: 1 } });

    expect((await migrateStaffToTeachers()).paymentsUpdated).toBe(1);
    expect((await Payment.findById(payment._id).lean())?.sectionIdAtPayment).toBe(school.s5B);
  });
});
