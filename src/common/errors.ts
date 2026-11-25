export const ERROR_STATUS = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  CLASS_NOT_ASSIGNED: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  SLC_ALREADY_ISSUED: 409,
  VERSION_CONFLICT: 409,
  DUPLICATE_RECEIPT: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_FILE: 415,
  AMOUNT_EXCEEDS_BALANCE: 422,
  VOUCHER_HAS_PAYMENTS: 422,
  STUDENT_NOT_ACTIVE: 422,
  DUES_NOT_CLEAR: 422,
  CERT_SETTINGS_MISSING: 422,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

/** An expected error that is safe to show to the client. */
export class AppError extends Error {
  readonly status: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
    this.status = ERROR_STATUS[code];
  }
}
