import mongoose, { Schema } from 'mongoose';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase } from '../../test/helpers.js';
import { AuditLog, writeAudit } from '../common/audit.js';
import { SETTINGS_ID } from './counters.js';
import { insertManySynced, syncPlugin, type SyncFields } from './syncPlugin.js';
import { withTransaction } from './transaction.js';

interface ItemAttrs extends SyncFields {
  _id: string;
  name: string;
}
const itemSchema = new Schema<ItemAttrs>(
  { _id: String, name: String },
  { timestamps: true, versionKey: false },
);
itemSchema.plugin(syncPlugin);
const Item = mongoose.model<ItemAttrs>('SyncTestItem', itemSchema);

async function counterValue(): Promise<number> {
  const doc = await mongoose.connection
    .collection<{ _id: string; counters: { syncSeq: number } }>('settings')
    .findOne({ _id: SETTINGS_ID });
  return doc?.counters.syncSeq ?? -1;
}

describe('syncPlugin', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('gives new documents version 1 and the next syncSeq', async () => {
    const start = await counterValue();
    const item = await Item.create({ _id: 'a', name: 'A' });

    expect(item.version).toBe(1);
    expect(item.syncSeq).toBe(start + 1);
  });

  it('bumps version and syncSeq on save()', async () => {
    const item = await Item.create({ _id: 'a', name: 'A' });
    item.name = 'B';
    await item.save();

    const stored = await Item.findById('a').lean();
    expect(stored?.version).toBe(2);
    expect(stored?.syncSeq).toBeGreaterThan(1);
    expect(stored?.syncSeq).toBe(item.syncSeq);
  });

  it('rejects a save() from a stale copy (optimistic concurrency)', async () => {
    await Item.create({ _id: 'a', name: 'A' });
    const copy1 = await Item.findById('a').orFail();
    const copy2 = await Item.findById('a').orFail();

    copy1.name = 'first';
    await copy1.save();
    copy2.name = 'second';

    await expect(copy2.save()).rejects.toBeInstanceOf(mongoose.Error.DocumentNotFoundError);
    expect((await Item.findById('a').lean())?.name).toBe('first');
  });

  it('bumps version and syncSeq on updateOne and findOneAndUpdate', async () => {
    const item = await Item.create({ _id: 'a', name: 'A' });
    await Item.updateOne({ _id: 'a' }, { $set: { name: 'B' } });
    const after = await Item.findOneAndUpdate(
      { _id: 'a' },
      { $set: { name: 'C' } },
      { returnDocument: 'after' },
    ).orFail();

    expect(after.version).toBe(3);
    expect(after.syncSeq).toBe(item.syncSeq + 2);
  });

  it('insertManySynced gives each document its own increasing syncSeq, in the transaction', async () => {
    const docs = await withTransaction((session) =>
      insertManySynced(
        Item,
        [
          { _id: 'a', name: 'A' },
          { _id: 'b', name: 'B' },
          { _id: 'c', name: 'C' },
        ],
        session,
      ),
    );
    const seqs = docs.map((d) => d.syncSeq);

    expect(seqs[1]).toBe((seqs[0] ?? 0) + 1);
    expect(seqs[2]).toBe((seqs[0] ?? 0) + 2);
    expect(docs.every((d) => d.version === 1)).toBe(true);
  });

  it('refuses a plain insertMany, which could not take part in the transaction', async () => {
    await expect(Item.insertMany([{ _id: 'a', name: 'A' }])).rejects.toThrow(/insertManySynced/);
    expect(await Item.countDocuments()).toBe(0);
  });

  it('refuses updateMany, which would give many documents the same syncSeq', async () => {
    await expect(Item.updateMany({}, { $set: { name: 'X' } })).rejects.toThrow(/not supported/);
  });

  it('rolls back the counter together with the write when a transaction fails', async () => {
    const start = await counterValue();
    await expect(
      withTransaction(async (session) => {
        await Item.create([{ _id: 'a', name: 'A' }], { session });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(await counterValue()).toBe(start);
    expect(await Item.countDocuments()).toBe(0);
  });
});

describe('audit_logs', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('is insert-only', async () => {
    await writeAudit(null, { action: 'LOGIN', userId: 'u1', entity: 'user', entityId: 'u1' });

    await expect(AuditLog.updateOne({}, { $set: { action: 'X' } })).rejects.toThrow(/insert-only/);
    await expect(AuditLog.deleteMany({})).rejects.toThrow(/insert-only/);
    expect(await AuditLog.countDocuments()).toBe(1);
  });
});
