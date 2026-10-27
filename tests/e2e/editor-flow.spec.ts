import { expect, test } from '@playwright/test';
import {
  API_BASE_URL,
  clickCanvas,
  createLayer,
  deleteImages,
  dragCanvas,
  ensureFixtureImage,
  ensureFixtureOverlay,
  saveEdits,
  selectTool,
  uploadAndOpenImage,
  waitForViewerReady,
} from './support';

/**
 * End-to-end coverage of the primary product flow:
 * upload -> background DZI generation -> draw every object type -> save.
 *
 * The suite runs against the real API, real MongoDB and real Sharp output, so a
 * green run proves the whole pipeline works, not just the UI wiring.
 */
test.describe('editor flow', () => {
  test('uploads an image, generates a DZI pyramid and edits layers end to end', async ({
    page,
    request,
  }) => {
    const fixture = await ensureFixtureImage(2048, 1536);
    const createdImageIds: string[] = [];

    try {
      /* ------------------------------ upload ------------------------------- */

      const imageId = await uploadAndOpenImage(page, fixture, 'Ảnh kiểm thử E2E');
      createdImageIds.push(imageId);

      await expect(page.getByRole('heading', { level: 1 })).toContainText('Ảnh kiểm thử E2E');
      await expect(page.getByText(`${fixture.width} × ${fixture.height} px`)).toBeVisible();
      await expect(page.getByTestId('editor-object-count')).toHaveText('0 đối tượng');

      /* --------------------------- layer creation -------------------------- */

      const layerId = await createLayer(page, 'Lớp địa hình');
      await expect(page.getByTestId(`layer-name-${layerId}`)).toHaveText('Lớp địa hình');

      // Drawing tools unlock only once an unlocked layer is active.
      await expect(page.getByTestId('drawing-disabled-hint')).toBeHidden();

      /* ------------------------------ polygon ------------------------------ */

      await selectTool(page, 'polygon');
      await expect(page.getByTestId('tool-hint')).toContainText('đa giác');

      await clickCanvas(page, 0.3, 0.3);
      await clickCanvas(page, 0.55, 0.32);
      await clickCanvas(page, 0.45, 0.55);
      await expect(page.getByTestId('polygon-progress')).toContainText('3 điểm');

      await page.getByTestId('finish-polygon').click();
      await expect(page.getByTestId('polygon-progress')).toBeHidden();
      await expect(page.getByTestId('editor-object-count')).toHaveText('1 đối tượng');
      await expect(page.getByTestId('properties-type')).toHaveText('Đa giác');
      await expect(page.locator('[data-testid^="object-polygon-"]')).toHaveCount(1);

      // Geometry is expressed in original image pixels, so the vertices must sit
      // inside the source resolution rather than in viewport pixels.
      const polygonPoints = await page
        .locator('[data-testid^="object-polygon-"]')
        .getAttribute('points');
      expect(polygonPoints?.trim().split(/\s+/)).toHaveLength(3);

      const firstVertex = await page.getByTestId('poly-x-0').inputValue();
      expect(Number(firstVertex)).toBeGreaterThan(0);
      expect(Number(firstVertex)).toBeLessThanOrEqual(fixture.width);

      /* ----------------------------- rectangle ----------------------------- */

      await selectTool(page, 'rectangle');
      await dragCanvas(page, { fx: 0.6, fy: 0.25 }, { fx: 0.8, fy: 0.45 });
      await expect(page.getByTestId('editor-object-count')).toHaveText('2 đối tượng');
      await expect(page.getByTestId('properties-type')).toHaveText('Hình chữ nhật');

      const rectWidth = Number(await page.getByTestId('rect-width').inputValue());
      const rectHeight = Number(await page.getByTestId('rect-height').inputValue());
      expect(rectWidth).toBeGreaterThan(0);
      expect(rectHeight).toBeGreaterThan(0);
      expect(rectWidth).toBeLessThanOrEqual(fixture.width);

      // Style edits are local until save, but render immediately.
      await page.getByTestId('style-fill').fill('#ff0000');
      await expect(page.locator('[data-testid^="object-rectangle-"]').first()).toHaveAttribute(
        'fill',
        /ff0000/i,
      );

      /* ------------------------------- point ------------------------------- */

      await selectTool(page, 'point');
      await clickCanvas(page, 0.5, 0.6);
      await expect(page.getByTestId('editor-object-count')).toHaveText('3 đối tượng');
      await expect(page.getByTestId('properties-type')).toHaveText('Điểm');
      await expect(page.locator('[data-testid^="object-point-"]')).toHaveCount(1);

      /* ------------------------------- label ------------------------------- */

      await selectTool(page, 'label');
      await clickCanvas(page, 0.35, 0.7);
      await expect(page.getByTestId('editor-object-count')).toHaveText('4 đối tượng');
      await expect(page.getByTestId('properties-type')).toHaveText('Nhãn chữ');

      await page.getByTestId('label-text-input').fill('Thửa đất số 42 — Quy hoạch');
      await expect(page.getByTestId('label-text').last()).toHaveText(
        'Thửa đất số 42 — Quy hoạch',
      );

      /* --------------------------- image overlay --------------------------- */

      const overlayPath = await ensureFixtureOverlay();

      await selectTool(page, 'image');
      await dragCanvas(page, { fx: 0.62, fy: 0.55 }, { fx: 0.82, fy: 0.75 });
      await expect(page.getByTestId('editor-object-count')).toHaveText('5 đối tượng');
      await expect(page.getByTestId('overlay-missing-warning')).toBeVisible();

      await page.getByTestId('overlay-file-input').setInputFiles(overlayPath);
      await expect(page.getByTestId('overlay-missing-warning')).toBeHidden({ timeout: 30_000 });
      await expect(page.locator('[data-testid^="object-image-"]')).toHaveCount(1);

      /* -------------------------------- save ------------------------------- */

      await saveEdits(page);
      await expect(page.getByTestId('editor-object-count')).toHaveText('5 đối tượng');
      await expect(page.getByTestId('save-edits')).toBeDisabled();

      /* ---------------------------- persistence ---------------------------- */

      await page.reload();
      await waitForViewerReady(page);

      await expect(page.getByTestId('editor-object-count')).toHaveText('5 đối tượng');
      await expect(page.locator('[data-testid^="object-polygon-"]')).toHaveCount(1);
      await expect(page.locator('[data-testid^="object-rectangle-"]')).toHaveCount(1);
      await expect(page.locator('[data-testid^="object-point-"]')).toHaveCount(1);
      await expect(page.locator('[data-testid^="object-label-"]')).toHaveCount(1);
      await expect(page.locator('[data-testid^="object-image-"]')).toHaveCount(1);
      await expect(page.getByTestId('label-text').last()).toHaveText(
        'Thửa đất số 42 — Quy hoạch',
      );

      // Vietnamese text survives the round trip through MongoDB unchanged.
      const layersResponse = await request.get(`${API_BASE_URL}/images/${imageId}/layers`);
      expect(layersResponse.ok()).toBeTruthy();
      const layersBody = (await layersResponse.json()) as {
        data: { name: string }[];
      };
      expect(layersBody.data).toHaveLength(1);
      expect(layersBody.data[0].name).toBe('Lớp địa hình');

      // The DZI descriptor is served as XML whose tile URL points back at the API.
      const dziResponse = await request.get(`${API_BASE_URL}/images/${imageId}/dzi`);
      expect(dziResponse.ok()).toBeTruthy();
      expect(dziResponse.headers()['content-type']).toContain('xml');
      const dziXml = await dziResponse.text();
      expect(dziXml).toContain('<Image');
      expect(dziXml).toContain(`${API_BASE_URL}/images/${imageId}/tiles/`);

      // Level 0 is the whole image scaled down into one tile. The extension
      // comes from the descriptor, because that is exactly what a client
      // (OpenSeadragon) uses to build the tile URL.
      const format = dziXml.match(/Format="([^"]+)"/)?.[1];
      expect(format).toBeTruthy();
      const tileResponse = await request.get(
        `${API_BASE_URL}/images/${imageId}/tiles/0/0_0.${format}`,
      );
      expect(tileResponse.ok()).toBeTruthy();
      expect(tileResponse.headers()['content-type']).toContain('image/jpeg');
      expect(tileResponse.headers()['cache-control']).toContain('immutable');

      // Path traversal must be rejected, not silently served.
      const traversal = await request.get(
        `${API_BASE_URL}/images/${imageId}/tiles/0/..%2f..%2f..%2fpackage.json`,
      );
      expect(traversal.ok()).toBeFalsy();
      expect(traversal.status()).toBeGreaterThanOrEqual(400);
    } finally {
      await deleteImages(request, createdImageIds);
    }
  });

  test('cancel restores the last saved snapshot', async ({ page, request }) => {
    const fixture = await ensureFixtureImage(1024, 768);
    const createdImageIds: string[] = [];

    try {
      const imageId = await uploadAndOpenImage(page, fixture, 'Ảnh kiểm thử Huỷ');
      createdImageIds.push(imageId);
      await createLayer(page, 'Lớp tạm');

      await selectTool(page, 'point');
      await clickCanvas(page, 0.4, 0.4);
      await expect(page.getByTestId('editor-object-count')).toHaveText('1 đối tượng');

      await saveEdits(page);
      await expect(page.getByTestId('editor-object-count')).toHaveText('1 đối tượng');

      // A second, unsaved object must disappear on cancel.
      await selectTool(page, 'point');
      await clickCanvas(page, 0.6, 0.6);
      await expect(page.getByTestId('editor-object-count')).toHaveText('2 đối tượng');
      await expect(page.getByTestId('cancel-edits')).toBeEnabled();

      await page.getByTestId('cancel-edits').click();
      await expect(page.getByTestId('editor-object-count')).toHaveText('1 đối tượng');
      await expect(page.getByTestId('cancel-edits')).toBeDisabled();
      await expect(page.getByTestId('editor-notice')).toContainText('Đã huỷ');
    } finally {
      await deleteImages(request, createdImageIds);
    }
  });

  test('zoom and pan keep the viewer instance and overlays anchored', async ({
    page,
    request,
  }) => {
    const fixture = await ensureFixtureImage(1024, 768);
    const createdImageIds: string[] = [];

    try {
      const imageId = await uploadAndOpenImage(page, fixture, 'Ảnh kiểm thử Zoom');
      createdImageIds.push(imageId);
      await createLayer(page, 'Lớp zoom');

      await selectTool(page, 'rectangle');
      await dragCanvas(page, { fx: 0.3, fy: 0.3 }, { fx: 0.5, fy: 0.5 });
      await expect(page.locator('[data-testid^="object-rectangle-"]')).toHaveCount(1);

      const overlay = page.getByTestId('svg-overlay');
      const before = Number(await overlay.getAttribute('data-viewport-version'));

      await selectTool(page, 'select');
      await page.getByTestId('zoom-in').click();
      await page.getByTestId('zoom-in').click();

      // The SVG overlay must re-render against the new viewport, and the
      // rectangle must still be present (same object, remapped coordinates).
      await expect
        .poll(async () => Number(await overlay.getAttribute('data-viewport-version')))
        .toBeGreaterThan(before);

      const zoomedWidth = await page
        .locator('[data-testid^="object-rectangle-"]')
        .getAttribute('width');
      expect(Number(zoomedWidth)).toBeGreaterThan(0);

      await page.getByTestId('fit-screen').click();
      await page.getByTestId('reset-view').click();
      await expect(page.locator('[data-testid^="object-rectangle-"]')).toHaveCount(1);

      // Real mouse gestures in select mode must reach OpenSeadragon. The
      // overlay SVG covers the viewer, so a regression to `pointer-events:
      // auto` on its root would silently swallow these and freeze pan/zoom.
      const overlayBox = await page.getByTestId('svg-overlay').boundingBox();
      if (!overlayBox) throw new Error('Overlay has no bounding box');
      const centre = {
        x: overlayBox.x + overlayBox.width / 2,
        y: overlayBox.y + overlayBox.height / 2,
      };

      // Zoom in first: at the home/fit view the image fills the viewport, so
      // `constrainDuringPan` correctly clamps a drag and panning would appear
      // to do nothing regardless of pointer handling.
      await page.getByTestId('zoom-in').click();
      await page.getByTestId('zoom-in').click();
      // OpenSeadragon animates for `animationTime` (0.5 s). A drag that starts
      // mid-animation is discarded by the viewer, so settle first.
      await page.waitForTimeout(1200);

      const beforePan = Number(await overlay.getAttribute('data-viewport-version'));
      await page.mouse.move(centre.x, centre.y);
      await page.mouse.down();
      await page.mouse.move(centre.x - 180, centre.y - 110, { steps: 12 });
      await page.mouse.up();
      await expect
        .poll(async () => Number(await overlay.getAttribute('data-viewport-version')))
        .toBeGreaterThan(beforePan);

      const beforeWheel = Number(await overlay.getAttribute('data-viewport-version'));
      await page.mouse.move(centre.x, centre.y);
      await page.mouse.wheel(0, -600);
      await expect
        .poll(async () => Number(await overlay.getAttribute('data-viewport-version')))
        .toBeGreaterThan(beforeWheel);

      // No tile failure means the viewer was never recreated, so zoom state
      // survived the interaction.
      await expect(page.getByTestId('viewer-error')).toBeHidden();
    } finally {
      await deleteImages(request, createdImageIds);
    }
  });
});
