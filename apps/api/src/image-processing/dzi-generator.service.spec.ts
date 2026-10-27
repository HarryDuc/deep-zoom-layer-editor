import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import sharp from 'sharp';
import {
  DziGeneratorService,
  absolutizeDziTileUrl,
  buildDziXml,
  getLevelSize,
  getMaxLevel,
  getTileExtension,
  getTileGrid,
  getTileSourceRect,
  listLevels,
} from './dzi-generator.service';

describe('DZI math', () => {
  it('computes the max level as ceil(log2(max(width, height)))', () => {
    expect(getMaxLevel(1, 1)).toBe(0);
    expect(getMaxLevel(256, 256)).toBe(8);
    expect(getMaxLevel(257, 100)).toBe(9);
    expect(getMaxLevel(2048, 1024)).toBe(11);
  });

  it('rejects non-positive dimensions', () => {
    expect(() => getMaxLevel(0, 10)).toThrow(/greater than zero/);
  });

  it('halves dimensions per level and clamps to at least 1px', () => {
    expect(getLevelSize(1000, 500, 10)).toEqual({ width: 1000, height: 500 });
    expect(getLevelSize(1000, 500, 9)).toEqual({ width: 500, height: 250 });
    expect(getLevelSize(1000, 500, 0)).toEqual({ width: 1, height: 1 });
  });

  it('computes the tile grid with ceil division', () => {
    expect(getTileGrid(256, 256, 256)).toEqual({ columns: 1, rows: 1 });
    expect(getTileGrid(257, 256, 256)).toEqual({ columns: 2, rows: 1 });
    expect(getTileGrid(1000, 600, 256)).toEqual({ columns: 4, rows: 3 });
  });

  it('lists every level from 1x1 up to full resolution', () => {
    const levels = listLevels(1000, 500, 256);
    expect(levels).toHaveLength(getMaxLevel(1000, 500) + 1);
    expect(levels[0]).toEqual({ level: 0, width: 1, height: 1, columns: 1, rows: 1 });
    expect(levels.at(-1)).toMatchObject({ width: 1000, height: 500 });
  });

  describe('tile source rect', () => {
    it('adds overlap on interior edges only', () => {
      // Level of 600x600 with 256px tiles: 3x3 grid, overlap 1.
      expect(getTileSourceRect(600, 600, 256, 1, 0, 0)).toEqual({
        left: 0,
        top: 0,
        width: 257,
        height: 257,
      });
      expect(getTileSourceRect(600, 600, 256, 1, 1, 1)).toEqual({
        left: 255,
        top: 255,
        width: 258,
        height: 258,
      });
      // Last tile in each axis: no overlap past the image edge.
      expect(getTileSourceRect(600, 600, 256, 1, 2, 2)).toEqual({
        left: 511,
        top: 511,
        width: 89,
        height: 89,
      });
    });

    it('never returns negative coordinates when overlap exceeds the tile origin', () => {
      const rect = getTileSourceRect(300, 300, 256, 1, 1, 1);
      expect(rect.left).toBeGreaterThanOrEqual(0);
      expect(rect.top).toBeGreaterThanOrEqual(0);
    });
  });

  it('maps tile format to a file extension', () => {
    // libvips names its Deep Zoom tiles `.jpeg`, and OpenSeadragon builds the
    // tile URL from the descriptor's `Format` attribute verbatim, so the
    // descriptor has to name the exact extension that exists on disk.
    expect(getTileExtension('jpeg')).toBe('jpeg');
    expect(getTileExtension('png')).toBe('png');
  });
});

