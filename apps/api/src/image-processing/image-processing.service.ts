import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ImageAsset, ImageAssetDocument } from '../images/schemas/image-asset.schema';
import { APP_CONFIG, AppConfig } from '../config/configuration';
import { StorageService } from '../storage/storage.service';
import { ApplicationError } from '../common/errors/application.error';
import { openImage } from '../common/sharp/sharp-input';
import { DziGeneratorService } from './dzi-generator.service';
import { TaskManagerService } from './task-manager.service';

export const INTERRUPTED_MESSAGE =
  'Processing was interrupted because the server restarted. Please upload the image again.';

@Injectable()
export class ImageProcessingService implements OnModuleInit {
  private readonly logger = new Logger(ImageProcessingService.name);

  constructor(
    @InjectModel(ImageAsset.name)
    private readonly imageModel: Model<ImageAssetDocument>,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly storage: StorageService,
    private readonly dziGenerator: DziGeneratorService,
    private readonly tasks: TaskManagerService,
  ) {}

  async onModuleInit(): Promise<void> {
    const removed = await this.storage.cleanTempDirectory();
    if (removed > 0) {
      this.logger.log(`Cleared ${removed} stale temporary upload file(s)`);
    }
    await this.recoverInterruptedAssets();
  }

  /**
   * In-process tasks do not survive a restart. Any asset still marked
   * `PROCESSING` at boot therefore belongs to a dead process and is failed
   * explicitly so the UI never polls forever.
   */
  async recoverInterruptedAssets(): Promise<number> {
    const result = await this.imageModel
      .updateMany(
        { status: 'PROCESSING' },
        {
          $set: {
            status: 'FAILED',
            errorMessage: INTERRUPTED_MESSAGE,
          },
        },
      )
      .exec();

    const modified = result.modifiedCount ?? 0;
    if (modified > 0) {
      this.logger.warn(
        `Marked ${modified} interrupted image asset(s) as FAILED after restart`,
      );
    }
    return modified;
  }

  /** Schedules background DZI generation. Never blocks the upload response. */
  scheduleProcessing(imageAssetId: string): void {
    const handle = this.tasks.submit(imageAssetId, () => this.process(imageAssetId));
    // Rejections are already persisted by `process`; swallow here to avoid
    // unhandled promise rejection noise.
    handle.promise.catch(() => undefined);
  }

  isScheduled(imageAssetId: string): boolean {
    return this.tasks.isScheduled(imageAssetId);
  }

  async onIdle(): Promise<void> {
    await this.tasks.onIdle();
  }

  /**
   * Full processing pipeline for a single asset. Exposed so tests can run it
   * deterministically instead of racing the background scheduler.
   */
  async process(imageAssetId: string): Promise<void> {
    if (!Types.ObjectId.isValid(imageAssetId)) {
      return;
    }

    const asset = await this.imageModel.findById(imageAssetId).exec();
    if (!asset) {
      this.logger.warn(`Skipping processing for unknown asset ${imageAssetId}`);
      return;
    }

    // The asset was created as PROCESSING by the upload path. Guard against a
    // second processing pass for an asset that already finished.
    if (asset.status !== 'PROCESSING') {
      this.logger.debug(`Asset ${imageAssetId} is ${asset.status}; skipping`);
      return;
    }

    const jobDir = path.join(this.storage.bucketPath('tmp'), `job-${asset.storageKey}`);
    const controller = new AbortController();
    // Local to this job: an instance field would be shared by every concurrent
    // job and could attribute one job's timeout to another.
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.config.imageProcessingTimeoutMs);
    const startedAt = Date.now();

