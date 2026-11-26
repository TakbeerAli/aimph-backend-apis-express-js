import { Router } from 'express';
import { requireRole } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import * as controller from './users.controller.js';
import {
  createTeacherBody,
  listUsersQuery,
  resetPasswordBody,
  updateTeacherBody,
  userIdParams,
} from './users.schemas.js';

// Mounted behind requireAuth in app.ts. Every route here is Admin only.

/** /users: everyone's names and phone codes (e.g. "received by"), password reset, sign-out. */
export const usersRouter = Router();
usersRouter.use(requireRole('ADMIN'));
usersRouter.get('/', validate({ query: listUsersQuery }), controller.list);
usersRouter.post(
  '/:id/reset-password',
  validate({ params: userIdParams, body: resetPasswordBody }),
  controller.resetPassword,
);
usersRouter.post('/:id/sign-out', validate({ params: userIdParams }), controller.signOut);

/** /teachers (TE-01): create teachers, assign sections, turn on/off. */
export const teachersRouter = Router();
teachersRouter.use(requireRole('ADMIN'));
teachersRouter.get('/', controller.listTeachers);
teachersRouter.post('/', validate({ body: createTeacherBody }), controller.createTeacher);
teachersRouter.patch(
  '/:id',
  validate({ params: userIdParams, body: updateTeacherBody }),
  controller.updateTeacher,
);
teachersRouter.post(
  '/:id/reset-password',
  validate({ params: userIdParams, body: resetPasswordBody }),
  controller.resetPassword,
);
teachersRouter.post('/:id/sign-out', validate({ params: userIdParams }), controller.signOut);
