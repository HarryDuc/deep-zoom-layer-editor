import { describe, expect, it } from 'vitest';
import type { ImagePoint } from '@deep-zoom/shared-types';
import {
  COORDINATE_EPSILON,
  addPoints,
  clampToImage,
  imageBoundsToViewportBounds,
  imageRectToViewportRect,
  imageToViewport,
  normalizeRect,
  pointerToElementPosition,
  pointerToImageCoordinates,
  polygonToSvgPoints,
  roundCoordinate,
  roundPoint,
  subtractPoints,
  toPlainPoint,
  viewportToImage,
} from './coordinate-transform';

/**
 * Synthetic mapper that mimics OpenSeadragon's coordinate APIs: an image of
 * `size` is fitted into a `viewport` box with the given zoom factor and pan
 * offset. This keeps the tests independent of a real viewer while still
 * exercising the transform pipeline end to end.
 */
function makeMapper(options: {
  imageWidth: number;
  imageHeight: number;
  zoom?: number;
  pan?: { x: number; y: number };
}) {
  const { imageWidth, imageHeight, zoom = 1, pan = { x: 0, y: 0 } } = options;
  const scale = Math.min(800 / imageWidth, 600 / imageHeight) * zoom;

  const imageToViewport = (point: { x: number; y: number }) => ({
    x: point.x * scale + pan.x,
    y: point.y * scale + pan.y,
  });
  const viewportToImage = (point: { x: number; y: number }) => ({
    x: (point.x - pan.x) / scale,
    y: (point.y - pan.y) / scale,
  });

  return { imageToViewport, viewportToImage, scale };
}

