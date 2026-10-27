import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { AppConfig } from '../config/configuration';
import { ApplicationError } from '../common/errors/application.error';
import { StorageService } from './storage.service';

function makeConfig(storageDir: string): AppConfig {
  return {
    nodeEnv: 'test',
    port: 3001,
    mongodbUri: 'mongodb://127.0.0.1:27017/test',
    storageDir,
    maxUploadSizeBytes: 10 * 1024 * 1024,
    maxUploadSizeMb: 10,
    maxImagePixels: 10_000_000,
    dziTileSize: 256,
    dziTileOverlap: 1,
    dziTileFormat: 'jpeg',
    dziTileQuality: 80,
    imageProcessingConcurrency: 1,
    imageProcessingTimeoutMs: 60_000,
    frontendOrigin: 'http://localhost:3000',
  };
}

describe('StorageService', () => {
  let root: string;
  let storage: StorageService;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'dzi-storage-'));
    storage = new StorageService(makeConfig(root));
    await storage.onModuleInit();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('creates every managed bucket on init', async () => {
    for (const bucket of ['originals', 'dzi', 'tiles', 'overlays', 'tmp'] as const) {
      const stat = await fs.stat(storage.bucketPath(bucket));
      expect(stat.isDirectory()).toBe(true);
    }
  });

  it('generates opaque, filesystem-safe storage keys', () => {
    const key = storage.createStorageKey();
    expect(key).toMatch(/^[a-f0-9]{32}$/);
    expect(storage.createStorageKey()).not.toBe(key);
  });

  describe('resolveTile', () => {
    it('accepts a well-formed tile path for the asset', async () => {
      const resolved = storage.resolveTile('abc123', '12/3_4.jpg');
      expect(resolved).not.toBeNull();
      expect(resolved?.contentType).toBe('image/jpeg');
      expect(resolved?.absolutePath).toBe(
        path.join(root, 'dzi', 'abc123_files', '12', '3_4.jpg'),
      );
    });

    it.each([
      ['../../etc/passwd', 'parent traversal'],
      ['12/..%2f3_4.jpg', 'encoded traversal'],
      ['12/../3_4.jpg', 'relative segment'],
      ['/12/3_4.jpg', 'absolute path'],
      ['12/3_4.bmp', 'unsupported extension'],
      ['abc/3_4.jpg', 'non numeric level'],
      ['-1/3_4.jpg', 'negative level'],
      ['99/3_4.jpg', 'level above the cap'],
      ['12/3_4', 'missing extension'],
      ['12/3_4.jpg.exe', 'chained extensions'],
    ])('rejects %p (%s)', (tilePath) => {
      expect(storage.resolveTile('abc123', tilePath)).toBeNull();
    });

    it('rejects keys containing traversal characters', () => {
      expect(() => storage.resolveTile('../evil', '0/0_0.jpg')).toThrow(ApplicationError);
    });

    it('normalizes Windows separators before validating', () => {
      expect(storage.resolveTile('abc123', '12\\3_4.jpg')?.contentType).toBe('image/jpeg');
    });
  });

  describe('descriptor handling', () => {
    it('round-trips a descriptor', async () => {
      const relative = await storage.writeDziDescriptor('key1', '<Image/>');
      expect(relative).toBe(path.join('dzi', 'key1.dzi'));
      await expect(storage.readDziDescriptor('key1')).resolves.toBe('<Image/>');
    });

    it('reports a missing descriptor as 404', async () => {
      await expect(storage.readDziDescriptor('missing')).rejects.toMatchObject({
        code: 'DZI_NOT_FOUND',
      });
    });

    it('rejects invalid storage keys', async () => {
      await expect(storage.readDziDescriptor('bad/key')).rejects.toMatchObject({
        code: 'INVALID_STORAGE_KEY',
      });
    });
  });

  describe('resolveStoredRelativePath', () => {
    it('resolves a server-generated relative path inside the root', () => {
      expect(storage.resolveStoredRelativePath('originals/abc.jpg')).toBe(
        path.join(root, 'originals', 'abc.jpg'),
      );
    });

    it('refuses to escape the storage root', () => {
      expect(() => storage.resolveStoredRelativePath('../../etc/passwd')).toThrow(
        ApplicationError,
      );
    });

    it('refuses an empty path', () => {
      expect(() => storage.resolveStoredRelativePath('')).toThrow(ApplicationError);
    });
  });

  describe('overlays', () => {
    it('builds a nested per-asset overlay path', () => {
      expect(storage.overlayAbsolutePath('asset1', 'ov1', 'png')).toBe(
        path.join(root, 'overlays', 'asset1', 'ov1.png'),
      );
      expect(storage.overlayRelativePath('asset1', 'ov1', 'webp')).toBe(
        path.join('overlays', 'asset1', 'ov1.webp'),
      );
    });
  });

  describe('file primitives', () => {
    it('moves a file into a bucket and returns its relative path', async () => {
      const tempFile = path.join(root, 'tmp', 'incoming');
      await fs.writeFile(tempFile, 'payload');

      const relative = await storage.moveIntoPlace(tempFile, 'originals', 'movedkey', 'jpg');

      expect(relative).toBe(path.join('originals', 'movedkey.jpg'));
      await expect(
        fs.readFile(path.join(root, 'originals', 'movedkey.jpg'), 'utf8'),
      ).resolves.toBe('payload');
      await expect(fs.stat(tempFile)).rejects.toThrow();
    });

    it('stats a missing file as null instead of throwing', async () => {
      await expect(storage.statFile(path.join(root, 'nope.jpg'))).resolves.toBeNull();
    });

    it('enforces the read size cap for buffers', async () => {
      const target = path.join(root, 'originals', 'big.bin');
      await fs.writeFile(target, Buffer.alloc(2048));
      await expect(storage.readFileBuffer(target, 1024)).rejects.toMatchObject({
        code: 'FILE_TOO_LARGE',
      });
    });

    it('removes an asset original and pyramid but leaves other assets alone', async () => {
      await fs.mkdir(path.join(root, 'dzi', 'keep_files'), { recursive: true });
      await fs.writeFile(path.join(root, 'originals', 'drop.jpg'), 'x');
      await fs.writeFile(path.join(root, 'originals', 'keep.jpg'), 'x');
      await fs.writeFile(path.join(root, 'dzi', 'drop.dzi'), 'x');
      await fs.mkdir(path.join(root, 'dzi', 'drop_files', '0'), { recursive: true });
      await fs.writeFile(path.join(root, 'dzi', 'drop_files', '0', '0_0.jpg'), 'x');

      await storage.removeAssetData('drop');

      await expect(fs.stat(path.join(root, 'originals', 'drop.jpg'))).rejects.toThrow();
      await expect(fs.stat(path.join(root, 'dzi', 'drop.dzi'))).rejects.toThrow();
      await expect(fs.stat(path.join(root, 'dzi', 'drop_files'))).rejects.toThrow();
      // Untouched neighbour stays.
      await expect(fs.stat(path.join(root, 'originals', 'keep.jpg'))).resolves.toBeTruthy();
    });

    it('clears stale temp files', async () => {
      await fs.writeFile(path.join(root, 'tmp', 'upload-1-abc'), 'x');
      await fs.writeFile(path.join(root, 'tmp', 'upload-2-def'), 'x');

      await expect(storage.cleanTempDirectory()).resolves.toBe(2);
      await expect(fs.readdir(path.join(root, 'tmp'))).resolves.toEqual([]);
    });

    it('reports zero cleared files when the temp directory is empty', async () => {
      await expect(storage.cleanTempDirectory()).resolves.toBe(0);
    });
  });

  /* --------------------------- uncovered paths --------------------------- */

  describe('extension handling', () => {
    it('maps a MIME type to a file extension', () => {
      expect(storage.extensionForMimeType('image/png')).toBe('png');
      expect(storage.extensionForMimeType('image/jpeg')).toBe('jpg');
    });

    it('rejects an extension with unexpected characters', () => {
      expect(() => storage.originalPath('key', 'jp g')).toThrow(ApplicationError);
      expect(() => storage.originalPath('key', '')).toThrow(ApplicationError);
    });

    it('accepts an extension with or without a leading dot', () => {
      expect(storage.originalRelativePath('key', '.png')).toBe(
        path.join('originals', 'key.png'),
      );
      expect(storage.originalRelativePath('key', 'png')).toBe(
        path.join('originals', 'key.png'),
      );
    });

    it('rejects a storage key containing path separators', () => {
      expect(() => storage.originalPath('../evil', 'jpg')).toThrow(ApplicationError);
      expect(() => storage.overlayAbsolutePath('asset', '../evil', 'png')).toThrow(
        ApplicationError,
      );
    });
  });

  describe('dziTileDir', () => {
    it('builds the conventional `<key>_files/<level>` directory', () => {
      expect(storage.dziTileDir('key1', 5)).toBe(
        path.join(root, 'dzi', 'key1_files', '5'),
      );
    });

    it.each([-1, 41, 1.5, Number.NaN])('rejects the invalid level %p', (level) => {
      expect(() => storage.dziTileDir('key1', level)).toThrow(ApplicationError);
    });
  });

  describe('writeFileWithKey', () => {
    it('writes the data and returns the relative path', async () => {
      const relative = await storage.writeFileWithKey('tiles', 'key1', 'jpg', Buffer.from('data'));

      expect(relative).toBe(path.join('tiles', 'key1.jpg'));
      await expect(
        fs.readFile(path.join(root, 'tiles', 'key1.jpg'), 'utf8'),
      ).resolves.toBe('data');
    });
  });

  describe('moveFile', () => {
    it('moves a file to a nested target, creating the directory', async () => {
      const source = path.join(root, 'tmp', 'source');
      await fs.writeFile(source, 'payload');

      await storage.moveFile(source, path.join(root, 'overlays', 'asset', 'file.png'));

      await expect(
        fs.readFile(path.join(root, 'overlays', 'asset', 'file.png'), 'utf8'),
      ).resolves.toBe('payload');
      await expect(fs.stat(source)).rejects.toThrow();
    });

    it('moves a directory tree', async () => {
      const source = path.join(root, 'tmp', 'tree');
      await fs.mkdir(path.join(source, 'level'), { recursive: true });
      await fs.writeFile(path.join(source, 'level', '0_0.jpg'), 'tile');

      await storage.moveFile(source, path.join(root, 'dzi', 'key_files'));

      await expect(
        fs.readFile(path.join(root, 'dzi', 'key_files', 'level', '0_0.jpg'), 'utf8'),
      ).resolves.toBe('tile');
    });
  });

  describe('file helpers', () => {
    it('reports whether a path exists', async () => {
      const target = path.join(root, 'originals', 'here.txt');
      await fs.writeFile(target, 'x');

      await expect(storage.pathExists(target)).resolves.toBe(true);
      await expect(storage.pathExists(path.join(root, 'originals', 'nope.txt'))).resolves.toBe(
        false,
      );
    });

    it('treats a directory as a non-file', async () => {
      await expect(storage.statFile(path.join(root, 'originals'))).resolves.toBeNull();
    });

    it('reads a bounded buffer', async () => {
      const target = path.join(root, 'originals', 'small.txt');
      await fs.writeFile(target, 'hello');

      await expect(storage.readFileBuffer(target)).resolves.toEqual(Buffer.from('hello'));
    });

    it('reports a missing file when reading a buffer', async () => {
      await expect(storage.readFileBuffer(path.join(root, 'nope'))).rejects.toMatchObject({
        code: 'FILE_NOT_FOUND',
      });
    });

    it('removes a file that does not exist without throwing', async () => {
      await expect(
        storage.removeIfExists(path.join(root, 'nothing-here')),
      ).resolves.toBeUndefined();
    });

    it('unlinks a temporary file', async () => {
      const target = path.join(root, 'tmp', 'temp-file');
      await fs.writeFile(target, 'x');

      await storage.safeUnlink(target);

      await expect(fs.stat(target)).rejects.toThrow();
    });

    it('ignores an unlink of a missing file', async () => {
      await expect(
        storage.safeUnlink(path.join(root, 'tmp', 'never-existed')),
      ).resolves.toBeUndefined();
    });

    it('creates a directory on demand', async () => {
      const dir = path.join(root, 'tmp', 'nested', 'deeper');
      await storage.ensureDir(dir);

      await expect(fs.stat(dir)).resolves.toBeTruthy();
    });
  });

  describe('removeAssetData', () => {
    it('ignores an invalid storage key', async () => {
      await expect(storage.removeAssetData('../evil')).resolves.toBeUndefined();
    });

    it('removes a PNG original as well as a JPG one', async () => {
      await fs.writeFile(path.join(root, 'originals', 'drop.png'), 'x');

      await storage.removeAssetData('drop');

      await expect(fs.stat(path.join(root, 'originals', 'drop.png'))).rejects.toThrow();
    });
  });
});
