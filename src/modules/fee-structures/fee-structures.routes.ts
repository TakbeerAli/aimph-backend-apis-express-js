import { Router } from 'express';
import { requireRole } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import * as controller from './fee-structures.controller.js';
import {
  copyFeeStructuresBody,
  feeStructureParams,
  listFeeStructuresQuery,
  putFeeStructureBody,
} from './fee-structures.schemas.js';

// Mounted behind requireAuth in app.ts.
export const feeStructuresRouter = Router();
const admin = requireRole('ADMIN');

feeStructuresRouter.get('/', validate({ query: listFeeStructuresQuery }), controller.list);
feeStructuresRouter.post(
  '/copy',
  admin,
  validate({ body: copyFeeStructuresBody }),
  controller.copy,
);
feeStructuresRouter.put(
  '/:sessionId/:classId',
  admin,
  validate({ params: feeStructureParams, body: putFeeStructureBody }),
  controller.put,
);
