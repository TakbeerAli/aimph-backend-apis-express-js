import { existsSync } from 'node:fs';
import { z } from 'zod';

// Load .env when present (Node's built-in loader; real env vars take precedence).
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

const ttl = z.string().regex(/^\d+[smhd]$/, 'Use a number followed by s, m, h or d (e.g. 15m)');

const isValidTimeZone = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']),
    PORT: z.coerce.number().int().min(1).max(65535),
    MONGODB_URI: z.string().startsWith('mongodb'),
    JWT_ACCESS_SECRET: z.string().min(1),
    JWT_REFRESH_SECRET: z.string().min(1),
    ACCESS_TOKEN_TTL: ttl,
    REFRESH_TOKEN_TTL: ttl,
    CORS_ORIGINS: z
      .string()
      .min(1)
      .transform((value) =>
        value
          .split(',')
          .map((origin) => origin.trim())
          .filter(Boolean),
      ),
    TZ_BUSINESS: z.string().refine(isValidTimeZone, 'Must be a valid IANA time zone'),
    /** Number of proxies in front of the app (1 on Render/Railway). 0 when run directly. */
    TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),
    /**
     * Where certificate images (signature, stamp) are stored. "memory" keeps them in the process
     * (tests only). When unset: cloudinary if its credentials are present, otherwise none
     * (uploads answer SERVICE_UNAVAILABLE).
     */
    STORAGE_PROVIDER: z.enum(['cloudinary', 'memory', 'none']).optional(),
    CLOUDINARY_CLOUD_NAME: z.string().min(1).optional(),
    CLOUDINARY_API_KEY: z.string().min(1).optional(),
    CLOUDINARY_API_SECRET: z.string().min(1).optional(),
  })
  .superRefine((env, ctx) => {
    if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_REFRESH_SECRET'],
        message: 'Must differ from JWT_ACCESS_SECRET',
      });
    }
    if (env.STORAGE_PROVIDER === 'cloudinary') {
      for (const key of [
        'CLOUDINARY_CLOUD_NAME',
        'CLOUDINARY_API_KEY',
        'CLOUDINARY_API_SECRET',
      ] as const) {
        if (!env[key]) {
          ctx.addIssue({ code: 'custom', path: [key], message: 'Required for Cloudinary storage' });
        }
      }
    }
    if (env.NODE_ENV === 'production' && env.STORAGE_PROVIDER === 'memory') {
      ctx.addIssue({
        code: 'custom',
        path: ['STORAGE_PROVIDER'],
        message: 'memory storage loses files on restart; use cloudinary in production',
      });
    }
    if (env.NODE_ENV === 'production') {
      for (const key of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'] as const) {
        if (env[key].length < 32) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: 'Must be at least 32 characters in production',
          });
        }
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    // Logger depends on env, so print directly and refuse to start.
    // eslint-disable-next-line no-console
    console.error(`Invalid environment variables:\n${z.prettifyError(result.error)}`);
    process.exit(1);
  }
  return result.data;
}

export const env = loadEnv();
export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
