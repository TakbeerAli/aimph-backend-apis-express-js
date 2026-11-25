import { writeAudit } from '../../common/audit.js';
import { AppError } from '../../common/errors.js';
import { logger } from '../../common/logger.js';
import type { AuthUser } from '../../common/middleware/auth.js';
import { withTransaction } from '../../db/transaction.js';
import { User, type UserDoc } from '../users/users.model.js';
import type { ChangePasswordInput, LoginInput } from './auth.schemas.js';
import { hashPassword, verifyAgainstDummy, verifyPassword } from './password.js';
import { hashToken, issueTokens, verifyRefreshToken, type TokenPair } from './tokens.js';

export interface LoginResult extends TokenPair {
  user: UserDoc;
}

const invalidLogin = () =>
  new AppError('UNAUTHORIZED', 'Wrong username, password or device. Please try again.');

const sessionEnded = () =>
  new AppError('UNAUTHORIZED', 'Your session has ended. Please log in again.');

export async function login(input: LoginInput): Promise<LoginResult> {
  const found = await User.findOne({ username: input.username }).select('+passwordHash');
  const passwordOk = found
    ? await verifyPassword(input.password, found.passwordHash)
    : await verifyAgainstDummy(input.password);

  const failure = !found
    ? 'UNKNOWN_USER'
    : !passwordOk
      ? 'WRONG_PASSWORD'
      : !found.isActive
        ? 'INACTIVE'
        : found.deviceCode !== input.deviceCode
          ? 'DEVICE_MISMATCH'
          : null;

  if (failure || !found) {
    // Not in a transaction: the failed attempt must be recorded even though we throw.
    await writeAudit(null, {
      action: 'LOGIN_FAILED',
      userId: found?._id ?? null,
      entity: 'user',
      entityId: found?._id ?? null,
      deviceCode: input.deviceCode,
      after: { username: input.username },
      reason: failure ?? 'UNKNOWN_USER',
    });
    throw invalidLogin();
  }

  const tokens = await issueTokens(found._id);
  const user = await withTransaction(async (session) => {
    const user = await User.findById(found._id).session(session);
    if (!user) throw invalidLogin();
    user.refreshTokenHash = hashToken(tokens.refreshToken);
    user.lastLoginAt = new Date();
    await user.save({ session });
    await writeAudit(session, {
      action: 'LOGIN',
      userId: user._id,
      entity: 'user',
      entityId: user._id,
      deviceCode: user.deviceCode,
    });
    return user;
  });

  return { ...tokens, user };
}

/**
 * Swaps a valid refresh token for a new pair. The stored hash is replaced atomically, so each
 * refresh token works exactly once. Presenting an old (already used) token revokes the session.
 */
export async function refresh(refreshToken: string): Promise<TokenPair> {
  const userId = await verifyRefreshToken(refreshToken);
  const presentedHash = hashToken(refreshToken);
  const tokens = await issueTokens(userId);

  const outcome = await withTransaction(async (session) => {
    const rotated = await User.findOneAndUpdate(
      { _id: userId, isActive: true, refreshTokenHash: presentedHash },
      { $set: { refreshTokenHash: hashToken(tokens.refreshToken) } },
      { session },
    );
    if (rotated) return 'ROTATED';

    // Signed by us but not the current token: reused, logged out, or user inactive.
    const revoked = await User.updateOne(
      { _id: userId, refreshTokenHash: { $ne: null } },
      { $set: { refreshTokenHash: null } },
      { session },
    );
    return revoked.modifiedCount > 0 ? 'REVOKED' : 'NONE';
  });

  if (outcome === 'ROTATED') return tokens;
  if (outcome === 'REVOKED') {
    logger.warn({ userId }, 'Refresh token reuse detected; session revoked');
  }
  throw sessionEnded();
}

export async function logout(user: AuthUser): Promise<void> {
  await withTransaction(async (session) => {
    await User.updateOne({ _id: user.id }, { $set: { refreshTokenHash: null } }, { session });
  });
}

export async function me(user: AuthUser): Promise<UserDoc> {
  const found = await User.findById(user.id);
  if (!found) throw new AppError('UNAUTHORIZED', 'Please log in.');
  return found;
}

/** Changes the password and returns a fresh token pair, so this phone stays logged in. */
export async function changePassword(
  authUser: AuthUser,
  input: ChangePasswordInput,
): Promise<TokenPair> {
  const current = await User.findById(authUser.id).select('+passwordHash');
  if (!current || !(await verifyPassword(input.currentPassword, current.passwordHash))) {
    throw new AppError('VALIDATION_ERROR', 'Current password is incorrect.');
  }

  const [passwordHash, tokens] = await Promise.all([
    hashPassword(input.newPassword),
    issueTokens(authUser.id),
  ]);

  await withTransaction(async (session) => {
    const user = await User.findById(authUser.id).session(session);
    if (!user) throw new AppError('UNAUTHORIZED', 'Please log in.');
    user.passwordHash = passwordHash;
    user.refreshTokenHash = hashToken(tokens.refreshToken);
    user.mustChangePassword = false;
    await user.save({ session });
    await writeAudit(session, {
      action: 'PASSWORD_CHANGE',
      userId: user._id,
      entity: 'user',
      entityId: user._id,
    });
  });
  return tokens;
}
