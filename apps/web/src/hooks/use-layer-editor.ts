'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ImageLayer,
  LayerGeometry,
  LayerObject,
  LayerObjectMetadata,
  LayerObjectStyle,
  LayerObjectType,
} from '@deep-zoom/shared-types';
import { ApiError } from '@/lib/http';
import {
  createLayer,
  createLayerObject,
  deleteLayer,
  deleteLayerObject,
  fetchLayerObjects,
  fetchLayers,
  reorderLayerObjects,
  updateLayer,
  updateLayerObject,
} from '@/services/api-client';
import {
  type DraftLayer,
  type DraftObject,
  type EditorSnapshot,
  type InteractionMode,
  createTemporaryId,
  isEditorDirty,
  toDraftLayer,
  toDraftObject,
  withDefaultStyle,
} from '@/lib/editor-state';

export interface UseLayerEditorResult {
  layers: DraftLayer[];
  objects: DraftObject[];
  selectedObject: DraftObject | null;
  selectedObjectId: string | null;
  activeLayerId: string | null;
  /**
   * Presentation-only state: whether the canvas is in view or edit mode.
   * Changing it never mutates a layer or issues an API request.
   */
  interactionMode: InteractionMode;
  isLoading: boolean;
  isSaving: boolean;
  isDirty: boolean;
  error: string | null;
  notice: string | null;
  setSelectedObjectId: (objectId: string | null) => void;
  setActiveLayerId: (layerId: string | null) => void;
  setInteractionMode: (mode: InteractionMode) => void;
  addLayer: (name: string) => void;
  renameLayer: (layerId: string, name: string) => void;
  toggleLayerVisibility: (layerId: string) => void;
  toggleLayerLock: (layerId: string) => void;
  removeLayer: (layerId: string) => void;
  moveLayer: (layerId: string, direction: 'up' | 'down') => void;
  addObject: (input: {
    type: LayerObjectType;
    geometry: LayerGeometry;
    style?: LayerObjectStyle;
    metadata?: LayerObjectMetadata;
  }) => void;
  updateObjectGeometry: (objectId: string, geometry: LayerGeometry) => void;
  updateObjectStyle: (objectId: string, patch: Partial<LayerObjectStyle>) => void;
  updateObjectMetadata: (objectId: string, patch: Partial<LayerObjectMetadata>) => void;
  toggleObjectVisibility: (objectId: string) => void;
  removeObject: (objectId: string) => void;
  moveObject: (objectId: string, direction: 'up' | 'down') => void;
  save: () => Promise<void>;
  cancel: () => void;
  reload: () => Promise<void>;
  clearMessages: () => void;
}

const EMPTY_SNAPSHOT: EditorSnapshot = { layers: [], objects: [] };

/**
 * Centralizes the editor's local state.
 *
 * Design rules enforced here:
 *  - all mutations are local; no API call happens during drawing or dragging;
 *  - `save()` diffs drafts against the last-saved snapshot and issues only the
 *    necessary requests;
 *  - `cancel()` restores the last-saved snapshot exactly.
 */
