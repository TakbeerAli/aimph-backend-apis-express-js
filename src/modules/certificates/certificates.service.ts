import mongoose, { type ClientSession, type QueryFilter } from 'mongoose';
import { writeAudit } from '../../common/audit.js';
import { AppError } from '../../common/errors.js';
import type { AuthUser } from '../../common/middleware/auth.js';
import { dateToWords } from '../../common/utils/dateWords.js';
import { dateOnly, toYmd, today, todayString } from '../../common/utils/dates.js';
import { formatPkr } from '../../common/utils/money.js';
import {
  pageResult,
  skipFor,
  toMongoSort,
  type PageResult,
} from '../../common/utils/pagination.js';
import { SETTINGS_ID } from '../../db/counters.js';
import { withTransaction } from '../../db/transaction.js';
import { SchoolClass } from '../classes/classes.model.js';
import { AcademicSession } from '../sessions/sessions.model.js';
import type { SettingsDoc } from '../settings/settings.model.js';
import { getSettings } from '../settings/settings.service.js';
import { withdrawInTransaction } from '../students/students.lifecycle.js';
import { Student, type StudentDoc } from '../students/students.model.js';
import { OPEN_BALANCE, Voucher } from '../vouchers/vouchers.model.js';
import {
  Certificate,
  type CertificateAttrs,
  type CertificateDoc,
  type CertificateSnapshot,
  type CertificateType,
} from './certificates.model.js';
import {
  FORM_SCHEMAS,
  type CancelCertificateInput,
  type CheckCertificateInput,
  type IssueCertificateInput,
  type ListCertificatesQuery,
  type ReprintInput,
} from './certificates.schemas.js';

const TYPE_NAMES: Record<CertificateType, string> = {
  SLC: 'Leaving Certificate',
  CC: 'Character Certificate',
  BF: 'Bonafide Certificate',
  DOB: 'Date of Birth Certificate',
};

/* ---------- Snapshot ---------- */

type StudentSnapshot = CertificateSnapshot['student'];

/** The student details printed on a certificate, from the current records. */
async function studentDetails(
  student: StudentDoc,
  session: ClientSession | null,
): Promise<StudentSnapshot> {
  const admissionClassId = student.admissionClassId ?? student.classHistory[0]?.classId;
  const classIds = [
    ...new Set([student.current.classId, admissionClassId].filter((c): c is string => !!c)),
  ];
  const classes = await SchoolClass.find({ _id: { $in: classIds } }).session(session);
  const classById = new Map(classes.map((c) => [c._id, c]));
  const currentClass = classById.get(student.current.classId);
  const academicSession = await AcademicSession.findById(student.current.sessionId).session(
    session,
  );

  return {
    fullName: student.fullName,
    gender: student.gender,
    fatherName: student.guardian.fatherName,
    admissionNo: student.admissionNo,
    dateOfBirth: toYmd(student.dateOfBirth),
    dateOfBirthWords: dateToWords(student.dateOfBirth),
    religion: student.religion || null,
    nationality: student.nationality || null,
    placeOfBirth: student.placeOfBirth || null,
    admissionDate: toYmd(student.admissionDate),
    admissionClassName: (admissionClassId && classById.get(admissionClassId)?.name) || null,
    currentOrLastClassName: currentClass?.name ?? null,
    sectionName:
      currentClass?.sections.find((s) => s._id === student.current.sectionId)?.name ?? null,
    sessionName: academicSession?.name ?? null,
  };
}

function buildSnapshot(
  settings: SettingsDoc,
  student: StudentSnapshot,
  form: Record<string, unknown>,
): CertificateSnapshot {
  const female = student.gender === 'FEMALE';
  const cert = settings.certificate;
  return {
    ...form,
    school: {
      name: settings.schoolName,
      address: settings.address,
      phone: settings.phone,
      logoUrl: settings.logoUrl || null,
    },
    student,
    principal: {
      name: cert.principalName,
      designation: cert.designation,
      signatureUrl: cert.signatureUrl ?? null,
      stampUrl: cert.stampUrl ?? null,
      printSignature: cert.printSignature,
    },
    text: {
      pronounSubject: female ? 'She' : 'He',
      pronounObject: female ? 'her' : 'him',
      pronounPossessive: female ? 'Her' : 'His',
      relation: female ? 'daughter' : 'son',
    },
  };
}

/* ---------- Rules ---------- */

