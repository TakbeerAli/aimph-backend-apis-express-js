import { z } from 'zod';
import { feeMonthSchema } from '../../common/utils/dates.js';
import { CALENDAR_EVENT_TYPES } from './calendar.model.js';

const id = z.string().min(1).max(64);
const ymd = z.iso.date();
/** "true" in a query string, or true in a body: the Admin saw the warning and goes ahead. */
const confirm = z
  .union([z.boolean(), z.enum(['true', 'false'])])
  .transform((v) => v === true || v === 'true')
  .default(false);

export const calendarMonthQuery = z.object({
  sessionId: id.optional(),
  month: feeMonthSchema,
});

export const weeklyOffBody = z.object({
  weeklyOffDays: z.array(z.int().min(0).max(6)).max(6),
});

export const createEventBody = z.object({
  type: z.enum(CALENDAR_EVENT_TYPES),
  name: z.string().trim().min(2).max(80),
  startDate: ymd,
  /** Leave out for one day. */
  endDate: ymd.optional(),
  confirm,
});

export const updateEventBody = z
  .object({
    name: z.string().trim().min(2).max(80).optional(),
    startDate: ymd.optional(),
    endDate: ymd.optional(),
    confirm,
  })
  .refine((b) => b.name !== undefined || b.startDate !== undefined || b.endDate !== undefined, {
    message: 'Nothing to update.',
  });

export const eventIdParams = z.object({ id });
export const deleteEventQuery = z.object({ confirm });

export type CalendarMonthQuery = z.infer<typeof calendarMonthQuery>;
export type CreateEventInput = z.infer<typeof createEventBody>;
export type UpdateEventInput = z.infer<typeof updateEventBody>;
