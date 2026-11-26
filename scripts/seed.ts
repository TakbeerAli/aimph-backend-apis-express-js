/**
 * Fills an empty database with realistic sample data (Section 12).
 *
 *   npm run seed               # empty database only
 *   npm run seed -- --reset    # wipe the database first (refused in production)
 *
 * Passwords: SEED_PASSWORD (used for all three users) or generated and printed once.
 *
 * Everything goes through the real services, so all business rules and audit entries apply.
 * Students are imported (like the go-live import), then vouchers are generated and paid
 * month by month from April to November 2026.
 */
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import mongoose from 'mongoose';
import { env, isProduction } from '../src/config/env.js';
import { writeAudit } from '../src/common/audit.js';
import type { AuthUser } from '../src/common/middleware/auth.js';
import { currentFeeMonth } from '../src/common/utils/dates.js';
import { newId } from '../src/common/utils/ids.js';
import { connectDb, disconnectDb } from '../src/db/connect.js';
import { withTransaction } from '../src/db/transaction.js';
import { hashPassword } from '../src/modules/auth/password.js';
import type { ClassDoc } from '../src/modules/classes/classes.model.js';
import { createClass } from '../src/modules/classes/classes.service.js';
import { putFeeStructure } from '../src/modules/fee-structures/fee-structures.service.js';
import { createPaymentBody } from '../src/modules/payments/payments.schemas.js';
import { createPayment } from '../src/modules/payments/payments.service.js';
import { createSession, setCurrentSession } from '../src/modules/sessions/sessions.service.js';
import { ensureSettings, updateSettings } from '../src/modules/settings/settings.service.js';
import { withdrawStudent } from '../src/modules/students/students.lifecycle.js';
import { Student } from '../src/modules/students/students.model.js';
import { importStudents } from '../src/modules/students/students.service.js';
import { User, type UserDoc } from '../src/modules/users/users.model.js';
import { createTeacher } from '../src/modules/users/users.service.js';
import { generateVouchers } from '../src/modules/vouchers/vouchers.generate.js';
import { Voucher } from '../src/modules/vouchers/vouchers.model.js';

/* eslint-disable no-console -- CLI output */

/* ---------- Deterministic "random" so every seed run is the same ---------- */

let state = 46;
const rand = () => {
  state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
  return state / 2_147_483_648;
};
const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)] as T;

/* ---------- Sample data ---------- */

const BOYS = [
  'Ali',
  'Hamza',
  'Usman',
  'Bilal',
  'Hassan',
  'Hussain',
  'Zain',
  'Ahmed',
  'Saad',
  'Talha',
  'Faizan',
  'Abdullah',
  'Ibrahim',
  'Umar',
  'Daniyal',
  'Haris',
  'Rayyan',
  'Shayan',
  'Arham',
  'Muneeb',
];
const GIRLS = [
  'Ayesha',
  'Fatima',
  'Zainab',
  'Maryam',
  'Hira',
  'Sana',
  'Iqra',
  'Mahnoor',
  'Eman',
  'Hafsa',
  'Areeba',
  'Laiba',
  'Anaya',
  'Aleena',
  'Noor',
  'Khadija',
  'Rida',
  'Amna',
  'Kinza',
  'Minahil',
];
const FATHERS = [
  'Ahmed',
  'Muhammad',
  'Tariq',
  'Imran',
  'Khalid',
  'Asif',
  'Naveed',
  'Shahid',
  'Javed',
  'Rashid',
  'Zafar',
  'Sajid',
  'Waqar',
  'Nadeem',
  'Farooq',
];
const SURNAMES = [
  'Raza',
  'Khan',
  'Malik',
  'Butt',
  'Qureshi',
  'Sheikh',
  'Chaudhry',
  'Mirza',
  'Abbasi',
  'Hashmi',
  'Siddiqui',
  'Awan',
  'Gondal',
  'Jutt',
  'Bhatti',
];
const AREAS = [
  'Satellite Town',
  'Saddar',
  'Westridge',
  'Chaklala',
  'Dhok Hassu',
  'Bahria Town',
  'Gulraiz',
  'Adiala Road',
];

