import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ImageAsset, LayerObject } from '@deep-zoom/shared-types';
import { LayerEditor } from './layer-editor';
import * as apiClient from '@/services/api-client';

/**
 * Component tests for the editor orchestrator.
 *
 * The viewer is replaced by a stub so the tests focus on the editor's own
 * behaviour: tool selection, the drawing pipeline, keyboard shortcuts and the
 * rules that decide which objects reach the overlay.
 */

vi.mock('@/services/api-client', () => ({
  fetchLayers: vi.fn(),
  fetchLayerObjects: vi.fn(),
  createLayer: vi.fn(),
  updateLayer: vi.fn(),
  deleteLayer: vi.fn(),
  createLayerObject: vi.fn(),
  updateLayerObject: vi.fn(),
  deleteLayerObject: vi.fn(),
  reorderLayerObjects: vi.fn(),
  uploadOverlay: vi.fn(),
}));

const mocked = vi.mocked(apiClient);

const canvasClick = vi.fn();
const canvasDragEnd = vi.fn();
const selectObject = vi.fn();

vi.mock('@/components/dzi-viewer/dzi-viewer', () => ({
  DziViewer: ({
    objects,
    activeTool,
    onCanvasClick,
    onCanvasDragEnd,
    onCanvasDoubleClick,
    onSelectObject,
    children,
  }: {
    objects: Array<{ _id: string; type: string }>;
    activeTool: string | null;
    onCanvasClick: (point: { x: number; y: number }) => void;
    onCanvasDragEnd: (rect: { x: number; y: number; width: number; height: number }) => void;
    onCanvasDoubleClick?: () => void;
    onSelectObject: (id: string | null) => void;
    children?: React.ReactNode;
  }) => (
    <div data-testid="dzi-viewer">
      <span data-testid="viewer-active-tool">{activeTool ?? 'none'}</span>
      <span data-testid="viewer-object-count">{objects.length}</span>
      <span data-testid="viewer-object-types">{objects.map((o) => o.type).join(',')}</span>
      <button
        type="button"
        data-testid="mock-canvas-click"
        onClick={() => onCanvasClick({ x: 120, y: 240 })}
      >
        click
      </button>
      <button
        type="button"
        data-testid="mock-canvas-double-click"
        onClick={() => onCanvasDoubleClick?.()}
      >
        double click
      </button>
      <button
        type="button"
        data-testid="mock-canvas-drag"
        onClick={() => onCanvasDragEnd({ x: 10, y: 20, width: 100, height: 50 })}
      >
        drag
      </button>
      <button
        type="button"
        data-testid="mock-select"
        onClick={() => onSelectObject('object-1')}
      >
        select
      </button>
      {children}
    </div>
  ),
}));

