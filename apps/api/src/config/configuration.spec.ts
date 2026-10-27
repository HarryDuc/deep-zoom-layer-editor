import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { findRepoRoot, loadConfig, resolveStorageDir } from './configuration';

describe('configuration', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('loadConfig', () => {
    it('applies documented defaults', () => {
      delete process.env.PORT;
      delete process.env.MAX_UPLOAD_SIZE_MB;
      delete process.env.DZI_TILE_SIZE;
      delete process.env.DZI_TILE_FORMAT;
      delete process.env.IMAGE_PROCESSING_CONCURRENCY;

      const config = loadConfig();

      expect(config.port).toBe(3001);
      expect(config.maxUploadSizeMb).toBe(100);
      expect(config.maxUploadSizeBytes).toBe(100 * 1024 * 1024);
      expect(config.maxImagePixels).toBe(100_000_000);
      expect(config.dziTileSize).toBe(256);
      expect(config.dziTileOverlap).toBe(1);
      expect(config.dziTileFormat).toBe('jpeg');
      expect(config.imageProcessingConcurrency).toBe(1);
      expect(config.frontendOrigin).toBe('http://localhost:3000');
    });

    it('reads overrides from the environment', () => {
      process.env.PORT = '4000';
      process.env.MAX_UPLOAD_SIZE_MB = '5';
      process.env.DZI_TILE_SIZE = '512';
      process.env.DZI_TILE_OVERLAP = '4';
      process.env.DZI_TILE_FORMAT = 'PNG';
      process.env.IMAGE_PROCESSING_CONCURRENCY = '3';
      process.env.FRONTEND_ORIGIN = 'http://localhost:4000';

      const config = loadConfig();

      expect(config).toMatchObject({
        port: 4000,
        maxUploadSizeMb: 5,
        maxUploadSizeBytes: 5 * 1024 * 1024,
        dziTileSize: 512,
        dziTileOverlap: 4,
        dziTileFormat: 'png',
        imageProcessingConcurrency: 3,
        frontendOrigin: 'http://localhost:4000',
      });
    });

    it('rejects a non-numeric port', () => {
      process.env.PORT = 'abc';
      expect(() => loadConfig()).toThrow(/PORT must be a positive integer/);
    });

    it('rejects an out-of-range tile overlap', () => {
      process.env.DZI_TILE_OVERLAP = '20';
      expect(() => loadConfig()).toThrow(/DZI_TILE_OVERLAP/);
    });

    it('rejects an unsupported tile format', () => {
      process.env.DZI_TILE_FORMAT = 'webp';
      expect(() => loadConfig()).toThrow(/DZI_TILE_FORMAT/);
    });
  });

  describe('findRepoRoot', () => {
    it('finds the nearest ancestor package.json declaring workspaces', async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'repo-root-'));
      try {
        await fs.writeFile(
          path.join(root, 'package.json'),
          JSON.stringify({ name: 'root', workspaces: ['apps/*'] }),
        );
        const nested = path.join(root, 'apps', 'api', 'src');
        await fs.mkdir(nested, { recursive: true });
        await fs.writeFile(path.join(root, 'apps', 'api', 'package.json'), JSON.stringify({}));

        expect(findRepoRoot(nested)).toBe(root);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });

    it('returns null when no workspace root exists', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'no-root-'));
      try {
        expect(findRepoRoot(dir)).toBeNull();
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('resolveStorageDir', () => {
    it('uses absolute values verbatim', () => {
      const absolute = path.resolve(os.tmpdir(), 'dzi-data');
      expect(resolveStorageDir(absolute)).toBe(absolute);
    });

    it('anchors relative values to the detected repo root', async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-root-'));
      try {
        await fs.writeFile(
          path.join(root, 'package.json'),
          JSON.stringify({ name: 'root', workspaces: ['apps/*'] }),
        );
        const nested = path.join(root, 'apps', 'api');
        await fs.mkdir(nested, { recursive: true });

        expect(resolveStorageDir('data', nested)).toBe(path.join(root, 'data'));
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  });
});