interface OpenVoucher {
  voucherNo: string;
  feeMonth: string;
  balance: number;
}

/** The non-cancelled Leaving Certificates of a student, newest first. */
const activeSlcs = (studentId: string, session: ClientSession | null) =>
  Certificate.find({ studentId, type: 'SLC', status: 'ISSUED' })
    .sort({ issueDate: -1, createdAt: -1 })
    .session(session);

interface RuleContext {
  settings: SettingsDoc;
  student: StudentDoc;
  /** For SLC: the latest non-cancelled SLC, if any. */
  existingSlc: CertificateDoc | null;
  /** For SLC: the original (non-duplicate) SLC a new duplicate points to. */
  originalSlc: CertificateDoc | null;
}

/**
 * All issue rules except the duplicate decision. Throws the AppError the client sees.
 * Order: settings -> student status -> dues -> existing SLC.
 */
async function checkRules(
  type: CertificateType,
  studentId: string,
  session: ClientSession | null,
): Promise<RuleContext> {
  const settings = await getSettings(session ?? undefined);
  if (!settings.certificate.principalName.trim()) {
    throw new AppError(
      'CERT_SETTINGS_MISSING',
      "Add the principal's name in Certificate Settings first.",
    );
  }

  const student = await Student.findById(studentId).session(session);
  if (!student) throw new AppError('NOT_FOUND', 'Student not found.');

  if (type === 'BF' && student.status !== 'ACTIVE') {
    throw new AppError(
      'STUDENT_NOT_ACTIVE',
      `${student.fullName} is ${student.status.toLowerCase()}. A Bonafide Certificate is only for current students.`,
      { status: student.status },
    );
  }

  if (type !== 'SLC') {
    return { settings, student, existingSlc: null, originalSlc: null };
  }

  const open = await Voucher.find(
    { studentId: student._id, ...OPEN_BALANCE },
    { voucherNo: 1, feeMonth: 1, balance: 1 },
  )
    .sort({ feeMonth: 1 })
    .session(session);
  const openBalance = open.reduce((sum, v) => sum + v.balance, 0);
  if (openBalance > 0) {
    const vouchers: OpenVoucher[] = open.map((v) => ({
      voucherNo: v.voucherNo,
      feeMonth: v.feeMonth,
      balance: v.balance,
    }));
    throw new AppError(
      'DUES_NOT_CLEAR',
      `${student.fullName} has ${formatPkr(openBalance)} unpaid. Clear the dues before issuing a Leaving Certificate.`,
      { openBalance, vouchers },
    );
  }

  const slcs = await activeSlcs(student._id, session);
  return {
    settings,
    student,
    existingSlc: slcs[0] ?? null,
    originalSlc: slcs.find((c) => !c.isDuplicate) ?? slcs[0] ?? null,
  };
}

const slcAlreadyIssued = (existing: CertificateDoc) =>
  new AppError(
    'SLC_ALREADY_ISSUED',
    `${existing.certificateNo} was issued on ${toYmd(existing.issueDate)}. A new one will print as DUPLICATE.`,
    {
      existingSlc: {
        id: existing._id,
        certificateNo: existing.certificateNo,
        issueDate: toYmd(existing.issueDate),
      },
    },
  );

/* ---------- Check (no changes) ---------- */

export interface CheckResult {
  allowed: boolean;
  code?: string;
  message?: string;
  openBalance?: number;
  vouchers?: OpenVoucher[];
  existingSlc?: { id: string; certificateNo: string; issueDate: string; form: unknown };
  /** Read-only values the form shows, from the current records. */
  prefill: (StudentSnapshot & { status: string }) | null;
}

export async function checkCertificate(input: CheckCertificateInput): Promise<CheckResult> {
  const student = await Student.findById(input.studentId);
  if (!student) throw new AppError('NOT_FOUND', 'Student not found.');
  const prefill = { ...(await studentDetails(student, null)), status: student.status };

  try {
    const { existingSlc } = await checkRules(input.type, input.studentId, null);
    if (existingSlc) {
      const { message } = slcAlreadyIssued(existingSlc);
      return {
        allowed: false,
        code: 'SLC_ALREADY_ISSUED',
        message,
        existingSlc: {
          id: existingSlc._id,
          certificateNo: existingSlc.certificateNo,
          issueDate: toYmd(existingSlc.issueDate),
          // A duplicate prints the same details unless the Admin changes them.
          form: existingSlc.form,
        },
        prefill,
      };
    }
    return { allowed: true, prefill };
  } catch (error) {
    if (!(error instanceof AppError) || error.code === 'NOT_FOUND') throw error;
    return {
      allowed: false,
      code: error.code,
      message: error.message,
      ...(error.details as { openBalance?: number; vouchers?: OpenVoucher[] }),
      prefill,
    };
  }
}

