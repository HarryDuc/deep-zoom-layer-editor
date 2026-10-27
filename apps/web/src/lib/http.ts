import type { ApiErrorBody, ApiResponse, PaginatedApiResponse } from '@deep-zoom/shared-types';
import { API_BASE_URL } from './api-config';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: string | string[],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function messageFromBody(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const raw = (body as { message?: unknown }).message;
    if (typeof raw === 'string' && raw.length > 0) return raw;
    if (Array.isArray(raw) && raw.length > 0) return raw.join(', ');
  }
  return fallback;
}

async function parseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
        ...init?.headers,
      },
      cache: 'no-store',
    });
  } catch {
    // Network/DNS failure: surface a stable message instead of "Failed to fetch".
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the API. Is the backend running?');
  }

  const body = await parseJson(response);

  if (!response.ok) {
    const errorBody = body as ApiErrorBody | undefined;
    throw new ApiError(
      response.status,
      errorBody?.code ?? `HTTP_${response.status}`,
      messageFromBody(body, response.statusText || 'Request failed'),
      errorBody?.message,
    );
  }

  return body as T;
}

/** GET wrapper that unwraps the `{ data }` envelope. */
export async function getJson<T>(path: string): Promise<T> {
  const body = await request<ApiResponse<T>>(path, { method: 'GET' });
  return body.data;
}

/** GET wrapper for paginated endpoints, preserving `meta`. */
export async function getPaginated<T>(path: string): Promise<PaginatedApiResponse<T>> {
  return request<PaginatedApiResponse<T>>(path, { method: 'GET' });
}

export async function postJson<T>(path: string, payload: unknown): Promise<T> {
  const body = await request<ApiResponse<T>>(path, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return body.data;
}

export async function patchJson<T>(path: string, payload: unknown): Promise<T> {
  const body = await request<ApiResponse<T>>(path, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
  return body.data;
}

export async function postForm<T>(path: string, form: FormData): Promise<T> {
  const body = await request<ApiResponse<T>>(path, { method: 'POST', body: form });
  return body.data;
}

export async function deleteResource(path: string): Promise<void> {
  await request<undefined>(path, { method: 'DELETE' });
}
