import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    mongoUri: string;
  }
}

/** Starts one in-memory replica set (needed for transactions) for the whole test run. */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  project.provide('mongoUri', replSet.getUri());

  return async () => {
    await replSet.stop();
  };
}
