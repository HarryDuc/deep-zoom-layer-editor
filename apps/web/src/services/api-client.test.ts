import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLayer,
  createLayerObject,
  deleteImage,
  deleteLayer,
  deleteLayerObject,
  fetchImage,
  fetchImageStatus,
  fetchImages,
  fetchLayerObjects,
  fetchLayers,
  reorderLayerObjects,
  updateLayer,
  updateLayerObject,
  uploadImage,
  uploadOverlay,
} from './api-client';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('api-client', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, { data: { ok: true } }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Returns the URL and init of the nth fetch call. */
  const call = (index = 0): { url: string; init?: RequestInit } => {
    const [url, init] = vi.mocked(fetch).mock.calls[index];
    return { url: String(url), init };
  };

  describe('images', () => {
    it('requests a page of images', async () => {
      vi.mocked(fetch).mockResolvedValue(
        jsonResponse(200, {
          data: [],
          meta: { page: 3, limit: 5, total: 0, totalPages: 0 },
        }),
      );

      await fetchImages(3, 5);

      expect(call().url).toContain('/images?page=3&limit=5');
    });

    it('defaults to the first page', async () => {
      await fetchImages();

      expect(call().url).toContain('/images?page=1&limit=20');
    });

    it('requests a single image', async () => {
      await fetchImage('abc');

      expect(call().url).toContain('/images/abc');
      expect(call().init?.method).toBe('GET');
    });

    it('requests the processing status', async () => {
      await fetchImageStatus('abc');

      expect(call().url).toContain('/images/abc/status');
    });

    it('uploads a file without a display name', async () => {
      const file = new File(['x'], 'a.jpg', { type: 'image/jpeg' });

      await uploadImage(file);

      expect(call().url).not.toContain('name=');
      expect(call().init?.method).toBe('POST');
      expect(call().init?.body).toBeInstanceOf(FormData);
    });

    it('uploads a file with a display name', async () => {
      const file = new File(['x'], 'a.jpg', { type: 'image/jpeg' });

      await uploadImage(file, 'Bản đồ vệ tinh');

      expect(call().url).toContain('name=B%E1%BA%A3n%20%C4%91%E1%BB%93%20v%E1%BB%87%20tinh');
    });

    it('ignores a whitespace-only display name', async () => {
      const file = new File(['x'], 'a.jpg', { type: 'image/jpeg' });

      await uploadImage(file, '   ');

      expect(call().url).not.toContain('name=');
    });

    it('deletes an image', async () => {
      vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }));

      await deleteImage('abc');

      expect(call().url).toContain('/images/abc');
      expect(call().init?.method).toBe('DELETE');
    });

    it('uploads an overlay', async () => {
      const file = new File(['x'], 'o.png', { type: 'image/png' });

      await uploadOverlay('abc', file);

      expect(call().url).toContain('/images/abc/overlays');
      expect(call().init?.body).toBeInstanceOf(FormData);
    });
  });

  describe('layers', () => {
    it('lists the layers of an image', async () => {
      await fetchLayers('abc');

      expect(call().url).toContain('/images/abc/layers');
    });

    it('creates a layer', async () => {
      await createLayer('abc', { name: 'Streets' });

      expect(call().url).toContain('/images/abc/layers');
      expect(call().init?.method).toBe('POST');
      expect(call().init?.body).toBe(JSON.stringify({ name: 'Streets' }));
    });

    it('updates a layer', async () => {
      await updateLayer('layer1', { visible: false });

      expect(call().url).toContain('/layers/layer1');
      expect(call().init?.method).toBe('PATCH');
    });

    it('deletes a layer', async () => {
      vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }));

      await deleteLayer('layer1');

      expect(call().url).toContain('/layers/layer1');
      expect(call().init?.method).toBe('DELETE');
    });
  });

  describe('layer objects', () => {
    it('lists the objects of a layer', async () => {
      await fetchLayerObjects('layer1');

      expect(call().url).toContain('/layers/layer1/objects');
    });

    it('creates a layer object', async () => {
      await createLayerObject('layer1', {
        type: 'RECTANGLE',
        geometry: { x: 0, y: 0, width: 10, height: 10 },
      } as never);

      expect(call().url).toContain('/layers/layer1/objects');
      expect(call().init?.method).toBe('POST');
    });

    it('updates a layer object', async () => {
      await updateLayerObject('obj1', { visible: false });

      expect(call().url).toContain('/layer-objects/obj1');
      expect(call().init?.method).toBe('PATCH');
    });

    it('deletes a layer object', async () => {
      vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }));

      await deleteLayerObject('obj1');

      expect(call().url).toContain('/layer-objects/obj1');
      expect(call().init?.method).toBe('DELETE');
    });

    it('reorders the objects of a layer', async () => {
      await reorderLayerObjects('layer1', ['a', 'b']);

      expect(call().url).toContain('/layers/layer1/objects/order');
      expect(call().init?.method).toBe('PATCH');
      expect(call().init?.body).toBe(JSON.stringify({ orderedObjectIds: ['a', 'b'] }));
    });
  });
});
