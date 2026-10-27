import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * Tests for the OpenSeadragon lifecycle hook.
 *
 * The real library is replaced by a fake that records the options it was
 * created with and exposes the handlers the hook registers. This makes the
 * contract explicit: the viewer is created once, `open()` is used for later
 * tile sources, and the coordinate helpers delegate to the library instead of
 * doing their own scale arithmetic.
 */

interface FakeHandler {
  (event: unknown): void;
}

interface FakeViewer {
  open: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  addHandler: ReturnType<typeof vi.fn>;
  removeHandler: ReturnType<typeof vi.fn>;
  canvas: HTMLElement;
  element: { getBoundingClientRect: () => DOMRect };
  viewport: {
    zoomBy: ReturnType<typeof vi.fn>;
    goHome: ReturnType<typeof vi.fn>;
    fitBounds: ReturnType<typeof vi.fn>;
    imageToViewerElementCoordinates: ReturnType<typeof vi.fn>;
    viewerElementToImageCoordinates: ReturnType<typeof vi.fn>;
  };
  world: { getItemAt: ReturnType<typeof vi.fn> };
}

let fakeViewer: FakeViewer;
let handlers: Map<string, FakeHandler>;
let openSeadragonFactory: ReturnType<typeof vi.fn>;
let destroyed: number;

vi.mock('openseadragon', () => ({
  default: Object.assign(
    (...args: unknown[]) => openSeadragonFactory(...args),
    {
      Point: class Point {
        constructor(
          public x: number,
          public y: number,
        ) {}
      },
    },
  ),
}));

type UseOpenSeadragon = (
  options: {
    tileSourceUrl: string | null;
    onError?: (message: string) => void;
  },
) => {
  viewerRef: React.RefObject<HTMLDivElement | null>;
  viewer: FakeViewer | null;
  overlayHost: HTMLElement | null;
  isReady: boolean;
  isLoading: boolean;
  error: string | null;
  viewportVersion: number;
  transform: {
    scale: number;
    offsetX: number;
    offsetY: number;
    version: number;
  };
  coordinates: {
    toImage: (clientX: number, clientY: number) => { x: number; y: number };
    toImageRect: (
      start: { clientX: number; clientY: number },
      end: { clientX: number; clientY: number },
    ) => { x: number; y: number; width: number; height: number };
    toElement: (x: number, y: number) => { x: number; y: number };
  };
  zoomIn: () => void;
  zoomOut: () => void;
  fitToScreen: () => void;
  resetView: () => void;
};

async function loadHook(): Promise<UseOpenSeadragon> {
  // The hook lazily imports the library, so the module is imported after the
  // mock is in place.
  const hookModule = await import('./use-open-seadragon');
  return hookModule.useOpenSeadragon as unknown as UseOpenSeadragon;
}

interface Harness {
  result: () => ReturnType<UseOpenSeadragon>;
  rerender: (options: { tileSourceUrl: string | null }) => void;
  unmount: () => void;
}

/**
 * The hook owns the container element through a ref, so it must point at a real
 * DOM node — a plain `renderHook` cannot provide one, hence this wrapper.
 */
function renderViewer(
  useOpenSeadragon: UseOpenSeadragon,
  initialOptions: { tileSourceUrl: string | null; onError?: (message: string) => void },
): Harness {
  let latest: ReturnType<UseOpenSeadragon> | null = null;

  function Probe({
    options,
  }: {
    options: { tileSourceUrl: string | null; onError?: (message: string) => void };
  }): React.ReactElement {
    const hook = useOpenSeadragon(options);
    latest = hook;
    return <div ref={hook.viewerRef} data-testid="osd-host" />;
  }

  const view = render(<Probe options={initialOptions} />);

  return {
    result: () => {
      if (!latest) throw new Error('Hook did not render');
      return latest;
    },
    rerender: (options) => view.rerender(<Probe options={options} />),
    unmount: () => view.unmount(),
  };
}

