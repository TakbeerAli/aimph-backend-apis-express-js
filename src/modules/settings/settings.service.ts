import mongoose, { type ClientSession } from 'mongoose';
import { diffFields, writeAudit } from '../../common/audit.js';
import { AppError } from '../../common/errors.js';
import type { AuthUser } from '../../common/middleware/auth.js';
import { SETTINGS_ID } from '../../db/counters.js';
import { withTransaction } from '../../db/transaction.js';
import { Settings, type SettingsDoc } from './settings.model.js';
import type { UpdateSettingsInput } from './settings.schemas.js';

/**
 * Creates the settings document with defaults if it does not exist yet. Safe to call repeatedly.
 * Written through the raw collection because the sync plugin needs this document to exist.
 */
export async function ensureSettings(): Promise<void> {
  const now = new Date();
  const { _id, ...defaults } = new Settings().toObject({ transform: false });
  await mongoose.connection.collection<{ _id: string }>('settings').updateOne(
    { _id: SETTINGS_ID },
    {
      $setOnInsert: {
        ...defaults,
        counters: { admissionNo: 1000, syncSeq: 1 },
        version: 1,
        syncSeq: 1,
        createdAt: now,
        updatedAt: now,
      },
    },
    { upsert: true },
  );
}

export async function getSettings(session?: ClientSession): Promise<SettingsDoc> {
  const settings = await Settings.findById(SETTINGS_ID).session(session ?? null);
  if (!settings) throw new AppError('NOT_FOUND', 'School settings have not been created.');
  return settings;
}

export async function updateSettings(
  user: AuthUser,
  input: UpdateSettingsInput,
): Promise<SettingsDoc> {
  return withTransaction(async (session) => {
    const settings = await getSettings(session);
    const keys = Object.keys(input);
    const snapshot = () => {
      const all = Object.fromEntries(Object.entries(settings.toObject()));
      return Object.fromEntries(keys.map((k) => [k, all[k] as unknown]));
    };
    const before = snapshot();

    const { bank, ...rest } = input;
    settings.set(rest);
    if (bank) settings.set('bank', { ...settings.toObject().bank, ...bank });

    if (settings.voucherDueDay < settings.voucherIssueDay) {
      throw new AppError('VALIDATION_ERROR', 'Due day must be on or after the issue day.');
    }

    await settings.save({ session });

    await writeAudit(session, {
      action: 'SETTINGS_UPDATE',
      userId: user.id,
      entity: 'settings',
      entityId: SETTINGS_ID,
      ...diffFields(before, snapshot()),
    });
    return settings;
  });
}
