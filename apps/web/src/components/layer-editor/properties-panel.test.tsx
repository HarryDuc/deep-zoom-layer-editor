import { describe, expect, it, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PropertiesPanel } from './properties-panel';
import type { DraftObject } from '@/lib/editor-state';
import { ApiError } from '@/lib/http';
import * as apiClient from '@/services/api-client';

vi.mock('@/services/api-client', () => ({
  uploadOverlay: vi.fn(),
}));

function makeObject(overrides: Partial<DraftObject> = {}): DraftObject {
  return {
    id: 'object-1',
    layerId: 'layer-1',
    type: 'RECTANGLE',
    geometry: { x: 100, y: 200, width: 300, height: 150 },
    style: {
      fill: '#2563eb',
      fillOpacity: 0.25,
      stroke: '#1d4ed8',
      strokeWidth: 2,
      strokeOpacity: 1,
    },
    metadata: {},
    visible: true,
    zIndex: 0,
    isNew: true,
    isPersisted: false,
    ...overrides,
  };
}

/**
 * Stateful harness mirroring the real editor: geometry/style/metadata updates
 * are applied to the draft object so the controlled inputs re-render with the
 * new values, exactly like the layer editor does.
 */
function renderPanel(initial: DraftObject | null = makeObject()) {
  const spies = {
    onUpdateGeometry: vi.fn(),
    onUpdateStyle: vi.fn(),
    onUpdateMetadata: vi.fn(),
    onRemove: vi.fn(),
    onToggleVisibility: vi.fn(),
    onMove: vi.fn(),
    onOverlayUploaded: vi.fn(),
  };

  function Harness() {
    const [object, setObject] = useState<DraftObject | null>(initial);
    return (
      <PropertiesPanel
        object={object}
        imageId="image-1"
        imageWidth={2000}
        imageHeight={1500}
        onUpdateGeometry={(geometry) => {
          spies.onUpdateGeometry(geometry);
          setObject((current) =>
            current ? { ...current, geometry } : current,
          );
        }}
        onUpdateStyle={(patch) => {
          spies.onUpdateStyle(patch);
          setObject((current) =>
            current
              ? { ...current, style: { ...current.style, ...patch } as DraftObject['style'] }
              : current,
          );
        }}
        onUpdateMetadata={(patch) => {
          spies.onUpdateMetadata(patch);
          setObject((current) =>
            current ? { ...current, metadata: { ...current.metadata, ...patch } } : current,
          );
        }}
        onRemove={spies.onRemove}
        onToggleVisibility={spies.onToggleVisibility}
        onMove={spies.onMove}
        onOverlayUploaded={spies.onOverlayUploaded}
      />
    );
  }

  const utils = render(<Harness />);
  return { ...utils, ...spies };
}

