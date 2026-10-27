import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import sharp from 'sharp';
import { ImagesService, UploadedFileLike } from './images.service';
import { ImageAsset, ImageAssetDocument } from './schemas/image-asset.schema';
import { OverlayAsset } from './schemas/overlay-asset.schema';
import { ImageLayer } from '../layers/schemas/image-layer.schema';
import { LayerObject } from '../layer-objects/schemas/layer-object.schema';
import { StorageService } from '../storage/storage.service';
import { ImageProcessingService } from '../image-processing/image-processing.service';
import { OverlayDziService } from '../image-processing/overlay-dzi.service';
import { APP_CONFIG, AppConfig } from '../config/configuration';
import { ApplicationError } from '../common/errors/application.error';

/**
 * Unit tests for the image asset lifecycle.
 *
 * The Mongo models are replaced with small in-memory fakes so the assertions
 * focus on the service's own rules (validation, rollback, ownership, cleanup)
 * rather than on Mongo itself — the real database is exercised by the
 * integration suite.
 */

const IMAGE_ID = new Types.ObjectId('64b000000000000000000001').toString();
const OTHER_IMAGE_ID = new Types.ObjectId('64b000000000000000000002').toString();
const OVERLAY_ID = new Types.ObjectId('64b000000000000000000003').toString();

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    nodeEnv: 'test',
    port: 3001,
    mongodbUri: 'mongodb://127.0.0.1:27017/test',
    storageDir: path.join(os.tmpdir(), 'dzi-images-spec'),
    maxUploadSizeBytes: 500 * 1024 * 1024,
    maxUploadSizeMb: 500,
    maxImagePixels: 100_000_000,
    dziTileSize: 256,
    dziTileOverlap: 1,
    dziTileFormat: 'jpeg',
    dziTileQuality: 82,
    imageProcessingConcurrency: 1,
    imageProcessingTimeoutMs: 60_000,
    frontendOrigin: 'http://localhost:3000',
    ...overrides,
  };
}

/** Minimal query-chain stub that resolves to a fixed value. */
function queryReturning<T>(value: T) {
  const chain: Record<string, unknown> = {};
  for (const method of ['sort', 'select', 'skip', 'limit']) {
    chain[method] = jest.fn(() => chain);
  }
  chain.exec = jest.fn(async () => value);
  return chain;
}