/* ---------- Issue ---------- */

/**
 * Next number for a type in the current calendar year (Asia/Karachi), e.g. SLC-2026-0007.
 * An atomic $inc on the settings document inside the issue transaction: an aborted issue rolls
 * the counter back, and concurrent issues are serialised by the write lock.
 */
async function nextCertificateNo(type: CertificateType, session: ClientSession): Promise<string> {
  const year = todayString().slice(0, 4);
  const key = `${type}-${year}`;
  const result = await mongoose.connection
    .collection<{ _id: string; counters: { certificates: Record<string, number> } }>('settings')
    .findOneAndUpdate(
      { _id: SETTINGS_ID },
      { $inc: { [`counters.certificates.${key}`]: 1 } },
      { returnDocument: 'after', projection: { counters: 1 }, session },
    );
  const value = result?.counters.certificates[key];
  if (!value) throw new Error('Settings document is missing. Call ensureSettings() at startup.');
  return `${key}-${String(value).padStart(4, '0')}`;
}

/** Checks the Admin's form against the type's rules (and SLC dates against the records). */
function parseForm(
  type: CertificateType,
  form: Record<string, unknown>,
  student: StudentDoc,
): Record<string, unknown> {
  const parsed = FORM_SCHEMAS[type].parse(form) as Record<string, unknown>;
  if (type === 'SLC') {
    const leaving = parsed.leavingDate as string;
    if (leaving > todayString()) {
      throw new AppError('VALIDATION_ERROR', 'The leaving date cannot be in the future.', {
        fieldErrors: { leavingDate: ['Cannot be in the future.'] },
      });
    }
    if (leaving < toYmd(student.admissionDate)) {
      throw new AppError('VALIDATION_ERROR', 'The leaving date is before the admission date.', {
        fieldErrors: { leavingDate: ['Before the admission date.'] },
      });
    }
  }
  return parsed;
}

/**
 * Issues a certificate in ONE transaction:
 * rules -> number -> snapshot -> insert -> (SLC of an ACTIVE student) withdraw -> audit.
 */
export async function issueCertificate(
  user: AuthUser,
  input: IssueCertificateInput,
): Promise<CertificateDoc> {
  return withTransaction(async (session) => {
    const { settings, student, existingSlc, originalSlc } = await checkRules(
      input.type,
      input.studentId,
      session,
    );

    if (existingSlc && !input.isDuplicate) throw slcAlreadyIssued(existingSlc);
    if (input.isDuplicate && !existingSlc) {
      throw new AppError(
        'VALIDATION_ERROR',
        'There is no Leaving Certificate to duplicate. Issue an original instead.',
      );
    }

    // A duplicate prints the details of the latest SLC unless the Admin sends new values.
    const form = parseForm(
      input.type,
      existingSlc && input.isDuplicate ? { ...existingSlc.form, ...input.form } : input.form,
      student,
    );

    const baseNo = await nextCertificateNo(input.type, session);
    const certificateNo = input.isDuplicate ? `${baseNo}-D` : baseNo;
    const snapshot = buildSnapshot(settings, await studentDetails(student, session), form);

    const certificate = new Certificate({
      certificateNo,
      type: input.type,
      studentId: student._id,
      issueDate: today(),
      issuedBy: user.id,
      createdBy: user.id,
      isDuplicate: input.isDuplicate,
      duplicateOf: input.isDuplicate ? (originalSlc?._id ?? null) : null,
      duplicateReason: input.isDuplicate ? (input.duplicateReason ?? null) : null,
      form,
      snapshot,
    });
    await certificate.save({ session });

    if (input.type === 'SLC' && student.status === 'ACTIVE') {
      await withdrawInTransaction(session, user, student, {
        date: dateOnly(form.leavingDate as string),
        reason: form.leavingReasonCode as 'SHIFTED_CITY',
        reasonNote: form.leavingReasonText as string,
        duesAction: 'COLLECTED',
      });
    }

    await writeAudit(session, {
      action: 'CERT_ISSUE',
      userId: user.id,
      entity: 'certificate',
      entityId: certificate._id,
      after: {
        certificateNo,
        type: input.type,
        typeName: TYPE_NAMES[input.type],
        studentId: student._id,
        isDuplicate: input.isDuplicate,
      },
      ...(input.duplicateReason && input.isDuplicate && { reason: input.duplicateReason }),
    });
    return certificate;
  });
}

