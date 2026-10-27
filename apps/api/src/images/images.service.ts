import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import sharp from 'sharp';
import {
  ImageAsset as ImageAssetDto,
  ImageStatusResponse,
  OverlayAsset as OverlayAssetDto,
  PaginationMeta,
} from '@deep-zoom/shared-types';
import { ImageAsset, ImageAssetDocument } from './schemas/image-asset.schema';
import { OverlayAsset, OverlayAssetDocument } from './schemas/overlay-asset.schema';
import { ImageLayer, ImageLayerDocument } from '../layers/schemas/image-layer.schema';
import { LayerObject, LayerObjectDocument } from '../layer-objects/schemas/layer-object.schema';
import { StorageService } from '../storage/storage.service';
import { ImageProcessingService } from '../image-processing/image-processing.service';
import { OverlayDziService } from '../image-processing/overlay-dzi.service';
import { absolutizeDziTileUrl } from '../image-processing/dzi-generator.service';
import { APP_CONFIG, AppConfig } from '../config/configuration';
import { ApplicationError } from '../common/errors/application.error';
import { openImage } from '../common/sharp/sharp-input';

const ALLOWED_UPLOAD_MIME = new Set(['image/jpeg', 'image/png']);
const ALLOWED_OVERLAY_MIME = new Set(['image/png', 'image/webp', 'image/jpeg']);
const MAX_NAME_LENGTH = 200;

/** Client-supplied tile path, e.g. `3/12_7.png`. */
const TILE_PATH_PATTERN = /^\d{1,2}\/\d{1,6}_\d{1,6}\.(jpg|jpeg|png|webp)$/;

export interface UploadedFileLike {
  originalname: string;
  mimetype: string;
  size: number;
  path?: string;
  buffer?: Buffer;
}

export interface PaginatedImages {
  items: ImageAssetDto[];
  meta: PaginationMeta;
}

@Injectable()
export class ImagesService {
  private readonly logger = new Logger(ImagesService.name);

  constructor(
    @InjectModel(ImageAsset.name)
    private readonly imageModel: Model<ImageAssetDocument>,
    @InjectModel(OverlayAsset.name)
    private readonly overlayModel: Model<OverlayAssetDocument>,
    @InjectModel(ImageLayer.name)
    private readonly layerModel: Model<ImageLayerDocument>,
    @InjectModel(LayerObject.name)
    private readonly objectModel: Model<LayerObjectDocument>,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly storage: StorageService,
    private readonly processing: ImageProcessingService,
    private readonly overlayDzi: OverlayDziService,
  ) {}

  /* -------------------------------- upload -------------------------------- */

  /**
   * Upload flow: validate, persist metadata as PROCESSING, return immediately,
   * then let the in-process task manager build the DZI pyramid.
   */
  async createFromUpload(file: UploadedFileLike, providedName?: string): Promise<ImageAssetDto> {
    if (!file) {
      throw ApplicationError.badRequest('FILE_REQUIRED', 'An image file is required');
    }

    const tempPath = file.path;
    if (!tempPath) {
      throw ApplicationError.badRequest('FILE_REQUIRED', 'Uploaded file was not persisted');
    }

    const storageKey = this.storage.createStorageKey();
    let createdDocument: ImageAssetDocument | null = null;

    try {
      await this.assertValidUpload(file, tempPath);

      const metadata = await openImage(tempPath).metadata();
      const width = metadata.autoOrient?.width ?? metadata.width ?? 0;
      const height = metadata.autoOrient?.height ?? metadata.height ?? 0;
      const mimeType = metadata.format === 'png' ? 'image/png' : 'image/jpeg';
      const extension = this.storage.extensionForMimeType(mimeType);

      const originalPath = await this.storage.moveIntoPlace(
        tempPath,
        'originals',
        storageKey,
        extension,
      );

      const name = this.deriveName(providedName, file.originalname);

      createdDocument = await this.imageModel.create({
        name,
        originalFilename: this.sanitizeFilename(file.originalname),
        originalPath,
        storageKey,
        width: width || undefined,
        height: height || undefined,
        fileSize: file.size,
        mimeType,
        status: 'PROCESSING',
      });

      // Metadata is durable and the file is safely in place, so it is safe to
      // respond now. DZI generation happens in the background.
      this.processing.scheduleProcessing(createdDocument._id.toString());

      return this.toDto(createdDocument);
    } catch (error) {
      // Roll back anything written for this asset so a failed upload leaves no
      // orphan files behind.
      await this.storage.removeAssetData(storageKey).catch(() => undefined);
      if (createdDocument) {
        await this.imageModel.deleteOne({ _id: createdDocument._id }).catch(() => undefined);
      }
      if (tempPath) {
        await this.storage.safeUnlink(tempPath);
      }
      throw error;
    }
  }

