import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ImageLayer, LayerObject } from '@deep-zoom/shared-types';
import { useLayerEditor } from './use-layer-editor';
import * as apiClient from '@/services/api-client';
import { ApiError } from '@/lib/http';

vi.mock('@/services/api-client', () => ({
  fetchLayers: vi.fn(),
  fetchLayerObjects: vi.fn(),
  createLayer: vi.fn(),
  updateLayer: vi.fn(),
  deleteLayer: vi.fn(),
  createLayerObject: vi.fn(),
  updateLayerObject: vi.fn(),
  deleteLayerObject: vi.fn(),
  reorderLayerObjects: vi.fn(),
}));

const mocked = vi.mocked(apiClient);

function makeLayer(overrides: Partial<ImageLayer> = {}): ImageLayer {
  return {
    _id: 'layer-1',
    imageAssetId: 'image-1',
    name: 'Lớp 1',
    visible: true,
    locked: false,
    zIndex: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeObject(overrides: Partial<LayerObject> = {}): LayerObject {
  return {
    _id: 'object-1',
    layerId: 'layer-1',
    type: 'POINT',
    geometry: { x: 10, y: 20 },
    style: { fill: '#ff0000', stroke: '#000000', strokeWidth: 2, radius: 8 },
    metadata: {},
    visible: true,
    zIndex: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Default: one layer with one point object. */
function setupServer() {
  mocked.fetchLayers.mockResolvedValue([makeLayer()]);
  mocked.fetchLayerObjects.mockResolvedValue([makeObject()]);
  mocked.reorderLayerObjects.mockResolvedValue([]);
  mocked.updateLayer.mockImplementation(async (layerId, payload) =>
    makeLayer({ _id: layerId, ...payload }),
  );
  mocked.updateLayerObject.mockImplementation(async (objectId, payload) =>
    makeObject({ _id: objectId, ...payload }),
  );
  mocked.createLayer.mockImplementation(async (imageId, payload) =>
    makeLayer({ _id: 'layer-new', name: payload.name }),
  );
  mocked.createLayerObject.mockImplementation(async (layerId, payload) =>
    makeObject({ _id: 'object-new', layerId, type: payload.type, geometry: payload.geometry }),
  );
  mocked.deleteLayer.mockResolvedValue(undefined);
  mocked.deleteLayerObject.mockResolvedValue(undefined);
}

describe('useLayerEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupServer();
  });

  async function renderEditor() {
    const view = renderHook(() => useLayerEditor('image-1'));
    await waitFor(() => expect(view.result.current.isLoading).toBe(false));
    return view;
  }

  describe('loading', () => {
    it('loads layers and their objects on mount', async () => {
      const { result } = await renderEditor();

      expect(mocked.fetchLayers).toHaveBeenCalledWith('image-1');
      expect(mocked.fetchLayerObjects).toHaveBeenCalledWith('layer-1');
      expect(result.current.layers).toHaveLength(1);
      expect(result.current.objects).toHaveLength(1);
      expect(result.current.activeLayerId).toBe('layer-1');
      expect(result.current.isDirty).toBe(false);
    });

    it('surfaces a load error', async () => {
      mocked.fetchLayers.mockRejectedValueOnce(new ApiError(500, 'SERVER_ERROR', 'Lỗi máy chủ'));

      const { result } = renderHook(() => useLayerEditor('image-1'));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(result.current.error).toBe('Lỗi máy chủ');
    });
  });

  describe('layer editing', () => {
    it('adds a layer locally and marks the editor dirty', async () => {
      const { result } = await renderEditor();

      act(() => result.current.addLayer('Lớp mới'));

      expect(result.current.layers).toHaveLength(2);
      expect(result.current.layers[1]).toMatchObject({
        name: 'Lớp mới',
        isNew: true,
        isPersisted: false,
      });
      expect(result.current.isDirty).toBe(true);
      // No request is sent while editing.
      expect(mocked.createLayer).not.toHaveBeenCalled();
    });

    it('renames, toggles visibility and lock without any request', async () => {
      const { result } = await renderEditor();

      act(() => result.current.renameLayer('layer-1', 'Lớp đổi tên'));
      act(() => result.current.toggleLayerVisibility('layer-1'));
      act(() => result.current.toggleLayerLock('layer-1'));

      expect(result.current.layers[0]).toMatchObject({
        name: 'Lớp đổi tên',
        visible: false,
        locked: true,
      });
      expect(mocked.updateLayer).not.toHaveBeenCalled();
    });

    it('ignores an empty layer name', async () => {
      const { result } = await renderEditor();

      act(() => result.current.renameLayer('layer-1', '   '));

      expect(result.current.layers[0].name).toBe('Lớp 1');
    });

    it('removes a layer together with its objects', async () => {
      const { result } = await renderEditor();

      act(() => result.current.removeLayer('layer-1'));

      expect(result.current.layers).toHaveLength(0);
      expect(result.current.objects).toHaveLength(0);
    });

    it('renumbers zIndex contiguously when a layer moves', async () => {
      const { result } = await renderEditor();

      act(() => result.current.addLayer('Lớp 2'));
      const upperId = result.current.layers[1].id;

      act(() => result.current.moveLayer(upperId, 'down'));

      const byId = new Map(result.current.layers.map((layer) => [layer.id, layer.zIndex]));
      expect(byId.get('layer-1')).toBe(1);
      expect(byId.get(upperId)).toBe(0);
    });

    it('ignores a move beyond the ends of the stack', async () => {
      const { result } = await renderEditor();

      act(() => result.current.moveLayer('layer-1', 'down'));

      expect(result.current.layers[0].zIndex).toBe(0);
    });
  });

  describe('object editing', () => {
    it('refuses to add an object without an active layer', async () => {
      const { result } = await renderEditor();

      act(() => result.current.setActiveLayerId(null));
      act(() =>
        result.current.addObject({ type: 'POINT', geometry: { x: 1, y: 2 } }),
      );

      expect(result.current.objects).toHaveLength(1);
      expect(result.current.error).toMatch(/chọn hoặc tạo một layer/i);
    });

    it('refuses to add an object to a locked layer', async () => {
      const { result } = await renderEditor();

      act(() => result.current.toggleLayerLock('layer-1'));
      act(() =>
        result.current.addObject({ type: 'POINT', geometry: { x: 1, y: 2 } }),
      );

      expect(result.current.objects).toHaveLength(1);
      expect(result.current.error).toMatch(/khoá/i);
    });

    it('adds an object with a temporary id and no request', async () => {
      const { result } = await renderEditor();

      act(() =>
        result.current.addObject({ type: 'POINT', geometry: { x: 55, y: 66 } }),
      );

      expect(result.current.objects).toHaveLength(2);
      const added = result.current.objects[1];
      expect(added.id).toMatch(/^temp-/);
      expect(added.isNew).toBe(true);
      expect(added.zIndex).toBe(1);
      expect(result.current.selectedObjectId).toBe(added.id);
      expect(mocked.createLayerObject).not.toHaveBeenCalled();
    });

    it('updates geometry and style locally', async () => {
      const { result } = await renderEditor();

      act(() => result.current.updateObjectGeometry('object-1', { x: 300, y: 400 }));
      act(() => result.current.updateObjectStyle('object-1', { fill: '#00ff00' }));

      expect(result.current.objects[0].geometry).toEqual({ x: 300, y: 400 });
      expect(result.current.objects[0].style).toMatchObject({ fill: '#00ff00' });
      expect(result.current.isDirty).toBe(true);
      expect(mocked.updateLayerObject).not.toHaveBeenCalled();
    });

    it('does not mark the editor dirty for sub-pixel geometry drift', async () => {
      const { result } = await renderEditor();

      act(() => result.current.updateObjectGeometry('object-1', { x: 10.2, y: 20.1 }));

      expect(result.current.isDirty).toBe(false);
    });

    it('removes an object locally', async () => {
      const { result } = await renderEditor();

      act(() => result.current.removeObject('object-1'));

      expect(result.current.objects).toHaveLength(0);
      expect(result.current.isDirty).toBe(true);
    });
  });

  describe('cancel', () => {
    it('restores the last saved snapshot exactly', async () => {
      const { result } = await renderEditor();

      act(() => result.current.addLayer('Lớp tạm'));
      act(() => result.current.updateObjectGeometry('object-1', { x: 999, y: 999 }));
      expect(result.current.isDirty).toBe(true);

      act(() => result.current.cancel());

      expect(result.current.layers).toHaveLength(1);
      expect(result.current.objects[0].geometry).toEqual({ x: 10, y: 20 });
      expect(result.current.isDirty).toBe(false);
      expect(result.current.notice).toMatch(/huỷ/i);
    });

    it('sends no request while cancelling', async () => {
      const { result } = await renderEditor();

      act(() => result.current.addLayer('Lớp tạm'));
      act(() => result.current.cancel());

      expect(mocked.createLayer).not.toHaveBeenCalled();
      expect(mocked.updateLayerObject).not.toHaveBeenCalled();
    });
  });

  describe('save', () => {
    it('creates new objects and re-reads the server state', async () => {
      const { result } = await renderEditor();

      act(() =>
        result.current.addObject({ type: 'POINT', geometry: { x: 55, y: 66 } }),
      );

      await act(async () => {
        await result.current.save();
      });

      expect(mocked.createLayerObject).toHaveBeenCalledWith(
        'layer-1',
        expect.objectContaining({
          type: 'POINT',
          geometry: { x: 55, y: 66 },
        }),
      );
      // The editor re-reads from the server so ids/defaults match exactly.
      expect(mocked.fetchLayers).toHaveBeenCalledTimes(2);
      expect(result.current.notice).toMatch(/lưu/i);
    });

    it('persists geometry changes of existing objects', async () => {
      const { result } = await renderEditor();

      act(() => result.current.updateObjectGeometry('object-1', { x: 300, y: 400 }));

      await act(async () => {
        await result.current.save();
      });

      expect(mocked.updateLayerObject).toHaveBeenCalledWith(
        'object-1',
        expect.objectContaining({ geometry: { x: 300, y: 400 } }),
      );
    });

    it('deletes objects removed locally', async () => {
      const { result } = await renderEditor();

      act(() => result.current.removeObject('object-1'));

      await act(async () => {
        await result.current.save();
      });

      expect(mocked.deleteLayerObject).toHaveBeenCalledWith('object-1');
    });

    it('creates new layers on save', async () => {
      const { result } = await renderEditor();

      act(() => result.current.addLayer('Lớp mới'));

      await act(async () => {
        await result.current.save();
      });

      expect(mocked.createLayer).toHaveBeenCalledWith(
        'image-1',
        expect.objectContaining({ name: 'Lớp mới' }),
      );
    });

    it('reports a save failure without losing the local edits', async () => {
      const { result } = await renderEditor();

      act(() => result.current.updateObjectGeometry('object-1', { x: 300, y: 400 }));
      mocked.updateLayerObject.mockRejectedValueOnce(
        new ApiError(400, 'INVALID_GEOMETRY', 'geometry is invalid'),
      );

      await act(async () => {
        await result.current.save();
      });

      expect(result.current.error).toBe('geometry is invalid');
      // The local edit survives so the user can correct it.
      expect(result.current.objects[0].geometry).toEqual({ x: 300, y: 400 });
      expect(result.current.isDirty).toBe(true);
    });
  });
});