describe('buildDziXml', () => {
  it('emits a descriptor pointing at the API tile endpoint', () => {
    const xml = buildDziXml({
      width: 4000,
      height: 3000,
      tileSize: 256,
      tileOverlap: 1,
      format: 'jpeg',
      tilesUrlPath: '/api/v1/images/abc/tiles',
    });

    // The trailing slash is required: OpenSeadragon appends `<level>/<x>_<y>`
    // directly to this value, so without it the last segment is swallowed.
    expect(xml).toContain('Url="/api/v1/images/abc/tiles/"');
    expect(xml).toContain('Format="jpeg"');
    expect(xml).toContain('TileSize="256"');
    expect(xml).toContain('Overlap="1"');
    expect(xml).toContain('Width="4000"');
    expect(xml).toContain('Height="3000"');
    expect(xml).toContain('http://schemas.microsoft.com/deepzoom/2008');
  });

  it('does not double the trailing slash when the path already has one', () => {
    const xml = buildDziXml({
      width: 10,
      height: 10,
      tileSize: 256,
      tileOverlap: 0,
      format: 'jpeg',
      tilesUrlPath: '/api/v1/images/abc/tiles/',
    });
    expect(xml).toContain('Url="/api/v1/images/abc/tiles/"');
    expect(xml).not.toContain('tiles//');
  });

  it('escapes XML metacharacters in the tile URL', () => {
    const xml = buildDziXml({
      width: 10,
      height: 10,
      tileSize: 256,
      tileOverlap: 0,
      format: 'png',
      tilesUrlPath: '/api/v1/images/a&b<c>/tiles',
    });
    expect(xml).toContain('Url="/api/v1/images/a&amp;b&lt;c&gt;/tiles/"');
    expect(xml).toContain('Format="png"');
  });
});

describe('absolutizeDziTileUrl', () => {
  const descriptor = buildDziXml({
    width: 4000,
    height: 3000,
    tileSize: 256,
    tileOverlap: 1,
    format: 'jpeg',
    tilesUrlPath: '/api/v1/images/abc/tiles',
  });

  it('prefixes a root-relative tile URL with the API origin', () => {
    const xml = absolutizeDziTileUrl(descriptor, 'http://localhost:3001');
    expect(xml).toContain('Url="http://localhost:3001/api/v1/images/abc/tiles/"');
    // Everything else is untouched.
    expect(xml).toContain('TileSize="256"');
    expect(xml).toContain('Width="4000"');
  });

  it('tolerates a trailing slash on the origin', () => {
    const xml = absolutizeDziTileUrl(descriptor, 'http://api.example.com/');
    expect(xml).toContain('Url="http://api.example.com/api/v1/images/abc/tiles/"');
  });

  it('leaves an already-absolute URL alone', () => {
    const absolute = buildDziXml({
      width: 10,
      height: 10,
      tileSize: 256,
      tileOverlap: 0,
      format: 'jpeg',
      tilesUrlPath: 'https://cdn.example.com/tiles',
    });
    const xml = absolutizeDziTileUrl(absolute, 'http://localhost:3001');
    expect(xml).toContain('Url="https://cdn.example.com/tiles/"');
    expect(xml).not.toContain('localhost');
  });
});

