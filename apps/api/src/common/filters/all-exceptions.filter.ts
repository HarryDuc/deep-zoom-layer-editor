import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import type { ApiErrorBody } from '@deep-zoom/shared-types';
import { ApplicationError } from '../errors/application.error';

const FALLBACK_MESSAGE = 'Internal server error';

interface NormalizedError {
  statusCode: number;
  code: string;
  message: string | string[];
  logStack?: string;
}

function normalize(exception: unknown): NormalizedError {
  if (exception instanceof ApplicationError) {
    return {
      statusCode: exception.getStatus(),
      code: exception.code,
      message: exception.message,
    };
  }

  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const response = exception.getResponse();

    let message: string | string[] = exception.message;
    let code = `HTTP_${status}`;

    if (typeof response === 'string') {
      message = response;
    } else if (response && typeof response === 'object') {
      const body = response as Record<string, unknown>;
      const rawMessage = body.message;
      if (typeof rawMessage === 'string' || Array.isArray(rawMessage)) {
        message = rawMessage as string | string[];
      }
      if (typeof body.code === 'string') {
        code = body.code;
      }
      // Multer errors surface as `{ message: 'File too large' }` with a 413 status.
      if (status === Number(HttpStatus.PAYLOAD_TOO_LARGE)) {
        code = 'PAYLOAD_TOO_LARGE';
        message = 'Uploaded file exceeds the configured size limit';
      }
    }

    return { statusCode: status, code, message };
  }

  const error = exception as { message?: unknown; stack?: unknown };
  return {
    statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
    code: 'INTERNAL_SERVER_ERROR',
    message: FALLBACK_MESSAGE,
    logStack: typeof error?.stack === 'string' ? error.stack : String(exception),
  };
}

/**
 * Converts every thrown error into a single, consistent JSON envelope and makes
 * sure internal details (stack traces, filesystem paths, driver errors) never
 * reach the client.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const normalized = normalize(exception);

    if (normalized.logStack) {
      this.logger.error(
        `Unhandled exception on ${request.method} ${request.originalUrl}`,
        normalized.logStack,
      );
    }

    const body: ApiErrorBody = {
      statusCode: normalized.statusCode,
      code: normalized.code,
      message: normalized.message,
      path: request.originalUrl,
      timestamp: new Date().toISOString(),
    };

    if (response.headersSent) {
      return;
    }

    response.status(normalized.statusCode).json(body);
  }
}
