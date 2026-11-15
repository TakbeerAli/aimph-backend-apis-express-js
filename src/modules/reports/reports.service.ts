import type { PipelineStage } from 'mongoose';
import { env } from '../../config/env.js';
import { AppError } from '../../common/errors.js';
import type { AuthUser } from '../../common/middleware/auth.js';
import { addMonths, todayString, today } from '../../common/utils/dates.js';
import { SchoolClass } from '../classes/classes.model.js';
import { Payment, type PaymentMethod } from '../payments/payments.model.js';
import { AcademicSession } from '../sessions/sessions.model.js';
import { User } from '../users/users.model.js';
import { OPEN_BALANCE, Voucher } from '../vouchers/vouchers.model.js';
import {
  COLLECTED_AMOUNT,
  collectionSummary,
  COUNTED_PAYMENT,
  dayRange,
  emptyByMethod,
  monthRange,
  type CollectionSummary,
} from './collection.js';
import type {
  ClassWiseQuery,
  CollectionQuery,
  DefaultersQuery,
  PreviousSessionDuesQuery,
  StatusListQuery,
} from './reports.schemas.js';

/*
 * Every report is an aggregation over vouchers and payments at request time; no totals are
 * stored. Pending amounts are voucher balances, never counting CANCELLED vouchers.
 */

const NOT_CANCELLED = { status: { $ne: 'CANCELLED' } } as const;

/** Joins the student and keeps the fields reports print. */
const withStudent: PipelineStage[] = [
  { $lookup: { from: 'students', localField: '_id', foreignField: '_id', as: 'student' } },
  { $unwind: '$student' },
];

const studentFields = {
  studentId: '$student._id',
  admissionNo: '$student.admissionNo',
  fullName: '$student.fullName',
  fatherName: '$student.guardian.fatherName',
  phone: '$student.guardian.phone',
  studentStatus: '$student.status',
  current: '$student.current',
};

async function sessionIdOrCurrent(sessionId?: string): Promise<string> {
  if (sessionId) {
    if (!(await AcademicSession.exists({ _id: sessionId }))) {
      throw new AppError('NOT_FOUND', 'Session not found.');
    }
    return sessionId;
  }
  const current = await AcademicSession.findOne({ isCurrent: true }, { _id: 1 }).lean();
  if (!current) throw new AppError('VALIDATION_ERROR', 'There is no current session.');
  return current._id;
}

/* ---------- Daily collection (Admin: everyone, Staff: own) ---------- */

export interface DailyCollection extends CollectionSummary {
  date: string;
  byStaff: ({ userId: string; fullName: string; deviceCode: string } & CollectionSummary)[];
  receipts: {
    _id: string;
    receiptNo: string;
    paidAt: Date;
    amount: number;
    collected: number;
    method: PaymentMethod;
    status: string;
    receivedBy: string;
    studentId: string;
    admissionNo: number;
    fullName: string;
  }[];
}

export async function dailyCollection(
  user: AuthUser,
  date = todayString(),
): Promise<DailyCollection> {
  const match = {
    paidAt: dayRange(date),
    ...(user.role === 'STAFF' && { receivedBy: user.id }),
  };

  const [summary, staffRows, receipts] = await Promise.all([
    collectionSummary(match),
    Payment.aggregate<{ _id: { by: string; method: PaymentMethod }; total: number; count: number }>(
      [
        { $match: { ...COUNTED_PAYMENT, ...match } },
        {
          $group: {
            _id: { by: '$receivedBy', method: '$method' },
            total: { $sum: COLLECTED_AMOUNT },
            count: { $sum: 1 },
          },
        },
      ] as PipelineStage[],
    ),
    Payment.aggregate<DailyCollection['receipts'][number]>([
      { $match: { ...COUNTED_PAYMENT, ...match } },
      { $sort: { paidAt: 1 } },
      {
        $lookup: { from: 'students', localField: 'studentId', foreignField: '_id', as: 'student' },
      },
      { $unwind: '$student' },
      {
        $project: {
          receiptNo: 1,
          paidAt: 1,
          amount: 1,
          collected: COLLECTED_AMOUNT,
          method: 1,
          status: 1,
          receivedBy: 1,
          studentId: 1,
          admissionNo: '$student.admissionNo',
          fullName: '$student.fullName',
        },
      },
    ] as PipelineStage[]),
  ]);

  const users = await User.find(
    { _id: { $in: [...new Set(staffRows.map((r) => r._id.by))] } },
    { fullName: 1, deviceCode: 1 },
  ).lean();
  const userById = new Map(users.map((u) => [u._id, u]));
  const byStaff = new Map<string, DailyCollection['byStaff'][number]>();
  for (const row of staffRows) {
    const u = userById.get(row._id.by);
    const entry = byStaff.get(row._id.by) ?? {
      userId: row._id.by,
      fullName: u?.fullName ?? 'Unknown',
      deviceCode: u?.deviceCode ?? '',
      total: 0,
      count: 0,
      byMethod: emptyByMethod(),
    };
    entry.byMethod[row._id.method] = row.total;
    entry.total += row.total;
    entry.count += row.count;
    byStaff.set(row._id.by, entry);
  }

  return { date, ...summary, byStaff: [...byStaff.values()], receipts };
}

