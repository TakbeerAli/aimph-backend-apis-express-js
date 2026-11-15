import { Router } from 'express';
import { requireRole } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import * as controller from './users.controller.js';
import {
  createUserBody,
  listUsersQuery,
  resetPasswordBody,
  updateUserBody,
  userIdParams,
} from './users.schemas.js';

// Mounted behind requireAuth in app.ts. Every route here is Admin only.
export const usersRouter = Router();

usersRouter.use(requireRole('ADMIN'));

usersRouter.get('/', validate({ query: listUsersQuery }), controller.list);
usersRouter.post('/', validate({ body: createUserBody }), controller.create);
usersRouter.patch(
  '/:id',
  validate({ params: userIdParams, body: updateUserBody }),
  controller.update,
);
usersRouter.post(
  '/:id/reset-password',
  validate({ params: userIdParams, body: resetPasswordBody }),
  controller.resetPassword,
);
usersRouter.post('/:id/sign-out', validate({ params: userIdParams }), controller.signOut);
