import * as path from 'node:path';
import * as fs from 'node:fs';

export interface AppConfig {
  nodeEnv: string;
  port: number;
  mongodbUri: string;
  storageDir: string;
  maxUploadSizeBytes: number;
  maxUploadSizeMb: number;
  maxImagePixels: number;
  dziTileSize: number;
  dziTileOverlap: number;
  dziTileFormat: 'jpeg' | 'png';
  dziTileQuality: number;
  imageProcessingConcurrency: number;
  imageProcessingTimeoutMs: number;
  frontendOrigin: string;
}

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer, received "${raw}"`);
  }
  return parsed;
}

function readTileOverlap(): number {
  const raw = process.env.DZI_TILE_OVERLAP ?? '1';
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 10) {
    throw new Error(`DZI_TILE_OVERLAP must be an integer between 0 and 10, received "${raw}"`);
  }
  return parsed;
}

function readFormat(): 'jpeg' | 'png' {
  const raw = (process.env.DZI_TILE_FORMAT ?? 'jpeg').toLowerCase();
  if (raw === 'jpeg' || raw === 'jpg') return 'jpeg';
  if (raw === 'png') return 'png';
  throw new Error(`DZI_TILE_FORMAT must be "jpeg" or "png", received "${raw}"`);
}

/**
 * Walks up from `process.cwd()` looking for the monorepo root (a package.json
 * declaring `workspaces`). Used to anchor relative storage paths so the API
 * behaves identically whether it is started from the repo root or apps/api.
 */
export function findRepoRoot(startDir: string = process.cwd()): string | null {
  let current = path.resolve(startDir);
  for (let depth = 0; depth < 6; depth += 1) {
    const packageJsonPath = path.join(current, 'package.json');
    try {
      const raw = fs.readFileSync(packageJsonPath, 'utf8');
      const parsed = JSON.parse(raw) as { workspaces?: unknown };
      if (parsed.workspaces) {
        return current;
      }
    } catch {
      // No readable package.json here; keep walking up.
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/**
 * Resolves the storage root.
 *
 * Absolute values are used verbatim. Relative values are resolved against the
 * monorepo root when it can be detected (falling back to the current working
 * directory), which keeps `APP_STORAGE_DIR=data` valid from any working dir.
 */
export function resolveStorageDir(
  configured: string = process.env.APP_STORAGE_DIR ?? 'data',
  cwd: string = process.cwd(),
): string {
  if (path.isAbsolute(configured)) {
    return path.resolve(configured);
  }
  const base = findRepoRoot(cwd) ?? cwd;
  return path.resolve(base, configured);
}

export const loadConfig = (): AppConfig => {
  const maxUploadSizeMb = readInt('MAX_UPLOAD_SIZE_MB', 100);

  return {
    nodeEnv: process.env.NODE_ENV ?? 'development',
    port: readInt('PORT', 3001),
    mongodbUri: process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/deep_zoom_layer_editor',
    storageDir: resolveStorageDir(),
    maxUploadSizeMb,
    maxUploadSizeBytes: maxUploadSizeMb * 1024 * 1024,
    maxImagePixels: readInt('MAX_IMAGE_PIXELS', 100_000_000),
    dziTileSize: readInt('DZI_TILE_SIZE', 256),
    dziTileOverlap: readTileOverlap(),
    dziTileFormat: readFormat(),
    dziTileQuality: readInt('DZI_TILE_QUALITY', 82),
    imageProcessingConcurrency: readInt('IMAGE_PROCESSING_CONCURRENCY', 1),
    imageProcessingTimeoutMs: readInt('IMAGE_PROCESSING_TIMEOUT_MS', 300_000),
    frontendOrigin: process.env.FRONTEND_ORIGIN ?? 'http://localhost:3000',
  };
};

export const APP_CONFIG = 'APP_CONFIG';