    try {
      this.logger.log(
        `Processing asset ${imageAssetId} ("${asset.name}", ${(asset.fileSize / 1e6).toFixed(1)} MB) ` +
          `— timeout ${Math.round(this.config.imageProcessingTimeoutMs / 1000)}s`,
      );

      await fs.rm(jobDir, { recursive: true, force: true });
      await fs.mkdir(jobDir, { recursive: true });

      const originalPath = this.storage.resolveStoredRelativePath(asset.originalPath);
      const exists = await this.storage.pathExists(originalPath);
      if (!exists) {
        throw new Error('Original image file is missing from storage');
      }

      await this.validateStoredImage(originalPath);

      const result = await this.dziGenerator.generate({
        sourcePath: originalPath,
        outputDir: jobDir,
        assetKey: asset.storageKey,
        tilesUrlPath: `/api/v1/images/${imageAssetId}/tiles`,
        tileSize: this.config.dziTileSize,
        tileOverlap: this.config.dziTileOverlap,
        tileFormat: this.config.dziTileFormat,
        tileQuality: this.config.dziTileQuality,
        signal: controller.signal,
      });

      this.logger.log(
        `Promoting the pyramid of ${imageAssetId} into the DZI bucket (${result.tileCount} tiles)`,
      );

      // Promote the finished artifacts from the temp job dir into `data/dzi/`
      // in one step per entry so a partially written pyramid is never visible.
      const dziRoot = this.storage.bucketPath('dzi');
      await fs.mkdir(dziRoot, { recursive: true });
      await this.storage.moveFile(
        result.descriptorPath,
        path.join(dziRoot, `${asset.storageKey}.dzi`),
      );
      await this.storage.moveFile(
        path.join(jobDir, `${asset.storageKey}_files`),
        path.join(dziRoot, `${asset.storageKey}_files`),
      );

      await this.imageModel
        .updateOne(
          { _id: asset._id, status: 'PROCESSING' },
          {
            $set: {
              status: 'COMPLETED',
              width: result.width,
              height: result.height,
              dziPath: this.storage.dziRelativePath(asset.storageKey),
            },
            $unset: { errorMessage: 1 },
          },
        )
        .exec();

      this.logger.log(
        `Asset ${imageAssetId} processed (${result.tileCount} tiles) in ` +
          `${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
      );
    } catch (error) {
      const message = this.describeError(error, timedOut);
      const elapsed = (Date.now() - startedAt) / 1000;

      this.logger.error(
        `Asset ${imageAssetId} failed after ${elapsed.toFixed(1)}s: ${message}` +
          (timedOut
            ? ` — the processing timeout of ${Math.round(
                this.config.imageProcessingTimeoutMs / 1000,
              )}s was reached. Raise IMAGE_PROCESSING_TIMEOUT_MS or lower MAX_IMAGE_PIXELS.`
            : ''),
      );

      await this.imageModel
        .updateOne(
          { _id: asset._id, status: 'PROCESSING' },
          {
            $set: {
              status: 'FAILED',
              errorMessage: message,
            },
          },
        )
        .exec()
        .catch((updateError: unknown) => {
          this.logger.error(
            `Unable to persist failure state for ${imageAssetId}: ${this.describeError(updateError)}`,
          );
        });

      // Never leave a half-written pyramid behind.
      await this.storage.removeIfExists(path.join(this.storage.bucketPath('dzi'), `${asset.storageKey}_files`)).catch(() => undefined);
      await this.storage.removeIfExists(path.join(this.storage.bucketPath('dzi'), `${asset.storageKey}.dzi`)).catch(() => undefined);
    } finally {
      clearTimeout(timeout);
      await fs.rm(jobDir, { recursive: true, force: true }).catch((error: unknown) => {
        this.logger.warn(`Failed to clean job dir: ${this.describeError(error)}`);
      });
    }
  }

  /**
   * Re-validates the stored file before decoding it. Guards against a file that
   * changed on disk or a spoofed upload that slipped past the first check.
   */
  private async validateStoredImage(originalPath: string): Promise<void> {
    const metadata = await openImage(originalPath).metadata();
    if (metadata.format !== 'jpeg' && metadata.format !== 'png') {
      throw new Error(`Unsupported image format "${metadata.format ?? 'unknown'}"`);
    }

    const width = metadata.autoOrient?.width ?? metadata.width ?? 0;
    const height = metadata.autoOrient?.height ?? metadata.height ?? 0;
    if (width <= 0 || height <= 0) {
      throw new Error('Image has no readable dimensions');
    }
    if (width * height > this.config.maxImagePixels) {
      throw new Error(
        `Image exceeds the maximum pixel budget (${width * height} > ${this.config.maxImagePixels})`,
      );
    }
  }

  /**
   * Converts any thrown value into a short, client-safe failure reason.
   *
   * The abort error raised by the generator is a generic `PROCESSING_ABORTED`,
   * which tells the user nothing. When the abort came from the timeout it is
   * rewritten into an explicit, actionable message.
   */
  private describeError(error: unknown, timedOut = false): string {
    if (error instanceof ApplicationError) {
      if (error.code === 'PROCESSING_ABORTED' && timedOut) {
        return (
          `Image processing timed out after ${Math.round(
            this.config.imageProcessingTimeoutMs / 1000,
          )}s. The image is too large to process with the current limits.`
        );
      }
      return error.message;
    }
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        return 'Image processing timed out';
      }
      // Keep only the first line to avoid leaking stack context.
      return error.message.split('\n')[0].slice(0, 500) || 'Image processing failed';
    }
    return 'Image processing failed';
  }
}