/* ---------- Collection by month or year: generated vs collected vs pending ---------- */

export async function collectionReport(query: CollectionQuery) {
  const byYear = query.groupBy === 'year';
  const periods: string[] = [];
  for (let m = query.from; m <= query.to; m = addMonths(m, 1)) {
    const period = byYear ? m.slice(0, 4) : m;
    if (periods.at(-1) !== period) periods.push(period);
  }

  const [voucherRows, paymentRows] = await Promise.all([
    // Generated and pending belong to the voucher's fee month.
    Voucher.aggregate<{ _id: string; generated: number; pending: number }>([
      { $match: { ...NOT_CANCELLED, feeMonth: { $gte: query.from, $lte: query.to } } },
      {
        $group: {
          _id: byYear ? { $substrBytes: ['$feeMonth', 0, 4] } : '$feeMonth',
          generated: { $sum: '$totalAmount' },
          pending: { $sum: '$balance' },
        },
      },
    ]),
    // Collected belongs to the day the money was received.
    Payment.aggregate<{ _id: string; collected: number }>([
      { $match: { ...COUNTED_PAYMENT, paidAt: monthRange(query.from, query.to) } },
      {
        $group: {
          _id: {
            $dateToString: {
              format: byYear ? '%Y' : '%Y-%m',
              date: '$paidAt',
              timezone: env.TZ_BUSINESS,
            },
          },
          collected: { $sum: COLLECTED_AMOUNT },
        },
      },
    ] as PipelineStage[]),
  ]);

  const vouchers = new Map(voucherRows.map((r) => [r._id, r]));
  const payments = new Map(paymentRows.map((r) => [r._id, r.collected]));
  const rows = periods.map((period) => ({
    period,
    generated: vouchers.get(period)?.generated ?? 0,
    collected: payments.get(period) ?? 0,
    pending: vouchers.get(period)?.pending ?? 0,
  }));
  const totals = rows.reduce(
    (t, r) => ({
      generated: t.generated + r.generated,
      collected: t.collected + r.collected,
      pending: t.pending + r.pending,
    }),
    { generated: 0, collected: 0, pending: 0 },
  );
  return { from: query.from, to: query.to, groupBy: query.groupBy, rows, totals };
}

/* ---------- Class-wise ---------- */

const percent = (part: number, whole: number) =>
  whole === 0 ? 0 : Math.round((part / whole) * 1000) / 10;

export async function classWise(query: ClassWiseQuery) {
  const sessionId = await sessionIdOrCurrent(query.sessionId);
  const rows = await Voucher.aggregate<{
    _id: string;
    students: string[];
    generated: number;
    collected: number;
    waived: number;
    pending: number;
  }>([
    {
      $match: { ...NOT_CANCELLED, sessionId, ...(query.feeMonth && { feeMonth: query.feeMonth }) },
    },
    {
      $group: {
        _id: '$classId',
        students: { $addToSet: '$studentId' },
        generated: { $sum: '$totalAmount' },
        collected: { $sum: '$paidAmount' },
        waived: { $sum: '$waivedAmount' },
        pending: { $sum: '$balance' },
      },
    },
  ]);

  const classes = await SchoolClass.find({ _id: { $in: rows.map((r) => r._id) } }).lean();
  const classById = new Map(classes.map((c) => [c._id, c]));
  return {
    sessionId,
    feeMonth: query.feeMonth ?? null,
    classes: rows
      .map((r) => ({
        classId: r._id,
        className: classById.get(r._id)?.name ?? 'Unknown',
        sortOrder: classById.get(r._id)?.sortOrder ?? 0,
        students: r.students.length,
        generated: r.generated,
        collected: r.collected,
        waived: r.waived,
        pending: r.pending,
        percentCollected: percent(r.collected, r.generated),
      }))
      .sort((a, b) => a.sortOrder - b.sortOrder),
  };
}

