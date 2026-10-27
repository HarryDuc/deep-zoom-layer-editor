import {
  ArgumentsHost,
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import type { Response } from 'express';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { ApplicationError } from '../errors/application.error';

interface CapturedResponse {
  status: number;
  body: unknown;
}

/** Builds an `ArgumentsHost` stub that records the JSON response. */
function makeHost(): { host: ArgumentsHost; captured: CapturedResponse } {
  const captured: CapturedResponse = { status: 0, body: undefined };
  const response = {
    headersSent: false,
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(body: unknown) {
      captured.body = body;
      return this;
    },
  };

  const host = {
    switchToHttp: () => ({
      getResponse: () => response as unknown as Response,
      getRequest: () => ({
        method: 'GET',
        originalUrl: '/images/abc/layers',
      }),
    }),
  } as unknown as ArgumentsHost;

  return { host, captured };
}

describe('AllExceptionsFilter', () => {
  let filter: AllExceptionsFilter;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    filter = new AllExceptionsFilter();
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('keeps the code and status of an ApplicationError', () => {
    const { host, captured } = makeHost();

    filter.catch(ApplicationError.notFound('LAYER_NOT_FOUND', 'Layer missing'), host);

    expect(captured.status).toBe(HttpStatus.NOT_FOUND);
    expect(captured.body).toMatchObject({
      statusCode: HttpStatus.NOT_FOUND,
      code: 'LAYER_NOT_FOUND',
      message: 'Layer missing',
      path: '/images/abc/layers',
    });
    expect((captured.body as { timestamp: string }).timestamp).toMatch(
      /^\d{4}-\d{2}-\d{2}T/,
    );
  });

  it('derives a fallback code from the HTTP status of a plain HttpException', () => {
    const { host, captured } = makeHost();

    filter.catch(new ForbiddenException('Nope'), host);

    expect(captured.status).toBe(HttpStatus.FORBIDDEN);
    expect(captured.body).toMatchObject({
      statusCode: HttpStatus.FORBIDDEN,
      code: 'HTTP_403',
    });
  });

  it('prefers the code carried by the exception body', () => {
    const { host, captured } = makeHost();

    filter.catch(
      new HttpException({ code: 'CUSTOM_CODE', message: 'Custom' }, HttpStatus.CONFLICT),
      host,
    );

    expect(captured.body).toMatchObject({ code: 'CUSTOM_CODE', message: 'Custom' });
  });

  it('preserves a validation message array', () => {
    const { host, captured } = makeHost();

    filter.catch(
      new BadRequestException({ message: ['a must be a string', 'b must be a number'] }),
      host,
    );

    expect(captured.body).toMatchObject({
      message: ['a must be a string', 'b must be a number'],
    });
  });

  it('uses a string response body as the message', () => {
    const { host, captured } = makeHost();

    filter.catch(new HttpException('Plain text', HttpStatus.BAD_REQUEST), host);

    expect(captured.body).toMatchObject({ message: 'Plain text' });
  });

  it('maps a payload-too-large error to a stable code and message', () => {
    const { host, captured } = makeHost();

    filter.catch(new PayloadTooLargeException('File too large'), host);

    expect(captured.status).toBe(HttpStatus.PAYLOAD_TOO_LARGE);
    expect(captured.body).toMatchObject({
      code: 'PAYLOAD_TOO_LARGE',
      message: 'Uploaded file exceeds the configured size limit',
    });
  });

  it('hides internal details of an unknown error behind a 500', () => {
    const { host, captured } = makeHost();

    filter.catch(new Error('connection to /secret/path failed'), host);

    expect(captured.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(captured.body).toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Internal server error',
    });
    expect(JSON.stringify(captured.body)).not.toContain('/secret/path');
  });

  it('logs the stack of an unknown error', () => {
    const { host } = makeHost();

    filter.catch(new Error('boom'), host);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toContain('GET /images/abc/layers');
  });

  it('does not log an expected ApplicationError', () => {
    const { host } = makeHost();

    filter.catch(ApplicationError.badRequest('BAD', 'Nope'), host);

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('does not write a body when the response was already sent', () => {
    const { host, captured } = makeHost();
    const response: { headersSent: boolean; status: jest.Mock; json: jest.Mock } =
      host.switchToHttp().getResponse();
    response.headersSent = true;

    filter.catch(new Error('boom'), host);

    expect(captured.body).toBeUndefined();
    expect(captured.status).toBe(0);
  });

  it('handles a thrown non-Error value', () => {
    const { host, captured } = makeHost();

    filter.catch('just a string', host);

    expect(captured.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(captured.body).toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  });

  it('keeps a NotFoundException message', () => {
    const { host, captured } = makeHost();

    filter.catch(new NotFoundException('Missing'), host);

    expect(captured.status).toBe(HttpStatus.NOT_FOUND);
    expect(captured.body).toMatchObject({ message: 'Missing' });
  });
});
