import type { Request, Response, NextFunction } from 'express';

export interface SanitizedError {
  status: number;
  message: string;
  code?: string;
}

export function sanitizeError(err: unknown): SanitizedError {
  if (err && typeof err === 'object' && 'status' in err && typeof err.status === 'number') {
    const message =
      'message' in err && typeof err.message === 'string'
        ? err.message
        : 'Request failed';
    const code = 'code' in err && typeof err.code === 'string' ? err.code : undefined;
    return { status: err.status, message, code };
  }
  if (err instanceof Error) {
    return { status: 500, message: 'Internal error' };
  }
  return { status: 500, message: 'Internal error' };
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const sanitized = sanitizeError(err);
  res.status(sanitized.status).json({
    error: sanitized.message,
    code: sanitized.code,
  });
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}
