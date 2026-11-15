import type { Request, Response } from 'express';
import { authUser } from '../../common/middleware/auth.js';
import { sendData } from '../../common/respond.js';
import type { ChangePasswordInput, LoginInput, RefreshInput } from './auth.schemas.js';
import * as authService from './auth.service.js';

export async function login(req: Request, res: Response): Promise<void> {
  sendData(res, await authService.login(req.body as LoginInput));
}

export async function refresh(req: Request, res: Response): Promise<void> {
  const { refreshToken } = req.body as RefreshInput;
  sendData(res, await authService.refresh(refreshToken));
}

export async function logout(req: Request, res: Response): Promise<void> {
  await authService.logout(authUser(req));
  sendData(res, { ok: true });
}

export async function me(req: Request, res: Response): Promise<void> {
  sendData(res, await authService.me(authUser(req)));
}

export async function changePassword(req: Request, res: Response): Promise<void> {
  const body = req.body as ChangePasswordInput;
  sendData(res, await authService.changePassword(authUser(req), body));
}
