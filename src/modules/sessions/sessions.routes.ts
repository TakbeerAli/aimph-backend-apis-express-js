import { Router } from 'express';
import { z } from 'zod';
import { requireRole } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import * as controller from './sessions.controller.js';
import { createSessionBody } from './sessions.schemas.js';

// Mounted behind requireAuth in app.ts.
export const sessionsRouter = Router();

sessionsRouter.get('/', controller.list);
sessionsRouter.post(
  '/:id/set-current',
  requireRole('ADMIN'),
  validate({ params: z.object({ id: z.string().min(1).max(64) }) }),
  controller.setCurrent,
);
sessionsRouter.post(
  '/',
  requireRole('ADMIN'),
  validate({ body: createSessionBody }),
  controller.create,
);