describe('DziGeneratorService.generate', () => {
  let workDir: string;
  const generator = new DziGeneratorService();

  beforeAll(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dzi-gen-'));
  });

  afterAll(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
  });

  async function writeSourceImage(width: number, height: number): Promise<string> {
    const target = path.join(workDir, `src-${width}x${height}.png`);
    await sharp({
      create: {
        width,
        height,
        channels: 3,
        background: { r: 40, g: 90, b: 160 },
      },
    })
      .png()
      .toFile(target);
    return target;
  }

  it('generates a descriptor and a complete tile pyramid', async () => {
    const width = 700;
    const height = 420;
    const sourcePath = await writeSourceImage(width, height);
    const outputDir = path.join(workDir, 'out-1');
    await fs.mkdir(outputDir, { recursive: true });

    const result = await generator.generate({
      sourcePath,
      outputDir,
      assetKey: 'abc123',
      tilesUrlPath: '/api/v1/images/img1/tiles',
      tileSize: 256,
      tileOverlap: 1,
      tileFormat: 'jpeg',
      tileQuality: 80,
    });

    expect(result.width).toBe(width);
    expect(result.height).toBe(height);
    expect(result.maxLevel).toBe(getMaxLevel(width, height));

    const descriptor = await fs.readFile(result.descriptorPath, 'utf8');
    expect(descriptor).toContain('Url="/api/v1/images/img1/tiles/"');
    expect(descriptor).toContain(`Width="${width}"`);

    const filesDir = path.join(outputDir, 'abc123_files');
    const levels = listLevels(width, height, 256);

    let writtenTiles = 0;
    for (const level of levels) {
      const levelDir = path.join(filesDir, String(level.level));
      const entries = await fs.readdir(levelDir);
      // Every grid cell must exist and nothing else (no libvips internals).
      expect(entries.sort()).toEqual(
        Array.from({ length: level.columns * level.rows }, (_, index) => {
          const column = index % level.columns;
          const row = Math.floor(index / level.columns);
          return `${column}_${row}.jpeg`;
        }).sort(),
      );
      writtenTiles += entries.length;
    }

    expect(result.tileCount).toBe(writtenTiles);
    // libvips leaves an internal properties file next to the pyramid. It is
    // never served, so the generator removes it.
    expect(await fs.readdir(filesDir)).not.toContain('vips-properties.xml');
  });

  it('honours the requested tile format', async () => {
    const sourcePath = await writeSourceImage(300, 200);
    const outputDir = path.join(workDir, 'out-png');
    await fs.mkdir(outputDir, { recursive: true });

    await generator.generate({
      sourcePath,
      outputDir,
      assetKey: 'pngkey',
      tilesUrlPath: '/tiles',
      tileSize: 256,
      tileOverlap: 1,
      tileFormat: 'png',
      tileQuality: 80,
    });

    const topLevel = await fs.readdir(path.join(outputDir, 'pngkey_files', '0'));
    expect(topLevel).toEqual(['0_0.png']);
  });

  it('keeps the alpha channel of a PNG overlay', async () => {
    const sourcePath = path.join(workDir, 'alpha.png');
    await sharp({
      create: {
        width: 400,
        height: 300,
        channels: 4,
        background: { r: 20, g: 160, b: 90, alpha: 0.6 },
      },
    })
      .png()
      .toFile(sourcePath);

    const outputDir = path.join(workDir, 'out-alpha');
    await generator.generate({
      sourcePath,
      outputDir,
      assetKey: 'alphakey',
      tilesUrlPath: '/tiles',
      tileSize: 256,
      tileOverlap: 1,
      tileFormat: 'png',
      tileQuality: 80,
    });

    // The overlay pyramid must keep transparency: flattening to JPEG would
    // destroy the alpha channel the editor relies on.
    const metadata = await sharp(
      path.join(outputDir, 'alphakey_files', '0', '0_0.png'),
    ).metadata();
    expect(metadata.format).toBe('png');
    expect(metadata.hasAlpha).toBe(true);
  });

  it('produces a descriptor whose Format matches the tiles on disk', async () => {
    // OpenSeadragon builds every tile URL from the `Format` attribute
    // verbatim, so a mismatch would make all tile requests 404.
    const sourcePath = await writeSourceImage(500, 400);
    const outputDir = path.join(workDir, 'out-format');

    const result = await generator.generate({
      sourcePath,
      outputDir,
      assetKey: 'fmtkey',
      tilesUrlPath: '/tiles',
      tileSize: 256,
      tileOverlap: 1,
      tileFormat: 'jpeg',
      tileQuality: 80,
    });

    const format = result.descriptor.match(/Format="([^"]+)"/)?.[1];
    expect(format).toBeDefined();

    const levelDir = path.join(outputDir, 'fmtkey_files', '0');
    const tileName = (await fs.readdir(levelDir))[0];
    expect(tileName.endsWith(`.${format}`)).toBe(true);
  });

  it('rejects an out-of-range tile size', async () => {
    await expect(
      generator.generate({
        sourcePath: 'irrelevant.png',
        outputDir: workDir,
        assetKey: 'k',
        tilesUrlPath: '/tiles',
        tileSize: 32,
        tileOverlap: 1,
        tileFormat: 'jpeg',
        tileQuality: 80,
      }),
    ).rejects.toThrow(/Tile size must be an integer between 64 and 2048/);
  });

  it('aborts before writing tiles when the signal is already aborted', async () => {
    const sourcePath = await writeSourceImage(300, 200);
    const controller = new AbortController();
    controller.abort();

    await expect(
      generator.generate({
        sourcePath,
        outputDir: path.join(workDir, 'out-abort'),
        assetKey: 'abortkey',
        tilesUrlPath: '/tiles',
        tileSize: 256,
        tileOverlap: 1,
        tileFormat: 'jpeg',
        tileQuality: 80,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/aborted/);
  });
});