  private deriveName(providedName: string | undefined, originalFilename: string): string {
    const candidate = (providedName ?? '').trim();
    if (candidate.length > 0) {
      return candidate.slice(0, MAX_NAME_LENGTH);
    }
    const base = path.parse(this.sanitizeFilename(originalFilename)).name.trim();
    return (base || 'Untitled image').slice(0, MAX_NAME_LENGTH);
  }

  /**
   * Strips directory components and control characters. The result is used for
   * display only and never to build a filesystem path.
   */
  private sanitizeFilename(originalFilename: string): string {
    const base = path.basename(originalFilename ?? '').replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_'); // eslint-disable-line no-control-regex
    return (base || 'upload').slice(0, 255);
  }

  /**
   * Verifies MIME type, extension and actual decoder output before an asset row
   * is created. The real format check (not just the declared MIME) is what
   * prevents a disguised file from reaching the processing pipeline.
   */
  private async assertValidUpload(file: UploadedFileLike, tempPath: string): Promise<void> {
    if (!ALLOWED_UPLOAD_MIME.has(file.mimetype)) {
      throw ApplicationError.badRequest(
        'UNSUPPORTED_FILE_TYPE',
        'Only JPEG and PNG images are supported',
      );
    }

    if (!Number.isFinite(file.size) || file.size <= 0) {
      throw ApplicationError.badRequest('EMPTY_FILE', 'The uploaded file is empty');
    }
    if (file.size > this.config.maxUploadSizeBytes) {
      throw ApplicationError.badRequest(
        'FILE_TOO_LARGE',
        `File exceeds the ${this.config.maxUploadSizeMb} MB limit`,
      );
    }

    const extension = path.extname(file.originalname ?? '').toLowerCase();
    if (!['.jpg', '.jpeg', '.png'].includes(extension)) {
      throw ApplicationError.badRequest(
        'UNSUPPORTED_FILE_TYPE',
        'File extension must be .jpg, .jpeg or .png',
      );
    }

    let metadata: sharp.Metadata;
    try {
      metadata = await openImage(tempPath).metadata();
    } catch {
      throw ApplicationError.badRequest('INVALID_IMAGE', 'The file is not a readable image');
    }

    if (metadata.format !== 'jpeg' && metadata.format !== 'png') {
      throw ApplicationError.badRequest(
        'UNSUPPORTED_FILE_TYPE',
        'The file content is not a JPEG or PNG image',
      );
    }

    // Declared MIME and decoded format must agree.
    const declared = file.mimetype === 'image/png' ? 'png' : 'jpeg';
    if (declared !== metadata.format) {
      throw ApplicationError.badRequest(
        'MIME_MISMATCH',
        'File content does not match the declared content type',
      );
    }

    const width = metadata.autoOrient?.width ?? metadata.width ?? 0;
    const height = metadata.autoOrient?.height ?? metadata.height ?? 0;
    if (width <= 0 || height <= 0) {
      throw ApplicationError.badRequest('INVALID_IMAGE', 'Image dimensions are invalid');
    }
    if (width * height > this.config.maxImagePixels) {
      throw ApplicationError.badRequest(
        'IMAGE_TOO_LARGE',
        `Image has ${width * height} pixels, exceeding the limit of ${this.config.maxImagePixels}`,
      );
    }
  }

