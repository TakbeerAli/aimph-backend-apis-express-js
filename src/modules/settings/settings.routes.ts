import { Router } from 'express';
import { requireRole } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import * as controller from './settings.controller.js';
import { putLogoBody, updateSettingsBody } from './settings.schemas.js';

// Mounted behind requireAuth in app.ts.
export const settingsRouter = Router();

settingsRouter.get('/', controller.get);
settingsRouter.patch(
  '/',
  requireRole('ADMIN'),
  validate({ body: updateSettingsBody }),
  controller.update,
);
// The logo is kept apart from the settings document so phones only download it when needed.
settingsRouter.get('/logo', controller.getLogo);
settingsRouter.put(
  '/logo',
  requireRole('ADMIN'),
  validate({ body: putLogoBody }),
  controller.putLogo,
);
settingsRouter.delete('/logo', requireRole('ADMIN'), controller.deleteLogo);
