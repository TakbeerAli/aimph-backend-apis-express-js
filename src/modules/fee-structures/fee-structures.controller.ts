import type { Request, Response } from 'express';
import { authUser } from '../../common/middleware/auth.js';
import { sendData } from '../../common/respond.js';
import type {
  CopyFeeStructuresInput,
  ListFeeStructuresQuery,
  PutFeeStructureInput,
} from './fee-structures.schemas.js';
import * as feeService from './fee-structures.service.js';

export async function list(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as ListFeeStructuresQuery;
  sendData(res, await feeService.listFeeStructures(query));
}

export async function put(
  req: Request<{ sessionId: string; classId: string }>,
  res: Response,
): Promise<void> {
  const { sessionId, classId } = req.params;
  const body = req.body as PutFeeStructureInput;
  sendData(res, await feeService.putFeeStructure(authUser(req), sessionId, classId, body));
}

export async function copy(req: Request, res: Response): Promise<void> {
  const body = req.body as CopyFeeStructuresInput;
  sendData(res, await feeService.copyFeeStructures(authUser(req), body));
}
