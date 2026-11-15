import { Router } from 'express';
import { requireRole } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import * as controller from './sessions.controller.js';
import { createSessionBody } from './sessions.schemas.js';

// Mounted behind requireAuth in app.ts.
export const sessionsRouter = Router();

sessionsRouter.get('/', controller.list);
sessionsRouter.post(
  '/',
  requireRole('ADMIN'),
  validate({ body: createSessionBody }),
  controller.create,
);
