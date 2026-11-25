/**
 * One-off migration for the Certificates module: sets students.admissionClassId from the
 * first class-history entry for students that do not have it yet.
 *
 *   npm run migrate:admission-class            # apply
 *   npm run migrate:admission-class -- --dry-run
 *
 * Safe to run more than once: students that already have admissionClassId are skipped.
 * Each student is saved on its own so it gets a new version and syncSeq (bulk updates are
 * not allowed on synced collections).
 */
import { parseArgs } from 'node:util';
import { env } from '../src/config/env.js';
import { connectDb, disconnectDb } from '../src/db/connect.js';
import { backfillAdmissionClass } from '../src/modules/students/students.migrations.js';

/* eslint-disable no-console -- CLI output */

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { 'dry-run': { type: 'boolean', default: false } } });
  await connectDb(env.MONGODB_URI);
  try {
    const result = await backfillAdmissionClass({ dryRun: values['dry-run'] });
    console.log(
      `${values['dry-run'] ? '[dry run] ' : ''}Students checked: ${result.checked}, ` +
        `updated: ${result.updated}, already set: ${result.alreadySet}, ` +
        `without class history: ${result.noHistory}`,
    );
  } finally {
    await disconnectDb();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
