import { describe, expect, it } from 'vitest';
import type { ImageOverlayGeometry } from '@deep-zoom/shared-types';
import { fitGeometryToOverlay } from './properties-panel';

/**
 * Unit tests for the overlay aspect-ratio fitting helper.
 *
 * Regression context: the overlay bitmap used to be stretched into whatever
 * box the user had dragged. A detailed image in a mismatched box was squashed
 * and looked torn. The helper reshapes the box to the bitmap's proportions
 * instead.
 */

const baseGeometry: ImageOverlayGeometry = {
  x: 100,
  y: 200,
  width: 400,
  height: 100,
  overlayId: 'old-overlay',
};

describe('fitGeometryToOverlay', () => {
  it('keeps the drawn width and derives the height for a too-wide box', () => {
    // Drawn 4:1, bitmap 2:1 -> the height must double to 200.
    const result = fitGeometryToOverlay(baseGeometry, 2000, 1000);

    expect(result.width).toBe(400);
    expect(result.height).toBe(200);
  });

  it('keeps the drawn height and derives the width for a too-tall box', () => {
    // Drawn 1:4, bitmap 2:1. The height is the larger drawn side, so it is
    // preserved and the width grows to 800 so the box still covers the
    // selection.
    const result = fitGeometryToOverlay({ ...baseGeometry, width: 100, height: 400 }, 2000, 1000);

    expect(result.width).toBe(800);
    expect(result.height).toBe(400);
  });

  it('leaves an already matching box untouched', () => {
    const result = fitGeometryToOverlay({ ...baseGeometry, width: 200, height: 100 }, 2000, 1000);

    expect(result.width).toBe(200);
    expect(result.height).toBe(100);
  });

  it('keeps the top-left anchor', () => {
    const result = fitGeometryToOverlay(baseGeometry, 2000, 1000);

    expect(result.x).toBe(100);
    expect(result.y).toBe(200);
  });

  it('replaces the overlay id', () => {
    const result = fitGeometryToOverlay(baseGeometry, 2000, 1000, 'new-overlay');

    expect(result.overlayId).toBe('new-overlay');
  });

  it('keeps the original overlay id when none is supplied', () => {
    const result = fitGeometryToOverlay(baseGeometry, 2000, 1000);

    expect(result.overlayId).toBe('old-overlay');
  });

  it('rounds the result to two decimals', () => {
    // Bitmap 1000x333 (aspect 3.003), drawn 333x111 (aspect 3.0). The drawn
    // box is slightly wider in proportion, so the width is preserved and the
    // height is derived.
    const result = fitGeometryToOverlay({ ...baseGeometry, width: 333, height: 111 }, 1000, 333);

    expect(result.width).toBe(333.33);
    expect(result.height).toBe(111);
  });

  it('ignores invalid overlay dimensions and only swaps the id', () => {
    const result = fitGeometryToOverlay(baseGeometry, 0, 100, 'new-overlay');

    expect(result.width).toBe(400);
    expect(result.height).toBe(100);
    expect(result.overlayId).toBe('new-overlay');
  });

  it('never produces a zero-sized box', () => {
    const result = fitGeometryToOverlay({ ...baseGeometry, width: 0, height: 0 }, 2000, 1000);

    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);
  });

  it('handles a very tall bitmap', () => {
    // Bitmap 1:10, drawn box 100x100. The drawn box is wider in proportion,
    // so the width is preserved and the height grows to 1000.
    const result = fitGeometryToOverlay({ ...baseGeometry, width: 100, height: 100 }, 100, 1000);

    expect(result.width).toBe(100);
    expect(result.height).toBe(1000);
  });
});
