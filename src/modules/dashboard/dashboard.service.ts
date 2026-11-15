import type { AuthUser } from '../../common/middleware/auth.js';
import { currentFeeMonth, today, todayString } from '../../common/utils/dates.js';
import { Payment, type PaymentDoc } from '../payments/payments.model.js';
import {
  collectionSummary,
  dayRange,
  monthRange,
  type CollectionSummary,
} from '../reports/collection.js';
import { AcademicSession } from '../sessions/sessions.model.js';
import { Student } from '../students/students.model.js';
import { OPEN_BALANCE, Voucher } from '../vouchers/vouchers.model.js';

export interface Dashboard {
  date: string;
  feeMonth: string;
  todayCollection: CollectionSummary;
  monthCollection: CollectionSummary;
  /** Open balances of the current session. */
  totalPending: number;
  activeStudents: number;
  /** Students with at least one overdue voucher in the current session. */
  defaulters: number;
  recentPayments: PaymentDoc[];
}

/**
 * Admin: school totals. Staff: collections from their own receipts; pending, students and
 * defaulters for their assigned classes.
 */
export async function getDashboard(user: AuthUser): Promise<Dashboard> {
  const isStaff = user.role === 'STAFF';
  const ownReceipts = isStaff ? { receivedBy: user.id } : {};
  const inClasses = isStaff ? { $in: user.assignedClassIds } : null;
  const date = todayString();
  const feeMonth = currentFeeMonth();
  const currentSession = await AcademicSession.findOne({ isCurrent: true }, { _id: 1 }).lean();

  const openInSession = currentSession
    ? { ...OPEN_BALANCE, sessionId: currentSession._id, ...(inClasses && { classId: inClasses }) }
    : null;

  const [
    todayCollection,
    monthCollection,
    pendingRows,
    activeStudents,
    defaulterIds,
    recentPayments,
  ] = await Promise.all([
    collectionSummary({ paidAt: dayRange(date), ...ownReceipts }),
    collectionSummary({ paidAt: monthRange(feeMonth), ...ownReceipts }),
    openInSession
      ? Voucher.aggregate<{ total: number }>([
          { $match: openInSession },
          { $group: { _id: null, total: { $sum: '$balance' } } },
        ])
      : [],
    Student.countDocuments({
      status: 'ACTIVE',
      ...(inClasses && { 'current.classId': inClasses }),
    }),
    openInSession
      ? Voucher.distinct('studentId', { ...openInSession, dueDate: { $lt: today() } })
      : [],
    Payment.find(ownReceipts).sort({ paidAt: -1 }).limit(5),
  ]);

  return {
    date,
    feeMonth,
    todayCollection,
    monthCollection,
    totalPending: pendingRows[0]?.total ?? 0,
    activeStudents,
    defaulters: defaulterIds.length,
    recentPayments,
  };
}
