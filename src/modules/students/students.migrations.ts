import { Student } from './students.model.js';

export interface BackfillResult {
  checked: number;
  updated: number;
  alreadySet: number;
  noHistory: number;
}

/**
 * Certificates module: students admitted before admissionClassId existed get it from their
 * first class-history entry (the class they were admitted to). Used by
 * scripts/backfill-admission-class.ts; kept here so it can be tested.
 */
export async function backfillAdmissionClass(
  options: { dryRun?: boolean } = {},
): Promise<BackfillResult> {
  const result: BackfillResult = { checked: 0, updated: 0, alreadySet: 0, noHistory: 0 };
  const cursor = Student.find().sort({ _id: 1 }).cursor();
  for await (const student of cursor) {
    result.checked += 1;
    if (student.admissionClassId) {
      result.alreadySet += 1;
      continue;
    }
    const first = student.classHistory[0];
    if (!first) {
      result.noHistory += 1;
      continue;
    }
    result.updated += 1;
    if (!options.dryRun) {
      student.admissionClassId = first.classId;
      await student.save();
    }
  }
  return result;
}
