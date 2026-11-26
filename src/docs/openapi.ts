import {
  calendarMonthQuery,
  createEventBody,
  deleteEventQuery,
  updateEventBody,
  weeklyOffBody,
} from '../modules/calendar/calendar.schemas.js';
import {
  monthQuery,
  notMarkedQuery,
  registerQuery,
  saveSheetBody,
  sheetQuery,
  statusQuery,
} from '../modules/attendance/attendance.schemas.js';
import { z } from 'zod';
import { changePasswordBody, loginBody, refreshBody } from '../modules/auth/auth.schemas.js';
import {
  addSectionBody,
  createClassBody,
  updateClassBody,
  updateSectionBody,
} from '../modules/classes/classes.schemas.js';
import {
  copyFeeStructuresBody,
  listFeeStructuresQuery,
  putFeeStructureBody,
} from '../modules/fee-structures/fee-structures.schemas.js';
import {
  createPaymentBody,
  listPaymentsQuery,
  resolveBody,
  reverseBody,
} from '../modules/payments/payments.schemas.js';
import {
  classWiseQuery,
  collectionQuery,
  dailyCollectionQuery,
  defaultersQuery,
  previousSessionDuesQuery,
  statusListQuery,
} from '../modules/reports/reports.schemas.js';
import { createSessionBody } from '../modules/sessions/sessions.schemas.js';
import {
  cancelCertificateBody,
  checkCertificateBody,
  issueCertificateBody,
  listCertificatesQuery,
  reprintBody,
} from '../modules/certificates/certificates.schemas.js';
import { updateCertificateSettingsBody } from '../modules/settings/certificate-settings.js';
import { putLogoBody, updateSettingsBody } from '../modules/settings/settings.schemas.js';
import {
  admitStudentBody,
  changeSectionBody,
  listStudentsQuery,
  promoteBody,
  updateStudentBody,
  withdrawBody,
} from '../modules/students/students.schemas.js';
import { pullQuery, pushBody } from '../modules/sync/sync.schemas.js';
import {
  createTeacherBody,
  listUsersQuery,
  resetPasswordBody,
  updateTeacherBody,
} from '../modules/users/users.schemas.js';
import {
  cancelBody,
  fineBody,
  generateVouchersBody,
  listVouchersQuery,
  openingBalanceRow,
  waiveBody,
} from '../modules/vouchers/vouchers.schemas.js';

/*
 * The OpenAPI document is built from the same Zod schemas the routes validate with,
 * so the docs cannot drift from the real rules. Served at /docs.
 */

type Access = 'public' | 'any' | 'admin';

interface Route {
  method: 'get' | 'post' | 'patch' | 'put' | 'delete';
  path: string;
  tag: string;
  summary: string;
  access: Access;
  body?: z.ZodType;
  query?: z.ZodType;
  /** multipart/form-data with one image in the field "file". */
  upload?: boolean;
}

const r = (
  method: Route['method'],
  path: string,
  tag: string,
  summary: string,
  access: Access,
  extra: Pick<Route, 'body' | 'query' | 'upload'> = {},
): Route => ({ method, path, tag, summary, access, ...extra });

