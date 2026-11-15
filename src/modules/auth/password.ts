import bcrypt from 'bcryptjs';
import { isTest } from '../../config/env.js';

// Cost 12 in real use; tests use the minimum so the suite stays fast.
const COST = isTest ? 4 : 12;

export const hashPassword = (password: string): Promise<string> => bcrypt.hash(password, COST);

export const verifyPassword = (password: string, hash: string): Promise<boolean> =>
  bcrypt.compare(password, hash);

let dummyHash: string | undefined;

/**
 * Runs a compare against a throwaway hash, so a login for an unknown username takes as long
 * as one with a wrong password (no username probing by timing).
 */
export async function verifyAgainstDummy(password: string): Promise<false> {
  dummyHash ??= await bcrypt.hash('dummy-password-for-timing', COST);
  await bcrypt.compare(password, dummyHash);
  return false;
}
