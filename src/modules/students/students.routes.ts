import { Router } from 'express';
import { requireRole } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import * as controller from './students.controller.js';
import {
  admitStudentBody,
  changeSectionBody,
  importStudentsBody,
  listStudentsQuery,
  studentIdParams,
  updateStudentBody,
} from './students.schemas.js';

// Mounted behind requireAuth in app.ts. Staff can view; only Admin changes students.
export const studentsRouter = Router();
const admin = requireRole('ADMIN');

studentsRouter.get('/', validate({ query: listStudentsQuery }), controller.list);
studentsRouter.post('/', admin, validate({ body: admitStudentBody }), controller.admit);
studentsRouter.post(
  '/import',
  admin,
  validate({ body: importStudentsBody }),
  controller.importMany,
);
studentsRouter.get('/:id', validate({ params: studentIdParams }), controller.get);
studentsRouter.patch(
  '/:id',
  admin,
  validate({ params: studentIdParams, body: updateStudentBody }),
  controller.update,
);
studentsRouter.post(
  '/:id/change-section',
  admin,
  validate({ params: studentIdParams, body: changeSectionBody }),
  controller.changeSection,
);