describe('useOpenSeadragon', () => {
  beforeEach(() => {
    handlers = new Map();
    destroyed = 0;

    fakeViewer = {
      open: vi.fn(),
      destroy: vi.fn(() => {
        destroyed += 1;
      }),
      addHandler: vi.fn((name: string, handler: FakeHandler) => {
        handlers.set(name, handler);
      }),
      removeHandler: vi.fn((name: string) => {
        handlers.delete(name);
      }),
      canvas: document.createElement('div'),
      element: {
        getBoundingClientRect: () =>
          ({
            x: 0,
            y: 0,
            left: 0,
            top: 0,
            width: 800,
            height: 600,
          }) as DOMRect,
      },
      viewport: {
        zoomBy: vi.fn(),
        goHome: vi.fn(),
        fitBounds: vi.fn(),
        imageToViewerElementCoordinates: vi.fn((point: { x: number; y: number }) => ({
          x: point.x * 2,
          y: point.y * 2,
        })),
        viewerElementToImageCoordinates: vi.fn((point: { x: number; y: number }) => ({
          x: point.x / 2,
          y: point.y / 2,
        })),
      },
      world: { getItemAt: vi.fn(() => ({ getBounds: () => ({}) })) },
    };

    openSeadragonFactory = vi.fn(() => fakeViewer);
  });

  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('creates the viewer exactly once and destroys it on unmount', async () => {
    const useOpenSeadragon = await loadHook();
    const harness = renderViewer(useOpenSeadragon, {
      tileSourceUrl: 'http://api.test/images/1/dzi',
    });

    await waitFor(() => expect(harness.result().viewer).not.toBeNull());
    expect(openSeadragonFactory).toHaveBeenCalledTimes(1);

    harness.unmount();
    expect(destroyed).toBe(1);
  });

  it('opens the tile source once the viewer exists', async () => {
    const useOpenSeadragon = await loadHook();
    const harness = renderViewer(useOpenSeadragon, {
      tileSourceUrl: 'http://api.test/images/1/dzi',
    });

    await waitFor(() => expect(fakeViewer.open).toHaveBeenCalledWith({
      tileSource: 'http://api.test/images/1/dzi',
    }));

    // The viewer reports readiness when the library fires its `open` event.
    act(() => {
      handlers.get('open')?.({});
    });

    await waitFor(() => expect(harness.result().isReady).toBe(true));
    expect(harness.result().isLoading).toBe(false);
  });

  it('does not reopen the same tile source', async () => {
    const useOpenSeadragon = await loadHook();
    const harness = renderViewer(useOpenSeadragon, {
      tileSourceUrl: 'http://api.test/images/1/dzi',
    });

    await waitFor(() => expect(fakeViewer.open).toHaveBeenCalledTimes(1));

    harness.rerender({ tileSourceUrl: 'http://api.test/images/1/dzi' });
    await act(async () => {
      await Promise.resolve();
    });

    expect(fakeViewer.open).toHaveBeenCalledTimes(1);
  });

  it('reopens when the tile source changes', async () => {
    const useOpenSeadragon = await loadHook();
    const harness = renderViewer(useOpenSeadragon, {
      tileSourceUrl: 'http://api.test/images/1/dzi',
    });

    await waitFor(() => expect(fakeViewer.open).toHaveBeenCalledTimes(1));

    harness.rerender({ tileSourceUrl: 'http://api.test/images/2/dzi' });

    await waitFor(() => expect(fakeViewer.open).toHaveBeenCalledTimes(2));
    expect(fakeViewer.open).toHaveBeenLastCalledWith({
      tileSource: 'http://api.test/images/2/dzi',
    });
  });

  it('does not open anything when there is no tile source', async () => {
    const useOpenSeadragon = await loadHook();
    const harness = renderViewer(useOpenSeadragon, { tileSourceUrl: null });

    await waitFor(() => expect(harness.result().viewer).not.toBeNull());
    expect(fakeViewer.open).not.toHaveBeenCalled();
  });

  it('increments the viewport version once per drawn frame', async () => {
    const useOpenSeadragon = await loadHook();
    const harness = renderViewer(useOpenSeadragon, {
      tileSourceUrl: 'http://api.test/images/1/dzi',
    });

    await waitFor(() => expect(harness.result().viewer).not.toBeNull());
    const before = harness.result().viewportVersion;

    // `update-viewport` is the single event that marks a drawn frame. Several
    // other viewport events (animation, animation-finish, viewport-change) must
    // NOT each bump the version, or a single pan would re-render the tree many
    // times per frame.
    act(() => {
      handlers.get('viewport-change')?.({});
      handlers.get('animation')?.({});
      handlers.get('animation-finish')?.({});
    });

    expect(harness.result().viewportVersion).toBe(before);

    act(() => {
      handlers.get('update-viewport')?.({});
    });

    await waitFor(() => expect(harness.result().viewportVersion).toBeGreaterThan(before));
  });

  describe('viewport transform', () => {
    it('publishes the image-to-element scale and offset', async () => {
      const useOpenSeadragon = await loadHook();
      const harness = renderViewer(useOpenSeadragon, {
        tileSourceUrl: 'http://api.test/images/1/dzi',
      });

      await waitFor(() => expect(harness.result().viewer).not.toBeNull());

      // The fake maps image (0,0) -> element (0,0) and (1,1) -> (2,2), so the
      // scale is 2 with no translation.
      act(() => {
        handlers.get('update-viewport')?.({});
      });

      await waitFor(() => {
        expect(harness.result().transform.scale).toBe(2);
        expect(harness.result().transform.offsetX).toBe(0);
        expect(harness.result().transform.offsetY).toBe(0);
      });
    });

    it('does not bump the version when the viewport did not actually move', async () => {
      const useOpenSeadragon = await loadHook();
      const harness = renderViewer(useOpenSeadragon, {
        tileSourceUrl: 'http://api.test/images/1/dzi',
      });

      await waitFor(() => expect(harness.result().viewer).not.toBeNull());

      act(() => {
        handlers.get('update-viewport')?.({});
      });
      const version = harness.result().transform.version;

      // A frame that redraws tiles without moving must not invalidate the
      // overlay transform.
      act(() => {
        handlers.get('update-viewport')?.({});
      });

      expect(harness.result().transform.version).toBe(version);
    });
  });

  it('reports an open failure through the error state and the callback', async () => {
    const useOpenSeadragon = await loadHook();
    const onError = vi.fn();
    const harness = renderViewer(useOpenSeadragon, {
      tileSourceUrl: 'http://api.test/images/1/dzi',
      onError,
    });

    await waitFor(() => expect(harness.result().viewer).not.toBeNull());

    act(() => {
      handlers.get('open-failed')?.({});
    });

    await waitFor(() => expect(harness.result().error).toBeTruthy());
    expect(onError).toHaveBeenCalled();
    expect(harness.result().isLoading).toBe(false);
  });

  it('reports an add-item failure without destroying the viewer', async () => {
    const useOpenSeadragon = await loadHook();
    const harness = renderViewer(useOpenSeadragon, {
      tileSourceUrl: 'http://api.test/images/1/dzi',
    });

    await waitFor(() => expect(harness.result().viewer).not.toBeNull());

    act(() => {
      handlers.get('add-item-failed')?.({ message: 'Bad descriptor' });
    });

    await waitFor(() => expect(harness.result().error).toBe('Bad descriptor'));
    expect(destroyed).toBe(0);
  });

  it('clears the error when the viewer opens successfully', async () => {
    const useOpenSeadragon = await loadHook();
    const harness = renderViewer(useOpenSeadragon, {
      tileSourceUrl: 'http://api.test/images/1/dzi',
    });

    await waitFor(() => expect(harness.result().viewer).not.toBeNull());

    act(() => {
      handlers.get('tile-load-failed')?.({});
    });
    await waitFor(() => expect(harness.result().error).toBeTruthy());

    act(() => {
      handlers.get('open')?.({});
    });

    await waitFor(() => expect(harness.result().error).toBeNull());
  });

  describe('controls', () => {
    it('zooms in and out by a fixed factor', async () => {
      const useOpenSeadragon = await loadHook();
      const harness = renderViewer(useOpenSeadragon, {
        tileSourceUrl: 'http://api.test/images/1/dzi',
      });

      await waitFor(() => expect(harness.result().viewer).not.toBeNull());

      act(() => harness.result().zoomIn());
      expect(fakeViewer.viewport.zoomBy).toHaveBeenCalledWith(1.4);

      act(() => harness.result().zoomOut());
      expect(fakeViewer.viewport.zoomBy).toHaveBeenLastCalledWith(1 / 1.4);
    });

    it('fits the first item to the screen', async () => {
      const useOpenSeadragon = await loadHook();
      const harness = renderViewer(useOpenSeadragon, {
        tileSourceUrl: 'http://api.test/images/1/dzi',
      });

      await waitFor(() => expect(harness.result().viewer).not.toBeNull());

      act(() => harness.result().fitToScreen());

      expect(fakeViewer.viewport.fitBounds).toHaveBeenCalled();
    });

    it('resets the view to home', async () => {
      const useOpenSeadragon = await loadHook();
      const harness = renderViewer(useOpenSeadragon, {
        tileSourceUrl: 'http://api.test/images/1/dzi',
      });

      await waitFor(() => expect(harness.result().viewer).not.toBeNull());

      act(() => harness.result().resetView());

      expect(fakeViewer.viewport.goHome).toHaveBeenCalled();
    });
  });

  describe('coordinate conversion', () => {
    it('converts client pixels to image pixels through the library', async () => {
      const useOpenSeadragon = await loadHook();
      const harness = renderViewer(useOpenSeadragon, {
        tileSourceUrl: 'http://api.test/images/1/dzi',
      });

      await waitFor(() => expect(harness.result().viewer).not.toBeNull());

      const point = harness.result().coordinates.toImage(100, 50);

      expect(fakeViewer.viewport.viewerElementToImageCoordinates).toHaveBeenCalled();
      expect(point).toEqual({ x: 50, y: 25 });
    });

    it('converts image pixels to element pixels through the library', async () => {
      const useOpenSeadragon = await loadHook();
      const harness = renderViewer(useOpenSeadragon, {
        tileSourceUrl: 'http://api.test/images/1/dzi',
      });

      await waitFor(() => expect(harness.result().viewer).not.toBeNull());

      const point = harness.result().coordinates.toElement(100, 50);

      expect(fakeViewer.viewport.imageToViewerElementCoordinates).toHaveBeenCalled();
      expect(point).toEqual({ x: 200, y: 100 });
    });

    it('builds a normalised rectangle from two client positions', async () => {
      const useOpenSeadragon = await loadHook();
      const harness = renderViewer(useOpenSeadragon, {
        tileSourceUrl: 'http://api.test/images/1/dzi',
      });

      await waitFor(() => expect(harness.result().viewer).not.toBeNull());

      const rect = harness.result().coordinates.toImageRect(
        { clientX: 200, clientY: 100 },
        { clientX: 100, clientY: 40 },
      );

      // The library halves the coordinates, so (200,100) -> (100,50) and
      // (100,40) -> (50,20). The rectangle is normalised to positive extents.
      expect(rect).toEqual({ x: 50, y: 20, width: 50, height: 30 });
    });
  });
});
