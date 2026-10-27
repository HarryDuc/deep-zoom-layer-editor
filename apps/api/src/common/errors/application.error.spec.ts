import { HttpStatus } from '@nestjs/common';
import { ApplicationError } from './application.error';

describe('ApplicationError', () => {
  it('carries the code and message in the response body', () => {
    const error = new ApplicationError('CUSTOM_CODE', 'Something went wrong');

    expect(error.code).toBe('CUSTOM_CODE');
    expect(error.message).toBe('Something went wrong');
    expect(error.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect(error.getResponse()).toEqual({
      code: 'CUSTOM_CODE',
      message: 'Something went wrong',
    });
  });

  it('defaults to a 400 status', () => {
    expect(new ApplicationError('X', 'y').getStatus()).toBe(HttpStatus.BAD_REQUEST);
  });

  it('builds a 404 error', () => {
    const error = ApplicationError.notFound('NOT_FOUND', 'Gone');

    expect(error.getStatus()).toBe(HttpStatus.NOT_FOUND);
    expect(error.code).toBe('NOT_FOUND');
  });

  it('builds a 400 error', () => {
    expect(ApplicationError.badRequest('BAD', 'Nope').getStatus()).toBe(HttpStatus.BAD_REQUEST);
  });

  it('builds a 409 error', () => {
    expect(ApplicationError.conflict('BUSY', 'Later').getStatus()).toBe(HttpStatus.CONFLICT);
  });

  it('builds a 422 error', () => {
    expect(
      ApplicationError.unprocessable('INVALID', 'Nope').getStatus(),
    ).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
  });

  it('builds a 500 error', () => {
    expect(ApplicationError.internal('BOOM', 'Broke').getStatus()).toBe(
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  });
});
