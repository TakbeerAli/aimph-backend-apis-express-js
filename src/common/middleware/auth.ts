import type { Request, RequestHandler } from 'express';
import { AppError } from '../errors.js';
import { verifyAccessToken } from '../../modules/auth/tokens.js';
import { User, type Role } from '../../modules/users/users.model.js';

export interface AuthUser {
  id: string;
  username: string;
  fullName: string;
  role: Role;
  deviceCode: string;
  assignedSectionIds: string[];
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser;
  }
}

/**
 * Verifies the Bearer access token and loads the user on every request, so role changes
 * and deactivation take effect immediately.
 */
export const requireAuth: RequestHandler = async (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    throw new AppError('UNAUTHORIZED', 'Please log in.');
  }
  const userId = await verifyAccessToken(header.slice('Bearer '.length));

  const user = await User.findById(userId)
    .select('username fullName role deviceCode assignedSectionIds isActive')
    .lean();
  if (!user?.isActive) {
    throw new AppError('UNAUTHORIZED', 'Your account is not active. Please log in again.');
  }

  req.user = {
    id: user._id,
    username: user.username,
    fullName: user.fullName,
    role: user.role,
    deviceCode: user.deviceCode,
    assignedSectionIds: user.assignedSectionIds,
  };
  next();
};

export function requireRole(...roles: Role[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      throw new AppError('FORBIDDEN', 'You do not have permission to do this.');
    }
    next();
  };
}

/** The logged-in user. Use only on routes behind requireAuth. */
export function authUser(req: Request): AuthUser {
  if (!req.user) throw new AppError('UNAUTHORIZED', 'Please log in.');
  return req.user;
}