/** Playgroup … Class 10, with tuition / admission / exam fees for 2026-27. */
const CLASSES = [
  { name: 'Playgroup', shortName: 'PG', tuition: 1500, admission: 4000, exam: 300 },
  { name: 'Nursery', shortName: 'NUR', tuition: 1600, admission: 4000, exam: 300 },
  { name: 'Prep', shortName: 'PREP', tuition: 1700, admission: 4000, exam: 300 },
  { name: 'Class 1', shortName: '1', tuition: 1800, admission: 4500, exam: 400 },
  { name: 'Class 2', shortName: '2', tuition: 2000, admission: 4500, exam: 400 },
  { name: 'Class 3', shortName: '3', tuition: 2100, admission: 4500, exam: 400 },
  { name: 'Class 4', shortName: '4', tuition: 2300, admission: 5000, exam: 500 },
  { name: 'Class 5', shortName: '5', tuition: 2500, admission: 5000, exam: 500 },
  { name: 'Class 6', shortName: '6', tuition: 2700, admission: 5500, exam: 500 },
  { name: 'Class 7', shortName: '7', tuition: 2800, admission: 5500, exam: 600 },
  { name: 'Class 8', shortName: '8', tuition: 3000, admission: 6000, exam: 600 },
  { name: 'Class 9', shortName: '9', tuition: 3000, admission: 6000, exam: 700 },
  { name: 'Class 10', shortName: '10', tuition: 3500, admission: 6000, exam: 700 },
] as const;

const SEED_MONTHS = [
  '2026-04',
  '2026-05',
  '2026-06',
  '2026-07',
  '2026-08',
  '2026-09',
  '2026-10',
  '2026-11',
];
/** The exam fee is ticked for November. */
const EXAM_MONTH = '2026-11';

const ALI_ADMISSION_NO = 1046;
/** Ali's months: Apr–Jul paid in full, Aug unpaid, Sep 1,000 of 2,500, Oct 1,500 of 2,500, Nov unpaid. */
const ALI_PAYS: Record<string, number | 'FULL'> = {
  '2026-04': 'FULL',
  '2026-05': 'FULL',
  '2026-06': 'FULL',
  '2026-07': 'FULL',
  '2026-09': 1000,
  '2026-10': 1500,
};
const ALI_EXPECTED_DUES = 8000;

/* ---------- Helpers ---------- */

const asAuthUser = (u: UserDoc): AuthUser => ({
  id: u._id,
  username: u.username,
  fullName: u.fullName,
  role: u.role,
  deviceCode: u.deviceCode,
  assignedSectionIds: u.assignedSectionIds,
});

const phone = () =>
  `03${pick(['00', '01', '12', '21', '33', '45', '55'])}-${String(Math.floor(rand() * 9_000_000) + 1_000_000)}`;

async function resetDatabase(): Promise<void> {
  if (isProduction) throw new Error('--reset is not allowed in production.');
  await mongoose.connection.dropDatabase();
  // Indexes (unique keys) must exist again before any transaction runs.
  for (const name of mongoose.modelNames()) await mongoose.model(name).syncIndexes();
}

async function createAdmin(password: string): Promise<UserDoc> {
  const passwordHash = await hashPassword(password);
  return withTransaction(async (session) => {
    const [admin] = await User.create(
      [
        {
          fullName: 'School Admin',
          username: 'admin',
          passwordHash,
          role: 'ADMIN',
          deviceCode: 'A',
          createdBy: 'system',
        },
      ],
      { session },
    );
    if (!admin) throw new Error('Admin was not created');
    await writeAudit(session, {
      action: 'USER_CREATE',
      userId: null,
      entity: 'user',
      entityId: admin._id,
      after: { username: 'admin', role: 'ADMIN' },
      reason: 'Created by scripts/seed.ts',
    });
    return admin;
  });
}

