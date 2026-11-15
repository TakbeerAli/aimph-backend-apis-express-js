import { pino } from 'pino';
import { env, isTest } from '../config/env.js';

// Paths are redacted wherever they appear in a log object (request headers, bodies, errors).
export const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.currentPassword',
  '*.newPassword',
  '*.passwordHash',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.refreshTokenHash',
];

export const logger = pino({
  level: isTest ? 'silent' : 'info',
  redact: { paths: redactPaths, censor: '[REDACTED]' },
  ...(env.NODE_ENV === 'development' && {
    transport: { target: 'pino-pretty', options: { translateTime: 'SYS:standard' } },
  }),
});
