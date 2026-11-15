import type { ClientSession, Model, Query, Schema, UpdateQuery } from 'mongoose';
import { allocateSyncSeq } from './counters.js';

/** Fields every synced document has (added by syncPlugin and Mongoose timestamps). */
export interface SyncFields {
  createdBy?: string;
  version: number;
  syncSeq: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Adds `createdBy`, `version` and `syncSeq` to a schema and keeps them up to date (Section 9.3).
 *
 * - Every insert or update gets a new `syncSeq` from settings.counters.syncSeq,
 *   using the same session as the write.
 * - `version` starts at 1 and goes up by 1 on every update.
 * - `doc.save()` on an existing document only succeeds if the stored version is unchanged.
 *   Otherwise Mongoose throws DocumentNotFoundError, which the API maps to VERSION_CONFLICT.
 *
 * Only `save`, `insertManySynced()`, `updateOne` and `findOneAndUpdate` are supported. Bulk updates would
 * give many documents the same syncSeq and break pull paging, so they throw.
 */
/**
 * insertMany for synced models: reserves one syncSeq per document in the caller's transaction.
 * (With `ordered: false`, numbers reserved for skipped duplicates are simply never used.)
 */
export async function insertManySynced<T>(
  model: Model<T>,
  docs: object[],
  session: ClientSession,
  options: { ordered?: boolean } = {},
) {
  const first = docs.length > 0 ? await allocateSyncSeq(docs.length, session) : 0;
  const prepared = docs.map((doc, i) => ({ ...doc, version: 1, syncSeq: first + i }));
  return model.insertMany(prepared, { ...options, session });
}

export function syncPlugin(schema: Schema): void {
  schema.add({
    createdBy: { type: String },
    version: { type: Number, default: 1, min: 1 },
    syncSeq: { type: Number, default: 0, index: true },
  });

  schema.pre('save', async function () {
    if (!this.isNew) {
      const current = this.get('version') as number;
      this.$where = { ...this.$where, version: current };
      this.set('version', current + 1);
    }
    this.set('syncSeq', await allocateSyncSeq(1, this.$session()));
  });

  // Mongoose does not pass insertMany options (the session) to this hook, so the hook cannot
  // allocate syncSeq inside the transaction. insertManySynced() does that; this guard makes
  // sure nobody calls insertMany directly.
  schema.pre('insertMany', function (docs: unknown) {
    const list = (Array.isArray(docs) ? docs : [docs]) as Record<string, unknown>[];
    if (list.some((doc) => typeof doc.syncSeq !== 'number' || doc.syncSeq < 1)) {
      throw new Error('Use insertManySynced() to insert many documents into a synced model.');
    }
  });

  schema.pre(['updateOne', 'findOneAndUpdate'], async function (this: Query<unknown, unknown>) {
    const update = this.getUpdate();
    if (Array.isArray(update)) {
      throw new Error('Pipeline updates are not supported on synced models.');
    }
    const session = this.getOptions().session as ClientSession | undefined;
    const next: UpdateQuery<unknown> = { ...update };
    next.$inc = { ...next.$inc, version: 1 };
    next.$set = { ...next.$set, syncSeq: await allocateSyncSeq(1, session) };
    this.setUpdate(next);
  });

  schema.pre(['updateMany', 'replaceOne', 'findOneAndReplace'], function () {
    throw new Error('Bulk or replace updates are not supported on synced models.');
  });
  schema.pre('bulkWrite', function () {
    throw new Error('bulkWrite is not supported on synced models.');
  });
}
