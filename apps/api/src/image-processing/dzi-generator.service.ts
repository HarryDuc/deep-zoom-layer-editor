import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ApplicationError } from '../common/errors/application.error';
import { configureSharpCache } from '../common/sharp/sharp-cache';
import { openImage } from '../common/sharp/sharp-input';

export interface DziGenerationOptions {
  sourcePath: string;
  /** Absolute directory that will contain `<key>.dzi` and `<key>_files/<level>/...` */
  outputDir: string;
  /** Opaque storage key used for the descriptor and tile folder names. */
  assetKey: string;
  /**
   * Absolute URL path of the tiles endpoint, written into the descriptor `Url`
   * attribute. OpenSeadragon uses it verbatim, so it must point at the NestJS
   * tile route rather than at a static folder.
   */
  tilesUrlPath: string;
  tileSize: number;
  tileOverlap: number;
  tileFormat: 'jpeg' | 'png';
  tileQuality: number;
  signal?: AbortSignal;
}

export interface DziGenerationResult {
  descriptorPath: string;
  descriptor: string;
  width: number;
  height: number;
  maxLevel: number;
  tileCount: number;
}

export interface DziLevel {
  level: number;
  width: number;
  height: number;
  columns: number;
  rows: number;
}

/**
 * Pure DZI math, kept free of I/O so it can be unit tested.
 *
 * Deep Zoom level `L` is `maxLevel - L` halvings from full resolution, with
 * `maxLevel = ceil(log2(max(width, height)))`. Level 0 is always 1x1.
 */
export function getMaxLevel(width: number, height: number): number {
  if (width <= 0 || height <= 0) {
    throw new Error('Image dimensions must be greater than zero');
  }
  return Math.ceil(Math.log2(Math.max(width, height)));
}

export function getLevelSize(
  width: number,
  height: number,
  level: number,
): { width: number; height: number } {
  const maxLevel = getMaxLevel(width, height);
  const divisor = Math.pow(2, maxLevel - level);
  return {
    width: Math.max(1, Math.ceil(width / divisor)),
    height: Math.max(1, Math.ceil(height / divisor)),
  };
}

export function getTileGrid(
  width: number,
  height: number,
  tileSize: number,
): { columns: number; rows: number } {
  return {
    columns: Math.ceil(width / tileSize),
    rows: Math.ceil(height / tileSize),
  };
}

export function listLevels(
  width: number,
  height: number,
  tileSize: number,
): DziLevel[] {
  const maxLevel = getMaxLevel(width, height);
  const levels: DziLevel[] = [];
  for (let level = 0; level <= maxLevel; level += 1) {
    const size = getLevelSize(width, height, level);
    const grid = getTileGrid(size.width, size.height, tileSize);
    levels.push({ level, width: size.width, height: size.height, ...grid });
  }
  return levels;
}

/**
 * Source rectangle for tile (column, row) including Deep Zoom overlap.
 *
 * Overlap is only added on interior edges, matching the reference DZI
 * generators and how OpenSeadragon offsets overlap when drawing.
 */
export function getTileSourceRect(
  levelWidth: number,
  levelHeight: number,
  tileSize: number,
  overlap: number,
  column: number,
  row: number,
): { left: number; top: number; width: number; height: number } {
  const columns = Math.ceil(levelWidth / tileSize);
  const rows = Math.ceil(levelHeight / tileSize);
  const left = Math.max(0, column * tileSize - (column > 0 ? overlap : 0));
  const top = Math.max(0, row * tileSize - (row > 0 ? overlap : 0));
  const right = Math.min(
    levelWidth,
    (column + 1) * tileSize + (column < columns - 1 ? overlap : 0),
  );
  const bottom = Math.min(
    levelHeight,
    (row + 1) * tileSize + (row < rows - 1 ? overlap : 0),
  );
  return { left, top, width: right - left, height: bottom - top };
}

/**
 * The tile file extension used on disk and in the descriptor's `Format`
 * attribute.
 *
 * libvips' Deep Zoom writer names its tiles `<x>_<y>.jpeg` for JPEG output
 * and `<x>_<y>.png` for PNG output. OpenSeadragon builds every tile URL by
 * concatenating the descriptor's `Format` attribute verbatim
 * (`<Url><level>/<x>_<y>.<Format>`), so the descriptor must name the exact
 * extension that exists on disk. Saying `jpg` while the files are `jpeg`
 * would make every single tile request 404.
 */