/** Builds the 60 import rows; Ali Raza is admission no. 1046 in 5-A with roll no. 12. */
function studentRows(classes: ClassDoc[]) {
  const rows: Record<string, unknown>[] = [];
  const nextRoll = new Map<string, number>();
  for (let i = 0; i < 60; i += 1) {
    const admissionNo = 1001 + i;
    const cls = classes[i % classes.length] as ClassDoc;
    const section = cls.sections[Math.floor(rand() * 2)] ?? cls.sections[0];
    if (!section) throw new Error(`${cls.name} has no sections`);
    const order = classes.indexOf(cls) + 1;
    const birthYear = 2026 - (order + 2);

    if (admissionNo === ALI_ADMISSION_NO) {
      const class5 = classes.find((c) => c.name === 'Class 5') as ClassDoc;
      const fiveA = class5.sections.find((s) => s.name === 'A');
      rows.push({
        admissionNo,
        fullName: 'Ali Raza',
        dateOfBirth: '2015-03-14',
        gender: 'MALE',
        admissionDate: '2021-04-05',
        address: 'House 12, Street 4, Satellite Town, Rawalpindi',
        guardian: { fatherName: 'Ahmed Raza', relation: 'FATHER', phone: '0345-1112233' },
        classId: class5._id,
        sectionId: fiveA?._id,
        rollNo: 12,
      });
      continue;
    }

    const isGirl = rand() < 0.45;
    const surname = pick(SURNAMES);
    const key = `${cls._id}:${section._id}`;
    let rollNo = (nextRoll.get(key) ?? 0) + 1;
    if (cls.name === 'Class 5' && section.name === 'A' && rollNo === 12) rollNo = 13; // Ali's roll
    nextRoll.set(key, rollNo);
    rows.push({
      admissionNo,
      fullName: `${isGirl ? pick(GIRLS) : pick(BOYS)} ${surname}`,
      dateOfBirth: `${birthYear}-${String(Math.floor(rand() * 12) + 1).padStart(2, '0')}-${String(Math.floor(rand() * 27) + 1).padStart(2, '0')}`,
      gender: isGirl ? 'FEMALE' : 'MALE',
      admissionDate: `${Math.max(birthYear + 3, 2018)}-04-0${Math.floor(rand() * 8) + 1}`,
      address: `House ${Math.floor(rand() * 300) + 1}, ${pick(AREAS)}, Rawalpindi`,
      guardian: { fatherName: `${pick(FATHERS)} ${surname}`, relation: 'FATHER', phone: phone() },
      classId: cls._id,
      sectionId: section._id,
      rollNo,
    });
  }
  return rows;
}

