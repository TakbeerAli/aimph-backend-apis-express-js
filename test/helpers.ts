import type { Express } from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import type { AuthUser } from '../src/common/middleware/auth.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { createClass } from '../src/modules/classes/classes.service.js';
import { newId } from '../src/common/utils/ids.js';
import { putFeeStructure } from '../src/modules/fee-structures/fee-structures.service.js';
import { createPaymentBody } from '../src/modules/payments/payments.schemas.js';
import { createPayment, type PaymentMode } from '../src/modules/payments/payments.service.js';
import { createSession } from '../src/modules/sessions/sessions.service.js';
import { admitStudentBody } from '../src/modules/students/students.schemas.js';
import { admitStudent } from '../src/modules/students/students.service.js';
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

export const asAuthUser = (user: UserDoc): AuthUser => ({
  id: user._id,
  username: user.username,
  fullName: user.fullName,
  role: user.role,
  deviceCode: user.deviceCode,
  assignedClassIds: user.assignedClassIds,
});

/**
 * A small school: Admin, current session 2026-27, Class 5 (A, B) → Class 6 (A), with fee
 * structures (Class 5: tuition 2500 / admission 5000 / exam 500; Class 6: 3000 / 5000 / 500).
 * Returns ids that tests use to build requests.
 */
export async function setupSchool() {
  const admin = await createUser({ role: 'ADMIN' });
  const actor = asAuthUser(admin);
  const session = await createSession(actor, { name: '2026-27' });
  const class6 = await createClass(actor, {
    name: 'Class 6',
    shortName: '6',
    sortOrder: 9,
    nextClassId: null,
    sections: ['A'],
  });
  const class5 = await createClass(actor, {
    name: 'Class 5',
    shortName: '5',
    sortOrder: 8,
    nextClassId: class6._id,
    sections: ['A', 'B'],
  });
  await putFeeStructure(actor, session._id, class5._id, {
    tuitionFee: 2500,
    admissionFee: 5000,
    examFee: 500,
  });
  await putFeeStructure(actor, session._id, class6._id, {
    tuitionFee: 3000,
    admissionFee: 5000,
    examFee: 500,
  });
  const sectionId = (cls: typeof class5, name: string) => {
    const found = cls.sections.find((s) => s.name === name);
    if (!found) throw new Error(`No section ${name}`);
    return found._id;
  };
  return {
    admin,
    actor,
    sessionId: session._id,
    class5Id: class5._id,
    class6Id: class6._id,
    s5A: sectionId(class5, 'A'),
    s5B: sectionId(class5, 'B'),
    s6A: sectionId(class6, 'A'),
  };
}

/** A valid admission body (raw JSON, as the app would send it). */
export function studentBody(
  placement: { classId: string; sectionId: string },
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    fullName: 'Ali Raza',
    dateOfBirth: '2015-05-10',
    gender: 'MALE',
    admissionDate: '2026-04-05',
    address: 'House 1, Street 2, Rawalpindi',
    guardian: { fatherName: 'Ahmed Raza', relation: 'FATHER', phone: '0345-1112233' },
    ...placement,
    ...overrides,
  };
}

/**
 * Collects a payment through the service, as `actor` on their own device.
 * `seq` is the device's receipt sequence number.
 */
export async function collect(
  actor: AuthUser,
  seq: number,
  studentId: string,
  allocations: { voucherId: string; amount: number }[],
  overrides: Record<string, unknown> = {},
  mode: PaymentMode = 'ONLINE',
) {
  const amount = allocations.reduce((sum, a) => sum + a.amount, 0);
  const input = createPaymentBody.parse({
    _id: newId(),
    receiptNo: `R-${actor.deviceCode}-${String(seq).padStart(5, '0')}`,
    receiptSeq: seq,
    studentId,
    amount,
    method: 'CASH',
    paidAt: new Date().toISOString(),
    allocations,
    receiptSnapshot: {
      studentName: 'Test Student',
      fatherName: 'Test Father',
      admissionNo: 1001,
      className: '5-A',
      months: [],
      previousBalance: 0,
      currentFee: amount,
      fine: 0,
      amountPaid: amount,
      remainingBalance: 0,
    },
    ...overrides,
  });
  return createPayment(actor, input, mode);
}

/** Admits a student through the service (no HTTP). */
export async function admit(
  actor: AuthUser,
  placement: { classId: string; sectionId: string },
  overrides: Record<string, unknown> = {},
) {
  const input = admitStudentBody.parse(studentBody(placement, overrides));
  return (await admitStudent(actor, input)).student;
}
