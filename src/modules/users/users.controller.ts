import type { Request, Response } from 'express';
import { authUser } from '../../common/middleware/auth.js';
import { sendData } from '../../common/respond.js';
import type { CreateTeacherInput, ListUsersQuery, UpdateTeacherInput } from './users.schemas.js';
import * as usersService from './users.service.js';

type IdParams = { id: string };

export async function list(req: Request, res: Response): Promise<void> {
  sendData(res, await usersService.listUsers(req.query as unknown as ListUsersQuery));
}

export async function listTeachers(_req: Request, res: Response): Promise<void> {
  sendData(res, await usersService.listTeachers());
}

export async function createTeacher(req: Request, res: Response): Promise<void> {
  const user = await usersService.createTeacher(authUser(req), req.body as CreateTeacherInput);
  sendData(res, user, 201);
}

export async function updateTeacher(req: Request<IdParams>, res: Response): Promise<void> {
  const body = req.body as UpdateTeacherInput;
  sendData(res, await usersService.updateTeacher(authUser(req), req.params.id, body));
}

export async function resetPassword(req: Request<IdParams>, res: Response): Promise<void> {
  const { newPassword } = req.body as { newPassword: string };
  await usersService.resetPassword(authUser(req), req.params.id, newPassword);
  sendData(res, { ok: true });
}

export async function signOut(req: Request<IdParams>, res: Response): Promise<void> {
  await usersService.signOutUser(authUser(req), req.params.id);
  sendData(res, { ok: true });
}
