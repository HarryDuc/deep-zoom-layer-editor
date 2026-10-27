import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { LayerObject } from '@deep-zoom/shared-types';
import { DziViewer } from './dzi-viewer';
import type { ViewerCoordinates } from '@/hooks/use-open-seadragon';

/**
 * Component tests for the viewer's interaction layer.
 *
 * The OpenSeadragon hook is stubbed so the tests can drive the pointer
 * gestures deterministically. The important behaviour under test is the
 * separation of concerns between "a tool is armed" (the transparent layer
 * captures the gestures) and "no tool is armed" (OpenSeadragon keeps the
 * gestures for panning and zooming), plus the view/edit mode distinction.
 */

const mockCoordinates: ViewerCoordinates = {
  toImage: (clientX, clientY) => ({ x: clientX / 2, y: clientY / 2 }),
  toImageRect: (start, end) => ({
    x: Math.min(start.clientX, end.clientX) / 2,
    y: Math.min(start.clientY, end.clientY) / 2,
    width: Math.abs(end.clientX - start.clientX) / 2,
    height: Math.abs(end.clientY - start.clientY) / 2,
  }),
  toElement: (x, y) => ({ x: x * 2, y: y * 2 }),
};

const mockTransform = {
  scale: 2,
  offsetX: 10,
  offsetY: 20,
  version: 1,
};

const mockHook = {
  viewerRef: { current: null },
  viewer: null as unknown,
  overlayHost: null as HTMLElement | null,
  isReady: true,
  isLoading: false,
  error: null as string | null,
  viewportVersion: 3,
  transform: mockTransform,
  coordinates: mockCoordinates,
  zoomIn: vi.fn(),
  zoomOut: vi.fn(),
  fitToScreen: vi.fn(),
  resetView: vi.fn(),
};

vi.mock('@/hooks/use-open-seadragon', () => ({
  useOpenSeadragon: () => mockHook,
}));

