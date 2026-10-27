import { BadRequestException } from '@nestjs/common';
import { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface';
import { diskStorage } from 'multer';
import { extname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { AppConfig } from '../../config/configuration';

export interface UploadRules {
  mimeTypes: Set<string>;
  extensions: Set<string>;
  message: string;
}

/**
 * Global Multer configuration: writes to the managed `data/tmp` directory with
 * a fully random filename (never derived from client input) and enforces the
 * configured size limit.
 */
export function createMulterOptions(config: AppConfig): MulterOptions {
  return {
    storage: diskStorage({
      destination: (_req, _file, callback) => {
        const dir = join(config.storageDir, 'tmp');
        mkdirSync(dir, { recursive: true });
        callback(null, dir);
      },
      filename: (_req, _file, callback) => {
        callback(null, `upload-${Date.now()}-${randomBytes(8).toString('hex')}`);
      },
    }),
    limits: { fileSize: config.maxUploadSizeBytes, files: 1 },
  };
}

/**
 * Per-endpoint file filter applied on top of the global Multer options.
 * Rejects based on declared MIME type and extension before the body is read;
 * the real content check happens later in the service.
 */
export function createFileFilter(rules: UploadRules): MulterOptions['fileFilter'] {
  return (_req, file, callback) => {
    const extension = extname(file.originalname ?? '').toLowerCase();
    if (!rules.mimeTypes.has(file.mimetype) || !rules.extensions.has(extension)) {
      callback(
        new BadRequestException({
          code: 'UNSUPPORTED_FILE_TYPE',
          message: rules.message,
        }),
        false,
      );
      return;
    }
    callback(null, true);
  };
}

export const IMAGE_UPLOAD_RULES: UploadRules = {
  mimeTypes: new Set(['image/jpeg', 'image/png']),
  extensions: new Set(['.jpg', '.jpeg', '.png']),
  message: 'Only JPEG and PNG images are supported',
};

export const OVERLAY_UPLOAD_RULES: UploadRules = {
  mimeTypes: new Set(['image/png', 'image/webp', 'image/jpeg']),
  extensions: new Set(['.png', '.webp', '.jpg', '.jpeg']),
  message: 'Overlays must be PNG, WebP or JPEG images',
};

export const IMAGE_UPLOAD_FILTER = createFileFilter(IMAGE_UPLOAD_RULES);
export const OVERLAY_UPLOAD_FILTER = createFileFilter(OVERLAY_UPLOAD_RULES);
