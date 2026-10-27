import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import sharp from 'sharp';
import { ApplicationError } from '../common/errors/application.error';
import { DziGeneratorService } from './dzi-generator.service';
import { OverlayDziService } from './overlay-dzi.service';

/**
 * Unit tests for the overlay Deep Zoom pyramid builder.
 *
 * An overlay used to be served as a single full-resolution bitmap, so zooming
 * in only upscaled it. These tests pin the contract that an overlay now gets
 * the same pyramid treatment as the base image: a descriptor plus a tile tree,
 * and a cleanup path that never leaves a half-written pyramid behind.
 */

describe('OverlayDziService', () => {
  let root: string;
  let generator: DziGeneratorService;
  let service: OverlayDziService;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'overlay-dzi-'));
    generator = new DziGeneratorService();
    service = new OverlayDziService(generator);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  /** Writes a real PNG so Sharp can read actual pixel data. */
  async function writeSource(name = 'overlay.png', width = 64, height = 48): Promise<string> {
    const filePath = path.join(root, name);
    await sharp({
      create: { width, height, channels: 4, background: { r: 20, g: 120, b: 200, alpha: 0.5 } },
    })
      .png()
      .toFile(filePath);
    return filePath;
  }

  const baseOptions = (sourcePath: string, overlayKey = 'ovl') => ({
    sourcePath,
    outputDir: root,
    overlayKey,
    tilesUrlPath: '/api/v1/images/img-1/overlays/ovl-1/tiles',
    tileSize: 256,
    tileOverlap: 1,
    tileFormat: 'png' as const,
    tileQuality: 82,
  });

  it('writes a descriptor and a tile tree for the overlay', async () => {
    const sourcePath = await writeSource();

    const result = await service.generate(baseOptions(sourcePath));

    expect(result.width).toBe(64);
    expect(result.height).toBe(48);
    expect(result.tileCount).toBeGreaterThan(0);

    const descriptor = await fs.readFile(path.join(root, 'ovl.dzi'), 'utf8');
    expect(descriptor).toContain('<Image');
    expect(descriptor).toContain('Format="png"');
    // The descriptor points at the overlay's own tile route.
    expect(descriptor).toContain('/api/v1/images/img-1/overlays/ovl-1/tiles/');

    const levels = await fs.readdir(path.join(root, 'ovl_files'));
    expect(levels.length).toBeGreaterThan(0);
  });

  it('keeps the alpha channel by writing PNG tiles', async () => {
    const sourcePath = await writeSource();

    await service.generate(baseOptions(sourcePath));

    // The highest level holds the full-resolution tiles.
    const levels = (await fs.readdir(path.join(root, 'ovl_files'))).map(Number).sort((a, b) => a - b);
    const topLevelDir = path.join(root, 'ovl_files', String(levels[levels.length - 1]));
    const tiles = await fs.readdir(topLevelDir);

    expect(tiles.length).toBeGreaterThan(0);
    expect(tiles.every((tile) => tile.endsWith('.png'))).toBe(true);
  });

  it('names the artifacts after the overlay key', async () => {
    const sourcePath = await writeSource();

    await service.generate(baseOptions(sourcePath, 'custom-key'));

    await expect(fs.stat(path.join(root, 'custom-key.dzi'))).resolves.toBeDefined();
    await expect(fs.stat(path.join(root, 'custom-key_files'))).resolves.toBeDefined();
  });

  it('surfaces an invalid tile size as a validation error', async () => {
    const sourcePath = await writeSource();

    await expect(
      service.generate({ ...baseOptions(sourcePath), tileSize: 8 }),
    ).rejects.toMatchObject({ code: 'INVALID_TILE_SIZE' });
  });

  it('removes a partial pyramid when generation fails', async () => {
    // A non-image source fails after the output directory may already exist.
    const brokenPath = path.join(root, 'broken.png');
    await fs.writeFile(brokenPath, 'not an image');
    await fs.mkdir(path.join(root, 'ovl_files', '0'), { recursive: true });
    await fs.writeFile(path.join(root, 'ovl_files', '0', '0_0.png'), 'stale');
    await fs.writeFile(path.join(root, 'ovl.dzi'), 'stale');

    await expect(service.generate(baseOptions(brokenPath))).rejects.toBeInstanceOf(
      ApplicationError,
    );

    // A half-written pyramid must never be servable.
    await expect(fs.stat(path.join(root, 'ovl.dzi'))).rejects.toThrow();
    await expect(fs.stat(path.join(root, 'ovl_files'))).rejects.toThrow();
  });

  it('removes the descriptor and the tile tree', async () => {
    const sourcePath = await writeSource();
    await service.generate(baseOptions(sourcePath));

    await service.removeArtifacts(root, 'ovl');

    await expect(fs.stat(path.join(root, 'ovl.dzi'))).rejects.toThrow();
    await expect(fs.stat(path.join(root, 'ovl_files'))).rejects.toThrow();
  });

  it('tolerates removing artifacts that never existed', async () => {
    await expect(service.removeArtifacts(root, 'missing')).resolves.toBeUndefined();
  });
});
