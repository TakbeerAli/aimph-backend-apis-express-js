import { Router, type Request, type Response } from 'express';
import { authUser } from '../../common/middleware/auth.js';
import { sendData } from '../../common/respond.js';
import { getDashboard } from './dashboard.service.js';

// Mounted behind requireAuth in app.ts. Admin and Staff (Staff get their own totals).
export const dashboardRouter = Router();

dashboardRouter.get('/', async (req: Request, res: Response) => {
  sendData(res, await getDashboard(authUser(req)));
});
