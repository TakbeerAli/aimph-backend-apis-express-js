import { Router, type Request, type Response } from 'express';
import { authUser } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import { sendData } from '../../common/respond.js';
import { pullQuery, pushBody, type PullQuery, type PushInput } from './sync.schemas.js';
import * as syncService from './sync.service.js';

// Mounted behind requireAuth in app.ts (inactive users are rejected there). Admin and Staff.
export const syncRouter = Router();

syncRouter.post('/push', validate({ body: pushBody }), async (req: Request, res: Response) => {
  const { operations } = req.body as PushInput;
  sendData(res, { results: await syncService.push(authUser(req), operations) });
});

syncRouter.get('/pull', validate({ query: pullQuery }), async (req: Request, res: Response) => {
  const query = req.query as unknown as PullQuery;
  sendData(res, await syncService.pull(authUser(req), query));
});
