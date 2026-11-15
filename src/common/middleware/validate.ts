import type { RequestHandler } from 'express';
import { z } from 'zod';
import { AppError } from '../errors.js';

interface Schemas {
  body?: z.ZodType;
  params?: z.ZodType;
  query?: z.ZodType;
}

/**
 * Validates and replaces req.body / req.params / req.query with the parsed values.
 * z.object() strips unknown keys, so only declared fields reach the services.
 */
export function validate(schemas: Schemas): RequestHandler {
  return (req, _res, next) => {
    const issues: Record<string, unknown> = {};

    for (const part of ['params', 'query', 'body'] as const) {
      const schema = schemas[part];
      if (!schema) continue;
      const result = schema.safeParse(req[part] ?? {});
      if (!result.success) {
        issues[part] = z.flattenError(result.error);
        continue;
      }
      if (part === 'query') {
        // Express 5 exposes req.query as a getter, so shadow it with the parsed value.
        Object.defineProperty(req, 'query', { value: result.data, writable: true });
      } else {
        req[part] = result.data as never;
      }
    }

    if (Object.keys(issues).length > 0) {
      next(new AppError('VALIDATION_ERROR', 'Some fields are invalid.', issues));
      return;
    }
    next();
  };
}
