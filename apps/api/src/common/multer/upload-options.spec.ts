import { BadRequestException } from '@nestjs/common';
import type { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AppConfig } from '../../config/configuration';
import {
  createFileFilter,
  createMulterOptions,
  IMAGE_UPLOAD_FILTER,
  IMAGE_UPLOAD_RULES,
  OVERLAY_UPLOAD_FILTER,
  OVERLAY_UPLOAD_RULES,
} from './upload-options';

/** Minimal `AppConfig` stub; only the fields the helpers read are provided. */
function makeConfig(storageDir: string, maxUploadSizeBytes = 500 * 1024 * 1024): AppConfig {
  return {
    nodeEnv: 'test',
    port: 3001,
    mongodbUri: 'mongodb://127.0.0.1:27017/test',
    storageDir,
    maxUploadSizeBytes,
    maxUploadSizeMb: 500,
    maxImagePixels: 100_000_000,
    dziTileSize: 256,
    dziTileOverlap: 1,
    dziTileFormat: 'jpeg',
    dziTileQuality: 82,
    imageProcessingConcurrency: 1,
    imageProcessingTimeoutMs: 300_000,
    frontendOrigin: 'http://localhost:3000',
  };
}

/** The concrete shape of a Multer `fileFilter` callback. */
type FileFilter = NonNullable<MulterOptions['fileFilter']>;

/** Invokes a Multer `fileFilter` and resolves with the callback arguments. */
function runFilter(
  filter: FileFilter | undefined,
  file: { originalname: string; mimetype: string },
): Promise<{ error: unknown; accepted: boolean }> {
  if (!filter) throw new Error('Expected a file filter to be configured');

  return new Promise((resolve) => {
    filter({}, file as never, (error, accepted) => {
      resolve({ error, accepted });
    });
  });
}

