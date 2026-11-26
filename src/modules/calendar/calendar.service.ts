import mongoose, { type ClientSession } from 'mongoose';
import { diffFields, writeAudit } from '../../common/audit.js';
import { AppError } from '../../common/errors.js';
import type { AuthUser } from '../../common/middleware/auth.js';
import { toYmd } from '../../common/utils/dates.js';
import { withTransaction } from '../../db/transaction.js';
import { AcademicSession, type AcademicSessionDoc } from '../sessions/sessions.model.js';
import { requireCurrentSession } from '../sessions/sessions.service.js';
import { getSettings } from '../settings/settings.service.js';
import { CalendarEvent, type CalendarEventDoc } from './calendar.model.js';
import {
  dayInfo,
  eachDay,
  monthRange,
  type CalendarRuleEvent,
  type DayInfo,
} from './calendar.rules.js';
import type { CalendarMonthQuery, CreateEventInput, UpdateEventInput } from './calendar.schemas.js';

const MAX_EVENT_DAYS = 120;

const sessionRange = (s: AcademicSessionDoc) => ({
  from: toYmd(s.startDate),
  to: toYmd(s.endDate),
});

/** The calendar of a session: weekly off days and its (not deleted) holidays and make-up days. */
export async function loadCalendar(
  sessionId: string,
  session?: ClientSession | null,
): Promise<{ weeklyOffDays: number[]; events: CalendarEventDoc[] }> {
  const [settings, events] = await Promise.all([
    getSettings(session ?? undefined),
    CalendarEvent.find({ sessionId, isDeleted: false })
      .sort({ startDate: 1 })
      .session(session ?? null),
  ]);
  return { weeklyOffDays: [...settings.calendar.weeklyOffDays], events };
}

/* ---------- GET /calendar ---------- */

export interface CalendarMonth {
  sessionId: string;
  month: string;
  weeklyOffDays: number[];
  /** Working days of the month that are inside the session. */
  workingDays: number;
  days: (DayInfo & { inSession: boolean })[];
  /** Holidays and make-up days that touch this month. */
  events: CalendarEventDoc[];
}

export async function getCalendarMonth(query: CalendarMonthQuery): Promise<CalendarMonth> {
  const academic = query.sessionId
    ? await AcademicSession.findById(query.sessionId)
    : await requireCurrentSession();
  if (!academic) throw new AppError('NOT_FOUND', 'Session not found.');
  const bounds = sessionRange(academic);
  const { weeklyOffDays, events } = await loadCalendar(academic._id);
  const { from, to } = monthRange(query.month);

  const days = eachDay(from, to).map((date) => ({
    ...dayInfo(date, weeklyOffDays, events),
    inSession: bounds.from <= date && date <= bounds.to,
  }));
  return {
    sessionId: academic._id,
    month: query.month,
    weeklyOffDays,
    workingDays: days.filter((d) => d.inSession && d.type === 'WORKING').length,
    days,
    events: events.filter((e) => e.startDate <= to && e.endDate >= from),
  };
}

/* ---------- Weekly off days (settings.calendar) ---------- */

export async function getWeeklyOff(): Promise<{ weeklyOffDays: number[] }> {
  return { weeklyOffDays: [...(await getSettings()).calendar.weeklyOffDays] };
}

export async function updateWeeklyOff(
  user: AuthUser,
  weeklyOffDays: number[],
): Promise<{ weeklyOffDays: number[] }> {
  const days = [...new Set(weeklyOffDays)].sort();
  return withTransaction(async (session) => {
    const settings = await getSettings(session);
    const before = [...settings.calendar.weeklyOffDays];
    if (JSON.stringify(before) === JSON.stringify(days)) return { weeklyOffDays: before };
    settings.set('calendar.weeklyOffDays', days);
    await settings.save({ session });
    await writeAudit(session, {
      action: 'WEEKLY_OFF_UPDATE',
      userId: user.id,
      entity: 'settings',
      entityId: settings._id,
      before: { weeklyOffDays: before },
      after: { weeklyOffDays: days },
    });
    return { weeklyOffDays: days };
  });
}

