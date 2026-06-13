export class AppError extends Error {
  readonly code: string;
  readonly statusCode: number;
  override readonly cause?: unknown;

  constructor(message: string, code: string, statusCode = 500, cause?: unknown) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = statusCode;
    this.cause = cause;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class DomainError extends AppError {
  constructor(message: string, code: string, cause?: unknown) {
    super(message, code, 422, cause);
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id?: string) {
    super(
      id ? `${resource} '${id}' not found` : `${resource} not found`,
      'NOT_FOUND',
      404,
    );
  }
}

export class ValidationError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(message, 'VALIDATION_ERROR', 400, cause);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(message, 'UNAUTHORIZED', 401);
  }
}

export class ToolError extends AppError {
  constructor(
    public readonly toolName: string,
    message: string,
    cause?: unknown,
  ) {
    super(`Tool '${toolName}' failed: ${message}`, 'TOOL_ERROR', 500, cause);
  }
}

export class PermissionDeniedError extends AppError {
  constructor(action: string, resource?: string) {
    super(
      resource
        ? `Permission denied: cannot '${action}' on '${resource}'`
        : `Permission denied: '${action}'`,
      'PERMISSION_DENIED',
      403,
    );
  }
}
