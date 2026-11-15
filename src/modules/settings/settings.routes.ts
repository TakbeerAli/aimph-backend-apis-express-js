import { Router } from 'express';
import { requireRole } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import * as controller from './settings.controller.js';
import { updateSettingsBody } from './settings.schemas.js';

// Mounted behind requireAuth in app.ts.
export const settingsRouter = Router();

settingsRouter.get('/', controller.get);
settingsRouter.patch(
  '/',
  requireRole('ADMIN'),
  validate({ body: updateSettingsBody }),
  controller.update,
);
