import mongoose, { Schema } from 'mongoose';
import { beforeEach, describe, expect, it } from 'vitest';
import { clearDatabase } from '../../test/helpers.js';
import { withTransaction } from './transaction.js';

const Thing = mongoose.model('TxTestThing', new Schema({ _id: String, name: String }));

describe('withTransaction', () => {
  beforeEach(async () => {
    await clearDatabase();
    await Thing.createCollection();
  });

  it('commits all writes and returns the callback result', async () => {
    const result = await withTransaction(async (session) => {
      await Thing.create([{ _id: 'a', name: 'A' }], { session });
      await Thing.create([{ _id: 'b', name: 'B' }], { session });
      return 'done';
    });

    expect(result).toBe('done');
    expect(await Thing.countDocuments()).toBe(2);
  });

  it('rolls back every write when the callback throws', async () => {
    await expect(
      withTransaction(async (session) => {
        await Thing.create([{ _id: 'a', name: 'A' }], { session });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(await Thing.countDocuments()).toBe(0);
  });
});