const routes: Route[] = [
  r('get', '/health', 'Health', 'Server and database status', 'public'),

  r('post', '/auth/login', 'Auth', 'Log in on your own device (rate-limited)', 'public', {
    body: loginBody,
  }),
  r('post', '/auth/refresh', 'Auth', 'Swap a refresh token for a new pair', 'public', {
    body: refreshBody,
  }),
  r('post', '/auth/logout', 'Auth', 'Log out (clears the refresh token)', 'any'),
  r('get', '/auth/me', 'Auth', 'Current user', 'any'),
  r('post', '/auth/change-password', 'Auth', 'Change own password', 'any', {
    body: changePasswordBody,
  }),

  r('get', '/users', 'Users', 'List users', 'admin', { query: listUsersQuery }),
  r('get', '/teachers', 'Teachers', 'Teachers, plus sections without a teacher', 'admin'),
  r('post', '/teachers', 'Teachers', 'Create a teacher (phone code T01, T02 … is given)', 'admin', {
    body: createTeacherBody,
  }),
  r('patch', '/teachers/{id}', 'Teachers', 'Update name, active flag, sections', 'admin', {
    body: updateTeacherBody,
  }),
  r(
    'post',
    '/teachers/{id}/reset-password',
    'Teachers',
    'Set a new password (logs the teacher out)',
    'admin',
    { body: resetPasswordBody },
  ),
  r('post', '/teachers/{id}/sign-out', 'Teachers', 'Sign the teacher out of their phone', 'admin'),
  r(
    'post',
    '/users/{id}/reset-password',
    'Users',
    'Set a new password (logs the user out)',
    'admin',
    { body: resetPasswordBody },
  ),
  r('post', '/users/{id}/sign-out', 'Users', 'Revoke the refresh token (lost phone)', 'admin'),

  r('get', '/settings', 'Settings', 'School settings', 'any'),
  r('patch', '/settings', 'Settings', 'Update settings (not counters)', 'admin', {
    body: updateSettingsBody,
  }),
  r('get', '/settings/logo', 'Settings', 'School logo as a data URI (null if none)', 'any'),
  r('put', '/settings/logo', 'Settings', 'Upload the school logo (PNG/JPEG data URI)', 'admin', {
    body: putLogoBody,
  }),
  r('delete', '/settings/logo', 'Settings', 'Remove the school logo', 'admin'),
  r(
    'get',
    '/settings/certificate',
    'Certificates',
    'Certificate signer, signature, stamp',
    'admin',
  ),
  r(
    'patch',
    '/settings/certificate',
    'Certificates',
    'Update principal name/designation',
    'admin',
    {
      body: updateCertificateSettingsBody,
    },
  ),
  r(
    'post',
    '/settings/certificate/signature',
    'Certificates',
    "Upload the principal's signature (PNG/JPG, max 2 MB; cleaned to a transparent PNG)",
    'admin',
    { upload: true },
  ),
  r(
    'post',
    '/settings/certificate/stamp',
    'Certificates',
    'Upload the school stamp (PNG/JPG, max 2 MB; cleaned to a transparent PNG)',
    'admin',
    { upload: true },
  ),
  r(
    'delete',
    '/settings/certificate/stamp',
    'Certificates',
    'Stop printing the stamp (the file is kept for old certificates)',
    'admin',
  ),
  r(
    'post',
    '/certificates/check',
    'Certificates',
    'Check the issue rules for a student without issuing (with the form prefill)',
    'admin',
    { body: checkCertificateBody },
  ),
  r(
    'post',
    '/certificates',
    'Certificates',
    'Issue a certificate (SLC also withdraws an active student, in one transaction)',
    'admin',
    { body: issueCertificateBody },
  ),
  r('get', '/certificates', 'Certificates', 'List certificates (newest first)', 'admin', {
    query: listCertificatesQuery,
  }),
  r('get', '/certificates/{id}', 'Certificates', 'One certificate with its snapshot', 'admin'),
  r(
    'post',
    '/certificates/{id}/reprint',
    'Certificates',
    'Record a reprint (the certificate itself never changes)',
    'admin',
    { body: reprintBody },
  ),
  r(
    'post',
    '/certificates/{id}/cancel',
    'Certificates',
    'Cancel with a reason (the number is never reused; an SLC does not re-activate the student)',
    'admin',
    { body: cancelCertificateBody },
  ),
  r('get', '/setup/status', 'Settings', 'Admin set-up checklist (7 steps)', 'admin'),

  r('get', '/sessions', 'Sessions', 'List sessions with student count and unpaid dues', 'any'),
  r('post', '/sessions', 'Sessions', 'Create a session (the first becomes current)', 'admin', {
    body: createSessionBody,
  }),
  r(
    'post',
    '/sessions/{id}/set-current',
    'Sessions',
    'Make a later session current; closes the old one',
    'admin',
  ),

  r(
    'get',
    '/calendar',
    'Calendar',
    'A month: each day WORKING / WEEKEND / HOLIDAY, working-day count',
    'any',
    {
      query: calendarMonthQuery,
    },
  ),
  r(
    'post',
    '/calendar/events',
    'Calendar',
    'Add a holiday or make-up working day (current session)',
    'admin',
    {
      body: createEventBody,
    },
  ),
  r(
    'patch',
    '/calendar/events/{id}',
    'Calendar',
    'Rename or move a holiday / working day',
    'admin',
    {
      body: updateEventBody,
    },
  ),
  r(
    'delete',
    '/calendar/events/{id}',
    'Calendar',
    'Delete (ATTENDANCE_EXISTS warning unless confirm=true)',
    'admin',
    {
      query: deleteEventQuery,
    },
  ),
  r(
    'get',
    '/attendance/sheet',
    'Attendance',
    'A section-day sheet, or a draft with everyone PRESENT; canEdit',
    'any',
    {
      query: sheetQuery,
    },
  ),
  r(
    'put',
    '/attendance/sheet',
    'Attendance',
    'Save a sheet (teacher: own sections, today; Admin past days need a reason)',
    'any',
    {
      body: saveSheetBody,
    },
  ),
  r(
    'get',
    '/attendance/sections-status',
    'Attendance',
    'Dashboard for a day: present %, absent, marked x/y, sections',
    'any',
    { query: statusQuery },
  ),
  r(
    'get',
    '/attendance/not-marked',
    'Attendance',
    'Working days with no sheet (default: last 30 days)',
    'any',
    { query: notMarkedQuery },
  ),
  r(
    'get',
    '/attendance/student/{id}',
    'Attendance',
    "A student's month: %, counts and each day",
    'any',
    { query: monthQuery },
  ),
  r(
    'get',
    '/attendance/register',
    'Attendance',
    'Monthly register grid of a section with totals',
    'any',
    { query: registerQuery },
  ),
  r('get', '/settings/calendar', 'Calendar', 'Weekly off days', 'any'),
  r('patch', '/settings/calendar', 'Calendar', 'Set the weekly off days', 'admin', {
    body: weeklyOffBody,
  }),

  r('get', '/classes', 'Classes', 'Classes with sections and active student counts', 'any'),
  r('post', '/classes', 'Classes', 'Create a class', 'admin', { body: createClassBody }),
  r('patch', '/classes/{id}', 'Classes', 'Update a class', 'admin', { body: updateClassBody }),
  r('post', '/classes/{id}/sections', 'Classes', 'Add a section', 'admin', {
    body: addSectionBody,
  }),
  r(
    'patch',
    '/classes/{id}/sections/{sectionId}',
    'Classes',
    'Rename or deactivate a section',
    'admin',
    { body: updateSectionBody },
  ),
  r(
    'delete',
    '/classes/{id}/sections/{sectionId}',
    'Classes',
    'Delete a section (one with old records is hidden instead; not one with active students)',
    'admin',
  ),

  r('get', '/students', 'Students', 'Search students (with current-session dues)', 'any', {
    query: listStudentsQuery,
  }),
  r('post', '/students', 'Students', 'Admit a student (charges the admission voucher)', 'admin', {
    body: admitStudentBody,
  }),
  r(
    'post',
    '/students/import',
    'Students',
    'Import students (all-or-nothing, errors per row)',
    'admin',
    { body: z.array(admitStudentBody).max(2000) },
  ),
  r('post', '/students/promote', 'Students', 'Promote a class into a later session', 'admin', {
    body: promoteBody,
  }),
  r('get', '/students/{id}', 'Students', 'Student profile', 'any'),
  r(
    'get',
    '/students/{id}/fee-history',
    'Students',
    'All vouchers and payments, newest first',
    'any',
  ),
  r('patch', '/students/{id}', 'Students', 'Edit personal/guardian info (needs version)', 'admin', {
    body: updateStudentBody,
  }),
  r(
    'post',
    '/students/{id}/change-section',
    'Students',
    'Move to another section of the same class',
    'admin',
    { body: changeSectionBody },
  ),
  r(
    'post',
    '/students/{id}/withdraw',
    'Students',
    'Withdraw (collected, kept as dues, or waived)',
    'admin',
    { body: withdrawBody },
  ),

  r(
    'get',
    '/fee-structures',
    'Fee structures',
    'Fee structures of a session (current by default)',
    'any',
    { query: listFeeStructuresQuery },
  ),
  r(
    'put',
    '/fee-structures/{sessionId}/{classId}',
    'Fee structures',
    'Create or update a class fee structure',
    'admin',
    { body: putFeeStructureBody },
  ),
  r(
    'post',
    '/fee-structures/copy',
    'Fee structures',
    'Copy structures to another session',
    'admin',
    { body: copyFeeStructuresBody },
  ),

  r(
    'post',
    '/vouchers/generate/preview',
    'Vouchers',
    'Preview monthly generation (writes nothing)',
    'admin',
    { body: generateVouchersBody },
  ),
  r(
    'post',
    '/vouchers/generate',
    'Vouchers',
    'Generate monthly vouchers (safe to repeat)',
    'admin',
    { body: generateVouchersBody },
  ),
  r(
    'post',
    '/vouchers/opening-balances',
    'Vouchers',
    'Go-live opening balances (all-or-nothing)',
    'admin',
    { body: z.array(openingBalanceRow).max(2000) },
  ),
  r('get', '/vouchers', 'Vouchers', 'List vouchers (overdue=true is computed)', 'any', {
    query: listVouchersQuery,
  }),
  r('get', '/vouchers/by-no/{voucherNo}', 'Vouchers', 'Find a voucher by number', 'any'),
  r('get', '/vouchers/{id}', 'Vouchers', 'Voucher with its payments', 'any'),
  r('post', '/vouchers/{id}/fine', 'Vouchers', 'Add a fine line', 'admin', { body: fineBody }),
  r('post', '/vouchers/{id}/waive', 'Vouchers', 'Waive part or all of the balance', 'admin', {
    body: waiveBody,
  }),
  r('post', '/vouchers/{id}/cancel', 'Vouchers', 'Cancel (only with no payments)', 'admin', {
    body: cancelBody,
  }),

  r('post', '/payments', 'Payments', 'Collect a payment (idempotent by _id)', 'any', {
    body: createPaymentBody,
  }),
  r('get', '/payments', 'Payments', 'List payments (teacher: own only)', 'any', {
    query: listPaymentsQuery,
  }),
  r('get', '/payments/needs-review', 'Payments', 'Payments waiting for review', 'admin'),
  r(
    'get',
    '/payments/by-receipt/{receiptNo}',
    'Payments',
    'Find by receipt number (teacher: own only)',
    'any',
  ),
  r('get', '/payments/{id}', 'Payments', 'One payment (teacher: own only)', 'any'),
  r('post', '/payments/{id}/reverse', 'Payments', 'Reverse a payment', 'admin', {
    body: reverseBody,
  }),
  r('post', '/payments/{id}/resolve', 'Payments', 'Resolve a NEEDS_REVIEW payment', 'admin', {
    body: resolveBody,
  }),

  r('get', '/dashboard', 'Reports', 'Dashboard (teacher: own totals)', 'any'),
  r('get', '/reports/daily-collection', 'Reports', 'Collection for one day (teacher: own)', 'any', {
    query: dailyCollectionQuery,
  }),
  r(
    'get',
    '/reports/collection',
    'Reports',
    'Generated vs collected vs pending by month/year',
    'admin',
    { query: collectionQuery },
  ),
  r('get', '/reports/class-wise', 'Reports', 'Per-class totals and % collected', 'admin', {
    query: classWiseQuery,
  }),
  r('get', '/reports/defaulters', 'Reports', 'Students with overdue balances', 'admin', {
    query: defaultersQuery,
  }),
  r('get', '/reports/status-list', 'Reports', 'Paid/partial/unpaid list for a month', 'admin', {
    query: statusListQuery,
  }),
  r(
    'get',
    '/reports/previous-session-dues',
    'Reports',
    'Unpaid vouchers of closed sessions',
    'admin',
    { query: previousSessionDuesQuery },
  ),

  r('post', '/sync/push', 'Sync', 'Apply queued offline operations', 'any', { body: pushBody }),
  r('get', '/sync/pull', 'Sync', 'Changes since a syncSeq, paged', 'any', { query: pullQuery }),
];

