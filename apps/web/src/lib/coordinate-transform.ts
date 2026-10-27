import type { ImagePoint } from '@deep-zoom/shared-types';

/**
 * Coordinate transforms between original-image pixels and viewport (CSS)
 * pixels.
 *
 * Conventions:
 *  - image coordinates: origin top-left, x right, y down, independent of zoom.
 *  - viewport coordinates: CSS pixels relative to the viewer element.
 *
 * This module is intentionally free of OpenSeadragon imports so it can be unit
 * tested in isolation. The viewer supplies the raw numbers from
 * `imageToViewportCoordinates()` / `viewportToImageCoordinates()` (which already
 * account for zoom, pan, and rotation) and this module handles the rest.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Tolerance used when comparing coordinate round-trips in tests. */
export const COORDINATE_EPSILON = 1e-6;

/**
 * OpenSeadragon's `Point` is a class, not a plain object. This converts any
 * `{x, y}`-shaped value into a plain object so it can be stored or compared.
 */
export function toPlainPoint(point: Point): Point {
  return { x: point.x, y: point.y };
}

export function addPoints(a: Point, b: Point): Point {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function subtractPoints(a: Point, b: Point): Point {
  return { x: a.x - b.x, y: a.y - b.y };
}

/**
 * Converts an image-space point to viewport space using the supplied mapper.
 *
 * The mapper exists so callers can pass `viewer.viewport.imageToViewportCoordinates`
 * directly, and tests can pass a synthetic scale.
 */
export function imageToViewport(
  point: ImagePoint,
  mapImageToViewport: (point: Point) => Point,
): Point {
  return toPlainPoint(mapImageToViewport({ x: point.x, y: point.y }));
}

export function viewportToImage(
  point: Point,
  mapViewportToImage: (point: Point) => Point,
): ImagePoint {
  const converted = mapViewportToImage({ x: point.x, y: point.y });
  return { x: converted.x, y: converted.y };
}

/**
 * Converts an image-space rectangle (used by RECTANGLE and IMAGE objects) into
 * a viewport rectangle. Both corners are mapped independently, then normalized
 * so negative widths/heights cannot occur.
 */
export function imageRectToViewportRect(
  rect: Rect,
  mapImageToViewport: (point: Point) => Point,
): Rect {
  const topLeft = mapImageToViewport({ x: rect.x, y: rect.y });
  const bottomRight = mapImageToViewport({ x: rect.x + rect.width, y: rect.y + rect.height });

  const x = Math.min(topLeft.x, bottomRight.x);
  const y = Math.min(topLeft.y, bottomRight.y);

  return {
    x,
    y,
    width: Math.abs(bottomRight.x - topLeft.x),
    height: Math.abs(bottomRight.y - topLeft.y),
  };
}

/** Full image bounds expressed in viewport coordinates. */
export function imageBoundsToViewportBounds(
  imageSize: Size,
  mapImageToViewport: (point: Point) => Point,
): Rect {
  return imageRectToViewportRect(
    { x: 0, y: 0, width: imageSize.width, height: imageSize.height },
    mapImageToViewport,
  );
}

/**
 * Converts a pointer event position (client coordinates, e.g. from
 * `MouseEvent.clientX/clientY`) into coordinates relative to the viewer element.
 *
 * `getBoundingClientRect()` is used because the viewer element may be offset or
 * scaled by CSS; OpenSeadragon expects element-relative pixels.
 */
export function pointerToElementPosition(
  pointer: { clientX: number; clientY: number },
  elementRect: { left: number; top: number },
): Point {
  return {
    x: pointer.clientX - elementRect.left,
    y: pointer.clientY - elementRect.top,
  };
}

/**
 * Full pointer -> image coordinate pipeline:
 * client pixels -> element pixels -> viewport -> image.
 */
export function pointerToImageCoordinates(
  pointer: { clientX: number; clientY: number },
  elementRect: { left: number; top: number },
  mapViewportToImage: (point: Point) => Point,
): ImagePoint {
  const elementPosition = pointerToElementPosition(pointer, elementRect);
  return viewportToImage(elementPosition, mapViewportToImage);
}

/**
 * Rounds to two decimals. Geometry is stored in image pixels, so sub-pixel
 * noise from zoom round-trips is meaningless and would make saved values
 * unstable across reloads.
 */
export function roundCoordinate(value: number, decimals = 2): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

export function roundPoint(point: Point, decimals = 2): ImagePoint {
  return { x: roundCoordinate(point.x, decimals), y: roundCoordinate(point.y, decimals) };
}

/** Clamps an image point into the image bounds. */
export function clampToImage(point: Point, imageSize: Size): ImagePoint {
  return {
    x: Math.min(Math.max(point.x, 0), imageSize.width),
    y: Math.min(Math.max(point.y, 0), imageSize.height),
  };
}

/**
 * Normalizes a rectangle that may have negative width/height (e.g. drawn
 * right-to-left or bottom-to-top) into a positive-size image rectangle.
 */
export function normalizeRect(start: Point, end: Point, imageSize?: Size): Rect {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  const width = Math.abs(end.x - start.x);
  const height = Math.abs(end.y - start.y);
  const rect = { x, y, width, height };

  if (!imageSize) {
    return rect;
  }

  const clampedWidth = Math.min(width, imageSize.width - x);
  const clampedHeight = Math.min(height, imageSize.height - y);
  return {
    x,
    y,
    width: Math.max(0, clampedWidth),
    height: Math.max(0, clampedHeight),
  };
}

/** Formats a polygon's points as an SVG `points` attribute value. */
export function polygonToSvgPoints(
  points: ImagePoint[],
  mapImageToViewport: (point: Point) => Point,
): string {
  return points
    .map((point) => {
      const viewportPoint = mapImageToViewport({ x: point.x, y: point.y });
      return `${viewportPoint.x.toFixed(2)},${viewportPoint.y.toFixed(2)}`;
    })
    .join(' ');
}
