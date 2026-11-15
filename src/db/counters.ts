import mongoose, { type ClientSession } from 'mongoose';

export const SETTINGS_ID = 'school';

type CounterPath = 'counters.syncSeq' | 'counters.admissionNo';

interface SettingsCounters {
  _id: string;
  counters: { syncSeq: number; admissionNo: number };
}

/**
 * Atomically adds `by` to a counter on the settings document and returns the new value.
 * Uses the raw collection so the update does not trigger the sync plugin on settings itself.
 *
 * When called with a transaction session, the settings document stays write-locked until the
 * transaction ends. Concurrent transactions then conflict and are retried, so counter values are
 * committed in increasing order (phones never miss a syncSeq that commits late).
 */
export async function incrementCounter(
  path: CounterPath,
  by: number,
  session?: ClientSession | null,
): Promise<number> {
  const result = await mongoose.connection
    .collection<SettingsCounters>('settings')
    .findOneAndUpdate(
      { _id: SETTINGS_ID },
      { $inc: { [path]: by } },
      { returnDocument: 'after', projection: { counters: 1 }, ...(session && { session }) },
    );
  if (!result) {
    throw new Error('Settings document is missing. Call ensureSettings() at startup.');
  }
  return path === 'counters.syncSeq' ? result.counters.syncSeq : result.counters.admissionNo;
}

/** Reserves `count` consecutive syncSeq values and returns the first one. */
export async function allocateSyncSeq(
  count: number,
  session?: ClientSession | null,
): Promise<number> {
  const last = await incrementCounter('counters.syncSeq', count, session);
  return last - count + 1;
}