type JsonSchema = Record<string, unknown> & {
  properties?: Record<string, Record<string, unknown>>;
  required?: string[];
};

/** Request-side JSON Schema (what the client sends, before transforms). */
function jsonSchema(schema: z.ZodType): JsonSchema {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, {
    io: 'input',
    unrepresentable: 'any',
  }) as JsonSchema;
  return rest;
}

function queryParameters(schema: z.ZodType) {
  const { properties = {}, required = [] } = jsonSchema(schema);
  return Object.entries(properties).map(([name, prop]) => ({
    name,
    in: 'query',
    required: required.includes(name),
    schema: prop,
  }));
}

const pathParameters = (path: string) =>
  [...path.matchAll(/\{(\w+)\}/g)].map(([, name]) => ({
    name,
    in: 'path',
    required: true,
    schema: { type: 'string' },
  }));

const errorResponse = {
  description: 'Error (standard shape)',
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
};

const ACCESS_NOTE: Record<Access, string> = {
  public: 'No login needed.',
  any: 'Admin or Teacher (teacher limits are applied by the server).',
  admin: 'Admin only.',
};

export function buildOpenApiDocument(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of routes) {
    paths[route.path] ??= {};
    paths[route.path]![route.method] = {
      tags: [route.tag],
      summary: route.summary,
      description: ACCESS_NOTE[route.access],
      ...(route.access !== 'public' && { security: [{ bearerAuth: [] }] }),
      parameters: [
        ...pathParameters(route.path),
        ...(route.query ? queryParameters(route.query) : []),
      ],
      ...(route.upload && {
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['file'],
                properties: { file: { type: 'string', format: 'binary' } },
              },
            },
          },
        },
      }),
      ...(route.body && {
        requestBody: {
          required: true,
          content: { 'application/json': { schema: jsonSchema(route.body) } },
        },
      }),
      responses: {
        '200': {
          description: 'Success. The result is in `data`.',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } },
        },
        '400': errorResponse,
        ...(route.access !== 'public' && { '401': errorResponse, '403': errorResponse }),
      },
    };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Al-Mahdi School Fee Manager API',
      version: '1.0.0',
      description:
        'Students, fees and certificates. Money is whole PKR. Business dates use Asia/Karachi; ' +
        'timestamps are UTC. Errors always look like `{ "error": { "code", "message", "details" } }`.',
    },
    servers: [{ url: '/api/v1' }],
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      schemas: {
        Success: { type: 'object', properties: { data: {} }, required: ['data'] },
        Error: {
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                code: { type: 'string', example: 'AMOUNT_EXCEEDS_BALANCE' },
                message: { type: 'string', example: "Amount can't be more than PKR 4,000." },
                details: { type: 'object' },
              },
              required: ['code', 'message', 'details'],
            },
          },
          required: ['error'],
        },
      },
    },
    paths,
  };
}
