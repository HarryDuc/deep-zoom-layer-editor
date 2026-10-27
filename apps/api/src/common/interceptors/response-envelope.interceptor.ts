import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  StreamableFile,
} from '@nestjs/common';
import { Observable, map } from 'rxjs';

export interface PaginatedPayload<T> {
  items: T[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}

function isPaginatedPayload(value: unknown): value is PaginatedPayload<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !(value instanceof StreamableFile) &&
    !Buffer.isBuffer(value) &&
    Array.isArray((value as PaginatedPayload<unknown>).items) &&
    typeof (value as PaginatedPayload<unknown>).meta === 'object'
  );
}

/**
 * Wraps successful JSON responses in a stable envelope:
 *  - plain value        -> { data: value }
 *  - paginated payload  -> { data: [...], meta: {...} }
 *
 * Raw payloads (strings such as the DZI XML descriptor, Buffers and
 * StreamableFile downloads) are passed through untouched so their
 * Content-Type and byte content stay intact.
 */
@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      map((value: unknown) => {
        if (value === undefined || value === null) {
          return value;
        }
        if (typeof value === 'string' || Buffer.isBuffer(value) || value instanceof StreamableFile) {
          return value;
        }
        if (isPaginatedPayload(value)) {
          return { data: value.items, meta: value.meta };
        }
        return { data: value };
      }),
    );
  }
}
