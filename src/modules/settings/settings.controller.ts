import type { Request, Response } from 'express';
import { authUser } from '../../common/middleware/auth.js';
import { sendData } from '../../common/respond.js';
import type { UpdateSettingsInput } from './settings.schemas.js';
import * as settingsService from './settings.service.js';

export async function get(_req: Request, res: Response): Promise<void> {
  sendData(res, await settingsService.getSettings());
}

export async function update(req: Request, res: Response): Promise<void> {
  const body = req.body as UpdateSettingsInput;
  sendData(res, await settingsService.updateSettings(authUser(req), body));
}
