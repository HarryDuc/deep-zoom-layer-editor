import type {
  ImageLayer,
  LayerGeometry,
  LayerObject,
  LayerObjectMetadata,
  LayerObjectStyle,
  LayerObjectType,
} from '@deep-zoom/shared-types';

/**
 * Local (not-yet-saved) representation of a layer object.
 *
 * `isNew` marks objects created in the current editing session: they need a
 * POST on save and have no server id yet. Objects loaded from the API carry
 * their `_id` and are compared/diffed to build PATCH requests.
 */
export interface DraftObject {
  /** Server id, or a client-side temporary id for new objects. */
  id: string;
  layerId: string;
  type: LayerObjectType;
  geometry: LayerGeometry;
  style: LayerObjectStyle;
  metadata: LayerObjectMetadata;
  visible: boolean;
  zIndex: number;
  isNew: boolean;
  /** True when this object exists on the server (used to decide PATCH). */
  isPersisted: boolean;
}

export interface DraftLayer {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  zIndex: number;
  isNew: boolean;
  isPersisted: boolean;
}

export interface EditorSnapshot {
  layers: DraftLayer[];
  objects: DraftObject[];
}

/**
 * How the canvas reacts to pointer input.
 *
 * - `view`: layers are passive visual content. The viewer keeps pan/zoom and
 *   clicking a layer never selects or edits it; selection happens through the
 *   layer list or the toolbar.
 * - `edit`: the drawing tools and direct object selection are enabled.
 *
 * This is presentation state only. It never changes what is stored and it
 * never triggers an API write.
 */
export type InteractionMode = 'view' | 'edit';

export const DEFAULT_INTERACTION_MODE: InteractionMode = 'view';

/**
 * Computes the visual stacking order of the layers.
 *
 * The result is a *presentation* ordering: it does not modify `zIndex` on the
 * layers themselves, so bringing a layer to the front never rewrites the
 * persisted stack. The active layer is simply sorted last, which makes it
 * render above the others.
 */
export function getDisplayOrder(
  layers: readonly DraftLayer[],
  activeLayerId: string | null,
): DraftLayer[] {
  const ordered = [...layers].sort((a, b) => a.zIndex - b.zIndex);
  if (!activeLayerId) return ordered;

  const activeIndex = ordered.findIndex((layer) => layer.id === activeLayerId);
  if (activeIndex === -1) return ordered;

  // Move the active layer to the end of the stack without touching the
  // original objects.
  const [active] = ordered.splice(activeIndex, 1);
  ordered.push(active);
  return ordered;
}

/**
 * Sorts the objects of every layer for rendering.
 *
 * Objects keep their own `zIndex` inside their layer; the layer order comes
 * from `getDisplayOrder`. The returned array is a new array, so the drafts are
 * never mutated.
 */
export function getRenderableObjects(
  objects: readonly DraftObject[],
  layers: readonly DraftLayer[],
  displayOrder: readonly DraftLayer[],
): DraftObject[] {
  const layerById = new Map(layers.map((layer) => [layer.id, layer]));

  return objects
    .filter((object) => {
      if (!object.visible) return false;
      const layer = layerById.get(object.layerId);
      return layer ? layer.visible : false;
    })
    .sort((a, b) => {
      const layerA = displayOrder.findIndex((layer) => layer.id === a.layerId);
      const layerB = displayOrder.findIndex((layer) => layer.id === b.layerId);
      return layerA - layerB || a.zIndex - b.zIndex;
    });
}

export function toDraftLayer(layer: ImageLayer): DraftLayer {
  return {
    id: layer._id,
    name: layer.name,
    visible: layer.visible,
    locked: layer.locked,
    zIndex: layer.zIndex,
    isNew: false,
    isPersisted: true,
  };
}

export function toDraftObject(object: LayerObject): DraftObject {
  return {
    id: object._id,
    layerId: object.layerId,
    type: object.type,
    geometry: object.geometry,
    style: object.style,
    metadata: object.metadata,
    visible: object.visible,
    zIndex: object.zIndex,
    isNew: false,
    isPersisted: true,
  };
}

/**
 * Style defaults per object type.
 *
 * These mirror the API's defaults exactly (`LayerObjectsService.DEFAULT_STYLE`)
 * so an object drawn in the current session looks identical before and after it
 * is saved. Without them, a not-yet-persisted draft carries an empty style and
 * the SVG overlay would compute `NaN` for every numeric attribute.
 */