/* ---------- Main ---------- */

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { reset: { type: 'boolean', default: false } } });
  const password = process.env.SEED_PASSWORD ?? null;
  const passwords = {
    admin: password ?? randomBytes(9).toString('base64url'),
    teacher1: password ?? randomBytes(9).toString('base64url'),
    teacher2: password ?? randomBytes(9).toString('base64url'),
  };
  if (currentFeeMonth() < '2026-11') {
    throw new Error('The seed data runs until November 2026; run it on or after 1 Nov 2026.');
  }

  await connectDb(env.MONGODB_URI);
  try {
    if (values.reset) await resetDatabase();
    if ((await Student.estimatedDocumentCount()) > 0 || (await User.estimatedDocumentCount()) > 0) {
      throw new Error(
        'The database already has data. Run `npm run seed -- --reset` to start over.',
      );
    }
    await ensureSettings();

    // Admin, sessions, classes (created from Class 10 down, so each knows its next class).
    const adminDoc = await createAdmin(passwords.admin);
    const admin = asAuthUser(adminDoc);
    await updateSettings(admin, {
      schoolName: 'AL-MAHDI PUBLIC HIGH SCHOOL & COLLEGE',
      address: 'Main Adiala Road, Rawalpindi (placeholder)',
      phone: '051-0000000',
      bank: {
        bankName: 'Sample Bank Ltd',
        accountTitle: 'Al-Mahdi Public High School',
        accountNo: '0000-0000000-00',
        branch: 'Adiala Road',
      },
      receiptFooter: 'Fee once paid is not refundable. Keep this receipt safe.',
    });
    const old = await createSession(admin, { name: '2025-26' });
    const current = await createSession(admin, { name: '2026-27' });
    await setCurrentSession(admin, current._id);

    const classes: ClassDoc[] = [];
    let next: string | null = null;
    for (let i = CLASSES.length - 1; i >= 0; i -= 1) {
      const c = CLASSES[i];
      if (!c) continue;
      const created = await createClass(admin, {
        name: c.name,
        shortName: c.shortName,
        sortOrder: i + 1,
        nextClassId: next,
        sections: ['A', 'B'],
      });
      await putFeeStructure(admin, current._id, created._id, {
        tuitionFee: c.tuition,
        admissionFee: c.admission,
        examFee: c.exam,
      });
      classes.unshift(created);
      next = created._id;
    }

    // Teachers (phone codes T01, T02): teacher1 has the sections of Playgroup–Class 4,
    // teacher2 those of Class 5–10.
    const sectionsOf = (list: typeof classes) =>
      list.flatMap((c) => c.sections.filter((s) => s.isActive).map((s) => s._id));
    const staff1 = asAuthUser(
      await createTeacher(admin, {
        fullName: 'Teacher One',
        username: 'teacher1',
        password: passwords.teacher1,
        assignedSectionIds: sectionsOf(classes.slice(0, 7)),
      }),
    );
    const staff2 = asAuthUser(
      await createTeacher(admin, {
        fullName: 'Teacher Two',
        username: 'teacher2',
        password: passwords.teacher2,
        assignedSectionIds: sectionsOf(classes.slice(7)),
      }),
    );
    const collectorFor = (sectionId: string) =>
      rand() < 0.1 ? admin : staff1.assignedSectionIds.includes(sectionId) ? staff1 : staff2;

    // Students (go-live import: no admission charge for existing students).
    const imported = await importStudents(admin, studentRows(classes));
    if (imported.errors.length > 0) {
      throw new Error(`Student import failed: ${JSON.stringify(imported.errors)}`);
    }
    const students = await Student.find().sort({ admissionNo: 1 }).lean();
    const ali = students.find((s) => s.admissionNo === ALI_ADMISSION_NO);
    if (!ali) throw new Error('Ali Raza was not created');

    // Month by month: generate vouchers, then collect payments in that month.
    const receiptSeq: Record<string, number> = {};
    let payments = 0;
    const pay = async (
      by: AuthUser,
      studentId: string,
      voucherId: string,
      amount: number,
      feeMonth: string,
      studentName: string,
    ) => {
      const seq = (receiptSeq[by.deviceCode] = (receiptSeq[by.deviceCode] ?? 0) + 1);
      const day = String(Math.floor(rand() * 7) + 3).padStart(2, '0');
      const paidAt = new Date(
        Math.min(Date.parse(`${feeMonth}-${day}T10:30:00+05:00`), Date.now() - 3_600_000),
      );
      const method = rand() < 0.15 ? 'BANK' : 'CASH';
      await createPayment(
        by,
        createPaymentBody.parse({
          _id: newId(),
          receiptNo: `R-${by.deviceCode}-${String(seq).padStart(5, '0')}`,
          receiptSeq: seq,
          studentId,
          amount,
          method,
          ...(method === 'BANK' && { bankDate: paidAt.toISOString().slice(0, 10) }),
          paidAt: paidAt.toISOString(),
          allocations: [{ voucherId, amount }],
          receiptSnapshot: {
            studentName,
            fatherName: '-',
            admissionNo: 1,
            className: '-',
            months: [feeMonth],
            previousBalance: 0,
            currentFee: amount,
            fine: 0,
            amountPaid: amount,
            remainingBalance: 0,
          },
        }),
      );
      payments += 1;
    };

    const withdrawnNo = 1023;
    for (const feeMonth of SEED_MONTHS) {
      if (feeMonth === '2026-11') {
        // One student left in October; their dues are kept and they get no November voucher.
        const leaver = students.find((s) => s.admissionNo === withdrawnNo);
        if (leaver) {
          await withdrawStudent(admin, leaver._id, {
            date: new Date('2026-10-20T00:00:00.000Z'),
            reason: 'SHIFTED_CITY',
            duesAction: 'KEPT_AS_DUES',
          });
        }
      }
      await generateVouchers(admin, {
        feeMonth,
        scope: 'ALL',
        addExamFee: feeMonth === EXAM_MONTH,
      });

      const vouchers = await Voucher.find({ feeMonth, type: 'MONTHLY' }).lean();
      for (const voucher of vouchers) {
        const student = students.find((s) => s._id === voucher.studentId);
        if (!student) continue;
        if (student._id === ali._id) {
          const plan = ALI_PAYS[feeMonth];
          if (plan !== undefined) {
            await pay(
              staff2,
              ali._id,
              voucher._id,
              plan === 'FULL' ? voucher.balance : plan,
              feeMonth,
              'Ali Raza',
            );
          }
          continue;
        }
        // Most families pay in full, some pay half, some fall behind (fewer have paid November yet).
        const roll = rand();
        const paysFull = feeMonth === '2026-11' ? roll < 0.45 : roll < 0.72;
        const paysHalf = !paysFull && roll < (feeMonth === '2026-11' ? 0.55 : 0.85);
        const amount = paysFull ? voucher.balance : paysHalf ? Math.floor(voucher.balance / 2) : 0;
        if (amount > 0) {
          await pay(
            collectorFor(student.current.sectionId),
            student._id,
            voucher._id,
            amount,
            feeMonth,
            student.fullName,
          );
        }
      }
    }

    // Self-check: Ali must owe exactly PKR 8,000.
    const aliOpen = await Voucher.find({
      studentId: ali._id,
      status: { $ne: 'CANCELLED' },
      balance: { $gt: 0 },
    })
      .sort({ feeMonth: 1 })
      .lean();
    const aliDues = aliOpen.reduce((sum, v) => sum + v.balance, 0);
    if (aliDues !== ALI_EXPECTED_DUES) {
      throw new Error(
        `Seed check failed: Ali Raza owes ${aliDues}, expected ${ALI_EXPECTED_DUES}.`,
      );
    }

    console.log('\nSeed complete.');
    console.log(`  Sessions: 2025-26 (closed, id ${old._id}), 2026-27 (current)`);
    console.log(`  Classes: ${classes.length} with sections A and B`);
    console.log(
      `  Students: ${students.length} (Adm ${students[0]?.admissionNo}–${students.at(-1)?.admissionNo}; ${withdrawnNo} withdrawn)`,
    );
    console.log(`  Vouchers: ${await Voucher.countDocuments()}  Payments: ${payments}`);
    console.log(
      `  Ali Raza (Adm ${ALI_ADMISSION_NO}, 5-A, Roll 12) owes PKR ${aliDues.toLocaleString('en-PK')}:`,
    );
    for (const v of aliOpen) console.log(`    ${v.feeMonth}  ${v.voucherNo}  balance ${v.balance}`);
    console.log('\n  Logins (shown once, store them safely):');
    console.log(`    admin  / ${passwords.admin}  (device A)`);
    console.log(`    teacher1 / ${passwords.teacher1}  (device T01, Playgroup–Class 4)`);
    console.log(`    teacher2 / ${passwords.teacher2}  (device T02, Class 5–10)\n`);
  } finally {
    await disconnectDb();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
