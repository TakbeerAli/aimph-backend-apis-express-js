import { Router } from 'express';
import { requireRole } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import * as controller from './payments.controller.js';
import {
  createPaymentBody,
  listPaymentsQuery,
  paymentIdParams,
  receiptNoParams,
  resolveBody,
  reverseBody,
} from './payments.schemas.js';

// Mounted behind requireAuth in app.ts. Staff limits (own payments, assigned classes) are
// enforced in the service, not only here.
export const paymentsRouter = Router();
const admin = requireRole('ADMIN');

paymentsRouter.post('/', validate({ body: createPaymentBody }), controller.create);
paymentsRouter.get('/', validate({ query: listPaymentsQuery }), controller.list);
paymentsRouter.get('/needs-review', admin, controller.needsReview);
paymentsRouter.get(
  '/by-receipt/:receiptNo',
  validate({ params: receiptNoParams }),
  controller.getByReceipt,
);
paymentsRouter.get('/:id', validate({ params: paymentIdParams }), controller.get);
paymentsRouter.post(
  '/:id/reverse',
  admin,
  validate({ params: paymentIdParams, body: reverseBody }),
  controller.reverse,
);
paymentsRouter.post(
  '/:id/resolve',
  admin,
  validate({ params: paymentIdParams, body: resolveBody }),
  controller.resolve,
);
