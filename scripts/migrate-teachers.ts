/**
 * One-off migration for the Attendance module (stage B1): STAFF → TEACHER, assigned classes →
 * sections, and the section on old payments.
 *
 *   npm run migrate:teachers            # apply
 *   npm run migrate:teachers -- --dry-run
 *
 * Safe to run more than once.
 */
import { parseArgs } from 'node:util';
import { env } from '../src/config/env.js';
import { connectDb, disconnectDb } from '../src/db/connect.js';
import { migrateStaffToTeachers } from '../src/modules/users/users.migrations.js';

/* eslint-disable no-console -- CLI output */

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { 'dry-run': { type: 'boolean', default: false } } });
  await connectDb(env.MONGODB_URI);
  try {
    const result = await migrateStaffToTeachers({ dryRun: values['dry-run'] });
    console.log(
      `${values['dry-run'] ? '[dry run] ' : ''}Renamed to TEACHER: ${result.renamed}, ` +
        `classes → sections: ${result.convertedSections}, ` +
        `payments given a section: ${result.paymentsUpdated}`,
    );
    if (result.skippedSections.length > 0) {
      console.log('Sections skipped (already had a teacher):', result.skippedSections);
    }
  } finally {
    await disconnectDb();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
