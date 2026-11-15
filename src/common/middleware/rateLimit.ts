import type { Request } from 'express';
import { ipKeyGenerator, rateLimit, type RateLimitRequestHandler } from 'express-rate-limit';
import { AppError } from '../errors.js';

const clientIp = (req: Request): string => ipKeyGenerator(req.ip ?? 'unknown');

function bodyUsername(req: Request): string {
  const body: unknown = req.body;
  if (typeof body === 'object' && body !== null && 'username' in body) {
    return String(body.username).trim().toLowerCase();
  }
  return '';
}

// Each call creates a fresh in-memory store, so every app instance (and test) starts clean.

/** /auth/login: 5 failed attempts per 15 minutes per IP + username. */
export function createLoginLimiter(): RateLimitRequestHandler {
  return rateLimit({
    windowMs: 15 * 60_000,
    limit: 5,
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: (req) => `${clientIp(req)}:${bodyUsername(req)}`,
    handler: (_req, _res, next) => {
      next(
        new AppError('RATE_LIMITED', 'Too many login attempts. Please try again in 15 minutes.'),
      );
    },
  });
}

/** Rest of the API: 300 requests per minute per user (per IP before login). */
export function createApiLimiter(): RateLimitRequestHandler {
  return rateLimit({
    windowMs: 60_000,
    limit: 300,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: (req) => req.user?.id ?? clientIp(req),
    handler: (_req, _res, next) => {
      next(new AppError('RATE_LIMITED', 'Too many requests. Please slow down.'));
    },
  });
}
