import { Router } from 'express';
import { requireRole } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import * as controller from './reports.controller.js';
import {
  classWiseQuery,
  collectionQuery,
  dailyCollectionQuery,
  defaultersQuery,
  previousSessionDuesQuery,
  statusListQuery,
} from './reports.schemas.js';

// Mounted behind requireAuth in app.ts. Only daily collection is open to Staff (own receipts).
export const reportsRouter = Router();
const admin = requireRole('ADMIN');

reportsRouter.get(
  '/daily-collection',
  validate({ query: dailyCollectionQuery }),
  controller.dailyCollection,
);
reportsRouter.get(
  '/collection',
  admin,
  validate({ query: collectionQuery }),
  controller.collection,
);
reportsRouter.get('/class-wise', admin, validate({ query: classWiseQuery }), controller.classWise);
reportsRouter.get(
  '/defaulters',
  admin,
  validate({ query: defaultersQuery }),
  controller.defaulters,
);
reportsRouter.get(
  '/status-list',
  admin,
  validate({ query: statusListQuery }),
  controller.statusList,
);
reportsRouter.get(
  '/previous-session-dues',
  admin,
  validate({ query: previousSessionDuesQuery }),
  controller.previousSessionDues,
);
