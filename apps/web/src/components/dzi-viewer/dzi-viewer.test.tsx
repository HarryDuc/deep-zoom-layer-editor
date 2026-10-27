import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { LayerObject } from '@deep-zoom/shared-types';
import { SvgOverlay } from './dzi-viewer';

/**
 * Rendering tests for the SVG overlay.
 *
 * The overlay is expressed directly in the *base image's* pixel grid: the
 * shapes carry image-space coordinates and the viewport transform is applied
 * once, with a CSS transform on the root element. These tests therefore assert
 * image-space geometry (not viewport-space) plus the presence of the viewBox
 * that makes the mapping explicit.
 */

const POLYGON: LayerObject = {
  _id: 'poly-1',
  layerId: 'layer-1',
  type: 'POLYGON',
  geometry: {
    points: [
      { x: 100, y: 100 },
      { x: 300, y: 100 },
      { x: 300, y: 200 },
    ],
  },
  style: { fill: '#2563eb', fillOpacity: 0.25, stroke: '#1d4ed8', strokeWidth: 2, strokeOpacity: 1 },
  metadata: {},
  visible: true,
  zIndex: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const RECTANGLE: LayerObject = {
  ...POLYGON,
  _id: 'rect-1',
  type: 'RECTANGLE',
  geometry: { x: 400, y: 200, width: 100, height: 50 },
  style: { fill: '#16a34a', fillOpacity: 0.2, stroke: '#15803d', strokeWidth: 2, strokeOpacity: 1 },
};

const POINT: LayerObject = {
  ...POLYGON,
  _id: 'point-1',
  type: 'POINT',
  geometry: { x: 250, y: 300 },
  style: { fill: '#dc2626', stroke: '#7f1d1d', strokeWidth: 2, radius: 8 },
};

const LABEL: LayerObject = {
  ...POLYGON,
  _id: 'label-1',
  type: 'LABEL',
  geometry: { x: 600, y: 400 },
  style: {
    color: '#111827',
    fontSize: 32,
    fontFamily: 'system-ui, sans-serif',
    backgroundColor: '#ffffff',
    backgroundOpacity: 0.75,
  },
  metadata: { text: 'Lô đất số 7 — 120 m²' },
};

const IMAGE_OBJECT: LayerObject = {
  ...POLYGON,
  _id: 'image-1',
  type: 'IMAGE',
  geometry: { x: 50, y: 60, width: 100, height: 80, overlayId: 'overlay-1' },
  style: { opacity: 0.6 },
};

const ALL_OBJECTS = [POLYGON, RECTANGLE, POINT, LABEL, IMAGE_OBJECT];

function renderOverlay(props: Partial<React.ComponentProps<typeof SvgOverlay>> = {}) {
  const onSelectObject = vi.fn();
  const utils = render(
    <SvgOverlay
      objects={ALL_OBJECTS}
      selectedObjectId={null}
      overlayImageUrls={{ 'overlay-1': 'http://localhost:3001/api/v1/overlays/1' }}
      interactive
      onSelectObject={onSelectObject}
      width={1000}
      height={800}
      {...props}
    />,
  );
  return { ...utils, onSelectObject };
}

describe('SvgOverlay', () => {
  describe('rendering each object type', () => {
    it('renders a polygon with image-space points', () => {
      renderOverlay();

      const polygon = screen.getByTestId('object-polygon-poly-1');
      // Geometry is stored in image pixels and rendered verbatim; the viewport
      // mapping happens through the root transform, not per-shape arithmetic.
      expect(polygon.getAttribute('points')).toBe('100.00,100.00 300.00,100.00 300.00,200.00');
      expect(polygon.getAttribute('fill')).toBe('#2563eb');
      expect(polygon.getAttribute('fill-opacity')).toBe('0.25');
      expect(polygon.getAttribute('stroke')).toBe('#1d4ed8');
    });

    it('renders a rectangle with its stored geometry', () => {
      renderOverlay();

      const rect = screen.getByTestId('object-rectangle-rect-1');
      expect(rect.getAttribute('x')).toBe('400');
      expect(rect.getAttribute('y')).toBe('200');
      expect(rect.getAttribute('width')).toBe('100');
      expect(rect.getAttribute('height')).toBe('50');
    });

    it('renders a point marker at its image position', () => {
      const { container } = renderOverlay();

      const group = screen.getByTestId('object-point-point-1');
      const circle = group.querySelector('circle');
      expect(circle?.getAttribute('cx')).toBe('250');
      expect(circle?.getAttribute('cy')).toBe('300');
      expect(circle?.getAttribute('r')).toBe('8');
      expect(container.querySelectorAll('circle')).toHaveLength(1);
    });

    it('renders Vietnamese label text at its stored font size', () => {
      renderOverlay();

      const text = screen.getByTestId('label-text');
      expect(text.textContent).toBe('Lô đất số 7 — 120 m²');
      // The font size is in image pixels, matching the base image's grid.
      expect(text.getAttribute('font-size')).toBe('32');
      expect(text.getAttribute('fill')).toBe('#111827');
    });

    it('renders an image overlay using the resolved asset URL', () => {
      renderOverlay();

      const image = screen.getByTestId('object-image-image-1');
      expect(image.getAttribute('href')).toBe('http://localhost:3001/api/v1/overlays/1');
      expect(image.getAttribute('opacity')).toBe('0.6');
      // Uniform scaling inside the box; `none` stretched detailed bitmaps until
      // they looked torn when the box aspect ratio did not match the source.
      expect(image.getAttribute('preserveAspectRatio')).toBe('xMidYMid meet');
    });

    it('skips an image object whose overlay asset is not resolved yet', () => {
      renderOverlay({ overlayImageUrls: {} });
      expect(screen.queryByTestId('object-image-image-1')).toBeNull();
    });
  });

  describe('image-space coordinate system', () => {
    it('declares a viewBox matching the base image dimensions', () => {
      const { container } = renderOverlay({ width: 2048, height: 1536 });

      const svg = container.querySelector('svg');
      expect(svg?.getAttribute('viewBox')).toBe('0 0 2048 1536');
      expect(svg?.getAttribute('width')).toBe('2048');
      expect(svg?.getAttribute('height')).toBe('1536');
    });

    it('does not distort the viewBox mapping', () => {
      // `none` lets the CSS transform own the aspect ratio; the shapes are
      // always drawn in the image's own units.
      const { container } = renderOverlay();

      expect(container.querySelector('svg')?.getAttribute('preserveAspectRatio')).toBe('none');
    });

    it('keeps stroke widths constant on screen while zooming', () => {
      // Without `non-scaling-stroke` a 2px stroke would become a 40px slab at
      // high zoom, because the whole overlay is scaled by the transform.
      renderOverlay();

      expect(
        screen.getByTestId('object-polygon-poly-1').getAttribute('vector-effect'),
      ).toBe('non-scaling-stroke');
      expect(
        screen.getByTestId('object-rectangle-rect-1').getAttribute('vector-effect'),
      ).toBe('non-scaling-stroke');
    });
  });

  describe('selection', () => {
    it('marks the selected object with a dashed halo for points', () => {
      renderOverlay({ selectedObjectId: 'point-1' });

      const group = screen.getByTestId('object-point-point-1');
      const circles = group.querySelectorAll('circle');
      expect(circles).toHaveLength(2);
      expect(circles[0].getAttribute('stroke-dasharray')).toBe('4 3');
    });

    it('thickens the stroke of a selected polygon', () => {
      renderOverlay({ selectedObjectId: 'poly-1' });

      const polygon = screen.getByTestId('object-polygon-poly-1');
      // base 2 + selection highlight 1.5
      expect(polygon.getAttribute('stroke-width')).toBe('3.5');
    });

    it('calls onSelectObject when an object is clicked', async () => {
      const user = userEvent.setup();
      const { onSelectObject } = renderOverlay();

      await user.click(screen.getByTestId('object-polygon-poly-1'));

      expect(onSelectObject).toHaveBeenCalledWith('poly-1');
    });

    it('ignores clicks when the overlay is not interactive', async () => {
      const user = userEvent.setup();
      const { onSelectObject, container } = renderOverlay({ interactive: false });

      const svg = container.querySelector('svg');
      expect(svg?.getAttribute('pointer-events')).toBe('none');

      await user.click(screen.getByTestId('object-polygon-poly-1'));
      expect(onSelectObject).not.toHaveBeenCalled();
    });

    it('keeps the root SVG non-interactive so pan/zoom gestures reach OpenSeadragon', () => {
      // Regression: an interactive overlay used to set the root SVG to
      // `pointer-events: auto`, which covered the whole viewer and swallowed
      // drag-to-pan and wheel-to-zoom. The root must always stay `none`;
      // only individual objects opt back in via the `.object` class.
      const { container } = renderOverlay({ interactive: true });

      const svg = container.querySelector('svg');
      expect(svg?.getAttribute('pointer-events')).toBe('none');
    });

    it('does not attach click handlers when the overlay is passive', () => {
      // View mode must not react to object clicks at all, independently of CSS
      // pointer-events support.
      renderOverlay({ interactive: false });

      const polygon = screen.getByTestId('object-polygon-poly-1');
      expect(polygon.className).not.toContain('object');
    });
  });

  describe('content', () => {
    it('renders nothing when there are no objects', () => {
      renderOverlay({ objects: [] });
      expect(screen.getByTestId('svg-overlay').childElementCount).toBe(0);
    });

    it('renders every object type at once', () => {
      renderOverlay();

      expect(screen.getByTestId('object-polygon-poly-1')).toBeInTheDocument();
      expect(screen.getByTestId('object-rectangle-rect-1')).toBeInTheDocument();
      expect(screen.getByTestId('object-point-point-1')).toBeInTheDocument();
      expect(screen.getByTestId('object-label-label-1')).toBeInTheDocument();
      expect(screen.getByTestId('object-image-image-1')).toBeInTheDocument();
    });
  });
});