/* ---------- List, detail, reprint, cancel ---------- */

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export async function listCertificates(
  query: ListCertificatesQuery,
): Promise<PageResult<CertificateDoc>> {
  const filter: QueryFilter<CertificateAttrs> = {};
  if (query.type) filter.type = query.type;
  if (query.status) filter.status = query.status;
  if (query.studentId) filter.studentId = query.studentId;
  if (query.from || query.to) {
    filter.issueDate = {
      ...(query.from && { $gte: dateOnly(query.from) }),
      ...(query.to && { $lte: dateOnly(query.to) }),
    };
  }
  if (query.updatedSince) filter.updatedAt = { $gt: new Date(query.updatedSince) };
  if (query.q) {
    const pattern = new RegExp(escapeRegex(query.q), 'i');
    // Current name/adm. no. (students.searchText) and the name printed on the certificate.
    const students = await Student.find(
      { searchText: { $regex: escapeRegex(query.q.toLowerCase()) } },
      { _id: 1 },
    ).limit(500);
    filter.$or = [
      { certificateNo: pattern },
      { 'snapshot.student.fullName': pattern },
      { studentId: { $in: students.map((s) => s._id) } },
    ];
  }

  const [items, total] = await Promise.all([
    Certificate.find(filter).sort(toMongoSort(query.sort)).skip(skipFor(query)).limit(query.limit),
    Certificate.countDocuments(filter),
  ]);
  return pageResult(items, total, query);
}

export async function getCertificate(id: string): Promise<CertificateDoc> {
  const certificate = await Certificate.findById(id);
  if (!certificate) throw new AppError('NOT_FOUND', 'Certificate not found.');
  return certificate;
}

/** Records a printed copy. The certificate itself never changes: reprints use the snapshot. */
export async function reprintCertificate(
  user: AuthUser,
  id: string,
  input: ReprintInput,
): Promise<CertificateDoc> {
  return withTransaction(async (session) => {
    const certificate = await Certificate.findById(id).session(session);
    if (!certificate) throw new AppError('NOT_FOUND', 'Certificate not found.');
    if (certificate.status !== 'ISSUED') {
      throw new AppError(
        'CONFLICT',
        `${certificate.certificateNo} was cancelled and cannot be printed.`,
      );
    }
    const now = new Date();
    // A copy printed offline is reported later with its own time (never in the future).
    const clientAt = input.at ? new Date(input.at) : undefined;
    const at = clientAt && clientAt < now ? clientAt : now;

    certificate.reprints.push({ by: user.id, at });
    certificate.reprintCount += 1;
    await certificate.save({ session });

    await writeAudit(session, {
      action: 'CERT_REPRINT',
      userId: user.id,
      entity: 'certificate',
      entityId: certificate._id,
      ...(clientAt && { clientAt }),
      after: { certificateNo: certificate.certificateNo, reprintCount: certificate.reprintCount },
    });
    return certificate;
  });
}

/**
 * Cancels an issued certificate. The number is never reused, and cancelling a Leaving
 * Certificate does not re-activate the student.
 */
export async function cancelCertificate(
  user: AuthUser,
  id: string,
  input: CancelCertificateInput,
): Promise<CertificateDoc> {
  return withTransaction(async (session) => {
    const certificate = await Certificate.findById(id).session(session);
    if (!certificate) throw new AppError('NOT_FOUND', 'Certificate not found.');
    if (certificate.status !== 'ISSUED') {
      throw new AppError('CONFLICT', `${certificate.certificateNo} is already cancelled.`);
    }
    certificate.status = 'CANCELLED';
    certificate.cancellation = { by: user.id, at: new Date(), reason: input.reason };
    await certificate.save({ session });

    await writeAudit(session, {
      action: 'CERT_CANCEL',
      userId: user.id,
      entity: 'certificate',
      entityId: certificate._id,
      before: { status: 'ISSUED' },
      after: { status: 'CANCELLED', certificateNo: certificate.certificateNo },
      reason: input.reason,
    });
    return certificate;
  });
}
