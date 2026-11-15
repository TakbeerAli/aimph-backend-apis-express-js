import { Router } from 'express';
import { sendData } from '../../common/respond.js';
import { isDbUp } from '../../db/connect.js';

export const healthRouter = Router();

healthRouter.get('/', async (_req, res) => {
  const dbUp = await isDbUp();
  sendData(res, { status: dbUp ? 'ok' : 'error', db: dbUp ? 'up' : 'down' }, dbUp ? 200 : 503);
});
