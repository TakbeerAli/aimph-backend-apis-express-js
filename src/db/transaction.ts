import mongoose, { type ClientSession } from 'mongoose';

/**
 * Runs `fn` inside one MongoDB transaction and returns its result.
 * Every write inside `fn` must pass `{ session }`.
 *
 * The driver retries `fn` on transient errors (e.g. write conflicts), so `fn` must only
 * touch the database: no HTTP calls, logging of "done", or other side effects.
 * Load the documents you change *inside* `fn` (with the session), so a retry starts from
 * fresh copies instead of instances already changed by the aborted attempt.
 */
export async function withTransaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
  // Mongoose's helper also resets document state ($isNew, modified paths) if a retry happens.
  return mongoose.connection.transaction(fn);
}
