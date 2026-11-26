import { Router, type Request, type Response } from 'express';
import { authUser } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import { sendData } from '../../common/respond.js';
import { notMarked, register, sectionsStatus, studentMonth } from './attendance.reports.js';
import {
  monthQuery,
  notMarkedQuery,
  registerQuery,
  saveSheetBody,
  sheetQuery,
  statusQuery,
  studentMonthParams,
  type SaveSheetInput,
  type SheetQuery,
} from './attendance.schemas.js';
import { getSheet, saveSheet } from './attendance.service.js';

// Mounted behind requireAuth in app.ts. Admin: every section. Teacher: own sections (marking:
// today only). Reports for a teacher are limited to their own sections.
export const attendanceRouter = Router();

attendanceRouter.get(
  '/sheet',
  validate({ query: sheetQuery }),
  async (req: Request, res: Response) => {
    sendData(res, await getSheet(authUser(req), req.query as unknown as SheetQuery));
  },
);

attendanceRouter.put(
  '/sheet',
  validate({ body: saveSheetBody }),
  async (req: Request, res: Response) => {
    const { sheet, status } = await saveSheet(authUser(req), req.body as SaveSheetInput);
    sendData(res, { sheet, status }, status === 'CREATED' ? 201 : 200);
  },
);

attendanceRouter.get(
  '/sections-status',
  validate({ query: statusQuery }),
  async (req: Request, res: Response) => {
    const { date } = req.query as unknown as { date: string };
    sendData(res, await sectionsStatus(authUser(req), date));
  },
);

attendanceRouter.get(
  '/not-marked',
  validate({ query: notMarkedQuery }),
  async (req: Request, res: Response) => {
    const { from, to } = req.query as unknown as { from?: string; to?: string };
    sendData(res, await notMarked(authUser(req), from, to));
  },
);

attendanceRouter.get(
  '/student/:id',
  validate({ params: studentMonthParams, query: monthQuery }),
  async (req: Request<{ id: string }>, res: Response) => {
    const { month } = req.query as unknown as { month: string };
    sendData(res, await studentMonth(authUser(req), req.params.id, month));
  },
);

attendanceRouter.get(
  '/register',
  validate({ query: registerQuery }),
  async (req: Request, res: Response) => {
    const { sectionId, month } = req.query as unknown as { sectionId: string; month: string };
    sendData(res, await register(authUser(req), sectionId, month));
  },
);
