import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ApplicationError } from '../common/errors/application.error';
import { configureSharpCache } from '../common/sharp/sharp-cache';
import {
  DziGenerationResult,
  DziGeneratorService,
  DziGenerationOptions,
} from './dzi-generator.service';

/**
 * Generates a Deep Zoom pyramid for an uploaded overlay bitmap.
 *
 * The base image already has a DZI pyramid, but overlay assets were historically
 * served as a single full-resolution file. That means the browser downloads the
 * whole bitmap once and then merely scales it, so zooming in reveals no extra
 * detail and large overlays cost a lot of memory.
 *
 * This service reuses the *same* generator as the base image so both pyramids
 * share tile size, overlap and format conventions. Tiles are written next to
 * the overlay bitmap under `overlays/<assetKey>/<overlayKey>_files/`, which
 * keeps the descriptor/tile pair discoverable and makes cleanup a single
 * directory removal.
 */
@Injectable()
export class OverlayDziService {
  private readonly logger = new Logger(OverlayDziService.name);

  constructor(private readonly dziGenerator: DziGeneratorService) {
    configureSharpCache();
  }

  /**
   * Builds the pyramid for one overlay.
   *
   * `outputDir` is the overlay's own directory so the resulting layout is
   * `<outputDir>/<overlayKey>.dzi` + `<outputDir>/<overlayKey>_files/`.
   */
  async generate(options: {
    sourcePath: string;
    outputDir: string;
    overlayKey: string;
    /** Absolute URL path of the overlay tile endpoint, without trailing slash. */
    tilesUrlPath: string;
    tileSize: number;
    tileOverlap: number;
    tileFormat: 'jpeg' | 'png';
    tileQuality: number;
  }): Promise<DziGenerationResult> {
    const {
      sourcePath,
      outputDir,
      overlayKey,
      tilesUrlPath,
      tileSize,
      tileOverlap,
      tileFormat,
      tileQuality,
    } = options;

    const generationOptions: DziGenerationOptions = {
      sourcePath,
      outputDir,
      // The base generator names artifacts `<assetKey>.dzi` / `<assetKey>_files`.
      // Reusing it with the overlay key keeps the two pyramids identical in
      // shape and lets the same storage helpers resolve them.
      assetKey: overlayKey,
      tilesUrlPath,
      tileSize,
      tileOverlap,
      tileFormat,
      tileQuality,
    };

    try {
      const result = await this.dziGenerator.generate(generationOptions);
      this.logger.log(
        `Generated overlay DZI ${overlayKey}: ${result.width}x${result.height}, ${result.tileCount} tiles`,
      );
      return result;
    } catch (error) {
      // A half-written pyramid must never be served: the descriptor would 404
      // on some levels while others still resolve.
      await this.removeArtifacts(outputDir, overlayKey);
      if (error instanceof ApplicationError) {
        throw error;
      }
      throw ApplicationError.internal(
        'OVERLAY_TILE_GENERATION_FAILED',
        'Unable to build the overlay tile pyramid',
      );
    }
  }

  /** Removes the descriptor and the tile tree of one overlay. */
  async removeArtifacts(outputDir: string, overlayKey: string): Promise<void> {
    await fs.rm(path.join(outputDir, `${overlayKey}.dzi`), { force: true });
    await fs.rm(path.join(outputDir, `${overlayKey}_files`), {
      recursive: true,
      force: true,
    });
  }
}
