import { Router, type Request, type Response } from 'express';
import { authUser } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import { sendData } from '../../common/respond.js';
import {
  saveSheetBody,
  sheetQuery,
  type SaveSheetInput,
  type SheetQuery,
} from './attendance.schemas.js';
import { getSheet, saveSheet } from './attendance.service.js';

// Mounted behind requireAuth in app.ts. Admin: every section. Teacher: own sections, today only.
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
