import { z } from 'zod';

/** "2026-27": a start year and the next year's last two digits (April to March). */
export const sessionName = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}$/, 'Use the format 2026-27.')
  .refine((name) => (Number(name.slice(0, 4)) + 1) % 100 === Number(name.slice(5)), {
    message: 'The second year must follow the first, e.g. 2026-27.',
  });

export const createSessionBody = z.object({ name: sessionName });

export type CreateSessionInput = z.infer<typeof createSessionBody>;