export function useLayerEditor(imageId: string): UseLayerEditorResult {
  const [layers, setLayers] = useState<DraftLayer[]>([]);
  const [objects, setObjects] = useState<DraftObject[]>([]);
  const [saved, setSaved] = useState<EditorSnapshot>(EMPTY_SNAPSHOT);
  const [selectedObjectId, setSelectedObjectId] = useState<string | null>(null);
  const [activeLayerId, setActiveLayerId] = useState<string | null>(null);
  const [interactionMode, setInteractionMode] = useState<InteractionMode>('view');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Guards against overlapping saves that would duplicate newly created objects.
  const savingRef = useRef(false);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const layerList = await fetchLayers(imageId);
      const objectLists = await Promise.all(
        layerList.map(async (layer) => ({
          layer,
          objects: await fetchLayerObjects(layer._id),
        })),
      );

      const draftLayers = layerList.map(toDraftLayer);
      const draftObjects = objectLists.flatMap((entry) => entry.objects.map(toDraftObject));

      setLayers(draftLayers);
      setObjects(draftObjects);
      setSaved({ layers: draftLayers, objects: draftObjects });
      setActiveLayerId(draftLayers[0]?.id ?? null);
      setSelectedObjectId(null);
    } catch (loadError) {
      setError(
        loadError instanceof ApiError ? loadError.message : 'Không thể tải layer.',
      );
    } finally {
      setIsLoading(false);
    }
  }, [imageId]);

  useEffect(() => {
    void load();
  }, [load]);

  const isDirty = useMemo(
    () => isEditorDirty({ layers, objects }, saved),
    [layers, objects, saved],
  );

  const selectedObject = useMemo(
    () => objects.find((object) => object.id === selectedObjectId) ?? null,
    [objects, selectedObjectId],
  );

  const clearMessages = useCallback(() => {
    setError(null);
    setNotice(null);
  }, []);

  /* --------------------------------- layers -------------------------------- */

  const addLayer = useCallback((name: string) => {
    const trimmed = name.trim() || 'Lớp mới';
    const maxZ = layers.reduce((max, layer) => Math.max(max, layer.zIndex), -1);

    const draft: DraftLayer = {
      id: createTemporaryId(),
      name: trimmed,
      visible: true,
      locked: false,
      zIndex: maxZ + 1,
      isNew: true,
      isPersisted: false,
    };

    setLayers((current) => [...current, draft]);
    setActiveLayerId(draft.id);
  }, [layers]);

  const renameLayer = useCallback((layerId: string, name: string) => {
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    setLayers((current) =>
      current.map((layer) => (layer.id === layerId ? { ...layer, name: trimmed } : layer)),
    );
  }, []);

  const toggleLayerVisibility = useCallback((layerId: string) => {
    setLayers((current) =>
      current.map((layer) =>
        layer.id === layerId ? { ...layer, visible: !layer.visible } : layer,
      ),
    );
  }, []);

  const toggleLayerLock = useCallback((layerId: string) => {
    setLayers((current) =>
      current.map((layer) => (layer.id === layerId ? { ...layer, locked: !layer.locked } : layer)),
    );
  }, []);

  const removeLayer = useCallback(
    (layerId: string) => {
      setLayers((current) => current.filter((layer) => layer.id !== layerId));
      setObjects((current) => current.filter((object) => object.layerId !== layerId));
      setActiveLayerId((current) => (current === layerId ? null : current));
      setSelectedObjectId((current) => {
        const selected = objects.find((object) => object.id === current);
        return selected?.layerId === layerId ? null : current;
      });
    },
    [objects],
  );

  /** Moves a layer up/down in the stack and renumbers zIndex contiguously. */
  const moveLayer = useCallback((layerId: string, direction: 'up' | 'down') => {
    setLayers((current) => {
      const ordered = [...current].sort((a, b) => a.zIndex - b.zIndex);
      const index = ordered.findIndex((layer) => layer.id === layerId);
      if (index === -1) return current;

      const targetIndex = direction === 'up' ? index + 1 : index - 1;
      if (targetIndex < 0 || targetIndex >= ordered.length) return current;

      const [moved] = ordered.splice(index, 1);
      ordered.splice(targetIndex, 0, moved);
      return ordered.map((layer, position) => ({ ...layer, zIndex: position }));
    });
  }, []);

  /* -------------------------------- objects -------------------------------- */

  const addObject = useCallback(
    (input: {
      type: LayerObjectType;
      geometry: LayerGeometry;
      style?: LayerObjectStyle;
      metadata?: LayerObjectMetadata;
    }) => {
      const layerId = input.type ? activeLayerId : null;
      if (!layerId) {
        setError('Hãy chọn hoặc tạo một layer trước khi vẽ.');
        return;
      }

      const layer = layers.find((candidate) => candidate.id === layerId);
      if (layer?.locked) {
        setError('Layer đang bị khoá. Mở khoá trước khi thêm đối tượng.');
        return;
      }

      const maxZ = objects
        .filter((object) => object.layerId === layerId)
        .reduce((max, object) => Math.max(max, object.zIndex), -1);

      const draft: DraftObject = {
        id: createTemporaryId(),
        layerId,
        type: input.type,
        geometry: input.geometry,
        // Defaults are applied locally so a brand-new object renders exactly
        // like its persisted counterpart (the API applies the same defaults).
        style: withDefaultStyle(input.type, input.style),
        metadata: input.metadata ?? {},
        visible: true,
        zIndex: maxZ + 1,
        isNew: true,
        isPersisted: false,
      };

      setObjects((current) => [...current, draft]);
      setSelectedObjectId(draft.id);
      clearMessages();
    },
    [activeLayerId, layers, objects, clearMessages],
  );

  const updateObjectGeometry = useCallback((objectId: string, geometry: LayerGeometry) => {
    setObjects((current) =>
      current.map((object) => (object.id === objectId ? { ...object, geometry } : object)),
    );
  }, []);

  const updateObjectStyle = useCallback(
    (objectId: string, patch: Partial<LayerObjectStyle>) => {
      setObjects((current) =>
        current.map((object) =>
          object.id === objectId
            ? { ...object, style: { ...object.style, ...patch } as LayerObjectStyle }
            : object,
        ),
      );
    },
    [],
  );

  const updateObjectMetadata = useCallback(
    (objectId: string, patch: Partial<LayerObjectMetadata>) => {
      setObjects((current) =>
        current.map((object) =>
          object.id === objectId
            ? {
                ...object,
                metadata: { ...object.metadata, ...patch } as LayerObjectMetadata,
              }
            : object,
        ),
      );
    },
    [],
  );

  const toggleObjectVisibility = useCallback((objectId: string) => {
    setObjects((current) =>
      current.map((object) =>
        object.id === objectId ? { ...object, visible: !object.visible } : object,
      ),
    );
  }, []);

  const removeObject = useCallback((objectId: string) => {
    setObjects((current) => current.filter((object) => object.id !== objectId));
    setSelectedObjectId((current) => (current === objectId ? null : current));
  }, []);

  const moveObject = useCallback((objectId: string, direction: 'up' | 'down') => {
    setObjects((current) => {
      const target = current.find((object) => object.id === objectId);
      if (!target) return current;

      const siblings = current
        .filter((object) => object.layerId === target.layerId)
        .sort((a, b) => a.zIndex - b.zIndex);

      const index = siblings.findIndex((object) => object.id === objectId);
      const swapIndex = direction === 'up' ? index + 1 : index - 1;
      if (swapIndex < 0 || swapIndex >= siblings.length) return current;

      const reordered = [...siblings];
      [reordered[index], reordered[swapIndex]] = [reordered[swapIndex], reordered[index]];

      const zIndexById = new Map(reordered.map((object, position) => [object.id, position]));
      return current.map((object) =>
        zIndexById.has(object.id)
          ? { ...object, zIndex: zIndexById.get(object.id) as number }
          : object,
      );
    });
  }, []);

  /* --------------------------------- saving -------------------------------- */

  /**
   * Persists all local changes.
   *
   * Order matters: new layers first (objects need a real layer id), then
   * deletions, then object upserts, then reorder. Everything else that is
   * unchanged is skipped, so a save after drawing one polygon sends one request.
   */
  const save = useCallback(async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setIsSaving(true);
    setError(null);
    setNotice(null);

    try {
      const savedLayerIds = new Set(saved.layers.map((layer) => layer.id));
      const savedObjectIds = new Set(saved.objects.map((object) => object.id));
      const currentLayerIds = new Set(layers.map((layer) => layer.id));
      const currentObjectIds = new Set(objects.map((object) => object.id));

      // 1. Create new layers and map temporary ids to server ids.
      const layerIdMap = new Map<string, string>();
      const createdLayers: DraftLayer[] = [];

      for (const layer of layers.filter((candidate) => candidate.isNew)) {
        const created: ImageLayer = await createLayer(imageId, {
          name: layer.name,
          visible: layer.visible,
          locked: layer.locked,
          zIndex: layer.zIndex,
        });
        layerIdMap.set(layer.id, created._id);
        createdLayers.push({ ...toDraftLayer(created) });
      }

      // 2. Update existing layers whose properties changed.
      for (const layer of layers.filter((candidate) => !candidate.isNew)) {
        const reference = saved.layers.find((candidate) => candidate.id === layer.id);
        if (!reference) continue;

        const changed =
          reference.name !== layer.name ||
          reference.visible !== layer.visible ||
          reference.locked !== layer.locked ||
          reference.zIndex !== layer.zIndex;

        if (changed) {
          await updateLayer(layer.id, {
            name: layer.name,
            visible: layer.visible,
            locked: layer.locked,
            zIndex: layer.zIndex,
          });
        }
      }

      // 3. Delete layers removed locally (objects cascade server-side).
      for (const reference of saved.layers) {
        if (!currentLayerIds.has(reference.id)) {
          await deleteLayer(reference.id);
        }
      }

      // 4. Delete objects removed locally.
      for (const reference of saved.objects) {
        if (!currentObjectIds.has(reference.id)) {
          await deleteLayerObject(reference.id);
        }
      }

      // 5. Create new objects and update changed persisted ones.
      const objectIdMap = new Map<string, string>();

      for (const object of objects) {
        const serverLayerId = layerIdMap.get(object.layerId) ?? object.layerId;

        if (object.isNew) {
          const created = await createLayerObject(serverLayerId, {
            type: object.type,
            geometry: object.geometry,
            style: normalizeStylePayload(object.style),
            metadata: object.metadata,
            visible: object.visible,
            zIndex: object.zIndex,
          });
          objectIdMap.set(object.id, created._id);
          continue;
        }

        const reference = saved.objects.find((candidate) => candidate.id === object.id);
        if (!reference) continue;

        const geometryChanged = !geometryPayloadsEqual(reference.geometry, object.geometry);
        const styleChanged = !payloadsEqual(reference.style, object.style);
        const metadataChanged = !payloadsEqual(reference.metadata, object.metadata);
        const flagsChanged =
          reference.visible !== object.visible || reference.zIndex !== object.zIndex;

        if (geometryChanged || styleChanged || metadataChanged || flagsChanged) {
          await updateLayerObject(object.id, {
            ...(geometryChanged ? { geometry: object.geometry } : {}),
            ...(styleChanged ? { style: normalizeStylePayload(object.style) } : {}),
            ...(metadataChanged ? { metadata: object.metadata } : {}),
            ...(reference.visible !== object.visible ? { visible: object.visible } : {}),
            ...(reference.zIndex !== object.zIndex ? { zIndex: object.zIndex } : {}),
          });
        }
      }

      // 6. Reorder objects in any layer whose stacking changed.
      for (const layerId of new Set(objects.map((object) => object.layerId))) {
        const serverLayerId = layerIdMap.get(layerId) ?? layerId;
        const ordered = objects
          .filter((object) => object.layerId === layerId)
          .sort((a, b) => a.zIndex - b.zIndex)
          .map((object) => objectIdMap.get(object.id) ?? object.id)
          .filter((id) => !id.startsWith('temp-'));

        const referenceOrder = saved.objects
          .filter((object) => object.layerId === layerId && !object.isNew)
          .sort((a, b) => a.zIndex - b.zIndex)
          .map((object) => object.id);

        const orderChanged =
          ordered.length !== referenceOrder.length ||
          ordered.some((id, index) => id !== referenceOrder[index]);

        if (orderChanged && ordered.length > 0) {
          await reorderLayerObjects(serverLayerId, ordered);
        }
      }

      // 7. Re-read from the server so local ids, defaults and server-applied
      //    values (style defaults, timestamps) match exactly.
      await load();
      setNotice('Đã lưu thay đổi.');
      void savedObjectIds;
      void savedLayerIds;
      void createdLayers;
    } catch (saveError) {
      if (saveError instanceof ApiError) {
        setError(saveError.message);
      } else {
        setError('Lưu thay đổi thất bại. Vui lòng thử lại.');
      }
    } finally {
      savingRef.current = false;
      setIsSaving(false);
    }
  }, [imageId, layers, objects, saved, load]);

  /** Restores the last saved snapshot, discarding every local edit. */
  const cancel = useCallback(() => {
    setLayers(saved.layers.map((layer) => ({ ...layer })));
    setObjects(saved.objects.map((object) => ({ ...object })));
    setSelectedObjectId(null);
    setError(null);
    setNotice('Đã huỷ thay đổi chưa lưu.');
  }, [saved]);

  return {
    layers,
    objects,
    selectedObject,
    selectedObjectId,
    activeLayerId,
    interactionMode,
    isLoading,
    isSaving,
    isDirty,
    error,
    notice,
    setSelectedObjectId,
    setActiveLayerId,
    setInteractionMode,
    addLayer,
    renameLayer,
    toggleLayerVisibility,
    toggleLayerLock,
    removeLayer,
    moveLayer,
    addObject,
    updateObjectGeometry,
    updateObjectStyle,
    updateObjectMetadata,
    toggleObjectVisibility,
    removeObject,
    moveObject,
    save,
    cancel,
    reload: load,
    clearMessages,
  };
}

/* ------------------------------- utilities -------------------------------- */

function payloadsEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});
}

function geometryPayloadsEqual(a: LayerGeometry, b: LayerGeometry): boolean {
  const round = (value: unknown): unknown => {
    if (typeof value === 'number') return Math.round(value * 100) / 100;
    if (Array.isArray(value)) return value.map(round);
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, round(item)]),
      );
    }
    return value;
  };
  return payloadsEqual(round(a), round(b));
}

/**
 * Strips empty style values so the API can apply type-specific defaults instead
 * of persisting `undefined` placeholders from a partially filled local draft.
 */
function normalizeStylePayload(style: LayerObjectStyle): LayerObjectStyle {
  const entries = Object.entries(style as unknown as Record<string, unknown>).filter(
    ([, value]) => value !== undefined && value !== null && value !== '',
  );
  return Object.fromEntries(entries) as unknown as LayerObjectStyle;
}