/* ---------- Defaulters: overdue = dueDate before today and balance > 0 ---------- */

export async function defaulters(query: DefaultersQuery) {
  const sessionId = await sessionIdOrCurrent(query.sessionId);
  const students = await Voucher.aggregate<{
    studentId: string;
    admissionNo: number;
    fullName: string;
    fatherName: string;
    phone: string;
    studentStatus: string;
    current: { classId: string; sectionId: string };
    amount: number;
    months: string[];
    monthsCount: number;
  }>([
    { $match: { ...OPEN_BALANCE, sessionId, dueDate: { $lt: today() } } },
    { $sort: { feeMonth: 1 } },
    {
      $group: {
        _id: '$studentId',
        amount: { $sum: '$balance' },
        months: { $push: '$feeMonth' },
      },
    },
    { $match: { [`months.${query.minMonths - 1}`]: { $exists: true } } },
    ...withStudent,
    {
      $match: {
        ...(query.classId && { 'student.current.classId': query.classId }),
        ...(query.sectionId && { 'student.current.sectionId': query.sectionId }),
      },
    },
    {
      $project: {
        _id: 0,
        ...studentFields,
        amount: 1,
        months: 1,
        monthsCount: { $size: '$months' },
      },
    },
    { $sort: { amount: -1, admissionNo: 1 } },
  ] as PipelineStage[]);

  return {
    sessionId,
    totalAmount: students.reduce((sum, s) => sum + s.amount, 0),
    students,
  };
}

/* ---------- Status list for one fee month ---------- */

export async function statusList(query: StatusListQuery) {
  const vouchers = await Voucher.aggregate([
    {
      $match: {
        type: 'MONTHLY',
        feeMonth: query.feeMonth,
        ...(query.status ? { status: query.status } : NOT_CANCELLED),
        ...(query.classId && { classId: query.classId }),
        ...(query.sectionId && { sectionId: query.sectionId }),
      },
    },
    { $lookup: { from: 'students', localField: 'studentId', foreignField: '_id', as: 'student' } },
    { $unwind: '$student' },
    {
      $project: {
        _id: 0,
        voucherId: '$_id',
        voucherNo: 1,
        classId: 1,
        sectionId: 1,
        totalAmount: 1,
        paidAmount: 1,
        waivedAmount: 1,
        balance: 1,
        status: 1,
        ...studentFields,
        rollNo: '$student.current.rollNo',
      },
    },
    { $sort: { sectionId: 1, rollNo: 1, fullName: 1 } },
  ]);
  return { feeMonth: query.feeMonth, count: vouchers.length, vouchers };
}

/* ---------- Previous-session dues: unpaid vouchers of closed sessions ---------- */

export async function previousSessionDues(query: PreviousSessionDuesQuery) {
  const sessions = query.sessionId
    ? await AcademicSession.find({ _id: query.sessionId }).lean()
    : await AcademicSession.find({ status: 'CLOSED' }).lean();
  if (query.sessionId && sessions.length === 0) {
    throw new AppError('NOT_FOUND', 'Session not found.');
  }

  const students = await Voucher.aggregate<{
    studentId: string;
    admissionNo: number;
    fullName: string;
    amount: number;
    vouchers: { voucherId: string; voucherNo: string; feeMonth: string; balance: number }[];
  }>([
    { $match: { ...OPEN_BALANCE, sessionId: { $in: sessions.map((s) => s._id) } } },
    { $sort: { feeMonth: 1 } },
    {
      $group: {
        _id: '$studentId',
        amount: { $sum: '$balance' },
        vouchers: {
          $push: {
            voucherId: '$_id',
            voucherNo: '$voucherNo',
            sessionId: '$sessionId',
            feeMonth: '$feeMonth',
            balance: '$balance',
          },
        },
      },
    },
    ...withStudent,
    { $project: { _id: 0, ...studentFields, amount: 1, vouchers: 1 } },
    { $sort: { amount: -1, admissionNo: 1 } },
  ] as PipelineStage[]);

  return {
    sessions: sessions.map((s) => ({ _id: s._id, name: s.name })),
    totalAmount: students.reduce((sum, s) => sum + s.amount, 0),
    students,
  };
}
