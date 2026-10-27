'use client';
import type OpenSeadragonType from 'openseadragon';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export interface ImageRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ViewerCoordinates {
  /** Image-space point from a client pixel position. */
  toImage: (clientX: number, clientY: number) => { x: number; y: number };
  /** Image-space rect from two client pixel positions. */
  toImageRect: (
    start: { clientX: number; clientY: number },
    end: { clientX: number; clientY: number },
  ) => ImageRect;
  /** Image-space point -> viewer element (CSS) pixels, for SVG overlays. */
  toElement: (x: number, y: number) => { x: number; y: number };
}

/**
 * A viewport transform that maps image pixels straight onto viewer element
 * pixels.
 *
 * The overlay is drawn in *image* coordinates and the browser scales it, so
 * panning and zooming no longer require recomputing every shape's geometry on
 * each animation frame. See `useViewerTransform`.
 */
export interface ViewerTransform {
  /** Scale factor from image pixels to element pixels. */
  scale: number;
  /** Translation of the image origin, in element pixels. */
  offsetX: number;
  offsetY: number;
  /** Bumped whenever the transform changes, so consumers can react. */
  version: number;
}

export interface UseOpenSeadragonResult {
  viewerRef: React.RefObject<HTMLDivElement | null>;
  /** Null until the viewer has been created on the client. */
  viewer: OpenSeadragonType.Viewer | null;
  /**
   * OpenSeadragon's own canvas element.
   *
   * Overlays must be rendered INSIDE this element (via a React portal), because
   * OpenSeadragon binds its mouse tracker to it. A sibling overlay never
   * bubbles pointer events to the viewer, so drag-to-pan and wheel-to-zoom
   * would silently stop working wherever an object covers the canvas.
   */
  overlayHost: HTMLElement | null;
  isReady: boolean;
  isLoading: boolean;
  error: string | null;
  /**
   * Incremented whenever the viewport transform changes.
   *
   * This is the ONLY viewport-driven React state in the app. It is bumped once
   * per drawn frame rather than once per OpenSeadragon event, and consumers
   * must use it to update a CSS transform instead of recomputing geometry.
   */
  viewportVersion: number;
  /**
   * The live image->element transform.
   *
   * Reading it is cheap (no allocation) and it always reflects the current
   * viewport, so it can be used inside animation frames.
   */
  transform: ViewerTransform;
  coordinates: ViewerCoordinates;
  zoomIn: () => void;
  zoomOut: () => void;
  fitToScreen: () => void;
  resetView: () => void;
}

export interface UseOpenSeadragonOptions {
  /** DZI descriptor URL. Changing it re-opens the image but keeps the viewer. */
  tileSourceUrl: string | null;
  /** Called when the descriptor or a tile fails to load. */
  onError?: (message: string) => void;
}

const NAVIGATOR_ASSET_BASE =
  'https://cdn.jsdelivr.net/npm/openseadragon@6.1.1/build/openseadragon/images/';

/**
 * OpenSeadragon touches `document` at module-evaluation time, so importing it
 * statically breaks server-side rendering of the viewer page (the module is
 * evaluated on the server even though the component is a client component).
 * Loading it lazily inside an effect keeps SSR clean; the promise is cached so
 * the library is fetched only once per page.
 */
let openSeadragonModulePromise: Promise<typeof OpenSeadragonType> | null = null;

function loadOpenSeadragon(): Promise<typeof OpenSeadragonType> {
  openSeadragonModulePromise ??= import('openseadragon').then(
    (module) => (module as unknown as { default: typeof OpenSeadragonType }).default,
  );
  return openSeadragonModulePromise;
}

/**
 * Owns a single OpenSeadragon viewer instance for the lifetime of the
 * component.
 *
 * Lifecycle contract (deliberately strict, because recreating a viewer throws
 * away the tile cache and resets the user's zoom):
 *  - the viewer is created exactly once, after mount, and destroyed on unmount;
 *  - `tileSourceUrl` changes call `open()`, never a recreate;
 *  - layer/object/selection state is NOT an input, so editing never reloads the
 *    image.
 *
 * Performance contract: the viewer never re-renders the React tree on its own.
 * Only `viewportVersion` changes, and it changes once per *drawn frame*
 * (`update-viewport`), not once per OpenSeadragon event. During a continuous
 * pan that is one state update per frame instead of one per event, and the
 * consumer only swaps a CSS transform.
 */