export function getTileExtension(format: 'jpeg' | 'png'): string {
  return format === 'png' ? 'png' : 'jpeg';
}

export function buildDziXml(options: {
  width: number;
  height: number;
  tileSize: number;
  tileOverlap: number;
  format: 'jpeg' | 'png';
  tilesUrlPath: string;
}): string {
  // OpenSeadragon concatenates the descriptor `Url` with the level and tile
  // indices verbatim (`<Url><level>/<x>_<y>.<format>`), so the value must end
  // with a slash or the last path segment is swallowed.
  const tilesUrl = options.tilesUrlPath.endsWith('/')
    ? options.tilesUrlPath
    : `${options.tilesUrlPath}/`;

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<Image xmlns="http://schemas.microsoft.com/deepzoom/2008" Url="${escapeXml(
      tilesUrl,
    )}" Format="${getTileExtension(options.format)}" TileSize="${
      options.tileSize
    }" Overlap="${options.tileOverlap}">`,
    `  <Size Width="${options.width}" Height="${options.height}"/>`,
    '</Image>',
    '',
  ].join('\n');
}

/**
 * Rewrites the descriptor's root-relative `Url` into an absolute one.
 *
 * The stored descriptor keeps a root-relative tile path so the same artifacts
 * stay valid behind any host. The browser, however, resolves a relative `Url`
 * against the *web* origin (the Next.js app), not the API origin, so the tile
 * requests would 404. Absolutizing at serve time keeps both properties.
 */
