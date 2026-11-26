import { z } from 'zod';
import { pageQuery } from '../../common/utils/pagination.js';
import { DEVICE_CODE_REGEX } from './users.model.js';

/** bcrypt only uses the first 72 bytes, so longer passwords are rejected rather than truncated. */
export const newPassword = z
  .string()
  .min(8, 'Password must be at least 8 characters.')
  .refine((p) => Buffer.byteLength(p, 'utf8') <= 72, 'Password is too long.');

export const username = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9._]{3,30}$/, 'Use 3–30 letters, numbers, dots or underscores.');

export const fullName = z.string().trim().min(1).max(80);

export const deviceCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(DEVICE_CODE_REGEX, 'Use a short code like S1 (letters and numbers, max 5).');

const id = z.string().min(1).max(64);
const assignedSectionIds = z
  .array(id)
  .max(100)
  .transform((ids) => [...new Set(ids)]);

export const userIdParams = z.object({ id });

export const listUsersQuery = pageQuery(['fullName', 'username', 'createdAt'], 'fullName');

/** Optional mobile number, e.g. 0300-0000000. */
const phone = z
  .string()
  .trim()
  .regex(/^\+?[0-9][0-9 -]{6,18}$/, 'Enter a valid phone number, e.g. 0300-0000000.');

/** POST /teachers. The phone code (T01, T02 …) is given by the server. */
export const createTeacherBody = z.object({
  fullName,
  username,
  password: newPassword,
  phone: phone.optional(),
  assignedSectionIds: assignedSectionIds.default([]),
});

export const updateTeacherBody = z
  .object({ fullName, isActive: z.boolean(), assignedSectionIds, phone: phone.nullable() })
  .partial()
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to update.' });

export const resetPasswordBody = z.object({ newPassword });

export type ListUsersQuery = z.infer<typeof listUsersQuery>;
export type CreateTeacherInput = z.infer<typeof createTeacherBody>;
export type UpdateTeacherInput = z.infer<typeof updateTeacherBody>;
