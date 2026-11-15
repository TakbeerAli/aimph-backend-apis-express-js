import type { Express } from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { hashPassword } from '../src/modules/auth/password.js';
import { ensureSettings } from '../src/modules/settings/settings.service.js';
import { User, type Role, type UserDoc } from '../src/modules/users/users.model.js';

export const PASSWORD = 'Passw0rd-123';

/** Empties every collection in the current test database. */
export async function clearDatabase(): Promise<void> {
  const collections = await mongoose.connection.db?.collections();
  await Promise.all((collections ?? []).map((c) => c.deleteMany({})));
}

/** Empty database plus a fresh settings document. */
export async function resetDatabase(): Promise<void> {
  await clearDatabase();
  await ensureSettings();
}

export async function createUser(
  overrides: Partial<{
    username: string;
    fullName: string;
    role: Role;
    deviceCode: string;
    assignedClassIds: string[];
    isActive: boolean;
    password: string;
  }> = {},
): Promise<UserDoc> {
  const role = overrides.role ?? 'STAFF';
  return User.create({
    fullName: overrides.fullName ?? 'Test User',
    username: overrides.username ?? (role === 'ADMIN' ? 'admin' : 'staff1'),
    passwordHash: await hashPassword(overrides.password ?? PASSWORD),
    role,
    deviceCode: overrides.deviceCode ?? (role === 'ADMIN' ? 'A' : 'S1'),
    assignedClassIds: overrides.assignedClassIds ?? [],
    isActive: overrides.isActive ?? true,
  });
}

export interface Tokens {
  accessToken: string;
  refreshToken: string;
}

export async function login(
  app: Express,
  user: Pick<UserDoc, 'username' | 'deviceCode'>,
  password = PASSWORD,
): Promise<Tokens> {
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ username: user.username, password, deviceCode: user.deviceCode });
  if (res.status !== 200) {
    throw new Error(`Login failed for ${user.username}: ${JSON.stringify(res.body)}`);
  }
  return (res.body as { data: Tokens }).data;
}

export const bearer = (tokens: Tokens): string => `Bearer ${tokens.accessToken}`;
