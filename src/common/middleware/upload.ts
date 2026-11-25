import type { RequestHandler } from 'express';
import multer from 'multer';
import { AppError } from '../errors.js';
import {
  IMAGE_RULE_MESSAGE,
  MAX_IMAGE_BYTES,
  detectImageType,
} from '../storage/imageProcessing.js';

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 5 },
  fileFilter: (_req, file, done) => {
    if (file.mimetype === 'image/png' || file.mimetype === 'image/jpeg') {
      done(null, true);
    } else {
      done(new AppError('UNSUPPORTED_FILE', IMAGE_RULE_MESSAGE));
    }
  },
}).single('file');

/**
 * Accepts one PNG/JPEG (max 2 MB) in the multipart field "file", checks its magic bytes, and
 * leaves it in req.file.buffer. Errors use the standard error format.
 */
export const singleImage: RequestHandler = (req, res, next) => {
  imageUpload(req, res, (err: unknown) => {
    if (err instanceof AppError) return next(err);
    if (err instanceof multer.MulterError) {
      return next(
        err.code === 'LIMIT_FILE_SIZE'
          ? new AppError('PAYLOAD_TOO_LARGE', IMAGE_RULE_MESSAGE)
          : new AppError('VALIDATION_ERROR', 'Send one image in the field "file".'),
      );
    }
    if (err) return next(err);
    if (!req.file) {
      return next(new AppError('VALIDATION_ERROR', 'Send one image in the field "file".'));
    }
    if (!detectImageType(req.file.buffer)) {
      return next(new AppError('UNSUPPORTED_FILE', IMAGE_RULE_MESSAGE));
    }
    next();
  });
};