const OBJECT: LayerObject = {
  _id: 'obj-1',
  layerId: 'layer-1',
  type: 'POINT',
  geometry: { x: 100, y: 100 },
  style: { fill: '#dc2626', stroke: '#7f1d1d', strokeWidth: 2, radius: 8 },
  metadata: {},
  visible: true,
  zIndex: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function renderViewer(props: Partial<React.ComponentProps<typeof DziViewer>> = {}) {
  const onCanvasClick = vi.fn();
  const onCanvasDragEnd = vi.fn();
  const onSelectObject = vi.fn();
  const onReadyChange = vi.fn();

  const utils = render(
    <DziViewer
      imageId="image-1"
      objects={[OBJECT]}
      selectedObjectId={null}
      onSelectObject={onSelectObject}
      activeTool={null}
      interactionMode="edit"
      onCanvasClick={onCanvasClick}
      onCanvasDragEnd={onCanvasDragEnd}
      overlayImageUrls={{}}
      imageWidth={1000}
      imageHeight={800}
      onReadyChange={onReadyChange}
      {...props}
    />,
  );

  return { ...utils, onCanvasClick, onCanvasDragEnd, onSelectObject, onReadyChange };
}

describe('DziViewer', () => {
  beforeEach(() => {
    mockHook.error = null;
    mockHook.isLoading = false;
    mockHook.isReady = true;
  });

  describe('toolbar', () => {
    it('wires the zoom, fit and reset buttons to the viewer controls', async () => {
      const user = userEvent.setup();
      renderViewer();

      await user.click(screen.getByTestId('zoom-in'));
      expect(mockHook.zoomIn).toHaveBeenCalled();

      await user.click(screen.getByTestId('zoom-out'));
      expect(mockHook.zoomOut).toHaveBeenCalled();

      await user.click(screen.getByTestId('fit-screen'));
      expect(mockHook.fitToScreen).toHaveBeenCalled();

      await user.click(screen.getByTestId('reset-view'));
      expect(mockHook.resetView).toHaveBeenCalled();
    });

    it('shows the object count once the viewer is ready', () => {
      renderViewer();

      expect(screen.getByTestId('viewer-meta')).toHaveTextContent('1 đối tượng');
    });

    it('shows a loading message while the viewer is starting', () => {
      mockHook.isReady = false;
      renderViewer();

      expect(screen.getByTestId('viewer-meta')).toHaveTextContent('Đang khởi tạo…');
    });

    it('reports the readiness change to the parent', async () => {
      const { onReadyChange } = renderViewer();

      await waitFor(() => expect(onReadyChange).toHaveBeenCalledWith(true));
    });
  });

  describe('interaction layer', () => {
    it('does not capture gestures when no tool is armed', () => {
      renderViewer();

      // The transparent layer only exists while a tool is active; otherwise
      // OpenSeadragon keeps pan and zoom.
      expect(screen.queryByTestId('drawing-layer')).toBeNull();
    });

    it('captures gestures when a tool is armed', () => {
      renderViewer({ activeTool: 'POINT' });

      expect(screen.getByTestId('drawing-layer')).toBeInTheDocument();
    });

    it('shows the hint of the active tool', () => {
      renderViewer({ activeTool: 'RECTANGLE' });

      expect(screen.getByTestId('tool-hint')).toHaveTextContent('Kéo chuột để vẽ hình chữ nhật.');
    });

    it('hides the hint when no tool is armed', () => {
      renderViewer();

      expect(screen.queryByTestId('tool-hint')).toBeNull();
    });

    it('reports a click as an image-space point', () => {
      const { onCanvasClick } = renderViewer({ activeTool: 'POINT' });

      // `fireEvent` is used instead of `userEvent` because only it propagates
      // explicit `clientX`/`clientY` values in jsdom.
      fireEvent.click(screen.getByTestId('drawing-layer'), { clientX: 200, clientY: 100 });

      expect(onCanvasClick).toHaveBeenCalledWith({ x: 100, y: 50 });
    });

    it('ignores a click when no tool is armed', () => {
      const { onCanvasClick } = renderViewer();

      fireEvent.click(screen.getByTestId('dzi-viewer'), { clientX: 200, clientY: 100 });

      expect(onCanvasClick).not.toHaveBeenCalled();
    });

    it('ignores a click on an existing object', async () => {
      const user = userEvent.setup();
      const { onCanvasClick } = renderViewer({ activeTool: 'POINT' });

      // The object group carries `data-object-id`, so a click on it is a
      // selection, not a canvas click.
      await user.click(screen.getByTestId('object-point-obj-1'));

      expect(onCanvasClick).not.toHaveBeenCalled();
    });

    it('does not report a drag for a bare click', () => {
      const { onCanvasDragEnd } = renderViewer({ activeTool: 'RECTANGLE' });

      const layer = screen.getByTestId('drawing-layer');
      fireEvent.pointerDown(layer, { clientX: 100, clientY: 100, pointerId: 1 });
      fireEvent.pointerMove(layer, { clientX: 101, clientY: 101, pointerId: 1 });
      fireEvent.pointerUp(layer, { clientX: 101, clientY: 101, pointerId: 1 });

      expect(onCanvasDragEnd).not.toHaveBeenCalled();
    });

    it('reports a drag as an image-space rectangle', () => {
      const { onCanvasDragEnd } = renderViewer({ activeTool: 'RECTANGLE' });

      const layer = screen.getByTestId('drawing-layer');
      fireEvent.pointerDown(layer, { clientX: 100, clientY: 100, pointerId: 1 });
      fireEvent.pointerMove(layer, { clientX: 200, clientY: 160, pointerId: 1 });
      fireEvent.pointerUp(layer, { clientX: 200, clientY: 160, pointerId: 1 });

      expect(onCanvasDragEnd).toHaveBeenCalledWith({
        x: 50,
        y: 50,
        width: 50,
        height: 30,
      });
    });

    it('shows a drag preview while the pointer is down', () => {
      renderViewer({ activeTool: 'RECTANGLE' });

      const layer = screen.getByTestId('drawing-layer');
      fireEvent.pointerDown(layer, { clientX: 100, clientY: 100, pointerId: 1 });
      fireEvent.pointerMove(layer, { clientX: 180, clientY: 140, pointerId: 1 });

      const preview = screen.getByTestId('drag-preview');
      expect(preview).toBeInTheDocument();
      expect(preview.style.width).toBe('80px');
    });

    it('reports a double click so the polygon can be closed', () => {
      const onCanvasDoubleClick = vi.fn();
      renderViewer({ activeTool: 'POLYGON', onCanvasDoubleClick });

      fireEvent.doubleClick(screen.getByTestId('drawing-layer'));

      expect(onCanvasDoubleClick).toHaveBeenCalledTimes(1);
    });

    it('ignores a double click when a non-polygon tool is armed', () => {
      const onCanvasDoubleClick = vi.fn();
      renderViewer({ activeTool: 'POINT', onCanvasDoubleClick });

      fireEvent.doubleClick(screen.getByTestId('drawing-layer'));

      expect(onCanvasDoubleClick).not.toHaveBeenCalled();
    });
  });

  describe('view vs edit mode', () => {
    it('makes objects non-interactive in view mode', async () => {
      const user = userEvent.setup();
      const { onSelectObject } = renderViewer({ interactionMode: 'view' });

      // The shape is still rendered (layers are visual content in view mode),
      // but clicking it must not select anything.
      await user.click(screen.getByTestId('object-point-obj-1'));

      expect(onSelectObject).not.toHaveBeenCalled();
    });

    it('makes objects interactive in edit mode', async () => {
      const user = userEvent.setup();
      const { onSelectObject } = renderViewer({ interactionMode: 'edit' });

      await user.click(screen.getByTestId('object-point-obj-1'));

      expect(onSelectObject).toHaveBeenCalledWith('obj-1');
    });

    it('keeps the root SVG transparent in both modes', () => {
      // In view mode the layers must behave like part of the base image, so
      // the overlay must never intercept a pan or a zoom gesture.
      for (const interactionMode of ['view', 'edit'] as const) {
        const { unmount } = renderViewer({ interactionMode });
        expect(screen.getByTestId('svg-overlay').getAttribute('pointer-events')).toBe('none');
        unmount();
      }
    });
  });

  describe('viewer state', () => {
    it('shows the loading overlay while the image loads', () => {
      mockHook.isLoading = true;
      renderViewer();

      expect(screen.getByTestId('viewer-loading')).toBeInTheDocument();
    });

    it('shows the error overlay when the descriptor fails to load', () => {
      mockHook.error = 'Không tải được ảnh';
      renderViewer();

      expect(screen.getByTestId('viewer-error')).toHaveTextContent('Không tải được ảnh');
    });
  });

  describe('overlay rendering', () => {
    it('renders the objects in the SVG overlay', () => {
      renderViewer();

      expect(screen.getByTestId('svg-overlay')).toBeInTheDocument();
      expect(screen.getByTestId('object-point-obj-1')).toBeInTheDocument();
    });

    it('keeps the root SVG transparent to pointer events', () => {
      renderViewer();

      // Regression: the root overlay used to swallow the drag-to-pan and
      // wheel-to-zoom gestures of OpenSeadragon.
      expect(screen.getByTestId('svg-overlay').getAttribute('pointer-events')).toBe('none');
    });

    it('sizes the overlay to the base image pixel grid', () => {
      renderViewer({ imageWidth: 2048, imageHeight: 1536 });

      const svg = screen.getByTestId('svg-overlay');
      expect(svg.getAttribute('viewBox')).toBe('0 0 2048 1536');
    });

    it('renders the children between the toolbar and the viewer', () => {
      render(
        <DziViewer
          imageId="image-1"
          objects={[]}
          selectedObjectId={null}
          onSelectObject={vi.fn()}
          activeTool={null}
          interactionMode="view"
          onCanvasClick={vi.fn()}
          onCanvasDragEnd={vi.fn()}
          overlayImageUrls={{}}
        >
          <div data-testid="viewer-child">Custom banner</div>
        </DziViewer>,
      );

      expect(screen.getByTestId('viewer-child')).toBeInTheDocument();
    });
  });
});
