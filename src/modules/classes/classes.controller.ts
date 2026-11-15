import type { Request, Response } from 'express';
import { authUser } from '../../common/middleware/auth.js';
import { sendData } from '../../common/respond.js';
import type {
  AddSectionInput,
  CreateClassInput,
  UpdateClassInput,
  UpdateSectionInput,
} from './classes.schemas.js';
import * as classesService from './classes.service.js';

export async function list(_req: Request, res: Response): Promise<void> {
  sendData(res, await classesService.listClasses());
}

export async function create(req: Request, res: Response): Promise<void> {
  const body = req.body as CreateClassInput;
  sendData(res, await classesService.createClass(authUser(req), body), 201);
}

export async function update(req: Request<{ id: string }>, res: Response): Promise<void> {
  const body = req.body as UpdateClassInput;
  sendData(res, await classesService.updateClass(authUser(req), req.params.id, body));
}

export async function addSection(req: Request<{ id: string }>, res: Response): Promise<void> {
  const body = req.body as AddSectionInput;
  sendData(res, await classesService.addSection(authUser(req), req.params.id, body), 201);
}

export async function updateSection(
  req: Request<{ id: string; sectionId: string }>,
  res: Response,
): Promise<void> {
  const body = req.body as UpdateSectionInput;
  const { id, sectionId } = req.params;
  sendData(res, await classesService.updateSection(authUser(req), id, sectionId, body));
}
