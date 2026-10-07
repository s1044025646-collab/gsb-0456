export type ErrorCode =
  | 'EMPTY_MATRIX'
  | 'NOT_RECTANGULAR'
  | 'EMPTY_ROW'
  | 'INVALID_VALUE'
  | 'INVALID_DIMENSIONS'
  | 'INVALID_MODE'
  | 'INVALID_BOUNDARY'
  | 'INVALID_PARAM'
  | 'BAD_JSON'
  | 'BODY_TOO_LARGE'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INTERNAL';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, status = 400, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}
