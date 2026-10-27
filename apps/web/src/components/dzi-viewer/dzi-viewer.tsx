'use client';

import { forwardRef, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { LayerObject } from '@deep-zoom/shared-types';
import { useOpenSeadragon } from '@/hooks/use-open-seadragon';
import type { ViewerCoordinates } from '@/hooks/use-open-seadragon';
import type { InteractionMode } from '@/lib/editor-state';
import { apiUrl } from '@/lib/api-config';
import styles from './dzi-viewer.module.css';

export type DrawingTool = 'POLYGON' | 'RECTANGLE' | 'POINT' | 'LABEL' | 'IMAGE';

export interface ImageRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DziViewerProps {
  imageId: string;
  /** Objects to draw, already flattened and filtered by the editor. */
  objects: LayerObject[];
  selectedObjectId: string | null;
  onSelectObject: (objectId: string | null) => void;
  /** Active drawing tool; `null` means select/pan mode. */
  activeTool: DrawingTool | null;
  /**
   * Whether the canvas is in the passive view mode or the active edit mode.
   *
   * In view mode the layers are pure visual content: they never select
   * anything and never swallow a gesture. In edit mode objects can be
   * selected and the drawing tools are available.
   */
  interactionMode: InteractionMode;
  onCanvasClick: (point: { x: number; y: number }) => void;
  onCanvasDragEnd: (rect: ImageRect) => void;
  /** Fired on a double click; used to close a polygon. */
  onCanvasDoubleClick?: () => void;
  /** Overlay asset id -> absolute image URL, for IMAGE objects. */
  overlayImageUrls: Record<string, string>;
  /** Width of the base image in pixels; defines the overlay's user units. */
  imageWidth?: number;
  /** Height of the base image in pixels; defines the overlay's user units. */
  imageHeight?: number;
  onReadyChange?: (ready: boolean) => void;
  /** Rendered between the toolbar and the viewer, e.g. status banners. */
  children?: React.ReactNode;
}

/** Minimum pointer travel before a drag creates an object. */
const MIN_DRAG_PIXELS = 4;

const TOOL_HINTS: Record<DrawingTool, string> = {
  POLYGON: 'Nhấn để thêm điểm, nhấn đúp hoặc Enter để đóng đa giác.',
  RECTANGLE: 'Kéo chuột để vẽ hình chữ nhật.',
  POINT: 'Nhấn để đặt điểm.',
  LABEL: 'Nhấn để đặt nhãn chữ.',
  IMAGE: 'Kéo chuột để đặt vùng ảnh chồng lớp.',
};

interface DragPreview {
  /** Element-relative CSS pixels, for the preview rectangle only. */
  left: number;
  top: number;
  width: number;
  height: number;
}

export function DziViewer({
  imageId,
  objects,
  selectedObjectId,
  onSelectObject,
  activeTool,
  interactionMode,
  onCanvasClick,
  onCanvasDragEnd,
  onCanvasDoubleClick,
  overlayImageUrls,
  imageWidth,
  imageHeight,
  onReadyChange,
  children,
}: DziViewerProps) {
  const {
    viewerRef,
    viewer,
    overlayHost,
    isReady,
    isLoading,
    error,
    transform,
    coordinates,
    zoomIn,
    zoomOut,
    fitToScreen,
    resetView,
  } = useOpenSeadragon({ tileSourceUrl: apiUrl(`/images/${imageId}/dzi`) });

  const dragStartRef = useRef<{ clientX: number; clientY: number } | null>(null);
  const [dragPreview, setDragPreview] = useState<DragPreview | null>(null);
  // The overlay is positioned with a CSS transform, so it must be updated
  // imperatively: re-rendering React on every animation frame is what made
  // panning and zooming feel laggy.
  const svgRef = useRef<SVGSVGElement | null>(null);
  // Counts the frames the viewport has moved. The end-to-end tests use it to
  // assert that a gesture actually reached OpenSeadragon.
  const viewportVersionRef = useRef(0);

  const isDragTool = activeTool === 'RECTANGLE' || activeTool === 'IMAGE';
  // Objects are only interactive in edit mode, and only while no drawing tool
  // is armed (a drawing tool owns the pointer).
  const objectsInteractive = interactionMode === 'edit' && activeTool === null;

  useEffect(() => {
    onReadyChange?.(isReady);
  }, [isReady, onReadyChange]);

  /* -------------------------- viewport synchronisation -------------------- */

  /**
   * Keeps the SVG glued to the base image.
   *
   * The overlay is drawn in *image* coordinates and the browser applies the
   * viewport transform, so panning and zooming never re-render the React
   * tree: only one CSS transform is rewritten per frame.
   */
  useEffect(() => {
    if (!viewer) return;

    const apply = (): void => {
      const element = svgRef.current;
      if (!element) return;

      const { scale, offsetX, offsetY } = transform;
      element.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
      viewportVersionRef.current += 1;
      element.setAttribute('data-viewport-version', String(viewportVersionRef.current));
    };

    viewer.addHandler('update-viewport', apply);
    viewer.addHandler('resize', apply);
    // The first frame may have been drawn before this effect ran.
    apply();

    return () => {
      viewer.removeHandler('update-viewport', apply);
      viewer.removeHandler('resize', apply);
    };
  }, [viewer, transform]);

  /* ------------------------------ interaction ----------------------------- */

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!isDragTool) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      dragStartRef.current = { clientX: event.clientX, clientY: event.clientY };
      setDragPreview({ left: 0, top: 0, width: 0, height: 0 });
    },
    [isDragTool],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const start = dragStartRef.current;
      if (!start) return;

      const elementRect = event.currentTarget.getBoundingClientRect();
      setDragPreview({
        left: Math.min(start.clientX, event.clientX) - elementRect.left,
        top: Math.min(start.clientY, event.clientY) - elementRect.top,
        width: Math.abs(event.clientX - start.clientX),
        height: Math.abs(event.clientY - start.clientY),
      });
    },
    [],
  );

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const start = dragStartRef.current;
      dragStartRef.current = null;
      setDragPreview(null);
      if (!start) return;

      const movedEnough =
        Math.abs(event.clientX - start.clientX) > MIN_DRAG_PIXELS ||
        Math.abs(event.clientY - start.clientY) > MIN_DRAG_PIXELS;

      // A bare click must not create a zero-size object (rejected by the API).
      if (!movedEnough) return;

      onCanvasDragEnd(
        coordinates.toImageRect(start, { clientX: event.clientX, clientY: event.clientY }),
      );
    },
    [coordinates, onCanvasDragEnd],
  );

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!activeTool || isDragTool) return;

      const target = event.target as Element;
      // Object clicks are handled by the object itself (selection).
      if (target.closest('[data-object-id]')) return;

      onCanvasClick(coordinates.toImage(event.clientX, event.clientY));
    },
    [activeTool, coordinates, isDragTool, onCanvasClick],
  );

  // A double click closes the polygon, matching the on-screen hint. The
  // intermediate click still adds a point, so the polygon must keep at least
  // three points; the editor decides what to do with the final shape.
  const handleDoubleClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (activeTool !== 'POLYGON') return;

      event.preventDefault();
      event.stopPropagation();
      onCanvasDoubleClick?.();
    },
    [activeTool, onCanvasDoubleClick],
  );

  /**
   * The overlay's user unit system is the base image's pixel grid.
   *
   * A fallback of 1x1 keeps the SVG valid before the image size is known; the
   * real size arrives with the asset metadata.
   */
  const overlayWidth = imageWidth && imageWidth > 0 ? imageWidth : 1;
  const overlayHeight = imageHeight && imageHeight > 0 ? imageHeight : 1;

  const overlay = (
    <SvgOverlay
      ref={svgRef}
      objects={objects}
      selectedObjectId={selectedObjectId}
      overlayImageUrls={overlayImageUrls}
      interactive={objectsInteractive}
      onSelectObject={onSelectObject}
      width={overlayWidth}
      height={overlayHeight}
    />
  );

  return (
    <div className={styles.wrapper}>
      <div className={styles.toolbar} role="toolbar" aria-label="Điều khiển trình xem">
        <button type="button" className="button button--small" onClick={zoomIn} data-testid="zoom-in">
          Phóng to
        </button>
        <button type="button" className="button button--small" onClick={zoomOut} data-testid="zoom-out">
          Thu nhỏ
        </button>
        <button
          type="button"
          className="button button--small"
          onClick={fitToScreen}
          data-testid="fit-screen"
        >
          Vừa màn hình
        </button>
        <button
          type="button"
          className="button button--small"
          onClick={resetView}
          data-testid="reset-view"
        >
          Đặt lại
        </button>
        <span className={styles.meta} data-testid="viewer-meta">
          {isReady ? `${objects.length} đối tượng` : 'Đang khởi tạo…'}
        </span>
      </div>

      {children}

      {activeTool && (
        <div className={styles.toolHint} data-testid="tool-hint">
          {TOOL_HINTS[activeTool]}
        </div>
      )}

      <div className={styles.viewerArea} data-testid="dzi-viewer">
        <div ref={viewerRef} className={styles.viewerCanvas} data-testid="osd-container" />

        {/*
          The SVG overlay is portaled INTO OpenSeadragon's canvas element.

          OpenSeadragon binds its mouse tracker to that canvas, so an overlay
          that is merely a sibling never bubbles pointer events to the viewer:
          dragging on top of a drawn object would neither pan nor zoom. As a
          descendant, every gesture reaches the tracker and OpenSeadragon
          performs the pan/zoom itself.

          Until the viewer exists there is no canvas to portal into, so the
          overlay is rendered in place; it is re-parented on the next render.
        */}
        {overlayHost ? createPortal(overlay, overlayHost) : overlay}

        {/* Transparent interaction layer active only while a tool is selected,
            so normal pan/zoom gestures keep working otherwise. */}
        {activeTool !== null && (
          <div
            className={styles.interactionLayer}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onClick={handleClick}
            onDoubleClick={handleDoubleClick}
            data-testid="drawing-layer"
          >
            {dragPreview && (
              <div
                className={styles.dragPreview}
                style={{
                  left: `${dragPreview.left}px`,
                  top: `${dragPreview.top}px`,
                  width: `${dragPreview.width}px`,
                  height: `${dragPreview.height}px`,
                }}
                data-testid="drag-preview"
              />
            )}
          </div>
        )}

        {isLoading && (
          <div className={styles.overlayState} data-testid="viewer-loading">
            <span className="spinner" aria-hidden="true" />
            <span>Đang tải ảnh…</span>
          </div>
        )}

        {error && (
          <div className={styles.overlayError} role="alert" data-testid="viewer-error">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/* SVG overlay                                                               */
/* ------------------------------------------------------------------------- */

export interface SvgOverlayProps {
  objects: LayerObject[];
  selectedObjectId: string | null;
  overlayImageUrls: Record<string, string>;
  interactive: boolean;
  onSelectObject: (objectId: string | null) => void;
  /** Width of the base image in pixels; the overlay's user unit system. */
  width: number;
  /** Height of the base image in pixels; the overlay's user unit system. */
  height: number;
}

/**
 * Converts stored image-pixel geometry into SVG shapes.
 *
 * The overlay is expressed in the *base image's* pixel grid, exactly like the
 * tiles OpenSeadragon draws underneath it. The viewport transform is applied
 * with a single CSS transform on the root element, so the shapes never need to
 * be recomputed while the user pans or zooms.
 */
export const SvgOverlay = forwardRef<SVGSVGElement, SvgOverlayProps>(function SvgOverlay(
  {
    objects,
    selectedObjectId,
    overlayImageUrls,
    interactive,
    onSelectObject,
    width,
    height,
  },
  ref,
) {
  /**
   * Object click handler. Returns `undefined` when the overlay is not
   * interactive so a non-interactive overlay never swallows or reacts to
   * events, independent of CSS `pointer-events` support.
   */
  const selectHandler = (objectId: string) =>
    interactive
      ? (event: React.MouseEvent) => {
          event.stopPropagation();
          onSelectObject(objectId);
        }
      : undefined;

  return (
    // The root SVG must always be `pointer-events: none`: it covers the whole
    // viewer, so `auto` here would swallow OpenSeadragon's drag-to-pan and
    // wheel-to-zoom gestures. Only the individual object shapes re-enable
    // pointer events (see the `.object` class), so pan/zoom keeps working while
    // objects stay clickable.
    //
    // `preserveAspectRatio="none"` makes the viewBox map exactly onto the
    // image box; the CSS transform then maps the image box onto the viewport.
    <svg
      ref={ref}
      className={styles.svg}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      pointerEvents="none"
      data-testid="svg-overlay"
    >
      {objects.map((object) => {
        const isSelected = object._id === selectedObjectId;

        switch (object.type) {
          case 'POLYGON': {
            const points = (object.geometry as { points: { x: number; y: number }[] }).points
              .map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`)
              .join(' ');
            const style = object.style as {
              fill: string;
              fillOpacity: number;
              stroke: string;
              strokeWidth: number;
              strokeOpacity: number;
            };

            return (
              <polygon
                key={object._id}
                data-object-id={object._id}
                data-testid={`object-polygon-${object._id}`}
                points={points}
                fill={style.fill}
                fillOpacity={style.fillOpacity}
                stroke={style.stroke}
                strokeWidth={isSelected ? style.strokeWidth + 1.5 : style.strokeWidth}
                strokeOpacity={style.strokeOpacity}
                vectorEffect="non-scaling-stroke"
                className={interactive ? styles.object : undefined}
                onClick={selectHandler(object._id)}
              />
            );
          }

          case 'RECTANGLE': {
            const geometry = object.geometry as ImageRect;
            const style = object.style as {
              fill: string;
              fillOpacity: number;
              stroke: string;
              strokeWidth: number;
              strokeOpacity: number;
            };

            return (
              <rect
                key={object._id}
                data-object-id={object._id}
                data-testid={`object-rectangle-${object._id}`}
                x={geometry.x}
                y={geometry.y}
                width={geometry.width}
                height={geometry.height}
                fill={style.fill}
                fillOpacity={style.fillOpacity}
                stroke={style.stroke}
                strokeWidth={isSelected ? style.strokeWidth + 1.5 : style.strokeWidth}
                strokeOpacity={style.strokeOpacity}
                vectorEffect="non-scaling-stroke"
                className={interactive ? styles.object : undefined}
                onClick={selectHandler(object._id)}
              />
            );
          }

          case 'POINT': {
            const geometry = object.geometry as { x: number; y: number };
            const style = object.style as {
              fill: string;
              stroke: string;
              strokeWidth: number;
              radius: number;
            };

            return (
              <g
                key={object._id}
                data-object-id={object._id}
                data-testid={`object-point-${object._id}`}
                className={interactive ? styles.object : undefined}
                onClick={selectHandler(object._id)}
              >
                {isSelected && (
                  <circle
                    cx={geometry.x}
                    cy={geometry.y}
                    r={style.radius + 5}
                    fill="none"
                    stroke="#22d3ee"
                    strokeWidth={2}
                    strokeDasharray="4 3"
                    vectorEffect="non-scaling-stroke"
                  />
                )}
                <circle
                  cx={geometry.x}
                  cy={geometry.y}
                  r={style.radius}
                  fill={style.fill}
                  stroke={style.stroke}
                  strokeWidth={style.strokeWidth}
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            );
          }

          case 'LABEL': {
            const geometry = object.geometry as { x: number; y: number };
            const style = object.style as {
              color: string;
              fontSize: number;
              fontFamily: string;
              backgroundColor: string;
              backgroundOpacity: number;
            };
            const metadata = object.metadata as { text?: string };

            return (
              <g
                key={object._id}
                data-object-id={object._id}
                data-testid={`object-label-${object._id}`}
                className={interactive ? styles.object : undefined}
                onClick={selectHandler(object._id)}
              >
                <text
                  x={geometry.x}
                  y={geometry.y}
                  fontSize={style.fontSize}
                  fontFamily={style.fontFamily}
                  fill={style.color}
                  stroke={isSelected ? '#22d3ee' : style.backgroundColor}
                  strokeOpacity={isSelected ? 1 : style.backgroundOpacity}
                  strokeWidth={isSelected ? 2 : Math.max(2, style.fontSize * 0.22)}
                  paintOrder="stroke"
                  data-testid="label-text"
                >
                  {metadata.text ?? ''}
                </text>
              </g>
            );
          }

          case 'IMAGE': {
            const geometry = object.geometry as ImageRect & { overlayId: string };
            const style = object.style as { opacity: number };
            const href = overlayImageUrls[geometry.overlayId];

            if (!href) {
              // Overlay asset not resolved yet; skip rather than render a
              // broken image node.
              return null;
            }

            return (
              <image
                key={object._id}
                data-object-id={object._id}
                data-testid={`object-image-${object._id}`}
                href={href}
                x={geometry.x}
                y={geometry.y}
                width={geometry.width}
                height={geometry.height}
                opacity={style.opacity}
                // Scale uniformly inside the drawn box. With `none` the bitmap
                // is stretched to the box's aspect ratio, which visibly
                // distorts (and can crush) a detailed overlay when the box and
                // the source image do not share proportions.
                preserveAspectRatio="xMidYMid meet"
                className={interactive ? styles.object : undefined}
                onClick={selectHandler(object._id)}
              />
            );
          }

          default:
            return null;
        }
      })}
    </svg>
  );
});
