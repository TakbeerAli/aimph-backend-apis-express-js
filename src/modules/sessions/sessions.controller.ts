import type { Request, Response } from 'express';
import { authUser } from '../../common/middleware/auth.js';
import { sendData } from '../../common/respond.js';
import type { CreateSessionInput } from './sessions.schemas.js';
import * as sessionsService from './sessions.service.js';

export async function list(_req: Request, res: Response): Promise<void> {
  sendData(res, await sessionsService.listSessions());
}

export async function setCurrent(req: Request<{ id: string }>, res: Response): Promise<void> {
  sendData(res, await sessionsService.setCurrentSession(authUser(req), req.params.id));
}

export async function create(req: Request, res: Response): Promise<void> {
  const body = req.body as CreateSessionInput;
  sendData(res, await sessionsService.createSession(authUser(req), body), 201);
}
