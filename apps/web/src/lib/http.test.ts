import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, deleteResource, getJson, getPaginated, patchJson, postForm, postJson } from './http';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('http client', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('unwraps the data envelope', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, { data: { _id: 'abc' } }));

    await expect(getJson<{ _id: string }>('/images/abc')).resolves.toEqual({ _id: 'abc' });
  });

  it('preserves pagination metadata', async () => {
    const payload = {
      data: [{ _id: 'a' }],
      meta: { page: 2, limit: 10, total: 11, totalPages: 2 },
    };
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, payload));

    const result = await getPaginated<{ _id: string }>('/images?page=2&limit=10');

    expect(result.data).toHaveLength(1);
    expect(result.meta).toMatchObject({ page: 2, total: 11 });
  });

  it('sends JSON for POST and PATCH', async () => {
    // A Response body can only be read once, so each call needs its own.
    vi.mocked(fetch).mockImplementation(async () => jsonResponse(201, { data: { ok: true } }));

    await postJson('/images', { name: 'x' });
    const [, postInit] = vi.mocked(fetch).mock.calls[0];
    expect(postInit?.method).toBe('POST');
    expect(postInit?.body).toBe(JSON.stringify({ name: 'x' }));
    expect((postInit?.headers as Record<string, string>)['Content-Type']).toBe('application/json');

    await patchJson('/layers/1', { visible: false });
    const [, patchInit] = vi.mocked(fetch).mock.calls[1];
    expect(patchInit?.method).toBe('PATCH');
  });

  it('omits the JSON content type for FormData uploads', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(201, { data: { ok: true } }));
    const form = new FormData();
    form.append('file', new File(['x'], 'a.jpg', { type: 'image/jpeg' }));

    await postForm('/images', form);

    const [, init] = vi.mocked(fetch).mock.calls[0];
    const headers = init?.headers as Record<string, string>;
    expect(headers['Content-Type']).toBeUndefined();
    expect(init?.body).toBe(form);
  });

  it('treats an empty response body as success for DELETE', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }));
    await expect(deleteResource('/images/abc')).resolves.toBeUndefined();
  });

  it('throws an ApiError carrying the server code and message', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(400, {
        statusCode: 400,
        code: 'INVALID_GEOMETRY',
        message: 'geometry.points must contain at least 3 points',
        path: '/api/v1/layers/1/objects',
        timestamp: '2026-01-01T00:00:00.000Z',
      }),
    );

    await expect(postJson('/layers/1/objects', {})).rejects.toMatchObject({
      name: 'ApiError',
      status: 400,
      code: 'INVALID_GEOMETRY',
      message: 'geometry.points must contain at least 3 points',
    });
  });

  it('joins validation message arrays into a single message', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(400, {
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        message: ['name should not be empty', 'name must be a string'],
      }),
    );

    await expect(postJson('/images/1/layers', {})).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'name should not be empty, name must be a string',
    });
  });

  it('reports an unreachable API with a stable, actionable message', async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(getJson('/images')).rejects.toMatchObject({
      status: 0,
      code: 'NETWORK_ERROR',
      message: 'Cannot reach the API. Is the backend running?',
    });
  });

  it('never caches API responses', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, { data: [] }));
    await getJson('/images');
    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(init?.cache).toBe('no-store');
  });

  it('falls back to an HTTP_ code when the body has no code', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('not json', { status: 502 }));

    const error = await getJson('/images').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(502);
    expect((error as ApiError).code).toBe('HTTP_502');
  });
});
