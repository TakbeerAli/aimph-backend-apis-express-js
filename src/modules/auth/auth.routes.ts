import { Router, type RequestHandler } from 'express';
import { requireAuth } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import * as controller from './auth.controller.js';
import { changePasswordBody, loginBody, refreshBody } from './auth.schemas.js';

export function createAuthRouter(limiters: { login: RequestHandler; api: RequestHandler }): Router {
  const router = Router();
  const authed = [requireAuth, limiters.api];

  router.post('/login', limiters.login, validate({ body: loginBody }), controller.login);
  router.post('/refresh', limiters.api, validate({ body: refreshBody }), controller.refresh);
  router.post('/logout', ...authed, controller.logout);
  router.get('/me', ...authed, controller.me);
  router.post(
    '/change-password',
    ...authed,
    validate({ body: changePasswordBody }),
    controller.changePassword,
  );

  return router;
}
