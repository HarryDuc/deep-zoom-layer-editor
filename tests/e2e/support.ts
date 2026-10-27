import { expect, type Page, type APIRequestContext } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { API_BASE_URL } from './config';

/**
 * Fixtures and page helpers shared by the end-to-end specs.
 *
 * Test images are generated once per run into `tests/e2e/.tmp` instead of being
 * committed, so the repository carries no large binaries.
 */
const TMP_DIR = path.join(__dirname, '.tmp');

/**
 * Base URL of the API under test.
 *
 * Re-exported from the shared config so the specs always call the same server
 * that `playwright.config.ts` started.
 */
export { API_BASE_URL };

export interface FixtureImage {
  path: string;
  name: string;
  width: number;
  height: number;
}

/**
 * Builds a JPEG large enough to produce a real tile pyramid (five levels for
 * 2048x1536 at 256px tiles) with enough visual structure that tiles are
 * non-trivial to encode.
 */
export async function ensureFixtureImage(
  width = 2048,
  height = 1536,
): Promise<FixtureImage> {
  await fs.mkdir(TMP_DIR, { recursive: true });
  const name = `e2e-fixture-${width}x${height}`;
  const filePath = path.join(TMP_DIR, `${name}.jpg`);

  try {
    await fs.access(filePath);
    return { path: filePath, name, width, height };
  } catch {
    // Not cached yet; generate below.
  }

  const stripes = Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <rect width="100%" height="100%" fill="#0f172a"/>
      <g fill="#38bdf8" opacity="0.35">
        ${Array.from({ length: 24 }, (_, index) => {
          const x = (index * width) / 24;
          return `<rect x="${x}" y="0" width="${width / 48}" height="${height}"/>`;
        }).join('')}
      </g>
      <circle cx="${width / 2}" cy="${height / 2}" r="${height / 4}" fill="#f97316" opacity="0.6"/>
      <text x="40" y="${height - 60}" font-size="72" fill="#e2e8f0">DZI ${width}x${height}</text>
    </svg>
  `);

  await sharp(stripes).jpeg({ quality: 88 }).toFile(filePath);
  return { path: filePath, name, width, height };
}

/** A small transparent-ish PNG used as an IMAGE overlay object asset. */
export async function ensureFixtureOverlay(): Promise<string> {
  await fs.mkdir(TMP_DIR, { recursive: true });
  const filePath = path.join(TMP_DIR, 'e2e-overlay.png');

  try {
    await fs.access(filePath);
    return filePath;
  } catch {
    // Generate below.
  }

  const svg = Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">
      <rect width="256" height="256" fill="#22c55e" opacity="0.85"/>
      <circle cx="128" cy="128" r="80" fill="#0ea5e9"/>
    </svg>
  `);

  await sharp(svg).png().toFile(filePath);
  return filePath;
}

/**
 * Uploads an image from the home page and waits until the viewer page has
 * finished generating the Deep Zoom pyramid.
 *
 * @returns the created image id (taken from the URL).
 */
export async function uploadAndOpenImage(
  page: Page,
  fixture: FixtureImage,
  displayName: string,
): Promise<string> {
  await page.goto('/');
  await expect(page.getByTestId('upload-dropzone')).toBeVisible();

  await page.getByTestId('upload-file-input').setInputFiles(fixture.path);
  await expect(page.getByTestId('upload-filename')).toContainText(path.basename(fixture.path));

  await page.getByTestId('upload-name-input').fill(displayName);
  await page.getByTestId('upload-submit').click();

  // The app navigates as soon as the API accepts the upload, then polls the
  // status endpoint until the background job reports COMPLETED.
  await page.waitForURL(/\/images\/[a-f0-9]{24}$/i, { timeout: 30_000 });
  const imageId = page.url().split('/').pop() as string;

  await expect(page.getByTestId('image-viewer-page')).toBeVisible({ timeout: 150_000 });
  await expect(page.getByTestId('dzi-viewer')).toBeVisible();
  await waitForViewerReady(page);

  return imageId;
}

/** Waits until OpenSeadragon has opened the tile source. */
export async function waitForViewerReady(page: Page): Promise<void> {
  await expect(page.getByTestId('viewer-loading')).toBeHidden({ timeout: 60_000 });
  await expect(page.getByTestId('viewer-meta')).toContainText('đối tượng', {
    timeout: 60_000,
  });
}

/** Creates a layer through the layer panel and returns its (temporary) id. */
export async function createLayer(page: Page, name: string): Promise<string> {
  await page.getByTestId('new-layer-name').fill(name);
  await page.getByTestId('add-layer').click();

  const item = page.locator('[data-testid^="layer-item-"]').first();
  await expect(item).toContainText(name);

  const testId = await item.getAttribute('data-testid');
  return (testId ?? '').replace('layer-item-', '');
}

/** Centre-ish box of the drawing surface, as fractions of its bounds. */
async function drawingBox(
  page: Page,
  anchor: { fx: number; fy: number },
): Promise<{ x: number; y: number; width: number; height: number }> {
  const layer = page.getByTestId('drawing-layer');
  await expect(layer).toBeVisible();
  const box = await layer.boundingBox();
  if (!box) throw new Error('Drawing layer has no bounding box');
  return {
    x: box.x + box.width * anchor.fx,
    y: box.y + box.height * anchor.fy,
    width: box.width,
    height: box.height,
  };
}

/** Clicks a single point on the canvas in image-tool mode. */
export async function clickCanvas(
  page: Page,
  fx = 0.35,
  fy = 0.4,
): Promise<void> {
  const point = await drawingBox(page, { fx, fy });
  await page.mouse.click(point.x, point.y);
}

/** Drags a rectangle on the canvas in RECTANGLE / IMAGE mode. */
export async function dragCanvas(
  page: Page,
  from = { fx: 0.25, fy: 0.25 },
  to = { fx: 0.45, fy: 0.45 },
): Promise<void> {
  const start = await drawingBox(page, from);
  const end = await drawingBox(page, to);

  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  // Several intermediate moves make the drag realistic and exercise the
  // preview rendering path.
  await page.mouse.move(start.x + (end.x - start.x) / 2, start.y + (end.y - start.y) / 2);
  await page.mouse.move(end.x, end.y);
  await expect(page.getByTestId('drag-preview')).toBeVisible();
  await page.mouse.up();
}

/** Selects a drawing tool by its short name. */
export async function selectTool(
  page: Page,
  tool: 'select' | 'polygon' | 'rectangle' | 'point' | 'label' | 'image',
): Promise<void> {
  // Tool buttons toggle, so reset to select mode first. Without this a repeated
  // selection of the already-armed tool would disarm it.
  await page.getByTestId('tool-select').click();

  if (tool === 'select') return;

  await page.getByTestId(`tool-${tool}`).click();
  await expect(page.getByTestId('drawing-layer')).toBeVisible();
}

/** Saves local edits and waits for the success notice. */
export async function saveEdits(page: Page): Promise<void> {
  const save = page.getByTestId('save-edits');
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByTestId('editor-notice')).toContainText('Đã lưu thay đổi', {
    timeout: 60_000,
  });
}

/** Deletes every image created by a spec, so runs stay repeatable. */
export async function deleteImages(
  request: APIRequestContext,
  imageIds: string[],
): Promise<void> {
  for (const imageId of imageIds) {
    await request.delete(`${API_BASE_URL}/images/${imageId}`).catch(() => undefined);
  }
}