/* ---------- Holidays and make-up working days ---------- */

/**
 * Dates in the range that already have attendance sheets. Attendance sheets are added in
 * stage B3; until then the collection is simply empty.
 */
export async function markedDates(
  from: string,
  to: string,
  session?: ClientSession | null,
): Promise<string[]> {
  const dates = await mongoose.connection
    .collection<{ date: string }>('attendance_sheets')
    .distinct('date', { date: { $gte: from, $lte: to } }, { session: session ?? undefined });
  return dates.sort();
}

/**
 * Asks before changing days that already have attendance: a holiday removes them from totals
 * and percentages (the records are kept); removing a holiday or make-up day changes them back.
 */
async function warnIfMarked(
  from: string,
  to: string,
  confirm: boolean,
  what: string,
  session: ClientSession,
): Promise<void> {
  if (confirm) return;
  const dates = await markedDates(from, to, session);
  if (dates.length === 0) return;
  throw new AppError(
    'ATTENDANCE_EXISTS',
    `Attendance was already marked on ${dates.length} day${dates.length === 1 ? '' : 's'} in this range. ${what} The records are kept. Send confirm=true to go ahead.`,
    { dates },
  );
}

/** Checks one event against the session and the other events; throws a clear message. */
async function validateEvent(
  event: { type: CalendarEventDoc['type']; startDate: string; endDate: string },
  academic: AcademicSessionDoc,
  exceptId: string | null,
  session: ClientSession,
): Promise<void> {
  const { from, to } = sessionRange(academic);
  if (event.endDate < event.startDate) {
    throw new AppError('VALIDATION_ERROR', 'The end date is before the start date.');
  }
  if (event.startDate < from || event.endDate > to) {
    throw new AppError(
      'VALIDATION_ERROR',
      `Dates must be inside the session ${academic.name} (${from} to ${to}).`,
    );
  }
  if (eachDay(event.startDate, event.endDate).length > MAX_EVENT_DAYS) {
    throw new AppError('VALIDATION_ERROR', `A holiday can be at most ${MAX_EVENT_DAYS} days long.`);
  }
  if (event.type !== 'WORKING_DAY') return;

  if (event.startDate !== event.endDate) {
    throw new AppError('VALIDATION_ERROR', 'A make-up working day is a single date.');
  }
  const { weeklyOffDays, events } = await loadCalendar(academic._id, session);
  const others = events.filter((e) => e._id !== exceptId);
  const day = dayInfo(event.startDate, weeklyOffDays, others);
  if (day.type === 'HOLIDAY') {
    throw new AppError(
      'VALIDATION_ERROR',
      `${event.startDate} is inside the holiday "${day.names.join(', ')}".`,
    );
  }
  if (day.isException) {
    throw new AppError('CONFLICT', `${event.startDate} is already a make-up working day.`);
  }
  if (!weeklyOffDays.includes(day.weekday)) {
    throw new AppError('VALIDATION_ERROR', `${event.startDate} is already a working day.`);
  }
}

const eventFields = (e: CalendarEventDoc) => ({
  type: e.type,
  name: e.name,
  startDate: e.startDate,
  endDate: e.endDate,
});

/** Admin adds a holiday or a make-up working day in the current session. */
export async function createEvent(
  user: AuthUser,
  input: CreateEventInput,
): Promise<CalendarEventDoc> {
  const endDate = input.endDate ?? input.startDate;
  return withTransaction(async (session) => {
    const academic = await requireCurrentSession(session);
    await validateEvent(
      { type: input.type, startDate: input.startDate, endDate },
      academic,
      null,
      session,
    );
    if (input.type === 'HOLIDAY') {
      await warnIfMarked(
        input.startDate,
        endDate,
        input.confirm,
        'These days will no longer count in attendance totals.',
        session,
      );
    }
    const [event] = await CalendarEvent.create(
      [
        {
          sessionId: academic._id,
          type: input.type,
          name: input.name,
          startDate: input.startDate,
          endDate,
          createdBy: user.id,
        },
      ],
      { session },
    );
    if (!event) throw new Error('Event was not created');
    await writeAudit(session, {
      action: 'CALENDAR_EVENT_CREATE',
      userId: user.id,
      entity: 'calendar_event',
      entityId: event._id,
      after: eventFields(event),
    });
    return event;
  });
}