export const DEFAULT_OBJECT_STYLES: Record<LayerObjectType, LayerObjectStyle> = {
  POLYGON: {
    fill: '#2563eb',
    fillOpacity: 0.25,
    stroke: '#1d4ed8',
    strokeWidth: 2,
    strokeOpacity: 1,
  },
  RECTANGLE: {
    fill: '#16a34a',
    fillOpacity: 0.2,
    stroke: '#15803d',
    strokeWidth: 2,
    strokeOpacity: 1,
  },
  POINT: { fill: '#dc2626', stroke: '#7f1d1d', strokeWidth: 2, radius: 8 },
  LABEL: {
    color: '#111827',
    fontSize: 32,
    fontFamily: 'system-ui, sans-serif',
    backgroundColor: '#ffffff',
    backgroundOpacity: 0.75,
  },
  IMAGE: { opacity: 1 },
};

/** Fills in the type defaults for any style key a local draft has not set. */
export function withDefaultStyle(
  type: LayerObjectType,
  style: Partial<LayerObjectStyle> | undefined,
): LayerObjectStyle {
  return { ...DEFAULT_OBJECT_STYLES[type], ...(style ?? {}) } as LayerObjectStyle;
}

/** Types whose geometry can be dragged directly on the canvas. */
export const EDITABLE_GEOMETRY_TYPES: LayerObjectType[] = [
  'POLYGON',
  'RECTANGLE',
  'POINT',
  'LABEL',
  'IMAGE',
];

/**
 * Tolerance in image pixels used when diffing geometry between the draft and
 * the persisted snapshot. Sub-pixel drift from zoom round-trips must not mark
 * the editor dirty.
 */
export const GEOMETRY_DIRTY_EPSILON = 0.75;

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (typeof a === 'object') {
    const aKeys = Object.keys(a as Record<string, unknown>);
    const bKeys = Object.keys(b as Record<string, unknown>);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) =>
      deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    );
  }
  return false;
}

/**
 * Compares drafts against the last-saved snapshot to decide whether Save should
 * be enabled. Uses a numeric tolerance for geometry so tiny float drift is not
 * treated as a change.
 */
export function isEditorDirty(current: EditorSnapshot, saved: EditorSnapshot): boolean {
  if (current.layers.length !== saved.layers.length) return true;
  if (current.objects.length !== saved.objects.length) return true;

  const savedLayers = new Map(saved.layers.map((layer) => [layer.id, layer]));
  for (const layer of current.layers) {
    const reference = savedLayers.get(layer.id);
    if (!reference) return true;
    if (
      reference.name !== layer.name ||
      reference.visible !== layer.visible ||
      reference.locked !== layer.locked ||
      reference.zIndex !== layer.zIndex
    ) {
      return true;
    }
  }

  const savedObjects = new Map(saved.objects.map((object) => [object.id, object]));
  for (const object of current.objects) {
    const reference = savedObjects.get(object.id);
    if (!reference) return true;
    if (object.isNew) return true;
    if (reference.visible !== object.visible || reference.zIndex !== object.zIndex) return true;
    if (!deepEqual(reference.style, object.style)) return true;
    if (!deepEqual(reference.metadata, object.metadata)) return true;
    if (!geometryEquals(reference.geometry, object.geometry)) return true;
  }

  return false;
}

/** Geometry equality with a pixel tolerance for numeric coordinates. */
export function geometryEquals(a: LayerGeometry, b: LayerGeometry): boolean {
  return valuesNear(a, b, GEOMETRY_DIRTY_EPSILON);
}

function valuesNear(a: unknown, b: unknown, epsilon: number): boolean {
  if (typeof a === 'number' && typeof b === 'number') {
    return Math.abs(a - b) <= epsilon;
  }
  if (typeof a === 'string' && typeof b === 'string') {
    return a === b;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => valuesNear(item, b[index], epsilon));
  }
  if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null) {
    const aKeys = Object.keys(a as Record<string, unknown>);
    const bKeys = Object.keys(b as Record<string, unknown>);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) =>
      valuesNear(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
        epsilon,
      ),
    );
  }
  return a === b;
}

/** Generates a client-side temporary id for objects that are not saved yet. */
let temporaryIdCounter = 0;
export function createTemporaryId(): string {
  temporaryIdCounter += 1;
  return `temp-${Date.now().toString(36)}-${temporaryIdCounter}`;
}
