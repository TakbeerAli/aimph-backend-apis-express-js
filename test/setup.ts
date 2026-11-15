import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { afterAll, beforeAll, inject } from 'vitest';
import { connectDb, disconnectDb } from '../src/db/connect.js';

// Each test file gets its own database, so files can run in parallel.
beforeAll(async () => {
  await connectDb(inject('mongoUri'), `test_${randomUUID()}`);
});

afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await disconnectDb();
});