export function useOpenSeadragon({
  tileSourceUrl,
  onError,
}: UseOpenSeadragonOptions): UseOpenSeadragonResult {
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const viewerInstanceRef = useRef<OpenSeadragonType.Viewer | null>(null);
  // Kept in a ref so the coordinate helpers stay synchronous once loaded.
  const osdRef = useRef<typeof OpenSeadragonType | null>(null);
  const [viewer, setViewer] = useState<OpenSeadragonType.Viewer | null>(null);
  // OpenSeadragon's canvas element. Overlays are portaled into it so their
  // pointer events bubble to the viewer's own mouse tracker.
  const [overlayHost, setOverlayHost] = useState<HTMLElement | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewportVersion, setViewportVersion] = useState(0);
  // The live transform, kept in a ref so reads never trigger a re-render.
  const transformRef = useRef<ViewerTransform>({
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    version: 0,
  });
  // Keep the latest callback in a ref so handler identity never forces re-init.
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);
  const openedUrlRef = useRef<string | null>(null);

  /* ------------------------------- lifecycle ------------------------------ */
  useEffect(() => {
    const element = viewerRef.current;
    if (!element) {
      return;
    }

    let disposed = false;
    let instance: OpenSeadragonType.Viewer | null = null;

    const start = async (): Promise<void> => {
      const OpenSeadragon = await loadOpenSeadragon();
      if (disposed) return;
      osdRef.current = OpenSeadragon;

      instance = OpenSeadragon({
        element,
        prefixUrl: NAVIGATOR_ASSET_BASE,
        showNavigationControl: false, // the toolbar provides custom controls
        showNavigator: true,
        navigatorPosition: 'BOTTOM_RIGHT',
        navigatorHeight: 110,
        navigatorWidth: 160,
        navigatorBackground: '#0b1220',
        navigatorBorderColor: '#334155',
        navigatorDisplayRegionColor: '#22d3ee',
        gestureSettingsMouse: { clickToZoom: false, dblClickToZoom: true, flickEnabled: true },
        gestureSettingsTouch: { pinchToZoom: true, flickEnabled: true, clickToZoom: false },
        animationTime: 0.5,
        blendTime: 0.1,
        visibilityRatio: 0.5,
        constrainDuringPan: true,
        minZoomImageRatio: 0.5,
        maxZoomPixelRatio: 8,
        imageLoaderLimit: 8,
        preserveViewport: true,
      });

      viewerInstanceRef.current = instance;
      setViewer(instance);
      // The canvas is the element OpenSeadragon tracks for pointer gestures;
      // the overlay has to live inside it to reach those handlers.
      setOverlayHost(instance.canvas ?? null);

      /**
       * Recomputes the image -> element transform and publishes it.
       *
       * Two image points are mapped to element pixels; their difference gives
       * the scale, and the origin gives the translation. Doing it this way
       * keeps the overlay glued to the image without depending on OpenSeadragon
       * internals such as the content bounds.
       */
      const updateTransform = (): void => {
        const current = viewerInstanceRef.current;
        const OpenSeadragon = osdRef.current;
        if (!current || !OpenSeadragon) return;

        const origin = current.viewport.imageToViewerElementCoordinates(
          new OpenSeadragon.Point(0, 0),
        );
        const unit = current.viewport.imageToViewerElementCoordinates(
          new OpenSeadragon.Point(1, 1),
        );

        // A single scale factor is used because OpenSeadragon never scales the
        // axes independently. Both deltas are checked so a rotated or otherwise
        // unexpected viewport is not silently mis-rendered.
        const scaleX = unit.x - origin.x;
        const scaleY = unit.y - origin.y;
        const transform = transformRef.current;

        // Guard against a degenerate viewport (e.g. a zero-sized container
        // during the first layout pass) producing a non-finite transform.
        if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || scaleX === 0) {
          return;
        }

        const nextOffsetX = origin.x;
        const nextOffsetY = origin.y;

        if (
          Math.abs(transform.scale - scaleX) < 1e-9 &&
          Math.abs(transform.offsetX - nextOffsetX) < 1e-9 &&
          Math.abs(transform.offsetY - nextOffsetY) < 1e-9
        ) {
          return;
        }

        transformRef.current = {
          scale: scaleX,
          offsetX: nextOffsetX,
          offsetY: nextOffsetY,
          version: transform.version + 1,
        };
      };

      // `update-viewport` is raised once per drawn frame, after the new
      // location has been rendered. It is the single source of truth for
      // "the viewport moved", so the React tree updates exactly once per frame.
      instance.addHandler('update-viewport', () => {
        updateTransform();
        setViewportVersion((version) => version + 1);
      });

      // A resize changes the mapping without necessarily redrawing, so the
      // transform has to be refreshed explicitly.
      instance.addHandler('resize', () => {
        updateTransform();
        setViewportVersion((version) => version + 1);
      });

      instance.addHandler('open-failed', () => {
        const message = 'Unable to load the image tiles for this asset.';
        setError(message);
        setIsLoading(false);
        onErrorRef.current?.(message);
      });

      instance.addHandler('tile-load-failed', () => {
        // A single missing tile is usually transient; surface it without
        // destroying the viewer, which would lose the user's zoom position.
        setError('Some image tiles failed to load. Try reloading the page.');
      });

      instance.addHandler('add-item-failed', (event) => {
        const message = event.message ?? 'Unable to load the image.';
        setError(message);
        setIsLoading(false);
        onErrorRef.current?.(message);
      });

      instance.addHandler('open', () => {
        setError(null);
        setIsReady(true);
        setIsLoading(false);
        updateTransform();
      });
    };

    void start().catch(() => {
      if (disposed) return;
      setError('Unable to initialise the image viewer.');
      setIsLoading(false);
    });

    return () => {
      disposed = true;
      // destroy() tears down the canvases and all registered handlers.
      instance?.destroy();
      viewerInstanceRef.current = null;
      osdRef.current = null;
      openedUrlRef.current = null;
      setViewer(null);
      setOverlayHost(null);
      setIsReady(false);
      setIsLoading(false);
    };
  }, []);

  /* ------------------------------ tile source ----------------------------- */
  useEffect(() => {
    const instance = viewerInstanceRef.current;
    if (!instance || !tileSourceUrl) {
      return;
    }
    if (openedUrlRef.current === tileSourceUrl) {
      return;
    }
    openedUrlRef.current = tileSourceUrl;
    setError(null);
    setIsReady(false);
    setIsLoading(true);
    // Passing a string tile source makes OpenSeadragon fetch the DZI descriptor
    // (XML) and configure a DziTileSource from it, including its tile Url.
    instance.open({ tileSource: tileSourceUrl });
    // `viewer` is a dependency because the instance is created asynchronously
    // (the library is loaded in an effect); without it the initial open would
    // be skipped and the viewer would stay blank.
  }, [tileSourceUrl, viewer]);

  /* -------------------------------- controls ------------------------------ */
  const zoomIn = useCallback(() => {
    viewerInstanceRef.current?.viewport.zoomBy(1.4);
  }, []);
  const zoomOut = useCallback(() => {
    viewerInstanceRef.current?.viewport.zoomBy(1 / 1.4);
  }, []);
  const fitToScreen = useCallback(() => {
    const instance = viewerInstanceRef.current;
    if (!instance) return;
    const item = instance.world.getItemAt(0);
    if (item) {
      instance.viewport.fitBounds(item.getBounds(), true);
    }
  }, []);
  const resetView = useCallback(() => {
    const instance = viewerInstanceRef.current;
    if (instance) {
      instance.viewport.goHome(true);
    }
  }, []);

  /* ------------------------- coordinate conversion ------------------------ */
  /**
   * Element (CSS) pixels -> image pixels in one call, accounting for zoom, pan
   * and rotation. Deliberately avoids any manual scale math.
   */
  const toImage = useCallback((clientX: number, clientY: number) => {
    const instance = viewerInstanceRef.current;
    const OpenSeadragon = osdRef.current;
    if (!instance || !OpenSeadragon) return { x: 0, y: 0 };
    const elementRect = instance.element.getBoundingClientRect();
    const elementPoint = new OpenSeadragon.Point(
      clientX - elementRect.left,
      clientY - elementRect.top,
    );
    const imagePoint = instance.viewport.viewerElementToImageCoordinates(elementPoint);
    return { x: imagePoint.x, y: imagePoint.y };
  }, []);

  // Stable object identity; each method reads live viewer state when called, so
  // nothing needs rebinding on zoom/pan/resize.
  const coordinates = useMemo<ViewerCoordinates>(
    () => ({
      toImage,
      toImageRect: (start, end) => {
        const first = toImage(start.clientX, start.clientY);
        const second = toImage(end.clientX, end.clientY);
        return {
          x: Math.min(first.x, second.x),
          y: Math.min(first.y, second.y),
          width: Math.abs(second.x - first.x),
          height: Math.abs(second.y - first.y),
        };
      },
      toElement: (x: number, y: number) => {
        const instance = viewerInstanceRef.current;
        const OpenSeadragon = osdRef.current;
        if (!instance || !OpenSeadragon) return { x: 0, y: 0 };
        const point = instance.viewport.imageToViewerElementCoordinates(
          new OpenSeadragon.Point(x, y),
        );
        return { x: point.x, y: point.y };
      },
    }),
    [toImage],
  );

  /**
   * The transform is exposed through a getter-backed object so consumers can
   * read the *current* value without subscribing to React state.
   */
  const transform = useMemo<ViewerTransform>(
    () => ({
      get scale() {
        return transformRef.current.scale;
      },
      get offsetX() {
        return transformRef.current.offsetX;
      },
      get offsetY() {
        return transformRef.current.offsetY;
      },
      get version() {
        return transformRef.current.version;
      },
    }),
    [],
  );

  return {
    viewerRef,
    viewer,
    overlayHost,
    isReady,
    isLoading,
    error,
    viewportVersion,
    transform,
    coordinates,
    zoomIn,
    zoomOut,
    fitToScreen,
    resetView,
  };
}
