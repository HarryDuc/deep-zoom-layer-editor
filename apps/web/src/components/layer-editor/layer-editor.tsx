'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ImageAsset,
  ImageOverlayGeometry,
  LayerGeometry,
  LayerObject,
  LayerObjectMetadata,
  LayerObjectStyle,
} from '@deep-zoom/shared-types';
import { DziViewer, type DrawingTool } from '@/components/dzi-viewer/dzi-viewer';
import { LayerPanel } from './layer-panel';
import { PropertiesPanel } from './properties-panel';
import { useLayerEditor } from '@/hooks/use-layer-editor';
import { apiUrl } from '@/lib/api-config';
import { clampToImage, normalizeRect, roundPoint } from '@/lib/coordinate-transform';
import type { DraftObject } from '@/lib/editor-state';
import { getDisplayOrder, getRenderableObjects, withDefaultStyle } from '@/lib/editor-state';
import styles from './layer-editor.module.css';

export interface LayerEditorProps {
  image: ImageAsset;
}

interface ToolDefinition {
  tool: DrawingTool;
  label: string;
  hint: string;
}

const TOOLS: ToolDefinition[] = [
  { tool: 'POLYGON', label: 'Đa giác', hint: 'Vẽ vùng đa giác' },
  { tool: 'RECTANGLE', label: 'Chữ nhật', hint: 'Vẽ hình chữ nhật' },
  { tool: 'POINT', label: 'Điểm', hint: 'Đặt điểm đánh dấu' },
  { tool: 'LABEL', label: 'Nhãn', hint: 'Đặt nhãn chữ' },
  { tool: 'IMAGE', label: 'Ảnh', hint: 'Đặt vùng ảnh chồng lớp' },
];

/** Converts local drafts into API-shaped objects for rendering. */
function toRenderableObject(draft: DraftObject): LayerObject {
  return {
    _id: draft.id,
    layerId: draft.layerId,
    type: draft.type,
    geometry: draft.geometry,
    // Defensive: guarantees the overlay always sees every numeric style key,
    // even for a draft created before defaults were applied.
    style: withDefaultStyle(draft.type, draft.style),
    metadata: draft.metadata,
    visible: draft.visible,
    zIndex: draft.zIndex,
    createdAt: '',
    updatedAt: '',
  };
}

function hasOverlayAsset(object: DraftObject): boolean {
  if (object.type !== 'IMAGE') return true;
  return Boolean((object.geometry as ImageOverlayGeometry).overlayId);
}

