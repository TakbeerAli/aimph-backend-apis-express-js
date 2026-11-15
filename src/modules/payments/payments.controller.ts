import type { Request, Response } from 'express';
import { authUser } from '../../common/middleware/auth.js';
import { sendData } from '../../common/respond.js';
import type {
  CreatePaymentInput,
  ListPaymentsQuery,
  ResolveInput,
  ReverseInput,
} from './payments.schemas.js';
import * as paymentsService from './payments.service.js';

type IdParams = { id: string };

export async function create(req: Request, res: Response): Promise<void> {
  const result = await paymentsService.createPayment(authUser(req), req.body as CreatePaymentInput);
  // A repeat of an already-saved payment returns it unchanged with 200.
  sendData(res, result, result.duplicate ? 200 : 201);
}

export async function list(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as ListPaymentsQuery;
  sendData(res, await paymentsService.listPayments(authUser(req), query));
}

export async function needsReview(_req: Request, res: Response): Promise<void> {
  sendData(res, await paymentsService.listNeedsReview());
}

export async function get(req: Request<IdParams>, res: Response): Promise<void> {
  sendData(res, await paymentsService.getPayment(authUser(req), req.params.id));
}

export async function getByReceipt(
  req: Request<{ receiptNo: string }>,
  res: Response,
): Promise<void> {
  sendData(res, await paymentsService.getPaymentByReceipt(authUser(req), req.params.receiptNo));
}

export async function reverse(req: Request<IdParams>, res: Response): Promise<void> {
  const { reason } = req.body as ReverseInput;
  sendData(res, await paymentsService.reversePayment(authUser(req), req.params.id, reason));
}

export async function resolve(req: Request<IdParams>, res: Response): Promise<void> {
  const body = req.body as ResolveInput;
  sendData(res, await paymentsService.resolvePayment(authUser(req), req.params.id, body));
}
