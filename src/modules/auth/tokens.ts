import { createHash, randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { env } from '../../config/env.js';
import { AppError } from '../../common/errors.js';

const ISSUER = 'al-mahdi-api';
const ALG = 'HS256';
const encoder = new TextEncoder();
const accessKey = encoder.encode(env.JWT_ACCESS_SECRET);
const refreshKey = encoder.encode(env.JWT_REFRESH_SECRET);

const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

/** "15m" → 900. The format is already validated in env.ts. */
export function ttlToSeconds(ttl: string): number {
  return Number(ttl.slice(0, -1)) * (UNIT_SECONDS[ttl.slice(-1)] ?? 1);
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  /** Seconds until the access token expires. */
  accessTokenExpiresIn: number;
}

async function sign(userId: string, audience: 'access' | 'refresh'): Promise<string> {
  const isAccess = audience === 'access';
  return new SignJWT({})
    .setProtectedHeader({ alg: ALG })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setAudience(audience)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(isAccess ? env.ACCESS_TOKEN_TTL : env.REFRESH_TOKEN_TTL)
    .sign(isAccess ? accessKey : refreshKey);
}

export async function issueTokens(userId: string): Promise<TokenPair> {
  const [accessToken, refreshToken] = await Promise.all([
    sign(userId, 'access'),
    sign(userId, 'refresh'),
  ]);
  return { accessToken, refreshToken, accessTokenExpiresIn: ttlToSeconds(env.ACCESS_TOKEN_TTL) };
}

async function verify(token: string, audience: 'access' | 'refresh'): Promise<string> {
  try {
    const { payload } = await jwtVerify(token, audience === 'access' ? accessKey : refreshKey, {
      issuer: ISSUER,
      audience,
      algorithms: [ALG],
    });
    if (!payload.sub) throw new Error('Token has no subject');
    return payload.sub;
  } catch {
    throw new AppError('UNAUTHORIZED', 'Your session has expired. Please log in again.');
  }
}

/** Returns the user id, or throws UNAUTHORIZED. */
export const verifyAccessToken = (token: string): Promise<string> => verify(token, 'access');
export const verifyRefreshToken = (token: string): Promise<string> => verify(token, 'refresh');

/** Refresh tokens are stored only as a SHA-256 hash. */
export const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');
