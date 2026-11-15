import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { env } from './config/env.js';
import { logger } from './common/logger.js';
import { requireAuth } from './common/middleware/auth.js';
import { errorHandler } from './common/middleware/errorHandler.js';
import { notFound } from './common/middleware/notFound.js';
import { createApiLimiter, createLoginLimiter } from './common/middleware/rateLimit.js';
import { createAuthRouter } from './modules/auth/auth.routes.js';
import { healthRouter } from './modules/health/health.routes.js';
import { settingsRouter } from './modules/settings/settings.routes.js';
import { usersRouter } from './modules/users/users.routes.js';

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
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
  api.use('/settings', ...authed, settingsRouter);
  app.use('/api/v1', api);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