export function LayerEditor({ image }: LayerEditorProps) {
  const editor = useLayerEditor(image._id);
  const [activeTool, setActiveTool] = useState<DrawingTool | null>(null);
  const [polygonDraft, setPolygonDraft] = useState<{ x: number; y: number }[]>([]);
  const [overlayUrls, setOverlayUrls] = useState<Record<string, string>>({});
  const [viewerReady, setViewerReady] = useState(false);
  const editorWrapperRef = useRef<HTMLDivElement | null>(null);
  const imageSize = useMemo(
    () => ({ width: image.width ?? 0, height: image.height ?? 0 }),
    [image.width, image.height],
  );

  /* ------------------------- overlay asset resolution ---------------------- */

  // Resolve every overlay referenced by IMAGE objects once per id. Overlay
  // responses are immutable (`Cache-Control: immutable`), so no re-fetch occurs.
  const overlayIdsKey = useMemo(() => {
    const ids = new Set<string>();
    for (const object of editor.objects) {
      if (object.type === 'IMAGE') {
        const overlayId = (object.geometry as ImageOverlayGeometry).overlayId;
        if (overlayId) ids.add(overlayId);
      }
    }
    return [...ids].sort().join(',');
  }, [editor.objects]);

  useEffect(() => {
    if (overlayIdsKey.length === 0) return;

    setOverlayUrls((current) => {
      const next = { ...current };
      let changed = false;
      for (const overlayId of overlayIdsKey.split(',')) {
        if (overlayId && !next[overlayId]) {
          next[overlayId] = apiUrl(`/images/${image._id}/overlays/${overlayId}`);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [overlayIdsKey, image._id]);

  const handleOverlayUploaded = useCallback(
    (overlayId: string) => {
      setOverlayUrls((current) => ({
        ...current,
        [overlayId]: apiUrl(`/images/${image._id}/overlays/${overlayId}`),
      }));
    },
    [image._id],
  );

  /* ------------------------------- drawing -------------------------------- */

  const selectTool = useCallback(
    (tool: DrawingTool | null) => {
      setPolygonDraft([]);
      setActiveTool(tool);
      if (tool) {
        editor.clearMessages();
        // Arming a tool is an editing action: switch to edit mode so the
        // canvas captures the drawing gestures instead of panning.
        editor.setInteractionMode('edit');
      }
    },
    [editor],
  );

  const finishPolygon = useCallback(() => {
    if (polygonDraft.length < 3) return;

    editor.addObject({
      type: 'POLYGON',
      geometry: { points: polygonDraft.map((point) => roundPoint(point)) },
    });
    setPolygonDraft([]);
  }, [editor, polygonDraft]);

  // Enter closes the polygon; Escape cancels the active tool.
  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setPolygonDraft([]);
        setActiveTool(null);
        return;
      }
      if (event.key === 'Enter' && activeTool === 'POLYGON') {
        event.preventDefault();
        finishPolygon();
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [activeTool, finishPolygon]);

  const handleCanvasClick = useCallback(
    (point: { x: number; y: number }) => {
      const rounded = roundPoint(clampToImage(point, imageSize));

      switch (activeTool) {
        case 'POLYGON':
          setPolygonDraft((current) => [...current, rounded]);
          break;

        case 'POINT':
          editor.addObject({ type: 'POINT', geometry: { x: rounded.x, y: rounded.y } });
          break;

        case 'LABEL':
          editor.addObject({
            type: 'LABEL',
            geometry: { x: rounded.x, y: rounded.y },
            metadata: { text: 'Nhãn mới' },
          });
          break;

        default:
          break;
      }
    },
    [activeTool, editor, imageSize],
  );

  const handleCanvasDragEnd = useCallback(
    (rect: { x: number; y: number; width: number; height: number }) => {
      if (activeTool !== 'RECTANGLE' && activeTool !== 'IMAGE') return;

      const normalized = normalizeRect(
        { x: rect.x, y: rect.y },
        { x: rect.x + rect.width, y: rect.y + rect.height },
        imageSize,
      );
      const box = {
        x: roundPoint({ x: normalized.x, y: 0 }).x,
        y: roundPoint({ x: 0, y: normalized.y }).y,
        width: roundPoint({ x: Math.max(normalized.width, 1), y: 0 }).x,
        height: roundPoint({ x: 0, y: Math.max(normalized.height, 1) }).y,
      };

      if (activeTool === 'RECTANGLE') {
        editor.addObject({ type: 'RECTANGLE', geometry: box });
        return;
      }

      // IMAGE objects become renderable only once the properties panel attaches
      // an uploaded overlay asset (the API rejects an empty overlayId), so the
      // draft is created hidden-ish by having no overlay until one is chosen.
      editor.addObject({
        type: 'IMAGE',
        geometry: { ...box, overlayId: '' },
      });
    },
    [activeTool, editor, imageSize],
  );

  /* -------------------------------- rendering ------------------------------ */

  // Flatten visible layers/objects in stacking order: highest zIndex drawn last.
  //
  // `displayOrder` is presentation-only: the active layer is sorted last so it
  // renders above the others, without changing any layer's persisted zIndex.
  const displayOrder = useMemo(
    () => getDisplayOrder(editor.layers, editor.activeLayerId),
    [editor.layers, editor.activeLayerId],
  );

  const renderableObjects = useMemo(() => {
    const ordered = getRenderableObjects(editor.objects, editor.layers, displayOrder);

    return ordered
      .filter(hasOverlayAsset)
      .map(toRenderableObject);
  }, [editor.objects, editor.layers, displayOrder]);

  const selected = editor.selectedObject;

  const handleSelectObject = useCallback(
    (objectId: string | null) => {
      editor.setSelectedObjectId(objectId);
      // Selecting an object should not keep a drawing tool armed.
      if (objectId) {
        setPolygonDraft([]);
        setActiveTool(null);
      }
    },
    [editor],
  );

  const handleUpdateGeometry = useCallback(
    (geometry: LayerGeometry) => {
      if (selected) editor.updateObjectGeometry(selected.id, geometry);
    },
    [editor, selected],
  );

  const handleUpdateStyle = useCallback(
    (patch: Partial<LayerObjectStyle>) => {
      if (selected) editor.updateObjectStyle(selected.id, patch);
    },
    [editor, selected],
  );

  const handleUpdateMetadata = useCallback(
    (patch: Partial<LayerObjectMetadata>) => {
      if (selected) editor.updateObjectMetadata(selected.id, patch);
    },
    [editor, selected],
  );

  const activeLayer = editor.layers.find((layer) => layer.id === editor.activeLayerId) ?? null;
  // Drawing needs an editable layer. The mode is not part of this check:
  // arming a tool switches to edit mode by itself (see `selectTool`), so a
  // locked layer or a missing one is the only real blocker.
  const canDraw = Boolean(activeLayer) && !activeLayer?.locked;

  const missingOverlayCount = editor.objects.filter(
    (object) => object.type === 'IMAGE' && !(object.geometry as ImageOverlayGeometry).overlayId,
  ).length;

  return (
    <div className={styles.editor} ref={editorWrapperRef}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>{image.name}</h1>
          <p className={styles.subtitle}>
            {image.width && image.height
              ? `${image.width} × ${image.height} px`
              : 'Kích thước đang cập nhật'}{' '}
            · <span data-testid="editor-object-count">{editor.objects.length} đối tượng</span>
          </p>
        </div>

        <div className={styles.headerActions}>
          <Link className="button button--small" href="/" data-testid="back-to-list">
            Danh sách ảnh
          </Link>
          <button
            type="button"
            className="button button--small"
            onClick={() => void editor.reload()}
            disabled={editor.isSaving}
            data-testid="reload-editor"
          >
            Tải lại
          </button>
          <button
            type="button"
            className="button button--small"
            onClick={editor.cancel}
            disabled={!editor.isDirty || editor.isSaving}
            data-testid="cancel-edits"
          >
            Huỷ
          </button>
          <button
            type="button"
            className="button button--primary button--small"
            onClick={() => void editor.save()}
            disabled={!editor.isDirty || editor.isSaving}
            data-testid="save-edits"
          >
            {editor.isSaving ? 'Đang lưu…' : 'Lưu thay đổi'}
          </button>
        </div>
      </header>

      {(editor.error || editor.notice) && (
        <div
          className={editor.error ? styles.errorBanner : styles.noticeBanner}
          role={editor.error ? 'alert' : 'status'}
          data-testid={editor.error ? 'editor-error' : 'editor-notice'}
        >
          {editor.error ?? editor.notice}
        </div>
      )}

      {missingOverlayCount > 0 && (
        <div className={styles.warnBanner} data-testid="overlay-missing-warning">
          Có {missingOverlayCount} vùng ảnh chồng lớp chưa có tệp ảnh. Chọn vùng đó và tải ảnh
          PNG/WebP trong bảng thuộc tính.
        </div>
      )}

      <div className={styles.body}>
        <aside className={styles.leftPanel}>
          <LayerPanel
            layers={editor.layers}
            objects={editor.objects}
            activeLayerId={editor.activeLayerId}
            selectedObjectId={editor.selectedObjectId}
            onActivateLayer={editor.setActiveLayerId}
            onRenameLayer={editor.renameLayer}
            onToggleVisibility={editor.toggleLayerVisibility}
            onToggleLock={editor.toggleLayerLock}
            onRemoveLayer={editor.removeLayer}
            onMoveLayer={editor.moveLayer}
            onSelectObject={handleSelectObject}
            onAddLayer={editor.addLayer}
            disabled={editor.isSaving}
          />
        </aside>

        <section className={styles.viewerColumn}>
          <div className={styles.toolbar} role="toolbar" aria-label="Công cụ vẽ">
            {/*
              Mode switch. View mode keeps the canvas passive (pan/zoom only,
              layers are pure visuals); edit mode enables object selection and
              the drawing tools. The mode is presentation state only: it never
              changes a layer or issues a request.
            */}
            <div className={styles.modeSwitch} role="group" aria-label="Chế độ">
              <button
                type="button"
                className={`button button--small ${
                  editor.interactionMode === 'view' ? styles.toolActive : ''
                }`}
                aria-pressed={editor.interactionMode === 'view'}
                onClick={() => {
                  setPolygonDraft([]);
                  setActiveTool(null);
                  editor.setInteractionMode('view');
                }}
                data-testid="mode-view"
              >
                Xem
              </button>
              <button
                type="button"
                className={`button button--small ${
                  editor.interactionMode === 'edit' ? styles.toolActive : ''
                }`}
                aria-pressed={editor.interactionMode === 'edit'}
                onClick={() => editor.setInteractionMode('edit')}
                data-testid="mode-edit"
              >
                Chỉnh sửa
              </button>
            </div>

            <span className={styles.toolbarDivider} aria-hidden="true" />

            <button
              type="button"
              className={`button button--small ${activeTool === null ? styles.toolActive : ''}`}
              onClick={() => selectTool(null)}
              data-testid="tool-select"
            >
              Chọn
            </button>
            {TOOLS.map((item) => (
              <button
                key={item.tool}
                type="button"
                className={`button button--small ${
                  activeTool === item.tool ? styles.toolActive : ''
                }`}
                onClick={() => selectTool(activeTool === item.tool ? null : item.tool)}
                disabled={!canDraw}
                title={canDraw ? item.hint : 'Chọn một layer đang mở khoá để vẽ'}
                data-testid={`tool-${item.tool.toLowerCase()}`}
              >
                {item.label}
              </button>
            ))}

            {activeTool === 'POLYGON' && (
              <button
                type="button"
                className="button button--small button--primary"
                onClick={finishPolygon}
                disabled={polygonDraft.length < 3}
                data-testid="finish-polygon"
              >
                Đóng đa giác ({polygonDraft.length} điểm)
              </button>
            )}

            {!canDraw && (
              <span className={styles.toolHintInline} data-testid="drawing-disabled-hint">
                Chọn hoặc mở khoá một layer để vẽ
              </span>
            )}
          </div>

          <DziViewer
            imageId={image._id}
            objects={renderableObjects}
            selectedObjectId={editor.selectedObjectId}
            onSelectObject={handleSelectObject}
            activeTool={activeTool}
            interactionMode={editor.interactionMode}
            onCanvasClick={handleCanvasClick}
            onCanvasDragEnd={handleCanvasDragEnd}
            onCanvasDoubleClick={finishPolygon}
            overlayImageUrls={overlayUrls}
            imageWidth={image.width ?? 0}
            imageHeight={image.height ?? 0}
            onReadyChange={setViewerReady}
          >
            {polygonDraft.length > 0 && (
              <div className={styles.polygonStatus} data-testid="polygon-progress">
                Đang vẽ đa giác: {polygonDraft.length} điểm. Nhấn Enter hoặc nút “Đóng đa giác”.
              </div>
            )}
          </DziViewer>
        </section>

        <aside className={styles.rightPanel}>
          <PropertiesPanel
            object={selected}
            imageId={image._id}
            imageWidth={image.width ?? 0}
            imageHeight={image.height ?? 0}
            onUpdateGeometry={handleUpdateGeometry}
            onUpdateStyle={handleUpdateStyle}
            onUpdateMetadata={handleUpdateMetadata}
            onRemove={() => selected && editor.removeObject(selected.id)}
            onToggleVisibility={() => selected && editor.toggleObjectVisibility(selected.id)}
            onMove={(direction) => selected && editor.moveObject(selected.id, direction)}
            onOverlayUploaded={handleOverlayUploaded}
            disabled={editor.isSaving}
          />
        </aside>
      </div>
    </div>
  );
}
