import { z } from 'zod';
import { newPassword } from '../users/users.schemas.js';

export const loginBody = z.object({
  username: z.string().trim().toLowerCase().min(1).max(30),
  password: z.string().min(1).max(200),
  deviceCode: z.string().trim().toUpperCase().min(1).max(5),
});

export const refreshBody = z.object({
  refreshToken: z.string().min(1).max(2000),
});

export const changePasswordBody = z
  .object({
    currentPassword: z.string().min(1).max(200),
    newPassword,
  })
  .refine((b) => b.currentPassword !== b.newPassword, {
    message: 'New password must be different from the current one.',
    path: ['newPassword'],
  });

export type LoginInput = z.infer<typeof loginBody>;
export type RefreshInput = z.infer<typeof refreshBody>;
export type ChangePasswordInput = z.infer<typeof changePasswordBody>;
