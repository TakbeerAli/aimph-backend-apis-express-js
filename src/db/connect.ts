import mongoose from 'mongoose';
import { logger } from '../common/logger.js';

mongoose.set('strictQuery', true);

export async function connectDb(uri: string, dbName?: string): Promise<void> {
  await mongoose.connect(uri, {
    ...(dbName && { dbName }),
    serverSelectionTimeoutMS: 10_000,
  });
  // Wait for collections and indexes (unique keys) before handling requests or transactions.
  await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
  logger.info({ db: mongoose.connection.name }, 'MongoDB connected');
}

export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect();
}

/** True when the connection is open and the server answers a ping. */
export async function isDbUp(): Promise<boolean> {
  const db = mongoose.connection.db;
  if (mongoose.connection.readyState !== mongoose.ConnectionStates.connected || !db) return false;
  try {
    await db.admin().ping();
    return true;
  } catch {
    return false;
  }
}
