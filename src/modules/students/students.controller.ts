import type { Request, Response } from 'express';
import { authUser } from '../../common/middleware/auth.js';
import { sendData } from '../../common/respond.js';
import { studentFeeHistory } from '../payments/payments.service.js';
import { promoteClass, withdrawStudent } from './students.lifecycle.js';
import type {
  AdmitStudentInput,
  ChangeSectionInput,
  ListStudentsQuery,
  PromoteInput,
  UpdateStudentInput,
  WithdrawInput,
} from './students.schemas.js';
import * as studentsService from './students.service.js';

type IdParams = { id: string };

export async function list(req: Request, res: Response): Promise<void> {
  sendData(
    res,
    await studentsService.listStudents(authUser(req), req.query as unknown as ListStudentsQuery),
  );
}

export async function get(req: Request<IdParams>, res: Response): Promise<void> {
  sendData(res, await studentsService.getStudent(authUser(req), req.params.id));
}

export async function withdraw(req: Request<IdParams>, res: Response): Promise<void> {
  const body = req.body as WithdrawInput;
  sendData(res, await withdrawStudent(authUser(req), req.params.id, body));
}

export async function promote(req: Request, res: Response): Promise<void> {
  sendData(res, await promoteClass(authUser(req), req.body as PromoteInput));
}

export async function feeHistory(req: Request<IdParams>, res: Response): Promise<void> {
  sendData(res, await studentFeeHistory(authUser(req), req.params.id));
}

export async function admit(req: Request, res: Response): Promise<void> {
  const result = await studentsService.admitStudent(authUser(req), req.body as AdmitStudentInput);
  sendData(res, result, result.duplicate ? 200 : 201);
}

export async function update(req: Request<IdParams>, res: Response): Promise<void> {
  const body = req.body as UpdateStudentInput;
  sendData(res, await studentsService.updateStudent(authUser(req), req.params.id, body));
}

export async function changeSection(req: Request<IdParams>, res: Response): Promise<void> {
  const body = req.body as ChangeSectionInput;
  sendData(res, await studentsService.changeSection(authUser(req), req.params.id, body));
}

export async function importMany(req: Request, res: Response): Promise<void> {
  sendData(res, await studentsService.importStudents(authUser(req), req.body as unknown[]));
}
