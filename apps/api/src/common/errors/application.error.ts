import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Application-level error carrying a stable machine-readable `code` used by the
 * global exception filter. Message text is always safe to expose to clients.
 */
export class ApplicationError extends HttpException {
  constructor(
    readonly code: string,
    message: string,
    status: HttpStatus = HttpStatus.BAD_REQUEST,
  ) {
    super({ code, message }, status);
  }

  static notFound(code: string, message: string): ApplicationError {
    return new ApplicationError(code, message, HttpStatus.NOT_FOUND);
  }

  static badRequest(code: string, message: string): ApplicationError {
    return new ApplicationError(code, message, HttpStatus.BAD_REQUEST);
  }

  static conflict(code: string, message: string): ApplicationError {
    return new ApplicationError(code, message, HttpStatus.CONFLICT);
  }

  static unprocessable(code: string, message: string): ApplicationError {
    return new ApplicationError(code, message, HttpStatus.UNPROCESSABLE_ENTITY);
  }

  static internal(code: string, message: string): ApplicationError {
    return new ApplicationError(code, message, HttpStatus.INTERNAL_SERVER_ERROR);
  }
}
