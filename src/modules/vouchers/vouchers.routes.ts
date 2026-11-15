import { Router } from 'express';
import { requireRole } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import * as controller from './vouchers.controller.js';
import {
  cancelBody,
  fineBody,
  generateVouchersBody,
  listVouchersQuery,
  openingBalancesBody,
  voucherIdParams,
  voucherNoParams,
  waiveBody,
} from './vouchers.schemas.js';

// Mounted behind requireAuth in app.ts. Staff can view; only Admin changes vouchers.
export const vouchersRouter = Router();
const admin = requireRole('ADMIN');
const generate = validate({ body: generateVouchersBody });

vouchersRouter.post('/generate/preview', admin, generate, controller.preview);
vouchersRouter.post('/generate', admin, generate, controller.generate);
vouchersRouter.post(
  '/opening-balances',
  admin,
  validate({ body: openingBalancesBody }),
  controller.openingBalances,
);
vouchersRouter.get('/', validate({ query: listVouchersQuery }), controller.list);
vouchersRouter.get('/by-no/:voucherNo', validate({ params: voucherNoParams }), controller.getByNo);
vouchersRouter.get('/:id', validate({ params: voucherIdParams }), controller.get);
vouchersRouter.post(
  '/:id/fine',
  admin,
  validate({ params: voucherIdParams, body: fineBody }),
  controller.fine,
);
vouchersRouter.post(
  '/:id/waive',
  admin,
  validate({ params: voucherIdParams, body: waiveBody }),
  controller.waive,
);
vouchersRouter.post(
  '/:id/cancel',
  admin,
  validate({ params: voucherIdParams, body: cancelBody }),
  controller.cancel,
);
