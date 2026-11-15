import type { ErrorRequestHandler } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { AppError } from '../errors.js';

interface MongoDuplicateKeyError {
  code: 11000;
  keyValue?: Record<string, unknown>;
}

const isDuplicateKeyError = (err: unknown): err is MongoDuplicateKeyError =>
  typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 11000;

/** Errors raised by express.json() carry a `type` string. */
const bodyParserType = (err: unknown): string | undefined =>
  typeof err === 'object' && err !== null && typeof (err as { type?: unknown }).type === 'string'
    ? (err as { type: string }).type
    : undefined;

/** Turns any thrown value into an AppError the client may see. */
function toAppError(err: unknown): AppError | null {
  if (err instanceof AppError) return err;
  if (err instanceof z.ZodError) {
    return new AppError('VALIDATION_ERROR', 'Some fields are invalid.', z.flattenError(err));
  }
  if (err instanceof mongoose.Error.ValidationError) {
    const fields = Object.fromEntries(
      Object.entries(err.errors).map(([path, e]) => [path, e.message]),
    );
    return new AppError('VALIDATION_ERROR', 'Some fields are invalid.', { fields });
  }
  if (err instanceof mongoose.Error.CastError) {
    return new AppError('VALIDATION_ERROR', `Invalid value for ${err.path}.`);
  }
  // The sync plugin adds `version` to save() filters, so a stale save matches no document.
  if (
    err instanceof mongoose.Error.VersionError ||
    err instanceof mongoose.Error.DocumentNotFoundError
  ) {
    return new AppError('VERSION_CONFLICT', 'This record was changed by someone else.');
  }
  if (isDuplicateKeyError(err)) {
    const fields = Object.keys(err.keyValue ?? {});
    return new AppError('CONFLICT', 'A record with the same value already exists.', { fields });
  }
  switch (bodyParserType(err)) {
    case 'entity.parse.failed':
      return new AppError('VALIDATION_ERROR', 'Request body is not valid JSON.');
    case 'entity.too.large':
      return new AppError('PAYLOAD_TOO_LARGE', 'Request body is too large.');
    default:
      return null;
  }
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const appError = toAppError(err);

  if (appError) {
    res.status(appError.status).json({
      error: {
        code: appError.code,
        message: appError.message,
        details: appError.details ?? {},
      },
    });
    return;
  }

  // Unexpected: log the full error, never send the stack to the client.
  req.log.error({ err }, 'Unhandled error');
  res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'Something went wrong.', details: {} },
  });
};