describe('upload options', () => {
  describe('createMulterOptions', () => {
    let storageDir: string;

    beforeEach(() => {
      storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dzi-upload-'));
    });

    afterEach(() => {
      fs.rmSync(storageDir, { recursive: true, force: true });
    });

    it('limits uploads to the configured size and a single file', () => {
      const options = createMulterOptions(makeConfig(storageDir, 500 * 1024 * 1024));

      expect(options.limits).toEqual({ fileSize: 500 * 1024 * 1024, files: 1 });
    });

    it('routes uploads into a `tmp` directory inside the storage root', async () => {
      const options = createMulterOptions(makeConfig(storageDir));
      const storage = options.storage as {
        getDestination: (
          req: unknown,
          file: unknown,
          cb: (err: Error | null, dir: string) => void,
        ) => void;
      };

      const destination = await new Promise<string>((resolve, reject) => {
        storage.getDestination({}, {}, (err, dir) => (err ? reject(err) : resolve(dir)));
      });

      expect(destination).toBe(path.join(storageDir, 'tmp'));
      expect(fs.existsSync(destination)).toBe(true);
    });

    it('generates a random filename that never leaks the client name', async () => {
      const options = createMulterOptions(makeConfig(storageDir));
      const storage = options.storage as {
        getFilename: (
          req: unknown,
          file: unknown,
          cb: (err: Error | null, name: string) => void,
        ) => void;
      };

      const first = await new Promise<string>((resolve, reject) => {
        storage.getFilename({}, { originalname: 'secret.png' }, (err, name) =>
          err ? reject(err) : resolve(name),
        );
      });
      const second = await new Promise<string>((resolve, reject) => {
        storage.getFilename({}, { originalname: 'secret.png' }, (err, name) =>
          err ? reject(err) : resolve(name),
        );
      });

      expect(first).not.toBe(second);
      expect(first).not.toContain('secret');
      expect(first).toMatch(/^upload-\d+-[0-9a-f]{16}$/);
    });
  });

  describe('createFileFilter', () => {
    it('accepts a file whose MIME type and extension are both allowed', async () => {
      const { error, accepted } = await runFilter(IMAGE_UPLOAD_FILTER, {
        originalname: 'photo.jpg',
        mimetype: 'image/jpeg',
      });

      expect(error).toBeNull();
      expect(accepted).toBe(true);
    });

    it('rejects a MIME type that is not allowed', async () => {
      const { error, accepted } = await runFilter(IMAGE_UPLOAD_FILTER, {
        originalname: 'photo.gif',
        mimetype: 'image/gif',
      });

      expect(accepted).toBe(false);
      expect(error).toBeInstanceOf(BadRequestException);
    });

    it('rejects an allowed MIME type with a mismatched extension', async () => {
      const { error, accepted } = await runFilter(IMAGE_UPLOAD_FILTER, {
        originalname: 'photo.png.exe',
        mimetype: 'image/jpeg',
      });

      expect(accepted).toBe(false);
      expect(error).toBeInstanceOf(BadRequestException);
    });

    it('matches the extension case-insensitively', async () => {
      const { accepted } = await runFilter(IMAGE_UPLOAD_FILTER, {
        originalname: 'PHOTO.JPG',
        mimetype: 'image/jpeg',
      });

      expect(accepted).toBe(true);
    });

    it('rejects a file without an original name', async () => {
      const { error, accepted } = await runFilter(IMAGE_UPLOAD_FILTER, {
        originalname: '',
        mimetype: 'image/jpeg',
      });

      expect(accepted).toBe(false);
      expect(error).toBeInstanceOf(BadRequestException);
    });

    it('reports the configured message in the rejection payload', async () => {
      const { error } = await runFilter(IMAGE_UPLOAD_FILTER, {
        originalname: 'photo.gif',
        mimetype: 'image/gif',
      });

      const response = (error as BadRequestException).getResponse() as {
        code: string;
        message: string;
      };
      expect(response.code).toBe('UNSUPPORTED_FILE_TYPE');
      expect(response.message).toBe(IMAGE_UPLOAD_RULES.message);
    });

    it('accepts WebP and JPEG for overlays', async () => {
      for (const file of [
        { originalname: 'a.png', mimetype: 'image/png' },
        { originalname: 'a.webp', mimetype: 'image/webp' },
        { originalname: 'a.jpg', mimetype: 'image/jpeg' },
      ]) {
        const { error, accepted } = await runFilter(OVERLAY_UPLOAD_FILTER, file);
        expect(accepted).toBe(true);
        expect(error).toBeNull();
      }
    });

    it('rejects an unsupported overlay type', async () => {
      const { error, accepted } = await runFilter(OVERLAY_UPLOAD_FILTER, {
        originalname: 'a.gif',
        mimetype: 'image/gif',
      });

      expect(accepted).toBe(false);
      expect(error).toBeInstanceOf(BadRequestException);
    });

    it('exposes the documented rule sets', () => {
      expect(IMAGE_UPLOAD_RULES.mimeTypes.has('image/jpeg')).toBe(true);
      expect(IMAGE_UPLOAD_RULES.mimeTypes.has('image/png')).toBe(true);
      expect(IMAGE_UPLOAD_RULES.mimeTypes.has('image/webp')).toBe(false);
      expect(IMAGE_UPLOAD_RULES.extensions.has('.jpg')).toBe(true);
      expect(IMAGE_UPLOAD_RULES.extensions.has('.jpeg')).toBe(true);

      expect(OVERLAY_UPLOAD_RULES.mimeTypes.has('image/webp')).toBe(true);
      expect(OVERLAY_UPLOAD_RULES.mimeTypes.has('image/jpeg')).toBe(true);
      expect(OVERLAY_UPLOAD_RULES.extensions.has('.webp')).toBe(true);
      expect(OVERLAY_UPLOAD_RULES.extensions.has('.jpeg')).toBe(true);
    });

    it('builds an independent filter for custom rules', async () => {
      const filter = createFileFilter({
        mimeTypes: new Set(['image/tiff']),
        extensions: new Set(['.tiff']),
        message: 'Only TIFF',
      });

      const ok = await runFilter(filter, {
        originalname: 'scan.tiff',
        mimetype: 'image/tiff',
      });
      const bad = await runFilter(filter, {
        originalname: 'scan.png',
        mimetype: 'image/png',
      });

      expect(ok.accepted).toBe(true);
      expect(bad.accepted).toBe(false);
    });
  });
});
