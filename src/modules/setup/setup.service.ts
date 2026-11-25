import { SchoolClass } from '../classes/classes.model.js';
import { FeeStructure } from '../fee-structures/fee-structures.model.js';
import { AcademicSession } from '../sessions/sessions.model.js';
import { getSettings } from '../settings/settings.service.js';
import { Student } from '../students/students.model.js';
import { User } from '../users/users.model.js';
import { Voucher } from '../vouchers/vouchers.model.js';

export type SetupStepKey =
  'schoolProfile' | 'session' | 'classes' | 'fees' | 'staff' | 'students' | 'openingBalances';

export interface SetupStep {
  key: SetupStepKey;
  done: boolean;
  /** Numbers and names the checklist shows under each step. */
  detail: Record<string, string | number | boolean | null>;
}

export interface SetupStatus {
  steps: SetupStep[];
  doneCount: number;
  total: number;
  complete: boolean;
}

/**
 * The Admin's set-up checklist (design A-01), in the order the steps should be done.
 * Everything is read from the existing data, so the checklist cannot drift out of date.
 */
export async function setupStatus(): Promise<SetupStatus> {
  const [settings, current, classes, staffCount, studentCount, openingCount] = await Promise.all([
    getSettings(),
    AcademicSession.findOne({ isCurrent: true }, { name: 1 }).lean(),
    SchoolClass.find({ isActive: true }, { sections: 1 }).lean(),
    User.countDocuments({ role: 'STAFF', isActive: true }),
    Student.countDocuments(),
    Voucher.countDocuments({ type: 'OPENING_BALANCE', status: { $ne: 'CANCELLED' } }),
  ]);

  const activeSections = classes.reduce(
    (sum, c) => sum + c.sections.filter((s) => s.isActive).length,
    0,
  );
  const classIds = classes.map((c) => c._id);
  const classesWithFees = current
    ? await FeeStructure.countDocuments({ sessionId: current._id, classId: { $in: classIds } })
    : 0;

  const steps: SetupStep[] = [
    {
      key: 'schoolProfile',
      done: settings.address.trim() !== '' && settings.phone.trim() !== '',
      detail: { schoolName: settings.schoolName },
    },
    { key: 'session', done: !!current, detail: { name: current?.name ?? null } },
    {
      key: 'classes',
      done: classes.length > 0 && classes.every((c) => c.sections.some((s) => s.isActive)),
      detail: { classes: classes.length, sections: activeSections },
    },
    {
      key: 'fees',
      done: classes.length > 0 && classesWithFees >= classes.length,
      detail: { withFees: classesWithFees, classes: classes.length },
    },
    { key: 'staff', done: staffCount > 0, detail: { staff: staffCount } },
    { key: 'students', done: studentCount > 0, detail: { students: studentCount } },
    {
      key: 'openingBalances',
      done: openingCount > 0 || settings.openingBalancesSkipped,
      detail: { entered: openingCount, skipped: settings.openingBalancesSkipped },
    },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  return { steps, doneCount, total: steps.length, complete: doneCount === steps.length };
}