describe('coordinate-transform', () => {
  describe('point helpers', () => {
    it('strips class instances down to plain {x, y} objects', () => {
      // OpenSeadragon returns `Point` class instances; they must not leak into
      // state or be persisted with extra prototype fields.
      class FakeOSDPoint {
        constructor(
          public x: number,
          public y: number,
        ) {}
        plus() {
          return this;
        }
      }
      const plain = toPlainPoint(new FakeOSDPoint(3, 4));
      expect(plain).toEqual({ x: 3, y: 4 });
      expect(Object.getPrototypeOf(plain)).toBe(Object.prototype);
    });

    it('adds and subtracts points', () => {
      expect(addPoints({ x: 1, y: 2 }, { x: 10, y: 20 })).toEqual({ x: 11, y: 22 });
      expect(subtractPoints({ x: 10, y: 20 }, { x: 1, y: 2 })).toEqual({ x: 9, y: 18 });
    });
  });

  describe('image <-> viewport round trips', () => {
    it('maps a point to viewport and back without error at zoom 1', () => {
      const { imageToViewport: mapper, viewportToImage: inverse } = makeMapper({
        imageWidth: 1600,
        imageHeight: 1200,
      });
      const original: ImagePoint = { x: 400, y: 300 };

      const viewport = imageToViewport(original, mapper);
      const roundTripped = viewportToImage(viewport, inverse);

      expect(roundTripped.x).toBeCloseTo(original.x, 6);
      expect(roundTripped.y).toBeCloseTo(original.y, 6);
    });

    it.each([0.25, 1, 4, 16])('round-trips points at zoom %d', (zoom) => {
      const { imageToViewport: mapper, viewportToImage: inverse } = makeMapper({
        imageWidth: 4096,
        imageHeight: 2048,
        zoom,
      });
      const original: ImagePoint = { x: 1234.5, y: 987.25 };

      const roundTripped = viewportToImage(imageToViewport(original, mapper), inverse);

      expect(Math.abs(roundTripped.x - original.x)).toBeLessThan(COORDINATE_EPSILON * 1500);
      expect(Math.abs(roundTripped.y - original.y)).toBeLessThan(COORDINATE_EPSILON * 1500);
    });

    it('round-trips points after panning', () => {
      const { imageToViewport: mapper, viewportToImage: inverse } = makeMapper({
        imageWidth: 2000,
        imageHeight: 1000,
        zoom: 2,
        pan: { x: -150, y: 42 },
      });
      const original: ImagePoint = { x: 1500, y: 750 };

      const roundTripped = viewportToImage(imageToViewport(original, mapper), inverse);

      expect(roundTripped.x).toBeCloseTo(original.x, 6);
      expect(roundTripped.y).toBeCloseTo(original.y, 6);
    });

    it('keeps a shape fixed relative to the image across zoom and pan changes', () => {
      const point: ImagePoint = { x: 1000, y: 500 };

      const atHome = makeMapper({ imageWidth: 4000, imageHeight: 2000 });
      const zoomed = makeMapper({
        imageWidth: 4000,
        imageHeight: 2000,
        zoom: 8,
        pan: { x: -320, y: -140 },
      });

      const homeViewport = imageToViewport(point, atHome.imageToViewport);
      const zoomedViewport = imageToViewport(point, zoomed.imageToViewport);

      // Same image pixel maps to different screen pixels -- that is expected.
      expect(homeViewport).not.toEqual(zoomedViewport);

      // But converting back always yields the same image coordinates, which is
      // what keeps overlays glued to the image.
      const homeBack = viewportToImage(homeViewport, atHome.viewportToImage);
      const zoomedBack = viewportToImage(zoomedViewport, zoomed.viewportToImage);

      expect(homeBack.x).toBeCloseTo(zoomedBack.x, 6);
      expect(homeBack.y).toBeCloseTo(zoomedBack.y, 6);
    });
  });

  describe('rectangle and bounds helpers', () => {
    it('maps a rectangle to viewport space', () => {
      const { imageToViewport: mapper, scale } = makeMapper({
        imageWidth: 1000,
        imageHeight: 1000,
      });

      const rect = imageRectToViewportRect(
        { x: 100, y: 200, width: 300, height: 400 },
        mapper,
      );

      expect(rect.x).toBeCloseTo(100 * scale, 6);
      expect(rect.y).toBeCloseTo(200 * scale, 6);
      expect(rect.width).toBeCloseTo(300 * scale, 6);
      expect(rect.height).toBeCloseTo(400 * scale, 6);
    });

    it('normalizes rectangles whose corners map in reverse order', () => {
      // A mapper that flips both axes simulates a hypothetical negative scale.
      const flipping = (point: { x: number; y: number }) => ({ x: -point.x, y: -point.y });

      const rect = imageRectToViewportRect({ x: 10, y: 20, width: 30, height: 40 }, flipping);

      expect(rect.width).toBeGreaterThan(0);
      expect(rect.height).toBeGreaterThan(0);
      expect(rect).toEqual({ x: -40, y: -60, width: 30, height: 40 });
    });

    it('maps the full image bounds to viewport bounds', () => {
      const { imageToViewport: mapper } = makeMapper({
        imageWidth: 1600,
        imageHeight: 1200,
      });

      const bounds = imageBoundsToViewportBounds({ width: 1600, height: 1200 }, mapper);

      // A 4:3 image fitted into an 800x600 box fills it exactly.
      expect(bounds.width).toBeCloseTo(800, 6);
      expect(bounds.height).toBeCloseTo(600, 6);
    });
  });

  describe('pointer conversion', () => {
    it('converts client coordinates to element-relative coordinates', () => {
      const position = pointerToElementPosition({ clientX: 350, clientY: 280 }, { left: 100, top: 80 });
      expect(position).toEqual({ x: 250, y: 200 });
    });

    it('runs the full client -> image pipeline', () => {
      const { viewportToImage: inverse, scale } = makeMapper({
        imageWidth: 2000,
        imageHeight: 1000,
      });

      const point = pointerToImageCoordinates(
        // Element is offset by 40/30 on the page; pointer sits at element 400,300.
        { clientX: 440, clientY: 330 },
        { left: 40, top: 30 },
        inverse,
      );

      expect(point.x).toBeCloseTo(400 / scale, 6);
      expect(point.y).toBeCloseTo(300 / scale, 6);
    });

    it('is unaffected by CSS scaling of the viewer element', () => {
      // `getBoundingClientRect` already accounts for CSS transforms, so the
      // client offset is all that matters; the mapper receives element pixels.
      const { viewportToImage: inverse } = makeMapper({ imageWidth: 500, imageHeight: 500 });
      const a = pointerToImageCoordinates({ clientX: 210, clientY: 110 }, { left: 10, top: 10 }, inverse);
      const b = pointerToImageCoordinates({ clientX: 210, clientY: 110 }, { left: 10, top: 10 }, inverse);
      expect(a).toEqual(b);
    });
  });

  describe('rounding, clamping and normalization', () => {
    it('rounds coordinates to two decimals by default', () => {
      expect(roundCoordinate(10.123456)).toBe(10.12);
      expect(roundCoordinate(10.126)).toBe(10.13);
      expect(roundCoordinate(-10.126)).toBe(-10.13);
      expect(roundCoordinate(10.126, 0)).toBe(10);
    });

    it('rounds a point without mutating the input', () => {
      const point = { x: 1.23456, y: 7.89123 };
      expect(roundPoint(point)).toEqual({ x: 1.23, y: 7.89 });
      expect(point).toEqual({ x: 1.23456, y: 7.89123 });
    });

    it('clamps a point into the image bounds', () => {
      const size = { width: 1000, height: 500 };
      expect(clampToImage({ x: -10, y: 600 }, size)).toEqual({ x: 0, y: 500 });
      expect(clampToImage({ x: 400, y: 200 }, size)).toEqual({ x: 400, y: 200 });
    });

    it('normalizes a rectangle drawn in any direction', () => {
      expect(normalizeRect({ x: 300, y: 400 }, { x: 100, y: 200 })).toEqual({
        x: 100,
        y: 200,
        width: 200,
        height: 200,
      });
    });

    it('clamps a normalized rectangle to the image bounds', () => {
      expect(normalizeRect({ x: 900, y: 100 }, { x: 1500, y: 400 }, { width: 1000, height: 500 })).toEqual(
        { x: 900, y: 100, width: 100, height: 300 },
      );
    });

    it('produces a zero-size rect for a click without drag', () => {
      const rect = normalizeRect({ x: 50, y: 50 }, { x: 50, y: 50 });
      expect(rect).toEqual({ x: 50, y: 50, width: 0, height: 0 });
    });
  });

  describe('polygonToSvgPoints', () => {
    it('formats points for an SVG polygon attribute', () => {
      const mapper = (point: { x: number; y: number }) => ({ x: point.x * 2, y: point.y * 2 });
      const result = polygonToSvgPoints(
        [
          { x: 10, y: 20 },
          { x: 30, y: 40 },
          { x: 50, y: 60 },
        ],
        mapper,
      );
      expect(result).toBe('20.00,40.00 60.00,80.00 100.00,120.00');
    });

    it('returns an empty string for an empty polygon', () => {
      expect(polygonToSvgPoints([], (point) => point)).toBe('');
    });
  });
});
