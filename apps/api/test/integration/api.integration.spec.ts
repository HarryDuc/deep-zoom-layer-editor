import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';
import sharp from 'sharp';
import { AppModule } from '../../src/app.module';
import { ImageProcessingService } from '../../src/image-processing/image-processing.service';
import { ImageAsset } from '../../src/images/schemas/image-asset.schema';
import { ImageLayer } from '../../src/layers/schemas/image-layer.schema';
import { LayerObject } from '../../src/layer-objects/schemas/layer-object.schema';
import { OverlayAsset } from '../../src/images/schemas/overlay-asset.schema';

/**
 * Full-stack integration suite: boots the real Nest application against a
 * throwaway MongoDB database and a temporary storage root, then drives the
 * documented REST flow (upload -> process -> DZI -> layers -> objects).
 *
 * Requires a reachable MongoDB. Override the host with MONGODB_TEST_URI.
 */
const MONGO_BASE = process.env.MONGODB_TEST_URI ?? 'mongodb://127.0.0.1:27017';
const DATABASE_NAME = `deep_zoom_it_${Date.now()}_${Math.floor(Math.random() * 10_000)}`;

describe('Deep Zoom API (integration)', () => {
  let app: INestApplication;
  let storageDir: string;
  let imageModel: Model<ImageAsset>;
  let layerModel: Model<ImageLayer>;
  let objectModel: Model<LayerObject>;
  let overlayModel: Model<OverlayAsset>;
  let processing: ImageProcessingService;
  let server: ReturnType<INestApplication['getHttpServer']>;

  /** A small but non-trivial source image (multi-tile at 256px). */
  async function sampleImage(
    width = 700,
    height = 420,
    format: 'jpeg' | 'png' = 'jpeg',
  ): Promise<Buffer> {
    const pipeline = sharp({
      create: { width, height, channels: 3, background: { r: 30, g: 120, b: 200 } },
    });
    return format === 'png' ? pipeline.png().toBuffer() : pipeline.jpeg({ quality: 90 }).toBuffer();
  }

  beforeAll(async () => {
    storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dzi-it-storage-'));

    process.env.MONGODB_URI = `${MONGO_BASE}/${DATABASE_NAME}`;
    process.env.APP_STORAGE_DIR = storageDir;
    process.env.IMAGE_PROCESSING_CONCURRENCY = '2';
    process.env.DZI_TILE_SIZE = '256';
    process.env.DZI_TILE_OVERLAP = '1';
    process.env.DZI_TILE_FORMAT = 'jpeg';
    process.env.MAX_UPLOAD_SIZE_MB = '20';
    process.env.MAX_IMAGE_PIXELS = '50000000';
    process.env.IMAGE_PROCESSING_TIMEOUT_MS = '120000';
    process.env.FRONTEND_ORIGIN = 'http://localhost:3000';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.enableCors({
      origin: ['http://localhost:3000'],
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Accept'],
    });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: false },
        validationError: { target: false, value: false },
      }),
    );
    await app.init();
    server = app.getHttpServer();

    imageModel = app.get<Model<ImageAsset>>(getModelToken(ImageAsset.name));
    layerModel = app.get<Model<ImageLayer>>(getModelToken(ImageLayer.name));
    objectModel = app.get<Model<LayerObject>>(getModelToken(LayerObject.name));
    overlayModel = app.get<Model<OverlayAsset>>(getModelToken(OverlayAsset.name));
    processing = app.get(ImageProcessingService);
  }, 120_000);

  afterAll(async () => {
    if (app) {
      // Drop the scratch database so repeated runs stay isolated.
      await imageModel?.db?.dropDatabase().catch(() => undefined);
      await app.close();
    }
    if (storageDir) {
      await fs.rm(storageDir, { recursive: true, force: true });
    }
  }, 120_000);

  beforeEach(async () => {
    await Promise.all([
      imageModel.deleteMany({}),
      layerModel.deleteMany({}),
      objectModel.deleteMany({}),
      overlayModel.deleteMany({}),
    ]);
    // Each test starts with an empty storage tree.
    for (const bucket of ['originals', 'dzi', 'tiles', 'overlays', 'tmp']) {
      await fs.rm(path.join(storageDir, bucket), { recursive: true, force: true });
      await fs.mkdir(path.join(storageDir, bucket), { recursive: true });
    }
  });

  /** Uploads an image and waits for DZI processing to finish. */
  async function uploadAndProcess(
    options: { width?: number; height?: number; format?: 'jpeg' | 'png' } = {},
  ): Promise<{ imageId: string; width: number; height: number }> {
    const width = options.width ?? 700;
    const height = options.height ?? 420;
    const format = options.format ?? 'jpeg';
    const buffer = await sampleImage(width, height, format);

    const response = await request(server)
      .post('/api/v1/images')
      .attach('file', buffer, `sample.${format === 'png' ? 'png' : 'jpg'}`)
      .expect(201);

    const imageId = response.body.data._id as string;
    await processing.onIdle();
    return { imageId, width, height };
  }

  async function createLayer(imageId: string, name = 'Lớp 1'): Promise<string> {
    const response = await request(server)
      .post(`/api/v1/images/${imageId}/layers`)
      .send({ name })
      .expect(201);
    return response.body.data._id as string;
  }

  /* ------------------------------- health -------------------------------- */

  it('reports health', async () => {
    const response = await request(server).get('/api/v1/health').expect(200);
    expect(response.body.data).toMatchObject({ status: 'ok', database: 'connected' });
  });

  /* ------------------------------- upload -------------------------------- */

  it('accepts an upload, returns immediately and completes processing', async () => {
    const buffer = await sampleImage(700, 420);

    const upload = await request(server)
      .post('/api/v1/images')
      .attach('file', buffer, 'hinh-anh.jpg')
      .expect(201);

    expect(upload.body.data).toMatchObject({
      originalFilename: 'hinh-anh.jpg',
      status: 'PROCESSING',
      mimeType: 'image/jpeg',
    });
    const imageId = upload.body.data._id as string;
    expect(Types.ObjectId.isValid(imageId)).toBe(true);

    await processing.onIdle();

    const status = await request(server).get(`/api/v1/images/${imageId}/status`).expect(200);
    expect(status.body.data).toMatchObject({ status: 'COMPLETED', width: 700, height: 420 });

    // The DZI artifacts really exist on disk.
    const assets = await imageModel.findById(imageId).exec();
    expect(assets?.dziPath).toBeTruthy();
    const descriptorPath = path.join(storageDir, assets!.dziPath!);
    await expect(fs.stat(descriptorPath)).resolves.toBeTruthy();
    // The extension comes from the descriptor, because that is what a client
    // uses to build the tile URL.
    const format = (await fs.readFile(descriptorPath, 'utf8')).match(/Format="([^"]+)"/)?.[1];
    expect(format).toBeTruthy();
    await expect(
      fs.stat(
        path.join(storageDir, 'dzi', `${assets!.storageKey}_files`, '0', `0_0.${format}`),
      ),
    ).resolves.toBeTruthy();
  });

  it('rejects a non-image upload with a structured error', async () => {
    const response = await request(server)
      .post('/api/v1/images')
      .attach('file', Buffer.from('not an image'), 'notes.jpg')
      .expect(400);

    expect(response.body).toMatchObject({ statusCode: 400 });
    expect(response.body.code).toBeTruthy();
    expect(response.body.path).toBe('/api/v1/images');
    // No internals leak into the response.
    expect(JSON.stringify(response.body)).not.toContain(storageDir);
  });

  it('rejects a request without a file', async () => {
    const response = await request(server).post('/api/v1/images').expect(400);
    expect(response.body.code).toBe('FILE_REQUIRED');
  });

  it('rejects a GIF disguised with a .png extension', async () => {
    const gif = Buffer.from(
      'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
      'base64',
    );
    const response = await request(server)
      .post('/api/v1/images')
      .attach('file', gif, 'fake.png')
      .expect(400);
    expect(response.body.code).toBeTruthy();
  });

  it('lists images with pagination metadata', async () => {
    await uploadAndProcess({ width: 300, height: 200 });
    await uploadAndProcess({ width: 320, height: 220 });

    const response = await request(server)
      .get('/api/v1/images')
      .query({ page: 1, limit: 1 })
      .expect(200);

    expect(response.body.data).toHaveLength(1);
    expect(response.body.meta).toMatchObject({ page: 1, limit: 1, total: 2, totalPages: 2 });
  });

  it('rejects a malformed image id with 400', async () => {
    const response = await request(server).get('/api/v1/images/not-an-id').expect(400);
    expect(response.body.code).toBe('INVALID_IMAGE_ID');
  });

  it('returns 404 for an unknown image id', async () => {
    const response = await request(server)
      .get(`/api/v1/images/${new Types.ObjectId().toString()}`)
      .expect(404);
    expect(response.body.code).toBe('IMAGE_NOT_FOUND');
  });

  /**
   * Reads the tile extension from the served descriptor.
   *
   * OpenSeadragon builds every tile URL from the descriptor's `Format`
   * attribute verbatim, so the extension is part of the public contract
   * rather than an implementation detail. Reading it back from the API keeps
   * the tests honest about what a real client would request.
   */
  async function tileExtension(imageId: string): Promise<string> {
    const response = await request(server).get(`/api/v1/images/${imageId}/dzi`).expect(200);
    const format = response.text.match(/Format="([^"]+)"/)?.[1];
    if (!format) throw new Error('The descriptor has no Format attribute');
    return format;
  }

  /* --------------------------- DZI + tiles ------------------------------- */

  describe('DZI serving', () => {
    it('serves a descriptor whose Url points back at the tile endpoint', async () => {
      const { imageId } = await uploadAndProcess();

      const response = await request(server).get(`/api/v1/images/${imageId}/dzi`).expect(200);

      expect(response.headers['content-type']).toContain('application/xml');
      // The descriptor exposes an absolute tile URL so the browser requests
      // tiles from the API origin, not from the web app that served the page.
      expect(response.text).toContain(`Url="http://127.0.0.1`);
      expect(response.text).toContain(`/api/v1/images/${imageId}/tiles/"`);
      expect(response.text).toContain('TileSize="256"');
      expect(response.text).toContain('Overlap="1"');
      // The internal filesystem layout must never be exposed.
      expect(response.text).not.toContain(storageDir);
      expect(response.text).not.toContain('_files');
    });

    it('serves tiles referenced by the descriptor with immutable caching', async () => {
      const { imageId } = await uploadAndProcess();
      const extension = await tileExtension(imageId);

      const tile = await request(server)
        .get(`/api/v1/images/${imageId}/tiles/0/0_0.${extension}`)
        .expect(200);

      expect(tile.headers['content-type']).toBe('image/jpeg');
      expect(tile.headers['cache-control']).toContain('immutable');
      expect(tile.headers['x-content-type-options']).toBe('nosniff');
      expect(Number(tile.headers['content-length'])).toBeGreaterThan(0);
      expect(tile.body.length).toBeGreaterThan(0);
    });

    it('serves tiles at an intermediate zoom level', async () => {
      const { imageId } = await uploadAndProcess({ width: 1200, height: 900 });
      const extension = await tileExtension(imageId);
      // Level 10 of a 1200x900 image is roughly 586x440 -> 3x2 tiles.
      const tile = await request(server)
        .get(`/api/v1/images/${imageId}/tiles/10/1_0.${extension}`)
        .expect(200);
      expect(tile.headers['content-type']).toBe('image/jpeg');
    });

    it('rejects a non-tile path with 400', async () => {
      const { imageId } = await uploadAndProcess();
      const response = await request(server)
        .get(`/api/v1/images/${imageId}/tiles/0/evil.txt`)
        .expect(400);
      expect(response.body.code).toBe('INVALID_TILE_PATH');
    });

    it('rejects a traversal attempt in the tile path', async () => {
      const { imageId } = await uploadAndProcess();
      const response = await request(server).get(
        `/api/v1/images/${imageId}/tiles/0/${encodeURIComponent('../../originals/x')}.jpg`,
      );
      expect([400, 404]).toContain(response.status);
      expect(JSON.stringify(response.body)).not.toContain(storageDir);
    });

    it('rejects a level above the supported cap', async () => {
      const { imageId } = await uploadAndProcess();
      const response = await request(server)
        .get(`/api/v1/images/${imageId}/tiles/99/0_0.jpg`)
        .expect(400);
      expect(response.body.code).toBe('INVALID_TILE_PATH');
    });

    it('returns 404 for a valid but absent tile', async () => {
      const { imageId } = await uploadAndProcess();
      const extension = await tileExtension(imageId);
      const response = await request(server)
        .get(`/api/v1/images/${imageId}/tiles/0/7_7.${extension}`)
        .expect(404);
      expect(response.body.code).toBe('TILE_NOT_FOUND');
    });

    it('refuses the descriptor while the image is still processing', async () => {
      const created = await imageModel.create({
        name: 'pending',
        originalFilename: 'pending.jpg',
        originalPath: 'originals/pending.jpg',
        storageKey: 'pendingkey',
        fileSize: 100,
        mimeType: 'image/jpeg',
        status: 'PROCESSING',
      });

      const response = await request(server)
        .get(`/api/v1/images/${created._id.toString()}/dzi`)
        .expect(409);
      expect(response.body.code).toBe('IMAGE_NOT_READY');
    });

    it('reports a failed image instead of serving a descriptor', async () => {
      const created = await imageModel.create({
        name: 'failed',
        originalFilename: 'failed.jpg',
        originalPath: 'originals/failed.jpg',
        storageKey: 'failedkey',
        fileSize: 100,
        mimeType: 'image/jpeg',
        status: 'FAILED',
        errorMessage: 'Unsupported image format "gif"',
      });

      const response = await request(server)
        .get(`/api/v1/images/${created._id.toString()}/dzi`)
        .expect(409);
      expect(response.body.code).toBe('IMAGE_PROCESSING_FAILED');
    });
  });

  /* ---------------------------- processing ------------------------------- */

  describe('processing lifecycle', () => {
    it('marks a broken original FAILED and cleans up the pyramid', async () => {
      const created = await imageModel.create({
        name: 'broken',
        originalFilename: 'broken.jpg',
        originalPath: 'originals/broken.jpg',
        storageKey: 'brokenkey',
        fileSize: 10,
        mimeType: 'image/jpeg',
        status: 'PROCESSING',
      });
      await fs.writeFile(path.join(storageDir, 'originals', 'broken.jpg'), 'garbage');

      await processing.process(created._id.toString());

      const reloaded = await imageModel.findById(created._id).exec();
      expect(reloaded?.status).toBe('FAILED');
      expect(reloaded?.errorMessage).toBeTruthy();

      const leftovers = await fs.readdir(path.join(storageDir, 'dzi')).catch(() => []);
      expect(leftovers).toEqual([]);
    });

    it('fails an asset whose original file is missing', async () => {
      const created = await imageModel.create({
        name: 'missing-file',
        originalFilename: 'missing.jpg',
        originalPath: 'originals/missing.jpg',
        storageKey: 'missingkey',
        fileSize: 10,
        mimeType: 'image/jpeg',
        status: 'PROCESSING',
      });

      await processing.process(created._id.toString());

      const reloaded = await imageModel.findById(created._id).exec();
      expect(reloaded?.status).toBe('FAILED');
      expect(reloaded?.errorMessage).toMatch(/missing from storage/i);
    });

    it('skips an already completed asset', async () => {
      const { imageId } = await uploadAndProcess();
      const before = await imageModel.findById(imageId).exec();

      await processing.process(imageId);

      const after = await imageModel.findById(imageId).exec();
      expect(after?.status).toBe('COMPLETED');
      expect(after?.updatedAt?.getTime()).toBe(before?.updatedAt?.getTime());
    });

    it('fails stale PROCESSING rows on startup instead of leaving them hanging', async () => {
      await imageModel.create({
        name: 'stale',
        originalFilename: 'stale.jpg',
        originalPath: 'originals/stale.jpg',
        storageKey: 'staleKey',
        fileSize: 10,
        mimeType: 'image/jpeg',
        status: 'PROCESSING',
      });

      const modified = await processing.recoverInterruptedAssets();
      expect(modified).toBe(1);

      const reloaded = await imageModel.findOne({ storageKey: 'staleKey' }).exec();
      expect(reloaded?.status).toBe('FAILED');
      expect(reloaded?.errorMessage).toMatch(/interrupted/i);
    });

    it('does not run two jobs for the same asset', async () => {
      const { imageId } = await uploadAndProcess();
      const isScheduled = processing.isScheduled(imageId);
      expect(isScheduled).toBe(false);

      // Re-submitting a completed asset is a no-op.
      processing.scheduleProcessing(imageId);
      await processing.onIdle();
      const reloaded = await imageModel.findById(imageId).exec();
      expect(reloaded?.status).toBe('COMPLETED');
    });
  });

  /* -------------------------------- layers ------------------------------- */

  describe('layers', () => {
    it('creates, lists, updates and deletes a layer', async () => {
      const { imageId } = await uploadAndProcess();

      const created = await request(server)
        .post(`/api/v1/images/${imageId}/layers`)
        .send({ name: 'Lớp nền' })
        .expect(201);

      const layerId = created.body.data._id as string;
      expect(created.body.data).toMatchObject({
        name: 'Lớp nền',
        visible: true,
        locked: false,
        zIndex: 0,
      });

      const list = await request(server).get(`/api/v1/images/${imageId}/layers`).expect(200);
      expect(list.body.data).toHaveLength(1);

      const patched = await request(server)
        .patch(`/api/v1/layers/${layerId}`)
        .send({ name: 'Lớp phủ', locked: true, visible: false })
        .expect(200);
      expect(patched.body.data).toMatchObject({
        name: 'Lớp phủ',
        locked: true,
        visible: false,
      });

      await request(server).delete(`/api/v1/layers/${layerId}`).expect(204);
      const empty = await request(server).get(`/api/v1/images/${imageId}/layers`).expect(200);
      expect(empty.body.data).toHaveLength(0);
    });

    it('appends new layers on top of the stack', async () => {
      const { imageId } = await uploadAndProcess();
      const first = await createLayer(imageId, 'A');
      const second = await createLayer(imageId, 'B');

      const list = await request(server).get(`/api/v1/images/${imageId}/layers`).expect(200);
      const byId = new Map(
        (list.body.data as Array<{ _id: string; zIndex: number }>).map((layer) => [
          layer._id,
          layer.zIndex,
        ]),
      );
      expect(byId.get(second)).toBeGreaterThan(byId.get(first)!);
    });

    it('rejects a layer for an unknown image', async () => {
      const response = await request(server)
        .post(`/api/v1/images/${new Types.ObjectId().toString()}/layers`)
        .send({ name: 'x' })
        .expect(404);
      expect(response.body.code).toBe('IMAGE_NOT_FOUND');
    });

    it('rejects an empty layer name', async () => {
      const { imageId } = await uploadAndProcess();
      await request(server)
        .post(`/api/v1/images/${imageId}/layers`)
        .send({ name: '' })
        .expect(400);
    });

    it('rejects unknown body fields', async () => {
      const { imageId } = await uploadAndProcess();
      await request(server)
        .post(`/api/v1/images/${imageId}/layers`)
        .send({ name: 'ok', sneaky: true })
        .expect(400);
    });

    it('rejects an empty PATCH body', async () => {
      const { imageId } = await uploadAndProcess();
      const layerId = await createLayer(imageId);
      const response = await request(server)
        .patch(`/api/v1/layers/${layerId}`)
        .send({})
        .expect(400);
      expect(response.body.code).toBe('EMPTY_UPDATE');
    });

    it('cascades object deletion when a layer is removed', async () => {
      const { imageId } = await uploadAndProcess();
      const layerId = await createLayer(imageId);

      await request(server)
        .post(`/api/v1/layers/${layerId}/objects`)
        .send({
          type: 'RECTANGLE',
          geometry: { x: 10, y: 10, width: 100, height: 50 },
        })
        .expect(201);

      await request(server).delete(`/api/v1/layers/${layerId}`).expect(204);
      await expect(objectModel.countDocuments({ layerId }).exec()).resolves.toBe(0);
    });
  });

  /* ----------------------------- layer objects --------------------------- */

  describe('layer objects', () => {
    it('persists a polygon in original-image pixel coordinates', async () => {
      const { imageId } = await uploadAndProcess();
      const layerId = await createLayer(imageId);

      const geometry = {
        points: [
          { x: 120.5, y: 80.25 },
          { x: 480, y: 90 },
          { x: 500, y: 300 },
          { x: 140, y: 280 },
        ],
      };

      const created = await request(server)
        .post(`/api/v1/layers/${layerId}/objects`)
        .send({ type: 'POLYGON', geometry })
        .expect(201);

      expect(created.body.data).toMatchObject({ type: 'POLYGON', visible: true });
      expect(created.body.data.geometry).toEqual(geometry);
      // Server-side defaults are applied when the client omits style.
      expect(created.body.data.style).toMatchObject({
        fillOpacity: expect.any(Number),
        strokeWidth: expect.any(Number),
      });

      const objectId = created.body.data._id as string;

      // Re-read: geometry survives the round-trip byte-for-byte.
      const list = await request(server).get(`/api/v1/layers/${layerId}/objects`).expect(200);
      expect(list.body.data).toHaveLength(1);
      expect(list.body.data[0].geometry).toEqual(geometry);
      expect(list.body.data[0]._id).toBe(objectId);
    });

    it('supports every object type', async () => {
      const { imageId } = await uploadAndProcess();
      const layerId = await createLayer(imageId);

      const overlay = await request(server)
        .post(`/api/v1/images/${imageId}/overlays`)
        .attach('file', await sharp({
          create: { width: 40, height: 40, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } },
        }).png().toBuffer(), 'pin.png')
        .expect(201);

      const overlayId = overlay.body.data._id as string;

      const payloads = [
        {
          type: 'RECTANGLE',
          geometry: { x: 10, y: 20, width: 100, height: 60 },
        },
        { type: 'POINT', geometry: { x: 250, y: 150 } },
        { type: 'LABEL', geometry: { x: 300, y: 200 }, metadata: { text: 'Lô đất số 7' } },
        {
          type: 'IMAGE',
          geometry: { x: 40, y: 40, width: 80, height: 80, overlayId },
        },
      ];

      for (const payload of payloads) {
        const response = await request(server)
          .post(`/api/v1/layers/${layerId}/objects`)
          .send(payload)
          .expect(201);
        expect(response.body.data.type).toBe(payload.type);
      }

      const list = await request(server).get(`/api/v1/layers/${layerId}/objects`).expect(200);
      expect(list.body.data).toHaveLength(payloads.length);
    });

    it('requires non-empty text metadata for a LABEL', async () => {
      const { imageId } = await uploadAndProcess();
      const layerId = await createLayer(imageId);

      const response = await request(server)
        .post(`/api/v1/layers/${layerId}/objects`)
        .send({ type: 'LABEL', geometry: { x: 10, y: 10 }, metadata: { text: '  ' } })
        .expect(400);
      expect(response.body.code).toBe('INVALID_METADATA');
    });

    it('accepts Vietnamese label text', async () => {
      const { imageId } = await uploadAndProcess();
      const layerId = await createLayer(imageId);
      const text = 'Khu đất phía Đông — 120 m²';

      const created = await request(server)
        .post(`/api/v1/layers/${layerId}/objects`)
        .send({ type: 'LABEL', geometry: { x: 10, y: 10 }, metadata: { text } })
        .expect(201);

      expect(created.body.data.metadata.text).toBe(text);
    });

    it('rejects geometry outside the image bounds', async () => {
      const { imageId } = await uploadAndProcess({ width: 400, height: 300 });
      const layerId = await createLayer(imageId);

      const response = await request(server)
        .post(`/api/v1/layers/${layerId}/objects`)
        .send({ type: 'RECTANGLE', geometry: { x: 10, y: 10, width: 900, height: 50 } })
        .expect(400);
      expect(response.body.code).toBe('INVALID_GEOMETRY');
    });

    it('rejects a degenerate polygon', async () => {
      const { imageId } = await uploadAndProcess();
      const layerId = await createLayer(imageId);

      const response = await request(server)
        .post(`/api/v1/layers/${layerId}/objects`)
        .send({
          type: 'POLYGON',
          geometry: {
            points: [
              { x: 1, y: 1 },
              { x: 2, y: 2 },
            ],
          },
        })
        .expect(400);
      expect(response.body.code).toBe('INVALID_GEOMETRY');
    });

    it('rejects an overlay owned by a different image', async () => {
      const first = await uploadAndProcess();
      const second = await uploadAndProcess();
      const layerOfSecond = await createLayer(second.imageId);

      const overlay = await request(server)
        .post(`/api/v1/images/${first.imageId}/overlays`)
        .attach('file', await sharp({
          create: { width: 10, height: 10, channels: 4, background: { r: 0, g: 255, b: 0, alpha: 1 } },
        }).png().toBuffer(), 'mark.png')
        .expect(201);

      const response = await request(server)
        .post(`/api/v1/layers/${layerOfSecond}/objects`)
        .send({
          type: 'IMAGE',
          geometry: {
            x: 5,
            y: 5,
            width: 20,
            height: 20,
            overlayId: overlay.body.data._id,
          },
        })
        .expect(400);
      expect(response.body.code).toBe('INVALID_OVERLAY_REFERENCE');
    });

    it('updates geometry and style, then deletes the object', async () => {
      const { imageId } = await uploadAndProcess();
      const layerId = await createLayer(imageId);

      const created = await request(server)
        .post(`/api/v1/layers/${layerId}/objects`)
        .send({ type: 'POINT', geometry: { x: 50, y: 60 } })
        .expect(201);
      const objectId = created.body.data._id as string;

      const patched = await request(server)
        .patch(`/api/v1/layer-objects/${objectId}`)
        .send({
          geometry: { x: 120, y: 140 },
          style: { fill: '#ff0000', radius: 12 },
          metadata: { name: 'Mốc 1' },
          visible: false,
          zIndex: 7,
        })
        .expect(200);

      expect(patched.body.data).toMatchObject({
        geometry: { x: 120, y: 140 },
        style: { fill: '#ff0000', radius: 12 },
        metadata: { name: 'Mốc 1' },
        visible: false,
        zIndex: 7,
      });

      await request(server).delete(`/api/v1/layer-objects/${objectId}`).expect(204);
      const list = await request(server).get(`/api/v1/layers/${layerId}/objects`).expect(200);
      expect(list.body.data).toHaveLength(0);
    });

    it('clamps out-of-range style values instead of storing them raw', async () => {
      const { imageId } = await uploadAndProcess();
      const layerId = await createLayer(imageId);

      const created = await request(server)
        .post(`/api/v1/layers/${layerId}/objects`)
        .send({
          type: 'POLYGON',
          geometry: {
            points: [
              { x: 1, y: 1 },
              { x: 10, y: 1 },
              { x: 10, y: 10 },
            ],
          },
          style: { fillOpacity: 5, strokeWidth: -3, fill: 'not-a-color' },
        })
        .expect(201);

      expect(created.body.data.style.fillOpacity).toBe(1);
      expect(created.body.data.style.strokeWidth).toBe(0);
      expect(created.body.data.style.fill).toMatch(/^#/);
    });

    it('reorders objects within a layer', async () => {
      const { imageId } = await uploadAndProcess();
      const layerId = await createLayer(imageId);

      const ids: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        const created = await request(server)
          .post(`/api/v1/layers/${layerId}/objects`)
          .send({ type: 'POINT', geometry: { x: 10 + index, y: 10 } })
          .expect(201);
        ids.push(created.body.data._id as string);
      }

      const reversed = [...ids].reverse();
      const response = await request(server)
        .patch(`/api/v1/layers/${layerId}/objects/order`)
        .send({ orderedObjectIds: reversed })
        .expect(200);

      expect((response.body.data as Array<{ _id: string }>).map((object) => object._id)).toEqual(
        reversed,
      );
    });

    it('rejects reordering objects that belong to another layer', async () => {
      const { imageId } = await uploadAndProcess();
      const layerA = await createLayer(imageId, 'A');
      const layerB = await createLayer(imageId, 'B');

      const created = await request(server)
        .post(`/api/v1/layers/${layerA}/objects`)
        .send({ type: 'POINT', geometry: { x: 10, y: 10 } })
        .expect(201);

      const response = await request(server)
        .patch(`/api/v1/layers/${layerB}/objects/order`)
        .send({ orderedObjectIds: [created.body.data._id] })
        .expect(400);
      expect(response.body.code).toBe('OBJECT_LAYER_MISMATCH');
    });

    it('rejects duplicate ids in a reorder request', async () => {
      const { imageId } = await uploadAndProcess();
      const layerId = await createLayer(imageId);
      const created = await request(server)
        .post(`/api/v1/layers/${layerId}/objects`)
        .send({ type: 'POINT', geometry: { x: 10, y: 10 } })
        .expect(201);

      const id = created.body.data._id as string;
      const response = await request(server)
        .patch(`/api/v1/layers/${layerId}/objects/order`)
        .send({ orderedObjectIds: [id, id] })
        .expect(400);
      expect(response.body.code).toBe('DUPLICATE_OBJECT_IDS');
    });

    it('returns 404 for objects that were never created', async () => {
      const response = await request(server)
        .patch(`/api/v1/layer-objects/${new Types.ObjectId().toString()}`)
        .send({ visible: false })
        .expect(404);
      expect(response.body.code).toBe('OBJECT_NOT_FOUND');
    });

    it('rejects an empty object PATCH', async () => {
      const { imageId } = await uploadAndProcess();
      const layerId = await createLayer(imageId);
      const created = await request(server)
        .post(`/api/v1/layers/${layerId}/objects`)
        .send({ type: 'POINT', geometry: { x: 10, y: 10 } })
        .expect(201);

      const response = await request(server)
        .patch(`/api/v1/layer-objects/${created.body.data._id}`)
        .send({})
        .expect(400);
      expect(response.body.code).toBe('EMPTY_UPDATE');
    });
  });

  /* ------------------------------- overlays ------------------------------ */

  describe('overlays', () => {
    it('uploads a PNG overlay and serves it back', async () => {
      const { imageId } = await uploadAndProcess();
      const buffer = await sharp({
        create: { width: 64, height: 32, channels: 4, background: { r: 0, g: 0, b: 255, alpha: 0.6 } },
      })
        .png()
        .toBuffer();

      const created = await request(server)
        .post(`/api/v1/images/${imageId}/overlays`)
        .attach('file', buffer, 'pin.png')
        .expect(201);

      expect(created.body.data).toMatchObject({
        mimeType: 'image/png',
        width: 64,
        height: 32,
      });
      expect(created.body.data.url).toBe(
        `/api/v1/images/${imageId}/overlays/${created.body.data._id}`,
      );

      const served = await request(server).get(created.body.data.url).expect(200);
      expect(served.headers['content-type']).toBe('image/png');
      expect(served.body.length).toBeGreaterThan(0);
    });

    it('refuses to serve an overlay through another image', async () => {
      const first = await uploadAndProcess();
      const second = await uploadAndProcess();

      const created = await request(server)
        .post(`/api/v1/images/${first.imageId}/overlays`)
        .attach('file', await sharp({
          create: { width: 8, height: 8, channels: 4, background: { r: 1, g: 1, b: 1, alpha: 1 } },
        }).png().toBuffer(), 'dot.png')
        .expect(201);

      const response = await request(server)
        .get(`/api/v1/images/${second.imageId}/overlays/${created.body.data._id}`)
        .expect(404);
      expect(response.body.code).toBe('OVERLAY_NOT_FOUND');
    });

    it('accepts a JPEG overlay and serves it as image/jpeg', async () => {
      // JPEG overlays are supported: detailed source artwork is often authored
      // as JPEG and re-encoding it to PNG added nothing but size.
      const { imageId } = await uploadAndProcess();
      const response = await request(server)
        .post(`/api/v1/images/${imageId}/overlays`)
        .attach('file', await sampleImage(16, 16), 'photo.jpg')
        .expect(201);

      const served = await request(server).get(response.body.data.url).expect(200);
      expect(served.headers['content-type']).toBe('image/jpeg');
      expect(served.body.length).toBeGreaterThan(0);
    });
  });

  /* ------------------------------- deletion ------------------------------ */

  describe('deletion', () => {
    it('removes the image, its layers, objects and files', async () => {
      const { imageId } = await uploadAndProcess();
      const layerId = await createLayer(imageId);
      await request(server)
        .post(`/api/v1/layers/${layerId}/objects`)
        .send({ type: 'POINT', geometry: { x: 5, y: 5 } })
        .expect(201);

      const asset = await imageModel.findById(imageId).exec();
      const originalFile = path.join(storageDir, asset!.originalPath);
      const dziFile = path.join(storageDir, 'dzi', `${asset!.storageKey}.dzi`);
      const tilesDir = path.join(storageDir, 'dzi', `${asset!.storageKey}_files`);
      await expect(fs.stat(originalFile)).resolves.toBeTruthy();

      await request(server).delete(`/api/v1/images/${imageId}`).expect(204);

      await expect(imageModel.findById(imageId).exec()).resolves.toBeNull();
      await expect(layerModel.countDocuments({ imageAssetId: imageId }).exec()).resolves.toBe(0);
      await expect(objectModel.countDocuments({ layerId }).exec()).resolves.toBe(0);

      await expect(fs.stat(originalFile)).rejects.toThrow();
      await expect(fs.stat(dziFile)).rejects.toThrow();
      await expect(fs.stat(tilesDir)).rejects.toThrow();
    });

    it('returns 404 when deleting twice', async () => {
      const { imageId } = await uploadAndProcess();
      await request(server).delete(`/api/v1/images/${imageId}`).expect(204);
      const response = await request(server).delete(`/api/v1/images/${imageId}`).expect(404);
      expect(response.body.code).toBe('IMAGE_NOT_FOUND');
    });
  });

  /* --------------------------------- CORS -------------------------------- */

  it('allows only the configured frontend origin', async () => {
    const allowed = await request(server)
      .get('/api/v1/health')
      .set('Origin', 'http://localhost:3000');
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:3000');

    const denied = await request(server)
      .get('/api/v1/health')
      .set('Origin', 'http://evil.example');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });
});