const IMAGE: ImageAsset = {
  _id: 'image-1',
  name: 'Bản đồ vệ tinh',
  originalFilename: 'map.jpg',
  width: 1000,
  height: 800,
  fileSize: 1024,
  mimeType: 'image/jpeg',
  status: 'COMPLETED',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function makeLayer(overrides: Record<string, unknown> = {}) {
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

describe('LayerEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    canvasClick.mockClear();
    canvasDragEnd.mockClear();
    selectObject.mockClear();

    mocked.fetchLayers.mockResolvedValue([makeLayer()]);
    mocked.fetchLayerObjects.mockResolvedValue([makeObject()]);
    mocked.reorderLayerObjects.mockResolvedValue([]);
    mocked.updateLayer.mockImplementation(async (layerId, payload) =>
      makeLayer({ _id: layerId, ...payload }),
    );
    mocked.updateLayerObject.mockImplementation(async (objectId, payload) =>
      makeObject({ _id: objectId, ...payload }),
    );
    mocked.createLayer.mockImplementation(async (_imageId, payload) =>
      makeLayer({ _id: 'layer-new', name: payload.name }),
    );
    mocked.createLayerObject.mockImplementation(async (layerId, payload) =>
      makeObject({ _id: 'object-new', layerId, type: payload.type, geometry: payload.geometry }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function renderEditor() {
    const view = render(<LayerEditor image={IMAGE} />);
    await waitFor(() => expect(mocked.fetchLayers).toHaveBeenCalled());
    return view;
  }

  /* ------------------------------- rendering ------------------------------ */

  it('shows the image name and the object count', async () => {
    await renderEditor();

    expect(screen.getByRole('heading', { name: 'Bản đồ vệ tinh' })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId('editor-object-count')).toHaveTextContent('1 đối tượng'),
    );
  });

  it('passes the visible objects to the viewer', async () => {
    await renderEditor();

    await waitFor(() => expect(screen.getByTestId('viewer-object-count')).toHaveTextContent('1'));
    expect(screen.getByTestId('viewer-object-types')).toHaveTextContent('POINT');
  });

  it('hides objects that belong to a hidden layer', async () => {
    mocked.fetchLayers.mockResolvedValue([makeLayer({ visible: false })]);

    await renderEditor();

    await waitFor(() => expect(screen.getByTestId('viewer-object-count')).toHaveTextContent('0'));
  });

  it('hides objects that are individually invisible', async () => {
    mocked.fetchLayerObjects.mockResolvedValue([makeObject({ visible: false })]);

    await renderEditor();

    await waitFor(() => expect(screen.getByTestId('viewer-object-count')).toHaveTextContent('0'));
  });

  it('does not render an IMAGE object that has no overlay asset yet', async () => {
    mocked.fetchLayerObjects.mockResolvedValue([
      makeObject({
        _id: 'image-object',
        type: 'IMAGE',
        geometry: { x: 0, y: 0, width: 10, height: 10, overlayId: '' },
      }),
    ]);

    await renderEditor();

    await waitFor(() => expect(screen.getByTestId('viewer-object-count')).toHaveTextContent('0'));
    expect(screen.getByTestId('overlay-missing-warning')).toBeInTheDocument();
  });

  it('renders an IMAGE object that references an overlay asset', async () => {
    mocked.fetchLayerObjects.mockResolvedValue([
      makeObject({
        _id: 'image-object',
        type: 'IMAGE',
        geometry: { x: 0, y: 0, width: 10, height: 10, overlayId: 'overlay-1' },
      }),
    ]);

    await renderEditor();

    await waitFor(() => expect(screen.getByTestId('viewer-object-count')).toHaveTextContent('1'));
    expect(screen.queryByTestId('overlay-missing-warning')).not.toBeInTheDocument();
  });

  /* --------------------------------- tools -------------------------------- */

  it('starts with no tool selected', async () => {
    await renderEditor();

    await waitFor(() => expect(screen.getByTestId('viewer-active-tool')).toHaveTextContent('none'));
  });

  it('arms and disarms a tool when it is clicked twice', async () => {
    const user = userEvent.setup();
    await renderEditor();

    await user.click(screen.getByTestId('tool-rectangle'));
    expect(screen.getByTestId('viewer-active-tool')).toHaveTextContent('RECTANGLE');

    await user.click(screen.getByTestId('tool-rectangle'));
    expect(screen.getByTestId('viewer-active-tool')).toHaveTextContent('none');
  });

  it('disables the drawing tools when there is no active layer', async () => {
    mocked.fetchLayers.mockResolvedValue([]);
    await renderEditor();

    await waitFor(() => expect(screen.getByTestId('tool-point')).toBeDisabled());
    expect(screen.getByTestId('drawing-disabled-hint')).toBeInTheDocument();
  });

  it('disables the drawing tools when the active layer is locked', async () => {
    mocked.fetchLayers.mockResolvedValue([makeLayer({ locked: true })]);
    await renderEditor();

    await waitFor(() => expect(screen.getByTestId('tool-point')).toBeDisabled());
  });

  it('returns to select mode when the select tool is clicked', async () => {
    const user = userEvent.setup();
    await renderEditor();

    await user.click(screen.getByTestId('tool-point'));
    expect(screen.getByTestId('viewer-active-tool')).toHaveTextContent('POINT');

    await user.click(screen.getByTestId('tool-select'));
    expect(screen.getByTestId('viewer-active-tool')).toHaveTextContent('none');
  });

  /* ------------------------------- drawing -------------------------------- */

  it('adds a point object on a canvas click with the point tool', async () => {
    const user = userEvent.setup();
    await renderEditor();

    await user.click(screen.getByTestId('tool-point'));
    await user.click(screen.getByTestId('mock-canvas-click'));

    await waitFor(() => expect(screen.getByTestId('editor-object-count')).toHaveTextContent('2'));
    // Editing must not issue a request; the save is explicit.
    expect(mocked.createLayerObject).not.toHaveBeenCalled();
  });

  it('adds a label object with default Vietnamese text', async () => {
    const user = userEvent.setup();
    await renderEditor();

    await user.click(screen.getByTestId('tool-label'));
    await user.click(screen.getByTestId('mock-canvas-click'));

    await waitFor(() => expect(screen.getByTestId('editor-object-count')).toHaveTextContent('2'));
  });

  it('adds a rectangle object on a drag', async () => {
    const user = userEvent.setup();
    await renderEditor();

    await user.click(screen.getByTestId('tool-rectangle'));
    await user.click(screen.getByTestId('mock-canvas-drag'));

    await waitFor(() => expect(screen.getByTestId('editor-object-count')).toHaveTextContent('2'));
    expect(screen.getByTestId('viewer-object-types')).toHaveTextContent('RECTANGLE');
  });

  it('adds an image object without an overlay asset on a drag', async () => {
    const user = userEvent.setup();
    await renderEditor();

    await user.click(screen.getByTestId('tool-image'));
    await user.click(screen.getByTestId('mock-canvas-drag'));

    await waitFor(() => expect(screen.getByTestId('editor-object-count')).toHaveTextContent('2'));
    // Without an overlay asset the object is not rendered yet.
    expect(screen.getByTestId('viewer-object-count')).toHaveTextContent('1');
    expect(screen.getByTestId('overlay-missing-warning')).toBeInTheDocument();
  });

  it('collects polygon points and closes them with the finish button', async () => {
    const user = userEvent.setup();
    await renderEditor();

    await user.click(screen.getByTestId('tool-polygon'));

    await user.click(screen.getByTestId('mock-canvas-click'));
    await user.click(screen.getByTestId('mock-canvas-click'));
    await user.click(screen.getByTestId('mock-canvas-click'));

    expect(screen.getByTestId('polygon-progress')).toHaveTextContent('3 điểm');

    await user.click(screen.getByTestId('finish-polygon'));

    await waitFor(() => expect(screen.getByTestId('editor-object-count')).toHaveTextContent('2'));
    expect(screen.getByTestId('viewer-object-types')).toHaveTextContent('POLYGON');
  });

  it('keeps the finish button disabled until the polygon has three points', async () => {
    const user = userEvent.setup();
    await renderEditor();

    await user.click(screen.getByTestId('tool-polygon'));
    expect(screen.getByTestId('finish-polygon')).toBeDisabled();

    await user.click(screen.getByTestId('mock-canvas-click'));
    await user.click(screen.getByTestId('mock-canvas-click'));
    expect(screen.getByTestId('finish-polygon')).toBeDisabled();

    await user.click(screen.getByTestId('mock-canvas-click'));
    expect(screen.getByTestId('finish-polygon')).toBeEnabled();
  });

  it('closes the polygon with the Enter key', async () => {
    const user = userEvent.setup();
    await renderEditor();

    await user.click(screen.getByTestId('tool-polygon'));
    await user.click(screen.getByTestId('mock-canvas-click'));
    await user.click(screen.getByTestId('mock-canvas-click'));
    await user.click(screen.getByTestId('mock-canvas-click'));

    await user.keyboard('{Enter}');

    await waitFor(() => expect(screen.getByTestId('editor-object-count')).toHaveTextContent('2'));
  });

  it('closes the polygon with a double click on the canvas', async () => {
    const user = userEvent.setup();
    await renderEditor();

    await user.click(screen.getByTestId('tool-polygon'));
    await user.click(screen.getByTestId('mock-canvas-click'));
    await user.click(screen.getByTestId('mock-canvas-click'));
    await user.click(screen.getByTestId('mock-canvas-click'));

    await user.click(screen.getByTestId('mock-canvas-double-click'));

    await waitFor(() => expect(screen.getByTestId('editor-object-count')).toHaveTextContent('2'));
    expect(screen.getByTestId('viewer-object-types')).toHaveTextContent('POLYGON');
  });

  it('cancels the polygon and the tool with the Escape key', async () => {
    const user = userEvent.setup();
    await renderEditor();

    await user.click(screen.getByTestId('tool-polygon'));
    await user.click(screen.getByTestId('mock-canvas-click'));
    expect(screen.getByTestId('polygon-progress')).toBeInTheDocument();

    await user.keyboard('{Escape}');

    expect(screen.queryByTestId('polygon-progress')).not.toBeInTheDocument();
    expect(screen.getByTestId('viewer-active-tool')).toHaveTextContent('none');
  });

  /* ------------------------------- selection ------------------------------ */

  it('disarms the active tool when an object is selected', async () => {
    const user = userEvent.setup();
    await renderEditor();

    await user.click(screen.getByTestId('tool-point'));
    await user.click(screen.getByTestId('mock-select'));

    expect(screen.getByTestId('viewer-active-tool')).toHaveTextContent('none');
  });

  /* -------------------------------- actions ------------------------------- */

  it('enables the save button only when there are unsaved changes', async () => {
    const user = userEvent.setup();
    await renderEditor();

    await waitFor(() => expect(screen.getByTestId('save-edits')).toBeDisabled());

    await user.click(screen.getByTestId('tool-point'));
    await user.click(screen.getByTestId('mock-canvas-click'));

    await waitFor(() => expect(screen.getByTestId('save-edits')).toBeEnabled());
  });

  it('saves the changes and reports success', async () => {
    const user = userEvent.setup();
    await renderEditor();

    await user.click(screen.getByTestId('tool-point'));
    await user.click(screen.getByTestId('mock-canvas-click'));
    await user.click(screen.getByTestId('save-edits'));

    await waitFor(() => expect(screen.getByTestId('editor-notice')).toHaveTextContent('Đã lưu'));
    expect(mocked.createLayerObject).toHaveBeenCalledTimes(1);
  });

  it('reverts the changes when the cancel button is used', async () => {
    const user = userEvent.setup();
    await renderEditor();

    await user.click(screen.getByTestId('tool-point'));
    await user.click(screen.getByTestId('mock-canvas-click'));
    await waitFor(() => expect(screen.getByTestId('editor-object-count')).toHaveTextContent('2'));

    await user.click(screen.getByTestId('cancel-edits'));

    await waitFor(() => expect(screen.getByTestId('editor-object-count')).toHaveTextContent('1'));
    expect(mocked.createLayerObject).not.toHaveBeenCalled();
  });

  it('reloads the layers and objects on demand', async () => {
    const user = userEvent.setup();
    await renderEditor();

    await waitFor(() => expect(mocked.fetchLayers).toHaveBeenCalledTimes(1));

    await user.click(screen.getByTestId('reload-editor'));

    await waitFor(() => expect(mocked.fetchLayers).toHaveBeenCalledTimes(2));
  });
});
