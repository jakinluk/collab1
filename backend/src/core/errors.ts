import type { ErrorCode } from '../shared/types';

export class DomainError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export const fail = (code: ErrorCode, message: string, details?: Record<string, unknown>): never => {
  throw new DomainError(code, message, details);
};

export const httpStatusFor = (code: ErrorCode): number =>
  ({
    unauthorized: 401,
    forbidden: 403,
    not_found: 404,
    conflict: 409,
    invalid: 400,
    not_ready: 409,
    path_conflict: 409,
    rate_limited: 429,
    update_required: 426,
  })[code];
