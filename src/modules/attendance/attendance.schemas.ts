import { z } from 'zod';
import { ATTENDANCE_STATUSES } from './attendance.rules.js';

const id = z.string().min(1).max(64);
const ymd = z.iso.date();

export const sheetQuery = z.object({ sectionId: id, date: ymd });

/** PUT /attendance/sheet (also the payload of the SAVE_ATTENDANCE sync operation). */
export const saveSheetBody = z.object({
  /** UUID made on the phone; a resend with the same id is recognised. */
  id: z.uuid(),
  sectionId: id,
  date: ymd,
  /** Students left out keep their current status (PRESENT on a new sheet). */
  entries: z.array(z.object({ studentId: id, status: z.enum(ATTENDANCE_STATUSES) })).max(500),
  /** The version the phone last saw, when changing an existing sheet. */
  version: z.int().min(1).optional(),
  /** Required when the Admin changes a past day. */
  reason: z.string().trim().min(3).max(250).optional(),
});

export type SheetQuery = z.infer<typeof sheetQuery>;
export type SaveSheetInput = z.infer<typeof saveSheetBody>;

/* ---------- Reports (stage B4) ---------- */

export const statusQuery = z.object({ date: ymd });
export const notMarkedQuery = z.object({ from: ymd.optional(), to: ymd.optional() });
export const studentMonthParams = z.object({ id });
export const monthQuery = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use the format YYYY-MM, e.g. 2026-11.'),
});
export const registerQuery = monthQuery.extend({ sectionId: id });