export function absolutizeDziTileUrl(xml: string, publicOrigin: string): string {
  return xml.replace(/(<Image\b[^>]*\bUrl=")([^"]*)(")/, (_match, prefix, url, suffix) => {
    if (/^https?:\/\//i.test(url)) return `${prefix}${url}${suffix}`;
    const origin = publicOrigin.replace(/\/+$/, '');
    return `${prefix}${origin}${url.startsWith('/') ? url : `/${url}`}${suffix}`;
  });
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Generates a Deep Zoom pyramid with Sharp/libvips.
 *
 * The pyramid is produced by libvips' native Deep Zoom writer (`dzsave`),
 * which sharp exposes through `.tile({ layout: 'dz' })`. Compared with
 * hand-rolling one pyramid level at a time, this is dramatically faster on
 * large images, because `dzsave` uses the source codec's *shrink on load*
 * (JPEG DCT scaling) to build every level below full resolution without ever
 * decoding the whole image.
 *
 * The previous implementation decoded the full-resolution source once per
 * pyramid level and then extracted every tile from a temporary TIFF. On a
 * 2922 MP scan that meant sixteen full decodes of a 121 MB file, which took
 * over half an hour and reliably hit the processing timeout.
 *
 * Produced layout (standard DZI):
 *
 *   <outputDir>/<key>.dzi
 *   <outputDir>/<key>_files/<level>/<column>_<row>.<ext>
 */
@Injectable()
export class DziGeneratorService {
  private readonly logger = new Logger(DziGeneratorService.name);

  constructor() {
    // libvips' file cache keeps source handles open, which blocks deleting
    // files on Windows. The operation cache can hold the same handle too.
    // Neither is useful here: every input is decoded once and written once.
    configureSharpCache();
  }

  async generate(options: DziGenerationOptions): Promise<DziGenerationResult> {
    const {
      sourcePath,
      outputDir,
      assetKey,
      tilesUrlPath,
      tileSize,
      tileOverlap,
      tileFormat,
      tileQuality,
      signal,
    } = options;

    if (!Number.isInteger(tileSize) || tileSize < 64 || tileSize > 2048) {
      throw ApplicationError.badRequest(
        'INVALID_TILE_SIZE',
        'Tile size must be an integer between 64 and 2048',
      );
    }

    this.assertAborted(signal);

    // `autoOrient` reports the post-rotation dimensions, which is what the
    // saved DZI pyramid (auto-oriented by libvips) will actually contain.
    const metadata = await openImage(sourcePath).metadata();
    const width = metadata.autoOrient?.width ?? metadata.width;
    const height = metadata.autoOrient?.height ?? metadata.height;
    if (!width || !height) {
      throw ApplicationError.badRequest('INVALID_IMAGE', 'Unable to read image dimensions');
    }

    await fs.mkdir(outputDir, { recursive: true });

    const levels = listLevels(width, height, tileSize);
    const maxLevel = levels.length - 1;
    const extension = getTileExtension(tileFormat);

    // libvips writes `<assetKey>.dzi` next to `<assetKey>_files/`, derived from
    // the output path, so the output path must not carry an extension.
    const basePath = path.join(outputDir, assetKey);
    const filesDir = `${basePath}_files`;

    // The descriptor libvips writes has no `Url` attribute and reports the
    // *pre-rotation* size, so it is replaced with our own descriptor below.
    const descriptorPath = `${basePath}.dzi`;

    const totalTiles = levels.reduce((sum, level) => sum + level.columns * level.rows, 0);
    const startedAt = Date.now();

    this.logger.log(
      `Starting pyramid for ${assetKey}: ${width}x${height} (${((width * height) / 1e6).toFixed(1)} MP), ` +
        `${levels.length} levels, ${totalTiles} tiles, ${tileSize}px ${extension}, overlap ${tileOverlap}`,
    );

    try {
      this.assertAborted(signal);

      let pipeline = openImage(sourcePath).autoOrient();

      // The output format must be selected before `.tile()`: sharp's `tile()`
      // forces the container format, and a later `.png()` would fail because
      // the dz container has already been chosen.
      if (tileFormat === 'png') {
        // Overlays keep their transparency, so PNG is required for alpha.
        // A PNG pyramid is larger, but flattening to JPEG would destroy the
        // alpha channel the editor relies on.
        pipeline = pipeline.png({ compressionLevel: 9 });
      } else {
        pipeline = pipeline.jpeg({ quality: tileQuality, mozjpeg: true });
      }

      await pipeline
        .tile({
          size: tileSize,
          overlap: tileOverlap,
          layout: 'dz',
          container: 'fs',
          // `onepixel` builds the pyramid down to a single pixel, which is
          // exactly the level structure this project computes:
          // `maxLevel = ceil(log2(max(width, height)))` with level 0 being
          // 1x1. (`one` would emit a single level only, and `onetile` would
          // stop one level too early.)
          depth: 'onepixel',
        })
        .toFile(basePath);

      this.assertAborted(signal);

      // libvips also leaves a `vips-properties.xml` next to the pyramid. It
      // is an internal artifact and is never served, so it is removed.
      await fs.rm(path.join(filesDir, 'vips-properties.xml'), { force: true });

      const tileCount = await this.countTiles(filesDir);

      const descriptor = buildDziXml({
        width,
        height,
        tileSize,
        tileOverlap,
        format: tileFormat,
        tilesUrlPath,
      });
      await fs.writeFile(descriptorPath, descriptor, 'utf8');

      const elapsed = (Date.now() - startedAt) / 1000;
      this.logger.log(
        `Generated DZI ${assetKey}: ${width}x${height}, ${levels.length} levels, ` +
          `${tileCount} tiles in ${elapsed.toFixed(1)}s`,
      );

      return {
        descriptorPath,
        descriptor,
        width,
        height,
        maxLevel,
        tileCount,
      };
    } catch (error) {
      // A half-written pyramid must never be served: the descriptor would 404
      // on some levels while others still resolve.
      await fs.rm(descriptorPath, { force: true });
      await fs.rm(filesDir, { recursive: true, force: true });
      this.logger.error(
        `Pyramid for ${assetKey} failed after ${((Date.now() - startedAt) / 1000).toFixed(1)}s: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  /** Counts the generated tiles across every level. */
  private async countTiles(filesDir: string): Promise<number> {
    let total = 0;
    const entries = await fs.readdir(filesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const levelDir = path.join(filesDir, entry.name);
      const tiles = await fs.readdir(levelDir);
      total += tiles.filter((name) => name.endsWith('.jpg') || name.endsWith('.jpeg') || name.endsWith('.png')).length;
    }
    return total;
  }

  private assertAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw ApplicationError.badRequest(
        'PROCESSING_ABORTED',
        'Image processing was aborted',
      );
    }
  }
}
