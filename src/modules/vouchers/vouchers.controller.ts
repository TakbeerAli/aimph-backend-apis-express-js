import type { Request, Response } from 'express';
import { authUser } from '../../common/middleware/auth.js';
import { sendData } from '../../common/respond.js';
import { paymentsForVoucher } from '../payments/payments.service.js';
import * as generation from './vouchers.generate.js';
import type {
  CancelInput,
  FineInput,
  GenerateVouchersInput,
  ListVouchersQuery,
  WaiveInput,
} from './vouchers.schemas.js';
import * as vouchersService from './vouchers.service.js';

type IdParams = { id: string };

export async function preview(req: Request, res: Response): Promise<void> {
  const body = req.body as GenerateVouchersInput;
  sendData(res, await generation.previewGeneration(authUser(req), body));
}

export async function generate(req: Request, res: Response): Promise<void> {
  const body = req.body as GenerateVouchersInput;
  sendData(res, await generation.generateVouchers(authUser(req), body));
}

export async function list(req: Request, res: Response): Promise<void> {
  sendData(res, await vouchersService.listVouchers(req.query as unknown as ListVouchersQuery));
}

/** The voucher plus the payments applied to it (Staff: see paymentsForVoucher). */
export async function get(req: Request<IdParams>, res: Response): Promise<void> {
  const voucher = await vouchersService.getVoucher(req.params.id);
  const payments = await paymentsForVoucher(authUser(req), voucher);
  sendData(res, { ...voucher.toJSON(), payments });
}

export async function getByNo(req: Request<{ voucherNo: string }>, res: Response): Promise<void> {
  sendData(res, await vouchersService.getVoucherByNo(req.params.voucherNo));
}

export async function fine(req: Request<IdParams>, res: Response): Promise<void> {
  const body = req.body as FineInput;
  sendData(res, await vouchersService.addFine(authUser(req), req.params.id, body));
}

export async function waive(req: Request<IdParams>, res: Response): Promise<void> {
  const body = req.body as WaiveInput;
  sendData(res, await vouchersService.waive(authUser(req), req.params.id, body));
}

export async function cancel(req: Request<IdParams>, res: Response): Promise<void> {
  const body = req.body as CancelInput;
  sendData(res, await vouchersService.cancel(authUser(req), req.params.id, body));
}

export async function openingBalances(req: Request, res: Response): Promise<void> {
  const rows = req.body as unknown[];
  sendData(res, await vouchersService.createOpeningBalances(authUser(req), rows));
}