  /* --------------------------------- reads -------------------------------- */

  async list(page: number, limit: number): Promise<PaginatedImages> {
    const skip = (page - 1) * limit;
    const [documents, total] = await Promise.all([
      this.imageModel.find().sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).exec(),
      this.imageModel.countDocuments().exec(),
    ]);

    return {
      items: documents.map((document) => this.toDto(document)),
      meta: {
        page,
        limit,
        total,
        totalPages: total === 0 ? 0 : Math.ceil(total / limit),
      },
    };
  }

  async findOne(imageId: string): Promise<ImageAssetDocument> {
    this.assertObjectId(imageId);
    const document = await this.imageModel.findById(imageId).exec();
    if (!document) {
      throw ApplicationError.notFound('IMAGE_NOT_FOUND', 'Image not found');
    }
    return document;
  }

  async getDto(imageId: string): Promise<ImageAssetDto> {
    return this.toDto(await this.findOne(imageId));
  }

  async getStatus(imageId: string): Promise<ImageStatusResponse> {
    const document = await this.findOne(imageId);
    return {
      imageId: document._id.toString(),
      status: document.status,
      errorMessage: document.errorMessage,
      width: document.width,
      height: document.height,
      updatedAt: (document.updatedAt ?? new Date()).toISOString(),
    };
  }

  /* ------------------------------ DZI serving ----------------------------- */

  /**
   * Returns the stored descriptor with its tile `Url` made absolute.
   *
   * The descriptor is generated with a root-relative tile path so the artifacts
   * stay host-independent, but OpenSeadragon resolves a relative `Url` against
   * the page origin (the web app), not the API origin. Absolutizing here keeps
   * tile requests pointed at this API.
   */
  async getDziDescriptor(
    imageId: string,
    publicOrigin: string,
  ): Promise<{ xml: string; etag: string }> {
    const document = await this.requireCompleted(imageId);
    const stored = await this.storage.readDziDescriptor(document.storageKey);
    const xml = absolutizeDziTileUrl(stored, publicOrigin);
    // The descriptor only changes when a new processing run completes.
    const etag = `"dzi-${document.storageKey}-${document.updatedAt?.getTime() ?? 0}"`;
    return { xml, etag };
  }

  async resolveTileFile(
    imageId: string,
    tilePath: string,
  ): Promise<{ absolutePath: string; contentType: string; size: number }> {
    const document = await this.requireCompleted(imageId);
    const resolved = this.storage.resolveTile(document.storageKey, tilePath);
    if (!resolved) {
      throw ApplicationError.badRequest('INVALID_TILE_PATH', 'Invalid tile path');
    }

    const stat = await this.storage.statFile(resolved.absolutePath);
    if (!stat) {
      throw ApplicationError.notFound('TILE_NOT_FOUND', 'Tile not found');
    }

    return { ...resolved, size: stat.size };
  }

  private async requireCompleted(imageId: string): Promise<ImageAssetDocument> {
    const document = await this.findOne(imageId);
    if (document.status === 'PROCESSING') {
      throw ApplicationError.conflict(
        'IMAGE_NOT_READY',
        'The image is still being processed',
      );
    }
    if (document.status === 'FAILED') {
      throw ApplicationError.conflict(
        'IMAGE_PROCESSING_FAILED',
        document.errorMessage ?? 'Image processing failed',
      );
    }
    return document;
  }

  /* -------------------------------- overlays ------------------------------ */

  async createOverlay(imageId: string, file: UploadedFileLike): Promise<OverlayAssetDto> {
    const document = await this.findOne(imageId);
    if (!file?.path) {
      throw ApplicationError.badRequest('FILE_REQUIRED', 'An overlay file is required');
    }

    const tempPath = file.path;
    const storageKey = this.storage.createStorageKey();

    try {
      if (!ALLOWED_OVERLAY_MIME.has(file.mimetype)) {
        throw ApplicationError.badRequest(
          'UNSUPPORTED_FILE_TYPE',
          'Overlay must be a PNG, WebP or JPEG image',
        );
      }
      if (file.size > this.config.maxUploadSizeBytes) {
        throw ApplicationError.badRequest(
          'FILE_TOO_LARGE',
          `File exceeds the ${this.config.maxUploadSizeMb} MB limit`,
        );
      }

      let metadata: sharp.Metadata;
      try {
        metadata = await openImage(tempPath).metadata();
      } catch {
        throw ApplicationError.badRequest('INVALID_IMAGE', 'The overlay is not a readable image');
      }

      if (
        metadata.format !== 'png' &&
        metadata.format !== 'webp' &&
        metadata.format !== 'jpeg'
      ) {
        throw ApplicationError.badRequest(
          'UNSUPPORTED_FILE_TYPE',
          'Overlay content must be PNG, WebP or JPEG',
        );
      }

      const width = metadata.autoOrient?.width ?? metadata.width ?? 0;
      const height = metadata.autoOrient?.height ?? metadata.height ?? 0;
      if (width <= 0 || height <= 0) {
        throw ApplicationError.badRequest('INVALID_IMAGE', 'Overlay dimensions are invalid');
      }
      if (width * height > this.config.maxImagePixels) {
        throw ApplicationError.badRequest('IMAGE_TOO_LARGE', 'Overlay exceeds the pixel limit');
      }

      const extension =
        metadata.format === 'webp' ? 'webp' : metadata.format === 'jpeg' ? 'jpg' : 'png';
      const overlayDir = this.storage.overlayAbsolutePath(document.storageKey, storageKey, extension);
      await fs.mkdir(path.dirname(overlayDir), {
        recursive: true,
      });
      await this.storage.moveFile(tempPath, overlayDir);

      // The overlay row is created first so its public id is known: the tile
      // URL embedded in the descriptor must address the overlay the same way
      // the existing `/overlays/:overlayId` route does.
      const overlay = await this.overlayModel.create({
        imageAssetId: document._id,
        storageKey,
        mimeType: `image/${extension === 'jpg' ? 'jpeg' : extension}`,
        extension,
        width,
        height,
        fileSize: file.size,
        originalFilename: this.sanitizeFilename(file.originalname),
      });

      // Build a Deep Zoom pyramid for the overlay so zooming in reveals the
      // bitmap's real detail instead of upscaling a single full-resolution
      // file. The pyramid is a derived display asset: the original bitmap is
      // untouched and remains the source of truth.
      await this.overlayDzi.generate({
        sourcePath: overlayDir,
        outputDir: path.dirname(overlayDir),
        overlayKey: storageKey,
        tilesUrlPath: `/api/v1/images/${imageId}/overlays/${overlay._id.toString()}/tiles`,
        tileSize: this.config.dziTileSize,
        tileOverlap: this.config.dziTileOverlap,
        // Overlays keep their transparency, so PNG is required for alpha.
        // A PNG pyramid is larger, but flattening to JPEG would destroy the
        // alpha channel the editor relies on.
        tileFormat: 'png',
        tileQuality: this.config.dziTileQuality,
      });

      return this.toOverlayDto(overlay);
    } catch (error) {
      await this.storage.safeUnlink(tempPath);
      // Remove the bitmap and any partially written tile pyramid.
      await this.overlayDzi
        .removeArtifacts(
          path.join(this.storage.bucketPath('overlays'), document.storageKey),
          storageKey,
        )
        .catch(() => undefined);
      for (const cleanupExtension of ['png', 'webp', 'jpg']) {
        await this.storage
          .removeIfExists(
            path.join(
              this.storage.bucketPath('overlays'),
              document.storageKey,
              `${storageKey}.${cleanupExtension}`,
            ),
          )
          .catch(() => undefined);
      }
      throw error;
    }
  }

  async getOverlayFile(
    imageId: string,
    overlayId: string,
  ): Promise<{ absolutePath: string; contentType: string; size: number }> {
    const document = await this.findOne(imageId);
    this.assertObjectId(overlayId, 'OVERLAY_NOT_FOUND');

    const overlay = await this.overlayModel.findById(overlayId).exec();
    // Ownership check: an overlay from another image must never be served.
    if (!overlay || overlay.imageAssetId.toString() !== document._id.toString()) {
      throw ApplicationError.notFound('OVERLAY_NOT_FOUND', 'Overlay not found');
    }

    const absolutePath = this.storage.overlayAbsolutePath(
      document.storageKey,
      overlay.storageKey,
      overlay.extension,
    );
    const stat = await this.storage.statFile(absolutePath);
    if (!stat) {
      throw ApplicationError.notFound('OVERLAY_NOT_FOUND', 'Overlay file is missing');
    }

    return { absolutePath, contentType: overlay.mimeType, size: stat.size };
  }

  /**
   * Returns the overlay's Deep Zoom descriptor with an absolute tile URL.
   *
   * Mirrors the base image endpoint: the stored descriptor keeps a
   * root-relative tile path so the artifacts stay host-independent, while the
   * browser needs an absolute URL pointing at this API.
   */
  async getOverlayDziDescriptor(
    imageId: string,
    overlayId: string,
    publicOrigin: string,
  ): Promise<{ xml: string; etag: string }> {
    const overlay = await this.requireOwnedOverlay(imageId, overlayId);

    const absolutePath = this.storage.overlayDziAbsolutePath(
      overlay.assetStorageKey,
      overlay.storageKey,
    );
    let stored: string;
    try {
      stored = await fs.readFile(absolutePath, 'utf8');
    } catch {
      throw ApplicationError.notFound(
        'OVERLAY_DZI_NOT_FOUND',
        'Overlay tile pyramid is not available',
      );
    }

    const xml = absolutizeDziTileUrl(stored, publicOrigin);
    const etag = `"overlay-dzi-${overlay.storageKey}"`;
    return { xml, etag };
  }

  /** Resolves a single overlay tile request to a file on disk. */
  async resolveOverlayTileFile(
    imageId: string,
    overlayId: string,
    tilePath: string,
  ): Promise<{ absolutePath: string; contentType: string; size: number }> {
    const overlay = await this.requireOwnedOverlay(imageId, overlayId);

    const normalized = tilePath.replace(/\\/g, '/');
    if (!TILE_PATH_PATTERN.test(normalized) || normalized.includes('..')) {
      throw ApplicationError.badRequest('INVALID_TILE_PATH', 'Invalid tile path');
    }

    const [levelPart, file] = normalized.split('/');
    const level = Number.parseInt(levelPart, 10);
    if (!Number.isInteger(level) || level < 0 || level > 40) {
      throw ApplicationError.badRequest('INVALID_TILE_PATH', 'Invalid tile path');
    }

    const absolutePath = this.storage.overlayTileAbsolutePath(
      overlay.assetStorageKey,
      overlay.storageKey,
      level,
      file,
    );
    const stat = await this.storage.statFile(absolutePath);
    if (!stat) {
      throw ApplicationError.notFound('TILE_NOT_FOUND', 'Tile not found');
    }

    const contentType = path.extname(file).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
    return { absolutePath, contentType, size: stat.size };
  }

  /**
   * Loads an overlay and verifies it belongs to the given image.
   *
   * The public id addresses the Mongo document; the storage key is the opaque
   * on-disk name used to locate the bitmap and its tile pyramid.
   */
  private async requireOwnedOverlay(
    imageId: string,
    overlayId: string,
  ): Promise<{ storageKey: string; assetStorageKey: string; extension: string }> {
    const document = await this.findOne(imageId);
    this.assertObjectId(overlayId, 'OVERLAY_NOT_FOUND');

    const overlay = await this.overlayModel.findById(overlayId).exec();
    // Ownership check: an overlay from another image must never be served.
    if (!overlay || overlay.imageAssetId.toString() !== document._id.toString()) {
      throw ApplicationError.notFound('OVERLAY_NOT_FOUND', 'Overlay not found');
    }

    return {
      storageKey: overlay.storageKey,
      assetStorageKey: document.storageKey,
      extension: overlay.extension,
    };
  }

  async assertOverlayBelongsToImage(imageId: Types.ObjectId, overlayId: string): Promise<void> {
    if (!Types.ObjectId.isValid(overlayId)) {
      throw ApplicationError.badRequest('INVALID_OVERLAY_ID', 'Invalid overlay id');
    }
    const exists = await this.overlayModel
      .exists({ _id: new Types.ObjectId(overlayId), imageAssetId: imageId })
      .exec();
    if (!exists) {
      throw ApplicationError.badRequest(
        'INVALID_OVERLAY_REFERENCE',
        'Overlay does not belong to this image',
      );
    }
  }

  /* -------------------------------- deletion ------------------------------ */

  /**
   * Deletes the asset together with its layers, objects, overlays and files.
   * Refuses while processing is in flight so a background task cannot resurrect
   * a deleted record.
   */
  async remove(imageId: string): Promise<void> {
    const document = await this.findOne(imageId);
    if (document.status === 'PROCESSING' && this.processing.isScheduled(imageId)) {
      throw ApplicationError.conflict(
        'IMAGE_BUSY',
        'The image is still being processed; retry after processing finishes',
      );
    }

    const layers = await this.layerModel.find({ imageAssetId: document._id }).select('_id').exec();
    const layerIds = layers.map((layer) => layer._id);

    await this.objectModel.deleteMany({ layerId: { $in: layerIds } }).exec();
    await this.layerModel.deleteMany({ imageAssetId: document._id }).exec();
    await this.overlayModel.deleteMany({ imageAssetId: document._id }).exec();
    await this.imageModel.deleteOne({ _id: document._id }).exec();
    await this.storage.removeAssetData(document.storageKey);

    this.logger.log(`Deleted image asset ${imageId}`);
  }

  /* ------------------------------- mapping -------------------------------- */

  private assertObjectId(value: string, code = 'INVALID_IMAGE_ID'): void {
    if (!Types.ObjectId.isValid(value) || !/^[0-9a-fA-F]{24}$/.test(value)) {
      throw ApplicationError.badRequest(code, 'Invalid image id');
    }
  }

  toDto(document: ImageAssetDocument): ImageAssetDto {
    return {
      _id: document._id.toString(),
      name: document.name,
      originalFilename: document.originalFilename,
      width: document.width,
      height: document.height,
      fileSize: document.fileSize,
      mimeType: document.mimeType,
      status: document.status,
      errorMessage: document.errorMessage,
      createdAt: (document.createdAt ?? new Date()).toISOString(),
      updatedAt: (document.updatedAt ?? new Date()).toISOString(),
    };
  }

  toOverlayDto(document: OverlayAssetDocument): OverlayAssetDto {
    const imageId = document.imageAssetId.toString();
    return {
      _id: document._id.toString(),
      imageAssetId: imageId,
      mimeType: document.mimeType,
      width: document.width,
      height: document.height,
      fileSize: document.fileSize,
      url: `/api/v1/images/${imageId}/overlays/${document._id.toString()}`,
      createdAt: (document.createdAt ?? new Date()).toISOString(),
    };
  }
}
