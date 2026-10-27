import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import sharp from 'sharp';
import {
  ImageProcessingService,
  INTERRUPTED_MESSAGE,
} from './image-processing.service';
import { ImageAsset, ImageAssetDocument } from '../images/schemas/image-asset.schema';
import { StorageService } from '../storage/storage.service';
import { DziGeneratorService } from './dzi-generator.service';
import { TaskManagerService } from './task-manager.service';
import { APP_CONFIG, AppConfig } from '../config/configuration';

const ASSET_ID = new Types.ObjectId('64b0000000000000000000e1').toString();

/** Minimal query-chain stub that resolves to a fixed value. */
function queryReturning<T>(value: T) {
  const chain: Record<string, unknown> = {};
  for (const method of ['sort', 'select', 'skip', 'limit']) {
    chain[method] = jest.fn(() => chain);
  }
  chain.exec = jest.fn(async () => value);
  return chain;
}

describe('ImageProcessingService', () => {
  let root: string;
  let config: AppConfig;
  let storage: StorageService;

  let imageModel: {
    updateMany: jest.Mock;
    findById: jest.Mock;
    updateOne: jest.Mock;
  };
  let dziGenerator: { generate: jest.Mock };
  let tasks: TaskManagerService;

  let service: ImageProcessingService;

  const makeAsset = (overrides: Record<string, unknown> = {}): ImageAssetDocument =>
    ({
      _id: new Types.ObjectId(ASSET_ID),
      storageKey: 'assetkey',
      originalPath: 'originals/assetkey.jpg',
      status: 'PROCESSING',
      ...overrides,
    }) as unknown as ImageAssetDocument;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'dzi-processing-'));
    config = {
      nodeEnv: 'test',
      port: 3001,
      mongodbUri: 'mongodb://127.0.0.1:27017/test',
      storageDir: root,
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
    };

    storage = new StorageService(config);
    await storage.onModuleInit();

    imageModel = {
      updateMany: jest.fn(),
      findById: jest.fn(),
      updateOne: jest.fn().mockReturnValue(queryReturning({ modifiedCount: 1 })),
    };
    dziGenerator = { generate: jest.fn() };
    tasks = new TaskManagerService(1);

    const moduleRef = await Test.createTestingModule({
      providers: [
        ImageProcessingService,
        { provide: getModelToken(ImageAsset.name), useValue: imageModel },
        { provide: APP_CONFIG, useValue: config },
        { provide: StorageService, useValue: storage },
        { provide: DziGeneratorService, useValue: dziGenerator },
        { provide: TaskManagerService, useValue: tasks },
      ],
    }).compile();

    service = moduleRef.get(ImageProcessingService);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  /* ------------------------------- recovery ------------------------------ */

  describe('recoverInterruptedAssets', () => {
    it('marks every PROCESSING asset as FAILED with an explanatory message', async () => {
      imageModel.updateMany.mockReturnValue(queryReturning({ modifiedCount: 3 }));

      const modified = await service.recoverInterruptedAssets();

      expect(modified).toBe(3);
      expect(imageModel.updateMany).toHaveBeenCalledWith(
        { status: 'PROCESSING' },
        {
          $set: {
            status: 'FAILED',
            errorMessage: INTERRUPTED_MESSAGE,
          },
        },
      );
    });

    it('reports zero when there was nothing to recover', async () => {
      imageModel.updateMany.mockReturnValue(queryReturning({ modifiedCount: 0 }));

      await expect(service.recoverInterruptedAssets()).resolves.toBe(0);
    });
  });

  describe('onModuleInit', () => {
    it('clears stale temporary uploads and recovers interrupted assets', async () => {
      const tmpDir = storage.bucketPath('tmp');
      await fs.writeFile(path.join(tmpDir, 'stale-upload.tmp'), 'leftover');
      imageModel.updateMany.mockReturnValue(queryReturning({ modifiedCount: 1 }));

      await service.onModuleInit();

      const entries = await fs.readdir(tmpDir);
      expect(entries).toHaveLength(0);
      expect(imageModel.updateMany).toHaveBeenCalled();
    });
  });

  /* ------------------------------ scheduling ----------------------------- */

  describe('scheduleProcessing', () => {
    it('runs the job in the background and reports it as scheduled', async () => {
      imageModel.findById.mockReturnValue(queryReturning(makeAsset({ status: 'COMPLETED' })));

      service.scheduleProcessing(ASSET_ID);

      expect(service.isScheduled(ASSET_ID)).toBe(true);
      await service.onIdle();
      expect(service.isScheduled(ASSET_ID)).toBe(false);
    });

    it('does not throw when the job fails', async () => {
      imageModel.findById.mockReturnValue(queryReturning(makeAsset({ status: 'COMPLETED' })));

      expect(() => service.scheduleProcessing(ASSET_ID)).not.toThrow();
      await service.onIdle();
    });
  });

  /* ------------------------------- processing ---------------------------- */

  describe('process', () => {
    it('ignores a malformed asset id', async () => {
      await service.process('not-an-id');

      expect(imageModel.findById).not.toHaveBeenCalled();
    });

    it('skips an unknown asset', async () => {
      imageModel.findById.mockReturnValue(queryReturning(null));

      await service.process(ASSET_ID);

      expect(dziGenerator.generate).not.toHaveBeenCalled();
    });

    it('skips an asset that already finished', async () => {
      imageModel.findById.mockReturnValue(queryReturning(makeAsset({ status: 'COMPLETED' })));

      await service.process(ASSET_ID);

      expect(dziGenerator.generate).not.toHaveBeenCalled();
    });

    it('fails the asset when the original file is missing', async () => {
      imageModel.findById.mockReturnValue(queryReturning(makeAsset()));

      await service.process(ASSET_ID);

      expect(imageModel.updateOne).toHaveBeenCalledWith(
        { _id: new Types.ObjectId(ASSET_ID), status: 'PROCESSING' },
        {
          $set: {
            status: 'FAILED',
            errorMessage: 'Original image file is missing from storage',
          },
        },
      );
    });

    it('fails the asset when the stored file is not a decodable image', async () => {
      const originalsDir = storage.bucketPath('originals');
      await fs.writeFile(path.join(originalsDir, 'assetkey.jpg'), 'not an image');
      imageModel.findById.mockReturnValue(queryReturning(makeAsset()));

      await service.process(ASSET_ID);

      const update = imageModel.updateOne.mock.calls[0][1];
      expect(update.$set.status).toBe('FAILED');
      expect(update.$set.errorMessage).toMatch(/unsupported image format/i);
    });

    it('fails the asset when the stored file is a readable but unsupported format', async () => {
      // WebP decodes fine, but the DZI pipeline only accepts JPEG and PNG.
      const originalsDir = storage.bucketPath('originals');
      await sharp({
        create: { width: 32, height: 32, channels: 3, background: { r: 1, g: 2, b: 3 } },
      })
        .webp()
        .toFile(path.join(originalsDir, 'assetkey.jpg'));
      imageModel.findById.mockReturnValue(queryReturning(makeAsset()));

      await service.process(ASSET_ID);

      const update = imageModel.updateOne.mock.calls[0][1];
      expect(update.$set.status).toBe('FAILED');
      expect(update.$set.errorMessage).toMatch(/Unsupported image format/);
    });

    it('fails the asset when it exceeds the pixel budget', async () => {
      const moduleRef = await Test.createTestingModule({
        providers: [
          ImageProcessingService,
          { provide: getModelToken(ImageAsset.name), useValue: imageModel },
          { provide: APP_CONFIG, useValue: { ...config, maxImagePixels: 4 } },
          { provide: StorageService, useValue: storage },
          { provide: DziGeneratorService, useValue: dziGenerator },
          { provide: TaskManagerService, useValue: tasks },
        ],
      }).compile();
      const strictService = moduleRef.get(ImageProcessingService);

      const originalsDir = storage.bucketPath('originals');
      await sharp({
        create: { width: 32, height: 32, channels: 3, background: { r: 1, g: 2, b: 3 } },
      })
        .jpeg()
        .toFile(path.join(originalsDir, 'assetkey.jpg'));
      imageModel.findById.mockReturnValue(queryReturning(makeAsset()));

      await strictService.process(ASSET_ID);

      const update = imageModel.updateOne.mock.calls[0][1];
      expect(update.$set.status).toBe('FAILED');
      expect(update.$set.errorMessage).toMatch(/maximum pixel budget/);
    });

    it('promotes the artifacts and marks the asset as COMPLETED', async () => {
      const originalsDir = storage.bucketPath('originals');
      await sharp({
        create: { width: 64, height: 48, channels: 3, background: { r: 9, g: 9, b: 9 } },
      })
        .jpeg()
        .toFile(path.join(originalsDir, 'assetkey.jpg'));

      const jobDir = path.join(root, 'tmp', 'job-assetkey');
      dziGenerator.generate.mockImplementation(async () => {
        await fs.mkdir(path.join(jobDir, 'assetkey_files', '0'), { recursive: true });
        await fs.writeFile(path.join(jobDir, 'assetkey.dzi'), '<Image TileSize="256"/>');
        await fs.writeFile(path.join(jobDir, 'assetkey_files', '0', '0_0.jpg'), 'tile');
        return {
          descriptorPath: path.join(jobDir, 'assetkey.dzi'),
          descriptor: '<Image TileSize="256"/>',
          width: 64,
          height: 48,
          levelCount: 1,
          tileCount: 1,
        };
      });

      imageModel.findById.mockReturnValue(queryReturning(makeAsset()));

      await service.process(ASSET_ID);

      expect(imageModel.updateOne).toHaveBeenCalledWith(
        { _id: new Types.ObjectId(ASSET_ID), status: 'PROCESSING' },
        {
          $set: {
            status: 'COMPLETED',
            width: 64,
            height: 48,
            dziPath: path.join('dzi', 'assetkey.dzi'),
          },
          $unset: { errorMessage: 1 },
        },
      );

      // The pyramid must be promoted out of the temp job directory.
      await expect(fs.stat(path.join(root, 'dzi', 'assetkey.dzi'))).resolves.toBeDefined();
      await expect(
        fs.stat(path.join(root, 'dzi', 'assetkey_files', '0', '0_0.jpg')),
      ).resolves.toBeDefined();
      // The job directory is cleaned up afterwards.
      await expect(fs.stat(jobDir)).rejects.toThrow();
    });

    it('removes a partially written pyramid when generation fails', async () => {
      const originalsDir = storage.bucketPath('originals');
      await sharp({
        create: { width: 32, height: 32, channels: 3, background: { r: 1, g: 1, b: 1 } },
      })
        .jpeg()
        .toFile(path.join(originalsDir, 'assetkey.jpg'));

      dziGenerator.generate.mockRejectedValue(new Error('libvips exploded'));
      imageModel.findById.mockReturnValue(queryReturning(makeAsset()));

      await service.process(ASSET_ID);

      const update = imageModel.updateOne.mock.calls[0][1];
      expect(update.$set.status).toBe('FAILED');
      expect(update.$set.errorMessage).toBe('libvips exploded');

      await expect(
        fs.stat(path.join(root, 'dzi', 'assetkey_files')),
      ).rejects.toThrow();
    });

    it('keeps only the first line of a multi-line failure message', async () => {
      const originalsDir = storage.bucketPath('originals');
      await sharp({
        create: { width: 32, height: 32, channels: 3, background: { r: 1, g: 1, b: 1 } },
      })
        .jpeg()
        .toFile(path.join(originalsDir, 'assetkey.jpg'));

      dziGenerator.generate.mockRejectedValue(new Error('first line\nsecond line'));
      imageModel.findById.mockReturnValue(queryReturning(makeAsset()));

      await service.process(ASSET_ID);

      const update = imageModel.updateOne.mock.calls[0][1];
      expect(update.$set.errorMessage).toBe('first line');
    });

    it('reports a timeout as a timeout', async () => {
      const originalsDir = storage.bucketPath('originals');
      await sharp({
        create: { width: 32, height: 32, channels: 3, background: { r: 1, g: 1, b: 1 } },
      })
        .jpeg()
        .toFile(path.join(originalsDir, 'assetkey.jpg'));

      const abortError = new Error('aborted');
      abortError.name = 'AbortError';
      dziGenerator.generate.mockRejectedValue(abortError);
      imageModel.findById.mockReturnValue(queryReturning(makeAsset()));

      await service.process(ASSET_ID);

      const update = imageModel.updateOne.mock.calls[0][1];
      expect(update.$set.errorMessage).toBe('Image processing timed out');
    });
  });
});
