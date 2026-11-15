import { Router } from 'express';
import { requireRole } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import * as controller from './classes.controller.js';
import {
  addSectionBody,
  classIdParams,
  createClassBody,
  sectionParams,
  updateClassBody,
  updateSectionBody,
} from './classes.schemas.js';

// Mounted behind requireAuth in app.ts. Classes are never deleted, only deactivated.
export const classesRouter = Router();
const admin = requireRole('ADMIN');

classesRouter.get('/', controller.list);
classesRouter.post('/', admin, validate({ body: createClassBody }), controller.create);
classesRouter.patch(
  '/:id',
  admin,
  validate({ params: classIdParams, body: updateClassBody }),
  controller.update,
);
classesRouter.post(
  '/:id/sections',
  admin,
  validate({ params: classIdParams, body: addSectionBody }),
  controller.addSection,
);
classesRouter.patch(
  '/:id/sections/:sectionId',
  admin,
  validate({ params: sectionParams, body: updateSectionBody }),
  controller.updateSection,
);