describe('PropertiesPanel', () => {
  beforeEach(() => {
    vi.mocked(apiClient.uploadOverlay).mockReset();
  });

  it('shows a hint when nothing is selected', () => {
    renderPanel(null);
    expect(screen.getByTestId('properties-empty')).toBeInTheDocument();
  });

  it('shows the type of the selected object', () => {
    renderPanel(makeObject({ type: 'POLYGON', geometry: { points: [] } }));
    expect(screen.getByTestId('properties-type')).toHaveTextContent('Đa giác');
  });

  describe('geometry editing', () => {
    it('updates rectangle x through the number field', async () => {
      const user = userEvent.setup();
      const { onUpdateGeometry } = renderPanel();

      const xInput = screen.getByTestId('rect-x');
      expect(xInput).toHaveValue(100);

      await user.clear(xInput);
      await user.type(xInput, '250');

      expect(onUpdateGeometry).toHaveBeenLastCalledWith(
        expect.objectContaining({ x: 250, y: 200, width: 300, height: 150 }),
      );
      expect(xInput).toHaveValue(250);
    });

    it('updates rectangle width', async () => {
      const user = userEvent.setup();
      const { onUpdateGeometry } = renderPanel();

      const widthInput = screen.getByTestId('rect-width');
      await user.clear(widthInput);
      await user.type(widthInput, '420');

      expect(onUpdateGeometry).toHaveBeenLastCalledWith(expect.objectContaining({ width: 420 }));
    });

    it('updates a single polygon vertex without touching the others', async () => {
      const user = userEvent.setup();
      const { onUpdateGeometry } = renderPanel(
        makeObject({
          type: 'POLYGON',
          geometry: {
            points: [
              { x: 10, y: 10 },
              { x: 100, y: 10 },
              { x: 100, y: 100 },
            ],
          },
        }),
      );

      const xInput = screen.getByTestId('poly-x-1');
      await user.clear(xInput);
      await user.type(xInput, '150');

      expect(onUpdateGeometry).toHaveBeenLastCalledWith({
        points: [
          { x: 10, y: 10 },
          { x: 150, y: 10 },
          { x: 100, y: 100 },
        ],
      });
    });

    it('updates point coordinates', async () => {
      const user = userEvent.setup();
      const { onUpdateGeometry } = renderPanel(
        makeObject({ type: 'POINT', geometry: { x: 5, y: 6 } }),
      );

      const yInput = screen.getByTestId('point-y');
      await user.clear(yInput);
      await user.type(yInput, '77');

      expect(onUpdateGeometry).toHaveBeenLastCalledWith({ x: 5, y: 77 });
    });

    it('ignores a non-numeric value instead of emitting NaN', async () => {
      const { onUpdateGeometry } = renderPanel();

      const xInput = screen.getByTestId('rect-x');
      fireEvent.change(xInput, { target: { value: '' } });

      expect(onUpdateGeometry).not.toHaveBeenCalledWith(
        expect.objectContaining({ x: Number.NaN }),
      );
    });

    it('clamps the max attribute to the image dimensions', () => {
      renderPanel();
      expect(screen.getByTestId('rect-x')).toHaveAttribute('max', '2000');
      expect(screen.getByTestId('rect-y')).toHaveAttribute('max', '1500');
    });
  });

  describe('style editing', () => {
    it('emits a fill colour patch', () => {
      const { onUpdateStyle } = renderPanel();

      fireEvent.change(screen.getByTestId('style-fill'), {
        target: { value: '#ff0000' },
      });

      expect(onUpdateStyle).toHaveBeenCalledWith({ fill: '#ff0000' });
    });

    it('emits a numeric fill opacity patch from the slider', async () => {
      const { onUpdateStyle } = renderPanel();
      const slider = screen.getByTestId('style-fill-opacity');

      fireEvent.change(slider, { target: { value: '0.5' } });

      await waitFor(() => {
        expect(onUpdateStyle).toHaveBeenCalledWith({ fillOpacity: 0.5 });
      });
    });

    it('renders point-specific style controls for POINT objects', () => {
      renderPanel(makeObject({ type: 'POINT', geometry: { x: 1, y: 2 }, style: {} as never }));

      const radius = screen.getByTestId('point-radius');
      expect(radius).toBeInTheDocument();
      // Falls back to defaults when the draft style is still empty.
      expect(radius).toHaveValue('8');
      expect(screen.queryByTestId('style-fill-opacity')).toBeNull();
    });

    it('renders label style controls for LABEL objects', () => {
      renderPanel(
        makeObject({
          type: 'LABEL',
          geometry: { x: 1, y: 2 },
          style: {} as never,
          metadata: { text: 'Xin chào' },
        }),
      );

      expect(screen.getByTestId('label-color')).toBeInTheDocument();
      expect(screen.getByTestId('label-text-input')).toHaveValue('Xin chào');
    });

    it('shows an opacity slider for IMAGE objects', () => {
      renderPanel(
        makeObject({
          type: 'IMAGE',
          geometry: { x: 0, y: 0, width: 10, height: 10, overlayId: 'overlay-1' },
          style: { opacity: 0.4 },
        }),
      );

      expect(screen.getByTestId('image-opacity')).toHaveValue('0.4');
      expect(screen.getByText('40%')).toBeInTheDocument();
    });
  });

  describe('label metadata', () => {
    it('updates the label text as the user types Vietnamese', async () => {
      const user = userEvent.setup();
      const { onUpdateMetadata } = renderPanel(
        makeObject({ type: 'LABEL', geometry: { x: 1, y: 2 }, metadata: { text: '' } }),
      );

      await user.type(screen.getByTestId('label-text-input'), 'Khu A');

      await waitFor(() => {
        expect(onUpdateMetadata).toHaveBeenLastCalledWith({ text: 'Khu A' });
      });
    });
  });

  describe('object actions', () => {
    it('toggles visibility, moves and removes the object', async () => {
      const user = userEvent.setup();
      const { onToggleVisibility, onMove, onRemove } = renderPanel();

      await user.click(screen.getByTestId('toggle-object-visibility'));
      expect(onToggleVisibility).toHaveBeenCalled();

      await user.click(screen.getByTestId('object-up'));
      expect(onMove).toHaveBeenCalledWith('up');

      await user.click(screen.getByTestId('object-down'));
      expect(onMove).toHaveBeenCalledWith('down');

      await user.click(screen.getByTestId('remove-object'));
      expect(onRemove).toHaveBeenCalled();
    });
  });

  describe('overlay upload', () => {
    it('uploads a PNG and reports the new overlay id', async () => {
      const user = userEvent.setup();
      const { onOverlayUploaded, onUpdateGeometry } = renderPanel(
        makeObject({
          type: 'IMAGE',
          geometry: { x: 0, y: 0, width: 10, height: 10, overlayId: 'old' },
          style: { opacity: 1 },
        }),
      );

      vi.mocked(apiClient.uploadOverlay).mockResolvedValue({
        _id: 'new-overlay',
        imageAssetId: 'image-1',
        mimeType: 'image/png',
        width: 10,
        height: 10,
        fileSize: 100,
        url: '/api/v1/images/image-1/overlays/new-overlay',
        createdAt: '2026-01-01T00:00:00.000Z',
      });

      const file = new File(['binary'], 'pin.png', { type: 'image/png' });
      await user.upload(screen.getByTestId('overlay-file-input'), file);

      await waitFor(() => {
        expect(onOverlayUploaded).toHaveBeenCalledWith('new-overlay');
      });
      expect(onUpdateGeometry).toHaveBeenCalledWith(
        expect.objectContaining({ overlayId: 'new-overlay' }),
      );
    });

    it('reshapes the box to the overlay aspect ratio instead of stretching it', async () => {
      // Regression: the overlay used to be drawn into whatever box the user
      // dragged, with preserveAspectRatio="none". A detailed bitmap in a
      // mismatched box was squashed and looked torn.
      const user = userEvent.setup();
      const { onUpdateGeometry } = renderPanel(
        makeObject({
          type: 'IMAGE',
          // Drawn box is 4:1, but the bitmap is 2:1.
          geometry: { x: 100, y: 200, width: 400, height: 100, overlayId: 'old' },
          style: { opacity: 1 },
        }),
      );

      vi.mocked(apiClient.uploadOverlay).mockResolvedValue({
        _id: 'new-overlay',
        imageAssetId: 'image-1',
        mimeType: 'image/png',
        width: 2000,
        height: 1000,
        fileSize: 100,
        url: '/api/v1/images/image-1/overlays/new-overlay',
        createdAt: '2026-01-01T00:00:00.000Z',
      });

      await user.upload(
        screen.getByTestId('overlay-file-input'),
        new File(['binary'], 'detail.png', { type: 'image/png' }),
      );

      await waitFor(() => {
        expect(onUpdateGeometry).toHaveBeenCalledWith(
          expect.objectContaining({ overlayId: 'new-overlay', width: 400, height: 200 }),
        );
      });
    });

    it('surfaces an API error without losing the current selection', async () => {
      const user = userEvent.setup();
      const { onOverlayUploaded } = renderPanel(
        makeObject({
          type: 'IMAGE',
          geometry: { x: 0, y: 0, width: 10, height: 10, overlayId: 'old' },
          style: { opacity: 1 },
        }),
      );

      vi.mocked(apiClient.uploadOverlay).mockRejectedValue(
        new ApiError(400, 'UNSUPPORTED_FILE_TYPE', 'Overlay content must be PNG or WebP'),
      );

      await user.upload(
        screen.getByTestId('overlay-file-input'),
        new File(['x'], 'bad.png', { type: 'image/png' }),
      );

      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent(/PNG or WebP/);
      });
      expect(onOverlayUploaded).not.toHaveBeenCalled();
    });
  });

  it('disables every control while a save is in flight', () => {
    render(
      <PropertiesPanel
        object={makeObject()}
        imageId="image-1"
        imageWidth={1000}
        imageHeight={1000}
        onUpdateGeometry={vi.fn()}
        onUpdateStyle={vi.fn()}
        onUpdateMetadata={vi.fn()}
        onRemove={vi.fn()}
        onToggleVisibility={vi.fn()}
        onMove={vi.fn()}
        onOverlayUploaded={vi.fn()}
        disabled
      />,
    );

    expect(screen.getByTestId('rect-x')).toBeDisabled();
    expect(screen.getByTestId('style-fill')).toBeDisabled();
    expect(screen.getByTestId('remove-object')).toBeDisabled();
  });
});