describe('ImagesService', () => {
  let root: string;
  let storage: StorageService;
  let config: AppConfig;

  let imageModel: {
    create: jest.Mock;
    findById: jest.Mock;
    deleteOne: jest.Mock;
    deleteMany: jest.Mock;
    countDocuments: jest.Mock;
    find: jest.Mock;
  };
  let overlayModel: { create: jest.Mock; findById: jest.Mock; deleteMany: jest.Mock; exists: jest.Mock };
  let layerModel: { find: jest.Mock; deleteMany: jest.Mock };
  let objectModel: { deleteMany: jest.Mock };
  let processing: { scheduleProcessing: jest.Mock; isScheduled: jest.Mock };
  let overlayDzi: { generate: jest.Mock; removeArtifacts: jest.Mock };

  let service: ImagesService;

  const makeImageDocument = (overrides: Record<string, unknown> = {}): ImageAssetDocument =>
    ({
      _id: new Types.ObjectId(IMAGE_ID),
      name: 'Test image',
      originalFilename: 'test.jpg',
      originalPath: 'originals/abc.jpg',
      storageKey: 'abc',
      width: 100,
      height: 80,
      fileSize: 1024,
      mimeType: 'image/jpeg',
      status: 'COMPLETED',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
      ...overrides,
    }) as unknown as ImageAssetDocument;

  const buildService = async (appConfig: AppConfig): Promise<ImagesService> => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        ImagesService,
        { provide: getModelToken(ImageAsset.name), useValue: imageModel },
        { provide: getModelToken(OverlayAsset.name), useValue: overlayModel },
        { provide: getModelToken(ImageLayer.name), useValue: layerModel },
        { provide: getModelToken(LayerObject.name), useValue: objectModel },
        { provide: APP_CONFIG, useValue: appConfig },
        { provide: StorageService, useValue: storage },
        { provide: ImageProcessingService, useValue: processing },
        { provide: OverlayDziService, useValue: overlayDzi },
      ],
    }).compile();

    return moduleRef.get(ImagesService);
  };

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'dzi-images-'));
    config = makeConfig({ storageDir: root });
    storage = new StorageService(config);
    await storage.onModuleInit();

    imageModel = {
      create: jest.fn(),
      findById: jest.fn(),
      // The real Mongoose model always returns a thenable; the fakes must do
      // the same because the service chains `.catch()` on the result.
      deleteOne: jest.fn().mockResolvedValue({ deletedCount: 1 }),
      deleteMany: jest.fn().mockResolvedValue({ deletedCount: 0 }),
      countDocuments: jest.fn(),
      find: jest.fn(),
    };
    overlayModel = {
      create: jest.fn(),
      findById: jest.fn(),
      deleteMany: jest.fn().mockResolvedValue({ deletedCount: 0 }),
      exists: jest.fn(),
    };
    layerModel = {
      find: jest.fn(),
      deleteMany: jest.fn().mockResolvedValue({ deletedCount: 0 }),
    };
    objectModel = { deleteMany: jest.fn().mockResolvedValue({ deletedCount: 0 }) };
    processing = { scheduleProcessing: jest.fn(), isScheduled: jest.fn() };
    overlayDzi = {
      generate: jest.fn().mockResolvedValue({ width: 16, height: 9, tileCount: 1 }),
      removeArtifacts: jest.fn().mockResolvedValue(undefined),
    };

    service = await buildService(config);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  /** Writes a real JPEG to disk and returns an upload-shaped descriptor. */
  const writeJpeg = async (
    name = 'photo.jpg',
    width = 32,
    height = 24,
  ): Promise<UploadedFileLike & { path: string }> => {
    const filePath = path.join(root, name);
    await sharp({
      create: { width, height, channels: 3, background: { r: 10, g: 120, b: 200 } },
    })
      .jpeg()
      .toFile(filePath);
    const stat = await fs.stat(filePath);
    return {
      originalname: name,
      mimetype: 'image/jpeg',
      size: stat.size,
      path: filePath,
    };
  };

  /* ------------------------------- uploads ------------------------------- */

  describe('createFromUpload', () => {
    it('rejects a missing file', async () => {
      await expect(
        service.createFromUpload(undefined as unknown as UploadedFileLike),
      ).rejects.toThrow(ApplicationError);
    });

    it('rejects a file that was not persisted to disk', async () => {
      await expect(
        service.createFromUpload({ originalname: 'a.jpg', mimetype: 'image/jpeg', size: 10 }),
      ).rejects.toMatchObject({ code: 'FILE_REQUIRED' });
    });

    it('rejects an unsupported MIME type', async () => {
      const file = await writeJpeg();
      file.mimetype = 'image/gif';

      await expect(service.createFromUpload(file)).rejects.toMatchObject({
        code: 'UNSUPPORTED_FILE_TYPE',
      });
    });

    it('rejects an empty file', async () => {
      const file = await writeJpeg();
      file.size = 0;

      await expect(service.createFromUpload(file)).rejects.toMatchObject({
        code: 'EMPTY_FILE',
      });
    });

    it('rejects a file above the configured size limit', async () => {
      const file = await writeJpeg();
      file.size = config.maxUploadSizeBytes + 1;

      await expect(service.createFromUpload(file)).rejects.toMatchObject({
        code: 'FILE_TOO_LARGE',
      });
    });

    it('rejects a disallowed extension', async () => {
      const file = await writeJpeg('photo.bmp');
      file.mimetype = 'image/bmp';

      await expect(service.createFromUpload(file)).rejects.toMatchObject({
        code: 'UNSUPPORTED_FILE_TYPE',
      });
    });

    it('rejects a file whose content is not a decodable image', async () => {
      const filePath = path.join(root, 'broken.jpg');
      await fs.writeFile(filePath, 'this is definitely not an image');

      await expect(
        service.createFromUpload({
          originalname: 'broken.jpg',
          mimetype: 'image/jpeg',
          size: 30,
          path: filePath,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_IMAGE' });
    });

    it('rejects a file whose declared MIME does not match its content', async () => {
      // A PNG file announced as JPEG: the decoder catches the lie.
      const filePath = path.join(root, 'liar.jpg');
      await sharp({
        create: { width: 8, height: 8, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } },
      })
        .png()
        .toFile(filePath);
      const stat = await fs.stat(filePath);

      await expect(
        service.createFromUpload({
          originalname: 'liar.jpg',
          mimetype: 'image/jpeg',
          size: stat.size,
          path: filePath,
        }),
      ).rejects.toMatchObject({ code: 'MIME_MISMATCH' });
    });

    it('rejects an image with more pixels than the configured budget', async () => {
      const strictService = await buildService({ ...config, maxImagePixels: 10 });

      const file = await writeJpeg('big.jpg', 64, 64);
      await expect(strictService.createFromUpload(file)).rejects.toMatchObject({
        code: 'IMAGE_TOO_LARGE',
      });
    });

    it('stores the original, creates a PROCESSING asset and schedules the job', async () => {
      const file = await writeJpeg('scan.jpg', 40, 30);
      const document = makeImageDocument({
        status: 'PROCESSING',
        name: 'scan',
        width: 40,
        height: 30,
      });
      imageModel.create.mockResolvedValue(document);

      const dto = await service.createFromUpload(file, '  My scan  ');

      expect(imageModel.create).toHaveBeenCalledTimes(1);
      const payload = imageModel.create.mock.calls[0][0];
      expect(payload.name).toBe('My scan');
      expect(payload.status).toBe('PROCESSING');
      expect(payload.width).toBe(40);
      expect(payload.height).toBe(30);
      expect(payload.mimeType).toBe('image/jpeg');

      // The original must have been moved into the managed bucket.
      const originalPath = path.join(root, 'originals', `${payload.storageKey}.jpg`);
      await expect(fs.stat(originalPath)).resolves.toBeDefined();

      expect(processing.scheduleProcessing).toHaveBeenCalledWith(document._id.toString());
      expect(dto.status).toBe('PROCESSING');
    });

    it('falls back to the filename when no display name is provided', async () => {
      const file = await writeJpeg('bản đồ vệ tinh.jpg');
      imageModel.create.mockResolvedValue(makeImageDocument());

      await service.createFromUpload(file);

      expect(imageModel.create.mock.calls[0][0].name).toBe('bản đồ vệ tinh');
    });

    it('treats a whitespace-only display name as absent', async () => {
      const file = await writeJpeg('bản đồ vệ tinh.jpg');
      imageModel.create.mockResolvedValue(makeImageDocument());

      await service.createFromUpload(file, '   ');

      expect(imageModel.create.mock.calls[0][0].name).toBe('bản đồ vệ tinh');
    });

    it('rolls back stored files when the asset cannot be created', async () => {
      const file = await writeJpeg('rollback.jpg');
      imageModel.create.mockRejectedValue(new Error('mongo is down'));

      await expect(service.createFromUpload(file)).rejects.toThrow('mongo is down');

      // No orphan original may remain in the bucket.
      const entries = await fs.readdir(path.join(root, 'originals'));
      expect(entries).toHaveLength(0);
    });

    it('deletes the asset row when the background scheduling step fails', async () => {
      const file = await writeJpeg('sched.jpg');
      const document = makeImageDocument({ status: 'PROCESSING' });
      imageModel.create.mockResolvedValue(document);
      processing.scheduleProcessing.mockImplementation(() => {
        throw new Error('queue exploded');
      });

      await expect(service.createFromUpload(file)).rejects.toThrow('queue exploded');

      expect(imageModel.deleteOne).toHaveBeenCalledWith({ _id: document._id });
      const entries = await fs.readdir(path.join(root, 'originals'));
      expect(entries).toHaveLength(0);
    });
  });

  /* -------------------------------- reads -------------------------------- */

  describe('findOne / getDto / getStatus', () => {
    it('rejects a malformed image id', async () => {
      await expect(service.findOne('not-an-id')).rejects.toMatchObject({
        code: 'INVALID_IMAGE_ID',
      });
    });

    it('throws not found for an unknown id', async () => {
      imageModel.findById.mockReturnValue(queryReturning(null));

      await expect(service.findOne(IMAGE_ID)).rejects.toMatchObject({
        code: 'IMAGE_NOT_FOUND',
      });
    });

    it('maps a document to the public DTO', async () => {
      const document = makeImageDocument();
      imageModel.findById.mockReturnValue(queryReturning(document));

      const dto = await service.getDto(IMAGE_ID);

      expect(dto).toMatchObject({
        _id: IMAGE_ID,
        name: 'Test image',
        width: 100,
        height: 80,
        status: 'COMPLETED',
        mimeType: 'image/jpeg',
      });
    });

    it('returns the processing status including the failure reason', async () => {
      const document = makeImageDocument({ status: 'FAILED', errorMessage: 'boom' });
      imageModel.findById.mockReturnValue(queryReturning(document));

      const status = await service.getStatus(IMAGE_ID);

      expect(status).toMatchObject({
        imageId: IMAGE_ID,
        status: 'FAILED',
        errorMessage: 'boom',
      });
    });
  });

  describe('list', () => {
    it('returns an empty page with zero total pages', async () => {
      imageModel.find.mockReturnValue(queryReturning([]));
      imageModel.countDocuments.mockReturnValue(queryReturning(0));

      const result = await service.list(1, 12);

      expect(result.items).toEqual([]);
      expect(result.meta).toEqual({ page: 1, limit: 12, total: 0, totalPages: 0 });
    });

    it('computes the total page count', async () => {
      imageModel.find.mockReturnValue(queryReturning([makeImageDocument()]));
      imageModel.countDocuments.mockReturnValue(queryReturning(25));

      const result = await service.list(2, 12);

      expect(result.meta.totalPages).toBe(3);
      expect(result.meta.total).toBe(25);
    });
  });

  /* ---------------------------- DZI serving ----------------------------- */

  describe('getDziDescriptor', () => {
    it('refuses to serve while the image is still processing', async () => {
      imageModel.findById.mockReturnValue(queryReturning(makeImageDocument({ status: 'PROCESSING' })));

      await expect(
        service.getDziDescriptor(IMAGE_ID, 'http://localhost:3001'),
      ).rejects.toMatchObject({ code: 'IMAGE_NOT_READY' });
    });

    it('surfaces the stored failure reason', async () => {
      imageModel.findById.mockReturnValue(
        queryReturning(makeImageDocument({ status: 'FAILED', errorMessage: 'broken file' })),
      );

      await expect(
        service.getDziDescriptor(IMAGE_ID, 'http://localhost:3001'),
      ).rejects.toMatchObject({ code: 'IMAGE_PROCESSING_FAILED', message: 'broken file' });
    });

    it('absolutizes the tile URL against the request origin', async () => {
      imageModel.findById.mockReturnValue(queryReturning(makeImageDocument()));
      await storage.writeDziDescriptor(
        'abc',
        '<?xml version="1.0" encoding="UTF-8"?><Image TileSize="256" Url="/api/v1/images/x/tiles"/>',
      );

      const { xml, etag } = await service.getDziDescriptor(IMAGE_ID, 'http://192.168.1.5:3001');

      expect(xml).toContain('http://192.168.1.5:3001/api/v1/images/x/tiles');
      expect(etag).toContain('dzi-abc-');
    });
  });

  describe('resolveTileFile', () => {
    it('rejects an invalid tile path', async () => {
      imageModel.findById.mockReturnValue(queryReturning(makeImageDocument()));

      await expect(service.resolveTileFile(IMAGE_ID, '../../etc/passwd')).rejects.toMatchObject({
        code: 'INVALID_TILE_PATH',
      });
    });

    it('reports a missing tile as not found', async () => {
      imageModel.findById.mockReturnValue(queryReturning(makeImageDocument()));

      await expect(service.resolveTileFile(IMAGE_ID, '3/0_0.jpg')).rejects.toMatchObject({
        code: 'TILE_NOT_FOUND',
      });
    });

    it('returns the absolute path and size of an existing tile', async () => {
      imageModel.findById.mockReturnValue(queryReturning(makeImageDocument()));
      const tileDir = storage.dziTileDir('abc', 3);
      await fs.mkdir(tileDir, { recursive: true });
      await fs.writeFile(path.join(tileDir, '0_0.jpg'), 'tile-bytes');

      const resolved = await service.resolveTileFile(IMAGE_ID, '3/0_0.jpg');

      expect(resolved.contentType).toBe('image/jpeg');
      expect(resolved.size).toBe('tile-bytes'.length);
    });
  });

  /* ------------------------------- overlays ------------------------------ */

  describe('createOverlay', () => {
    beforeEach(() => {
      imageModel.findById.mockReturnValue(queryReturning(makeImageDocument()));
    });

    it('rejects a missing file', async () => {
      await expect(
        service.createOverlay(IMAGE_ID, {
          originalname: 'a.png',
          mimetype: 'image/png',
          size: 10,
        }),
      ).rejects.toMatchObject({ code: 'FILE_REQUIRED' });
    });

    it('rejects an unsupported overlay MIME type', async () => {
      const file = await writeJpeg('o.png');
      file.mimetype = 'image/gif';

      await expect(service.createOverlay(IMAGE_ID, file)).rejects.toMatchObject({
        code: 'UNSUPPORTED_FILE_TYPE',
      });
    });

    it('rejects an overlay above the size limit', async () => {
      const file = await writeJpeg('o.png');
      file.size = config.maxUploadSizeBytes + 1;

      await expect(service.createOverlay(IMAGE_ID, file)).rejects.toMatchObject({
        code: 'FILE_TOO_LARGE',
      });
    });

    it('rejects an unreadable overlay', async () => {
      const filePath = path.join(root, 'broken.png');
      await fs.writeFile(filePath, 'nope');

      await expect(
        service.createOverlay(IMAGE_ID, {
          originalname: 'broken.png',
          mimetype: 'image/png',
          size: 4,
          path: filePath,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_IMAGE' });
    });

    it('accepts a PNG overlay and stores it next to the asset', async () => {
      const filePath = path.join(root, 'overlay.png');
      await sharp({
        create: { width: 16, height: 9, channels: 4, background: { r: 9, g: 9, b: 9, alpha: 1 } },
      })
        .png()
        .toFile(filePath);
      const stat = await fs.stat(filePath);

      overlayModel.create.mockImplementation(async (payload: Record<string, unknown>) => ({
        _id: new Types.ObjectId(OVERLAY_ID),
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        ...payload,
      }));

      const dto = await service.createOverlay(IMAGE_ID, {
        originalname: 'overlay.png',
        mimetype: 'image/png',
        size: stat.size,
        path: filePath,
      });

      expect(dto.mimeType).toBe('image/png');
      expect(dto.width).toBe(16);
      expect(dto.height).toBe(9);
      expect(dto.url).toBe(`/api/v1/images/${IMAGE_ID}/overlays/${OVERLAY_ID}`);

      const payload = overlayModel.create.mock.calls[0][0];
      await expect(
        fs.stat(path.join(root, 'overlays', 'abc', `${payload.storageKey}.png`)),
      ).resolves.toBeDefined();
    });

    it('accepts a JPEG overlay', async () => {
      const file = await writeJpeg('photo.jpg', 20, 10);
      overlayModel.create.mockImplementation(async (payload: Record<string, unknown>) => ({
        _id: new Types.ObjectId(OVERLAY_ID),
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        ...payload,
      }));

      const dto = await service.createOverlay(IMAGE_ID, file);

      expect(dto.mimeType).toBe('image/jpeg');
      expect(overlayModel.create.mock.calls[0][0].extension).toBe('jpg');
    });

    it('accepts a WebP overlay', async () => {
      const filePath = path.join(root, 'overlay.webp');
      await sharp({
        create: { width: 12, height: 6, channels: 4, background: { r: 4, g: 5, b: 6, alpha: 1 } },
      })
        .webp()
        .toFile(filePath);
      const stat = await fs.stat(filePath);

      overlayModel.create.mockImplementation(async (payload: Record<string, unknown>) => ({
        _id: new Types.ObjectId(OVERLAY_ID),
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        ...payload,
      }));

      const dto = await service.createOverlay(IMAGE_ID, {
        originalname: 'overlay.webp',
        mimetype: 'image/webp',
        size: stat.size,
        path: filePath,
      });

      expect(dto.mimeType).toBe('image/webp');
    });

    it('cleans up the temporary file when validation fails', async () => {
      const filePath = path.join(root, 'bad.png');
      await fs.writeFile(filePath, 'not an image');

      await expect(
        service.createOverlay(IMAGE_ID, {
          originalname: 'bad.png',
          mimetype: 'image/png',
          size: 11,
          path: filePath,
        }),
      ).rejects.toThrow();

      await expect(fs.stat(filePath)).rejects.toThrow();
    });
  });

  describe('getOverlayFile', () => {
    it('rejects a malformed overlay id', async () => {
      imageModel.findById.mockReturnValue(queryReturning(makeImageDocument()));

      await expect(service.getOverlayFile(IMAGE_ID, 'nope')).rejects.toMatchObject({
        code: 'OVERLAY_NOT_FOUND',
      });
    });

    it('refuses to serve an overlay that belongs to another image', async () => {
      imageModel.findById.mockReturnValue(queryReturning(makeImageDocument()));
      overlayModel.findById.mockReturnValue(
        queryReturning({
          _id: new Types.ObjectId(OVERLAY_ID),
          imageAssetId: new Types.ObjectId(OTHER_IMAGE_ID),
        }),
      );

      await expect(service.getOverlayFile(IMAGE_ID, OVERLAY_ID)).rejects.toMatchObject({
        code: 'OVERLAY_NOT_FOUND',
      });
    });

    it('reports a missing overlay file as not found', async () => {
      imageModel.findById.mockReturnValue(queryReturning(makeImageDocument()));
      overlayModel.findById.mockReturnValue(
        queryReturning({
          _id: new Types.ObjectId(OVERLAY_ID),
          imageAssetId: new Types.ObjectId(IMAGE_ID),
          storageKey: 'overlaykey',
          extension: 'png',
          mimeType: 'image/png',
        }),
      );

      await expect(service.getOverlayFile(IMAGE_ID, OVERLAY_ID)).rejects.toMatchObject({
        code: 'OVERLAY_NOT_FOUND',
      });
    });

    it('returns the path, content type and size of a stored overlay', async () => {
      imageModel.findById.mockReturnValue(queryReturning(makeImageDocument()));
      overlayModel.findById.mockReturnValue(
        queryReturning({
          _id: new Types.ObjectId(OVERLAY_ID),
          imageAssetId: new Types.ObjectId(IMAGE_ID),
          storageKey: 'overlaykey',
          extension: 'png',
          mimeType: 'image/png',
        }),
      );
      await fs.mkdir(path.join(root, 'overlays', 'abc'), { recursive: true });
      await fs.writeFile(path.join(root, 'overlays', 'abc', 'overlaykey.png'), 'overlay-bytes');

      const resolved = await service.getOverlayFile(IMAGE_ID, OVERLAY_ID);

      expect(resolved.contentType).toBe('image/png');
      expect(resolved.size).toBe('overlay-bytes'.length);
    });
  });

  describe('getOverlayDziDescriptor', () => {
    const storedOverlay = (storageKey = 'overlaykey') => ({
      _id: new Types.ObjectId(OVERLAY_ID),
      imageAssetId: new Types.ObjectId(IMAGE_ID),
      storageKey,
      extension: 'png',
      mimeType: 'image/png',
    });

    it('returns the descriptor with an absolute tile URL', async () => {
      imageModel.findById.mockReturnValue(queryReturning(makeImageDocument()));
      overlayModel.findById.mockReturnValue(queryReturning(storedOverlay()));
      await fs.mkdir(path.join(root, 'overlays', 'abc'), { recursive: true });
      await fs.writeFile(
        path.join(root, 'overlays', 'abc', 'overlaykey.dzi'),
        '<?xml version="1.0"?><Image Url="/api/v1/images/x/overlays/y/tiles/" Format="png" TileSize="256" Overlap="1"><Size Width="16" Height="9"/></Image>',
      );

      const { xml, etag } = await service.getOverlayDziDescriptor(
        IMAGE_ID,
        OVERLAY_ID,
        'http://api.test',
      );

      // The stored descriptor keeps a root-relative URL so the artifacts stay
      // host-independent; the served one must be absolute for the browser.
      expect(xml).toContain('Url="http://api.test/api/v1/images/x/overlays/y/tiles/"');
      expect(etag).toContain('overlay-dzi-');
    });

    it('reports a missing pyramid as not found', async () => {
      imageModel.findById.mockReturnValue(queryReturning(makeImageDocument()));
      overlayModel.findById.mockReturnValue(queryReturning(storedOverlay()));

      await expect(
        service.getOverlayDziDescriptor(IMAGE_ID, OVERLAY_ID, 'http://api.test'),
      ).rejects.toMatchObject({ code: 'OVERLAY_DZI_NOT_FOUND' });
    });

    it('refuses a descriptor for an overlay of another image', async () => {
      imageModel.findById.mockReturnValue(queryReturning(makeImageDocument()));
      overlayModel.findById.mockReturnValue(
        queryReturning({
          _id: new Types.ObjectId(OVERLAY_ID),
          imageAssetId: new Types.ObjectId(OTHER_IMAGE_ID),
          storageKey: 'overlaykey',
          extension: 'png',
        }),
      );

      await expect(
        service.getOverlayDziDescriptor(IMAGE_ID, OVERLAY_ID, 'http://api.test'),
      ).rejects.toMatchObject({ code: 'OVERLAY_NOT_FOUND' });
    });
  });

  describe('resolveOverlayTileFile', () => {
    beforeEach(async () => {
      imageModel.findById.mockReturnValue(queryReturning(makeImageDocument()));
      overlayModel.findById.mockReturnValue(
        queryReturning({
          _id: new Types.ObjectId(OVERLAY_ID),
          imageAssetId: new Types.ObjectId(IMAGE_ID),
          storageKey: 'overlaykey',
          extension: 'png',
        }),
      );
      await fs.mkdir(path.join(root, 'overlays', 'abc', 'overlaykey_files', '3'), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(root, 'overlays', 'abc', 'overlaykey_files', '3', '1_2.png'),
        'tile-bytes',
      );
    });

    it('resolves a real tile with its content type and size', async () => {
      const resolved = await service.resolveOverlayTileFile(IMAGE_ID, OVERLAY_ID, '3/1_2.png');

      expect(resolved.contentType).toBe('image/png');
      expect(resolved.size).toBe('tile-bytes'.length);
    });

    it('reports a missing tile as not found', async () => {
      await expect(
        service.resolveOverlayTileFile(IMAGE_ID, OVERLAY_ID, '3/9_9.png'),
      ).rejects.toMatchObject({ code: 'TILE_NOT_FOUND' });
    });

    it.each([
      ['traversal', '../../package.json'],
      ['absolute', '/etc/passwd'],
      ['missing level', '1_2.png'],
      ['non-numeric level', 'x/1_2.png'],
      ['bad extension', '3/1_2.exe'],
      ['nested', '3/sub/1_2.png'],
    ])('rejects a %s path', async (_label, tilePath) => {
      await expect(
        service.resolveOverlayTileFile(IMAGE_ID, OVERLAY_ID, tilePath),
      ).rejects.toMatchObject({ code: 'INVALID_TILE_PATH' });
    });

    it('rejects an out-of-range level', async () => {
      await expect(
        service.resolveOverlayTileFile(IMAGE_ID, OVERLAY_ID, '99/0_0.png'),
      ).rejects.toMatchObject({ code: 'INVALID_TILE_PATH' });
    });
  });

  describe('assertOverlayBelongsToImage', () => {    it('rejects a malformed overlay id', async () => {
      await expect(
        service.assertOverlayBelongsToImage(new Types.ObjectId(IMAGE_ID), 'bad'),
      ).rejects.toMatchObject({ code: 'INVALID_OVERLAY_ID' });
    });

    it('rejects an overlay that belongs to another image', async () => {
      overlayModel.exists.mockReturnValue(queryReturning(null));

      await expect(
        service.assertOverlayBelongsToImage(new Types.ObjectId(IMAGE_ID), OVERLAY_ID),
      ).rejects.toMatchObject({ code: 'INVALID_OVERLAY_REFERENCE' });
    });

    it('accepts an overlay that belongs to the image', async () => {
      overlayModel.exists.mockReturnValue(queryReturning({ _id: new Types.ObjectId(OVERLAY_ID) }));

      await expect(
        service.assertOverlayBelongsToImage(new Types.ObjectId(IMAGE_ID), OVERLAY_ID),
      ).resolves.toBeUndefined();
    });
  });

  /* ------------------------------- deletion ------------------------------ */

  describe('remove', () => {
    it('refuses to delete an image that is still being processed', async () => {
      imageModel.findById.mockReturnValue(queryReturning(makeImageDocument({ status: 'PROCESSING' })));
      processing.isScheduled.mockReturnValue(true);

      await expect(service.remove(IMAGE_ID)).rejects.toMatchObject({ code: 'IMAGE_BUSY' });
    });

    it('cascades the delete to layers, objects, overlays and files', async () => {
      imageModel.findById.mockReturnValue(queryReturning(makeImageDocument()));
      processing.isScheduled.mockReturnValue(false);
      const layerIds = [new Types.ObjectId('64b000000000000000000010')];
      layerModel.find.mockReturnValue(queryReturning(layerIds.map((_id) => ({ _id }))));
      layerModel.deleteMany.mockReturnValue(queryReturning({ deletedCount: 1 }));
      objectModel.deleteMany.mockReturnValue(queryReturning({ deletedCount: 2 }));
      overlayModel.deleteMany.mockReturnValue(queryReturning({ deletedCount: 1 }));
      imageModel.deleteOne.mockReturnValue(queryReturning({ deletedCount: 1 }));

      await service.remove(IMAGE_ID);

      expect(objectModel.deleteMany).toHaveBeenCalledWith({ layerId: { $in: layerIds } });
      expect(layerModel.deleteMany).toHaveBeenCalled();
      expect(overlayModel.deleteMany).toHaveBeenCalled();
      expect(imageModel.deleteOne).toHaveBeenCalledWith({ _id: new Types.ObjectId(IMAGE_ID) });
    });
  });
});
