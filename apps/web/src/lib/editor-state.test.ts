import { describe, expect, it } from 'vitest';
import type { ImageLayer, LayerObject, LayerObjectType } from '@deep-zoom/shared-types';
import {
  DEFAULT_OBJECT_STYLES,
  GEOMETRY_DIRTY_EPSILON,
  createTemporaryId,
  geometryEquals,
  getDisplayOrder,
  getRenderableObjects,
  isEditorDirty,
  toDraftLayer,
  toDraftObject,
  withDefaultStyle,
  type DraftLayer,
  type DraftObject,
  type EditorSnapshot,
} from './editor-state';

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

function snapshot(layers: DraftLayer[], objects: DraftObject[]): EditorSnapshot {
  return { layers, objects };
}

describe('editor-state', () => {
  describe('toDraftLayer / toDraftObject', () => {    it('marks persisted layers as saved', () => {
      expect(toDraftLayer(makeLayer())).toEqual({
        id: 'layer-1',
        name: 'Lớp 1',
        visible: true,
        locked: false,
        zIndex: 0,
        isNew: false,
        isPersisted: true,
      });
    });

    it('maps a server object to a draft with its server id', () => {
      const draft = toDraftObject(makeObject());
      expect(draft.id).toBe('object-1');
      expect(draft.isNew).toBe(false);
      expect(draft.isPersisted).toBe(true);
      expect(draft.geometry).toEqual({ x: 10, y: 20 });
    });
  });

  describe('createTemporaryId', () => {
    it('never repeats an id', () => {
      const ids = new Set(Array.from({ length: 500 }, () => createTemporaryId()));
      expect(ids.size).toBe(500);
    });

    it('produces ids that cannot collide with ObjectIds', () => {
      expect(createTemporaryId()).toMatch(/^temp-/);
    });
  });

  describe('geometryEquals', () => {
    it('treats sub-pixel drift as equal', () => {
      expect(
        geometryEquals({ x: 100, y: 200 }, { x: 100 + GEOMETRY_DIRTY_EPSILON / 2, y: 200 }),
      ).toBe(true);
    });

    it('treats drift beyond the tolerance as different', () => {
      expect(geometryEquals({ x: 100, y: 200 }, { x: 100 + GEOMETRY_DIRTY_EPSILON * 2, y: 200 })).toBe(
        false,
      );
    });

    it('compares nested polygon points with the same tolerance', () => {
      const a = {
        points: [
          { x: 10, y: 10 },
          { x: 20, y: 10 },
          { x: 20, y: 20 },
        ],
      };
      const b = {
        points: [
          { x: 10.2, y: 10.1 },
          { x: 20, y: 10 },
          { x: 20, y: 20 },
        ],
      };
      expect(geometryEquals(a, b)).toBe(true);
    });

    it('detects a moved point inside a polygon', () => {
      const a = {
        points: [
          { x: 10, y: 10 },
          { x: 20, y: 10 },
          { x: 20, y: 20 },
        ],
      };
      const b = {
        points: [
          { x: 10, y: 10 },
          { x: 20, y: 10 },
          { x: 20, y: 40 },
        ],
      };
      expect(geometryEquals(a, b)).toBe(false);
    });

    it('treats a differing point count as different', () => {
      expect(
        geometryEquals(
          { points: [{ x: 0, y: 0 }] },
          {
            points: [
              { x: 0, y: 0 },
              { x: 1, y: 1 },
            ],
          },
        ),
      ).toBe(false);
    });
  });

  describe('isEditorDirty', () => {
    const layer = toDraftLayer(makeLayer());
    const object = toDraftObject(
      makeObject({ geometry: { x: 10, y: 20 }, style: { fill: '#fff', stroke: '#000', strokeWidth: 1, radius: 4 } }),
    );

    it('reports a clean editor when nothing changed', () => {
      expect(isEditorDirty(snapshot([layer], [object]), snapshot([layer], [object]))).toBe(false);
    });

    it('is dirty when a layer is added', () => {
      const added: DraftLayer = { ...layer, id: 'layer-2', isNew: true, isPersisted: false };
      expect(isEditorDirty(snapshot([layer, added], [object]), snapshot([layer], [object]))).toBe(true);
    });

    it('is dirty when a layer is renamed', () => {
      expect(
        isEditorDirty(snapshot([{ ...layer, name: 'Đổi tên' }], [object]), snapshot([layer], [object])),
      ).toBe(true);
    });

    it('is dirty when layer visibility or lock changes', () => {
      expect(isEditorDirty(snapshot([{ ...layer, visible: false }], [object]), snapshot([layer], [object]))).toBe(
        true,
      );
      expect(isEditorDirty(snapshot([{ ...layer, locked: true }], [object]), snapshot([layer], [object]))).toBe(
        true,
      );
    });

    it('is dirty when layer order changes', () => {
      expect(isEditorDirty(snapshot([{ ...layer, zIndex: 5 }], [object]), snapshot([layer], [object]))).toBe(true);
    });

    it('is dirty when a new object exists locally', () => {
      const draft: DraftObject = { ...object, id: 'temp-1', isNew: true, isPersisted: false };
      expect(isEditorDirty(snapshot([layer], [object, draft]), snapshot([layer], [object]))).toBe(true);
    });

    it('is dirty when geometry moved', () => {
      expect(
        isEditorDirty(
          snapshot([layer], [{ ...object, geometry: { x: 200, y: 300 } }]),
          snapshot([layer], [object]),
        ),
      ).toBe(true);
    });

    it('stays clean for sub-pixel geometry drift', () => {
      expect(
        isEditorDirty(
          snapshot([layer], [{ ...object, geometry: { x: 10.2, y: 20.1 } }]),
          snapshot([layer], [object]),
        ),
      ).toBe(false);
    });

    it('is dirty when a style value changed', () => {
      expect(
        isEditorDirty(
          snapshot([layer], [{ ...object, style: { ...object.style, radius: 20 } }]),
          snapshot([layer], [object]),
        ),
      ).toBe(true);
    });

    it('is dirty when metadata changed', () => {
      expect(
        isEditorDirty(
          snapshot([layer], [{ ...object, metadata: { name: 'Mốc A' } }]),
          snapshot([layer], [object]),
        ),
      ).toBe(true);
    });

    it('is dirty when visibility or stacking changed', () => {
      expect(
        isEditorDirty(snapshot([layer], [{ ...object, visible: false }]), snapshot([layer], [object])),
      ).toBe(true);
      expect(
        isEditorDirty(snapshot([layer], [{ ...object, zIndex: 3 }]), snapshot([layer], [object])),
      ).toBe(true);
    });

    it('is dirty when an object is removed', () => {
      expect(isEditorDirty(snapshot([layer], []), snapshot([layer], [object]))).toBe(true);
    });

    it('ignores id-only differences in ordering of the arrays', () => {
      // Same set, different array order: the comparison is keyed by id.
      const second = toDraftObject(makeObject({ _id: 'object-2', geometry: { x: 50, y: 60 } }));
      expect(isEditorDirty(snapshot([layer], [second, object]), snapshot([layer], [object, second]))).toBe(
        false,
      );
    });
  });

  /**
   * Newly drawn objects have no server round trip yet, so their style must be
   * completed locally. Without defaults the SVG overlay receives `undefined` for
   * every numeric attribute and React renders `NaN`.
   */
  describe('DEFAULT_OBJECT_STYLES / withDefaultStyle', () => {    it('defines a complete style for every object type', () => {
      const types: LayerObjectType[] = ['POLYGON', 'RECTANGLE', 'POINT', 'LABEL', 'IMAGE'];
      for (const type of types) {
        const style = DEFAULT_OBJECT_STYLES[type] as unknown as Record<string, unknown>;
        expect(style, type).toBeDefined();
        for (const [key, value] of Object.entries(style)) {
          expect(value, `${type}.${key}`).not.toBeUndefined();
        }
      }
    });

    it('produces only finite numbers for the numeric style keys', () => {
      for (const type of Object.keys(DEFAULT_OBJECT_STYLES) as LayerObjectType[]) {
        const style = DEFAULT_OBJECT_STYLES[type] as unknown as Record<string, unknown>;
        for (const [key, value] of Object.entries(style)) {
          if (typeof value === 'number') {
            expect(Number.isFinite(value), `${type}.${key}`).toBe(true);
          }
        }
      }
    });

    it('fills an empty draft style with the type defaults', () => {
      expect(withDefaultStyle('POINT', {})).toEqual(DEFAULT_OBJECT_STYLES.POINT);
      expect(withDefaultStyle('RECTANGLE', {})).toEqual(DEFAULT_OBJECT_STYLES.RECTANGLE);
      expect(withDefaultStyle('IMAGE', undefined)).toEqual(DEFAULT_OBJECT_STYLES.IMAGE);
    });

    it('keeps explicit user values over the defaults', () => {
      const style = withDefaultStyle('POLYGON', { fill: '#ff0000', strokeWidth: 6 });
      expect(style).toMatchObject({ fill: '#ff0000', strokeWidth: 6 });
      // Untouched keys still come from the defaults.
      expect(style).toMatchObject({ fillOpacity: 0.25, strokeOpacity: 1 });
    });

    it('does not mutate the shared defaults object', () => {
      const before = { ...DEFAULT_OBJECT_STYLES.POINT };
      withDefaultStyle('POINT', { radius: 3 });
      expect(DEFAULT_OBJECT_STYLES.POINT).toEqual(before);
    });
  });

  /**
   * Presentation ordering: selecting a layer must bring it to the front
   * visually WITHOUT rewriting the persisted z-index. These helpers produce a
   * sorted copy and never touch the drafts themselves.
   */
  describe('getDisplayOrder', () => {
    const layers: DraftLayer[] = [
      { id: 'a', name: 'A', visible: true, locked: false, zIndex: 0, isNew: false, isPersisted: true },
      { id: 'b', name: 'B', visible: true, locked: false, zIndex: 1, isNew: false, isPersisted: true },
      { id: 'c', name: 'C', visible: true, locked: false, zIndex: 2, isNew: false, isPersisted: true },
    ];

    it('orders by zIndex when no layer is active', () => {
      expect(getDisplayOrder(layers, null).map((layer) => layer.id)).toEqual(['a', 'b', 'c']);
    });

    it('places the active layer last so it renders on top', () => {
      expect(getDisplayOrder(layers, 'a').map((layer) => layer.id)).toEqual(['b', 'c', 'a']);
    });

    it('keeps the remaining layers in their original relative order', () => {
      expect(getDisplayOrder(layers, 'b').map((layer) => layer.id)).toEqual(['a', 'c', 'b']);
    });

    it('never mutates the layer z-index', () => {
      const snapshot = layers.map((layer) => ({ ...layer }));
      getDisplayOrder(layers, 'a');

      expect(layers).toEqual(snapshot);
      // The active layer keeps zIndex 0 even though it is drawn last.
      expect(layers[0].zIndex).toBe(0);
    });

    it('does not mutate the input array', () => {
      const order = ['a', 'b', 'c'];
      getDisplayOrder(layers, 'c');

      expect(layers.map((layer) => layer.id)).toEqual(order);
    });

    it('ignores an unknown active id', () => {
      expect(getDisplayOrder(layers, 'missing').map((layer) => layer.id)).toEqual([
        'a',
        'b',
        'c',
      ]);
    });

    it('handles an empty layer list', () => {
      expect(getDisplayOrder([], 'a')).toEqual([]);
    });
  });

  describe('getRenderableObjects', () => {
    const layers: DraftLayer[] = [
      { id: 'a', name: 'A', visible: true, locked: false, zIndex: 0, isNew: false, isPersisted: true },
      { id: 'b', name: 'B', visible: true, locked: false, zIndex: 1, isNew: false, isPersisted: true },
      { id: 'hidden', name: 'H', visible: false, locked: false, zIndex: 2, isNew: false, isPersisted: true },
    ];

    const object = (id: string, layerId: string, zIndex = 0, visible = true): DraftObject => ({
      id,
      layerId,
      type: 'POINT',
      geometry: { x: 1, y: 1 },
      style: withDefaultStyle('POINT', {}),
      metadata: {},
      visible,
      zIndex,
      isNew: false,
      isPersisted: true,
    });

    it('drops objects belonging to a hidden layer', () => {
      const objects = [object('o1', 'a'), object('o2', 'hidden')];
      const ordered = getRenderableObjects(objects, layers, getDisplayOrder(layers, null));

      expect(ordered.map((item) => item.id)).toEqual(['o1']);
    });

    it('drops individually hidden objects', () => {
      const objects = [object('o1', 'a'), object('o2', 'a', 1, false)];
      const ordered = getRenderableObjects(objects, layers, getDisplayOrder(layers, null));

      expect(ordered.map((item) => item.id)).toEqual(['o1']);
    });

    it('sorts by layer stacking, then by the object zIndex inside the layer', () => {
      const objects = [object('b1', 'b'), object('a2', 'a', 2), object('a1', 'a', 1)];
      const ordered = getRenderableObjects(objects, layers, getDisplayOrder(layers, null));

      expect(ordered.map((item) => item.id)).toEqual(['a1', 'a2', 'b1']);
    });

    it('follows the presentation order so the active layer draws last', () => {
      const objects = [object('a1', 'a'), object('b1', 'b')];
      const ordered = getRenderableObjects(objects, layers, getDisplayOrder(layers, 'a'));

      // Layer `a` is active, so it is drawn above layer `b`.
      expect(ordered.map((item) => item.id)).toEqual(['b1', 'a1']);
    });

    it('drops objects whose layer no longer exists', () => {
      const objects = [object('orphan', 'deleted')];
      const ordered = getRenderableObjects(objects, layers, getDisplayOrder(layers, null));

      expect(ordered).toEqual([]);
    });

    it('does not mutate the input array', () => {
      const objects = [object('b1', 'b'), object('a1', 'a')];
      getRenderableObjects(objects, layers, getDisplayOrder(layers, null));

      expect(objects.map((item) => item.id)).toEqual(['b1', 'a1']);
    });
  });
});
