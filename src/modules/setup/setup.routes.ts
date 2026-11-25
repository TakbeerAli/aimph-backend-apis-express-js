import { Router, type Request, type Response } from 'express';
import { requireRole } from '../../common/middleware/auth.js';
import { sendData } from '../../common/respond.js';
import { setupStatus } from './setup.service.js';

// Mounted behind requireAuth in app.ts. Admin only: the set-up checklist on Admin Home.
export const setupRouter = Router();

setupRouter.get('/status', requireRole('ADMIN'), async (_req: Request, res: Response) => {
  sendData(res, await setupStatus());
});
