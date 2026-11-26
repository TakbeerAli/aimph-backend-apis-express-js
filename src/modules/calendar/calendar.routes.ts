import { Router, type Request, type Response } from 'express';
import { authUser, requireRole } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import { sendData } from '../../common/respond.js';
import {
  calendarMonthQuery,
  createEventBody,
  deleteEventQuery,
  eventIdParams,
  updateEventBody,
  weeklyOffBody,
  type CalendarMonthQuery,
  type CreateEventInput,
  type UpdateEventInput,
} from './calendar.schemas.js';
import {
  createEvent,
  deleteEvent,
  getCalendarMonth,
  getWeeklyOff,
  updateEvent,
  updateWeeklyOff,
} from './calendar.service.js';

// Mounted behind requireAuth in app.ts. Everyone reads the calendar; only Admin changes it.
export const calendarRouter = Router();
const admin = requireRole('ADMIN');

calendarRouter.get(
  '/',
  validate({ query: calendarMonthQuery }),
  async (req: Request, res: Response) => {
    sendData(res, await getCalendarMonth(req.query as unknown as CalendarMonthQuery));
  },
);

calendarRouter.post(
  '/events',
  admin,
  validate({ body: createEventBody }),
  async (req: Request, res: Response) => {
    sendData(res, await createEvent(authUser(req), req.body as CreateEventInput), 201);
  },
);

calendarRouter.patch(
  '/events/:id',
  admin,
  validate({ params: eventIdParams, body: updateEventBody }),
  async (req: Request<{ id: string }>, res: Response) => {
    const body = req.body as UpdateEventInput;
    sendData(res, await updateEvent(authUser(req), req.params.id, body));
  },
);

calendarRouter.delete(
  '/events/:id',
  admin,
  validate({ params: eventIdParams, query: deleteEventQuery }),
  async (req: Request<{ id: string }>, res: Response) => {
    const { confirm } = req.query as unknown as { confirm: boolean };
    sendData(res, await deleteEvent(authUser(req), req.params.id, confirm));
  },
);

/** /settings/calendar: the weekly off days. */
export const calendarSettingsRouter = Router();

calendarSettingsRouter.get('/', async (_req: Request, res: Response) => {
  sendData(res, await getWeeklyOff());
});

calendarSettingsRouter.patch(
  '/',
  admin,
  validate({ body: weeklyOffBody }),
  async (req: Request, res: Response) => {
    const { weeklyOffDays } = req.body as { weeklyOffDays: number[] };
    sendData(res, await updateWeeklyOff(authUser(req), weeklyOffDays));
  },
);