async function findEventOrThrow(id: string, session: ClientSession): Promise<CalendarEventDoc> {
  const event = await CalendarEvent.findOne({ _id: id, isDeleted: false }).session(session);
  if (!event) throw new AppError('NOT_FOUND', 'Holiday or working day not found.');
  return event;
}

/** Change a name or dates. The type cannot change. */
export async function updateEvent(
  user: AuthUser,
  id: string,
  input: UpdateEventInput,
): Promise<CalendarEventDoc> {
  return withTransaction(async (session) => {
    const event = await findEventOrThrow(id, session);
    const academic = await requireCurrentSession(session);
    if (event.sessionId !== academic._id) {
      throw new AppError('VALIDATION_ERROR', 'Only the current session can be changed.');
    }
    const startDate = input.startDate ?? event.startDate;
    const endDate = input.endDate ?? (event.type === 'WORKING_DAY' ? startDate : event.endDate);
    await validateEvent({ type: event.type, startDate, endDate }, academic, event._id, session);

    // Days the change adds to a holiday, or gives back: both change attendance totals.
    const before = eventFields(event);
    const changedFrom = startDate < before.startDate ? startDate : before.startDate;
    const changedTo = endDate > before.endDate ? endDate : before.endDate;
    if (startDate !== before.startDate || endDate !== before.endDate) {
      await warnIfMarked(
        changedFrom,
        changedTo,
        input.confirm,
        'Attendance totals for these days will change.',
        session,
      );
    }

    event.set({ name: input.name ?? event.name, startDate, endDate });
    await event.save({ session });
    await writeAudit(session, {
      action: 'CALENDAR_EVENT_UPDATE',
      userId: user.id,
      entity: 'calendar_event',
      entityId: event._id,
      ...diffFields(before, eventFields(event)),
    });
    return event;
  });
}

/** Removes a holiday or make-up day (kept as deleted so phones hear about it). */
export async function deleteEvent(
  user: AuthUser,
  id: string,
  confirm: boolean,
): Promise<CalendarEventDoc> {
  return withTransaction(async (session) => {
    const event = await findEventOrThrow(id, session);
    await warnIfMarked(
      event.startDate,
      event.endDate,
      confirm,
      event.type === 'HOLIDAY'
        ? 'These days will count in attendance totals again.'
        : 'This day will no longer count in attendance totals.',
      session,
    );
    event.isDeleted = true;
    await event.save({ session });
    await writeAudit(session, {
      action: 'CALENDAR_EVENT_DELETE',
      userId: user.id,
      entity: 'calendar_event',
      entityId: event._id,
      before: eventFields(event),
    });
    return event;
  });
}

/** For other modules: the rules data of a session, as plain objects. */
export async function calendarRules(
  sessionId: string,
  session?: ClientSession | null,
): Promise<{ weeklyOffDays: number[]; events: CalendarRuleEvent[] }> {
  const { weeklyOffDays, events } = await loadCalendar(sessionId, session);
  return { weeklyOffDays, events: events.map(eventFields) };
}

/** The rules data for a date range, whatever session(s) it falls in. */
export async function calendarRulesForRange(
  from: string,
  to: string,
  session?: ClientSession | null,
): Promise<{ weeklyOffDays: number[]; events: CalendarRuleEvent[] }> {
  const [settings, events] = await Promise.all([
    getSettings(session ?? undefined),
    CalendarEvent.find({ isDeleted: false, startDate: { $lte: to }, endDate: { $gte: from } })
      .sort({ startDate: 1 })
      .session(session ?? null),
  ]);
  return { weeklyOffDays: [...settings.calendar.weeklyOffDays], events: events.map(eventFields) };
}
