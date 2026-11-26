import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import { buildOpenApiDocument } from './docs/openapi.js';
import { env } from './config/env.js';
import { logger } from './common/logger.js';
import { requireAuth } from './common/middleware/auth.js';
import { errorHandler } from './common/middleware/errorHandler.js';
import { notFound } from './common/middleware/notFound.js';
import { createApiLimiter, createLoginLimiter } from './common/middleware/rateLimit.js';
import { createAuthRouter } from './modules/auth/auth.routes.js';
import { certificatesRouter } from './modules/certificates/certificates.routes.js';
import { classesRouter } from './modules/classes/classes.routes.js';
import { healthRouter } from './modules/health/health.routes.js';
import { sessionsRouter } from './modules/sessions/sessions.routes.js';
import { settingsRouter } from './modules/settings/settings.routes.js';
import { studentsRouter } from './modules/students/students.routes.js';
import { feeStructuresRouter } from './modules/fee-structures/fee-structures.routes.js';
import { vouchersRouter } from './modules/vouchers/vouchers.routes.js';
import { paymentsRouter } from './modules/payments/payments.routes.js';
import { dashboardRouter } from './modules/dashboard/dashboard.routes.js';
import { reportsRouter } from './modules/reports/reports.routes.js';
import { setupRouter } from './modules/setup/setup.routes.js';
import { syncRouter } from './modules/sync/sync.routes.js';
import { teachersRouter, usersRouter } from './modules/users/users.routes.js';
import { calendarRouter } from './modules/calendar/calendar.routes.js';

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  // Behind a host's proxy (Render, Railway, nginx) req.ip must come from X-Forwarded-For,
  // or rate limits would treat every user as one IP.
  app.set('trust proxy', env.TRUST_PROXY);
  app.use(helmet());
  app.use(
    cors({
      // Requests without an Origin header (the Android app, curl) are allowed;
      // browsers are limited to the allow-list.
      origin: (origin, callback) => {
        callback(null, !origin || env.CORS_ORIGINS.includes(origin));
      },
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(
    pinoHttp({
      logger,
      genReqId: (_req, res) => {
        const id = randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
    }),
  );

  const apiLimiter = createApiLimiter();
  const authed = [requireAuth, apiLimiter];

  const api = express.Router();
  api.use('/health', healthRouter);
  api.use('/auth', createAuthRouter({ login: createLoginLimiter(), api: apiLimiter }));
  api.use('/users', ...authed, usersRouter);
  api.use('/teachers', ...authed, teachersRouter);
  api.use('/calendar', ...authed, calendarRouter);
  api.use('/settings', ...authed, settingsRouter);
  api.use('/sessions', ...authed, sessionsRouter);
  api.use('/classes', ...authed, classesRouter);
  api.use('/students', ...authed, studentsRouter);
  api.use('/fee-structures', ...authed, feeStructuresRouter);
  api.use('/vouchers', ...authed, vouchersRouter);
  api.use('/payments', ...authed, paymentsRouter);
  api.use('/dashboard', ...authed, dashboardRouter);
  api.use('/reports', ...authed, reportsRouter);
  api.use('/sync', ...authed, syncRouter);
  api.use('/setup', ...authed, setupRouter);
  api.use('/certificates', ...authed, certificatesRouter);
  app.use('/api/v1', api);

  // API docs, generated from the same Zod schemas the routes use.
  const openApi = buildOpenApiDocument();
  app.get('/docs/openapi.json', (_req, res) => {
    res.json(openApi);
  });
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openApi, { customSiteTitle: 'Al-Mahdi API' }));

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
