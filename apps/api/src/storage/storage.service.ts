import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createReadStream, ReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { APP_CONFIG, AppConfig } from '../config/configuration';
import { ApplicationError } from '../common/errors/application.error';

export interface StoredFileStat {
  size: number;
  absolutePath: string;
}

const SAFE_STORAGE_KEY = /^[A-Za-z0-9_-]+$/;
const SAFE_RELATIVE_SEGMENT = /^[A-Za-z0-9_.-]+$/;
const TILE_FILE = /^\d{1,2}\/\d{1,6}_\d{1,6}\.(jpg|jpeg|png|webp)$/;

export type StorageBucket = 'originals' | 'dzi' | 'tiles' | 'overlays' | 'tmp';

/**
 * Owns every filesystem interaction for image assets. Controllers and services
 * never build paths themselves; they pass validated ids/keys and receive
 * streams or error results.
 */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private readonly root: string;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.root = path.resolve(config.storageDir);
  }

  async onModuleInit(): Promise<void> {
    for (const bucket of ['originals', 'dzi', 'tiles', 'overlays', 'tmp'] as StorageBucket[]) {
      await fs.mkdir(this.bucketPath(bucket), { recursive: true });
    }
    this.logger.log(`Storage root initialized at ${this.root}`);
  }

  getRootPath(): string {
    return this.root;
  }

  /** Generates an opaque, filesystem-safe storage key. Never derived from user input. */
  createStorageKey(): string {
    return randomBytes(16).toString('hex');
  }

  bucketPath(bucket: StorageBucket): string {
    return path.join(this.root, bucket);
  }

  /**
   * Resolves `segments` inside `bucket` while guaranteeing the result stays
   * within that bucket directory. Throws on traversal or unknown keys.
   */
  private resolveWithin(bucket: StorageBucket, segments: string[]): string {
    const base = this.bucketPath(bucket);
    for (const segment of segments) {
      if (!SAFE_RELATIVE_SEGMENT.test(segment) || segment === '.' || segment === '..') {
        throw ApplicationError.badRequest('INVALID_STORAGE_KEY', 'Invalid storage key');
      }
    }
    const resolved = path.resolve(base, ...segments);
    const baseWithSep = base + path.sep;
    if (resolved !== base && !resolved.startsWith(baseWithSep)) {
      throw ApplicationError.badRequest('INVALID_STORAGE_KEY', 'Invalid storage key');
    }
    return resolved;
  }

  private assertKey(key: string): string {
    if (!SAFE_STORAGE_KEY.test(key)) {
      throw ApplicationError.badRequest('INVALID_STORAGE_KEY', 'Invalid storage key');
    }
    return key;
  }

  /* ------------------------------- originals ------------------------------ */

  /** Canonical relative path of a stored original, e.g. `originals/<key>.jpg`. */
  originalRelativePath(assetKey: string, extension: string): string {
    const ext = this.normalizeExtension(extension);
    return path.join('originals', `${this.assertKey(assetKey)}.${ext}`);
  }

  originalPath(assetKey: string, extension: string): string {
    const ext = this.normalizeExtension(extension);
    return this.resolveWithin('originals', [`${this.assertKey(assetKey)}.${ext}`]);
  }

  /**
   * Extension derived from a stored MIME type. Originals are saved under this
   * extension so the decoder can sniff the format reliably.
   */
  extensionForMimeType(mimeType: string): string {
    return mimeType === 'image/png' ? 'png' : 'jpg';
  }

  private normalizeExtension(extension: string): string {
    const normalized = extension.replace(/^\./, '').toLowerCase();
    if (!/^[a-z0-9]{1,8}$/.test(normalized)) {
      throw ApplicationError.badRequest('INVALID_STORAGE_KEY', 'Invalid file extension');
    }
    return normalized;
  }

  /**
   * Resolves a *server-generated* relative path (as stored in MongoDB) to an
   * absolute path inside the storage root. Client input must never be passed
   * here; the containment check is a defence-in-depth guard against a corrupted
   * or tampered database value.
   */
  resolveStoredRelativePath(relativePath: string): string {
    if (typeof relativePath !== 'string' || relativePath.length === 0) {
      throw ApplicationError.badRequest('INVALID_STORAGE_KEY', 'Invalid storage path');
    }
    const segments = relativePath.split(/[\\/]+/).filter((segment) => segment.length > 0);
    if (segments.length === 0) {
      throw ApplicationError.badRequest('INVALID_STORAGE_KEY', 'Invalid storage path');
    }
    const resolved = path.resolve(this.root, ...segments);
    const rootWithSep = this.root + path.sep;
    if (!resolved.startsWith(rootWithSep)) {
      throw ApplicationError.badRequest('INVALID_STORAGE_KEY', 'Invalid storage path');
    }
    return resolved;
  }

  /* ---------------------------------- DZI --------------------------------- */

  dziRelativePath(assetKey: string): string {
    return path.join('dzi', `${this.assertKey(assetKey)}.dzi`);
  }

  private dziFilesDir(assetKey: string): string {
    return this.resolveWithin('dzi', [`${this.assertKey(assetKey)}_files`]);
  }

  async writeDziDescriptor(assetKey: string, xml: string): Promise<string> {
    const target = this.resolveWithin('dzi', [`${this.assertKey(assetKey)}.dzi`]);
    await fs.writeFile(target, xml, 'utf8');
    return this.dziRelativePath(assetKey);
  }

  async readDziDescriptor(assetKey: string): Promise<string> {
    const target = this.resolveWithin('dzi', [`${this.assertKey(assetKey)}.dzi`]);
    try {
      return await fs.readFile(target, 'utf8');
    } catch {
      throw ApplicationError.notFound('DZI_NOT_FOUND', 'DZI descriptor is not available');
    }
  }

  dziTileDir(assetKey: string, level: number): string {
    if (!Number.isInteger(level) || level < 0 || level > 40) {
      throw ApplicationError.badRequest('INVALID_TILE_PATH', 'Invalid tile path');
    }
    // DZI convention: tiles live next to the descriptor in `<key>_files/<level>`.
    return path.join(this.dziFilesDir(assetKey), `${level}`);
  }

  /**
   * Validates a client-supplied tile path (`<level>/<x>_<y>.<ext>`) and returns
   * the absolute path plus content type, or null when the path is not a valid
   * tile reference for the given asset.
   */
  resolveTile(assetKey: string, tilePath: string): { absolutePath: string; contentType: string } | null {
    const normalized = tilePath.replace(/\\/g, '/');
    if (!TILE_FILE.test(normalized) || normalized.includes('..')) {
      return null;
    }
    const [levelPart, file] = normalized.split('/');
    const level = Number.parseInt(levelPart, 10);
    if (!Number.isInteger(level) || level < 0 || level > 40) {
      return null;
    }

    const extension = path.extname(file).toLowerCase();
    const contentType =
      extension === '.png' ? 'image/png' : extension === '.webp' ? 'image/webp' : 'image/jpeg';

    const dir = this.dziTileDir(assetKey, level);
    const absolutePath = path.resolve(dir, file);
    const dirWithSep = dir + path.sep;
    if (!absolutePath.startsWith(dirWithSep)) {
      return null;
    }

    return { absolutePath, contentType };
  }

  /* -------------------------------- overlays ------------------------------ */

  overlayRelativePath(assetKey: string, overlayKey: string, extension: string): string {
    return path.join('overlays', this.assertKey(assetKey), `${this.assertKey(overlayKey)}.${extension}`);
  }

  overlayAbsolutePath(assetKey: string, overlayKey: string, extension: string): string {
    return this.resolveWithin('overlays', [
      this.assertKey(assetKey),
      `${this.assertKey(overlayKey)}.${extension}`,
    ]);
  }

  /**
   * Relative path of an overlay's Deep Zoom descriptor.
   *
   * Overlays live in their own bucket, so the descriptor sits next to the
   * bitmap: `overlays/<assetKey>/<overlayKey>.dzi`.
   */
  overlayDziRelativePath(assetKey: string, overlayKey: string): string {
    return path.join(
      'overlays',
      this.assertKey(assetKey),
      `${this.assertKey(overlayKey)}.dzi`,
    );
  }

  /** Absolute path of an overlay's Deep Zoom descriptor. */
  overlayDziAbsolutePath(assetKey: string, overlayKey: string): string {
    return this.resolveWithin('overlays', [
      this.assertKey(assetKey),
      `${this.assertKey(overlayKey)}.dzi`,
    ]);
  }

  /**
   * Directory holding an overlay's tile tree: `<assetKey>/<overlayKey>_files`.
   *
   * The `_files` suffix mirrors the DZI convention used for the base image, so
   * the descriptor and its tiles are always discoverable as a pair.
   */
  overlayTileFilesDir(assetKey: string, overlayKey: string): string {
    return this.resolveWithin('overlays', [
      this.assertKey(assetKey),
      `${this.assertKey(overlayKey)}_files`,
    ]);
  }

  /** Absolute path of a single overlay tile inside its level directory. */
  overlayTileAbsolutePath(
    assetKey: string,
    overlayKey: string,
    level: number,
    file: string,
  ): string {
    if (!Number.isInteger(level) || level < 0 || level > 40) {
      throw ApplicationError.badRequest('INVALID_TILE_PATH', 'Invalid tile path');
    }
    return this.resolveWithin('overlays', [
      this.assertKey(assetKey),
      `${this.assertKey(overlayKey)}_files`,
      String(level),
      file,
    ]);
  }

  /* ------------------------------- primitives ----------------------------- */

  async ensureDir(dir: string): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
  }

  async writeFileWithKey(bucket: StorageBucket, assetKey: string, extension: string, data: Buffer): Promise<string> {
    const dir = this.resolveWithin(bucket, []);
    await fs.mkdir(dir, { recursive: true });
    const relative = path.join(bucket, `${this.assertKey(assetKey)}.${extension}`);
    await fs.writeFile(path.join(dir, `${this.assertKey(assetKey)}.${extension}`), data);
    return relative;
  }

  async moveIntoPlace(sourcePath: string, bucket: StorageBucket, assetKey: string, extension: string): Promise<string> {
    const dir = this.resolveWithin(bucket, []);
    await fs.mkdir(dir, { recursive: true });
    const target = path.join(dir, `${this.assertKey(assetKey)}.${extension || 'bin'}`);
    await this.moveFile(sourcePath, target);
    return path.join(bucket, `${this.assertKey(assetKey)}.${extension || 'bin'}`);
  }

  async moveFile(source: string, target: string): Promise<void> {
    await fs.mkdir(path.dirname(target), { recursive: true });
    try {
      await fs.rename(source, target);
    } catch (error) {
      // Windows: rename can fail across volumes (EXDEV) or while a handle is
      // still open (EPERM/EBUSY). Copy + delete is the portable fallback, and
      // it must handle directories because tile pyramids are moved as a tree.
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EXDEV' || code === 'EPERM' || code === 'EBUSY') {
        const stat = await fs.stat(source);
        if (stat.isDirectory()) {
          await fs.cp(source, target, { recursive: true, force: true });
          await fs.rm(source, { recursive: true, force: true });
        } else {
          await fs.copyFile(source, target);
          await this.safeUnlink(source);
        }
        return;
      }
      throw error;
    }
  }

  async statFile(absolutePath: string): Promise<StoredFileStat | null> {
    try {
      const stat = await fs.stat(absolutePath);
      if (!stat.isFile()) return null;
      return { size: stat.size, absolutePath };
    } catch {
      return null;
    }
  }

  createReadStream(absolutePath: string): ReadStream {
    return createReadStream(absolutePath);
  }

  /** Whole-file read used only for small, bounded artifacts (DZI descriptor, overlays). */
  async readFileBuffer(absolutePath: string, maxBytes = 20 * 1024 * 1024): Promise<Buffer> {
    const stat = await this.statFile(absolutePath);
    if (!stat) {
      throw ApplicationError.notFound('FILE_NOT_FOUND', 'File is not available');
    }
    if (stat.size > maxBytes) {
      throw ApplicationError.badRequest('FILE_TOO_LARGE', 'File is too large to read');
    }
    return fs.readFile(absolutePath);
  }

  asWebStream(stream: Readable): ReadableStream {
    return Readable.toWeb(stream) as ReadableStream;
  }

  async pathExists(absolutePath: string): Promise<boolean> {
    return (await this.statFile(absolutePath)) !== null;
  }

  /* -------------------------------- cleanup ------------------------------- */

  async safeUnlink(absolutePath: string): Promise<void> {
    try {
      await fs.unlink(absolutePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        this.logger.warn(`Failed to remove temporary file: ${code ?? 'unknown error'}`);
      }
    }
  }

  async removeIfExists(absolutePath: string): Promise<void> {
    await fs.rm(absolutePath, { recursive: true, force: true });
  }

  /** Removes everything stored for an asset (original, DZI pyramid, overlays). */
  async removeAssetData(assetKey: string): Promise<void> {
    if (!SAFE_STORAGE_KEY.test(assetKey)) {
      return;
    }
    const originalsDir = this.bucketPath('originals');
    const targets = [
      this.resolveWithin('dzi', [`${assetKey}.dzi`]),
      // Tiles live in `<key>_files/` next to the descriptor, not in `<key>/`.
      this.resolveWithin('dzi', [`${assetKey}_files`]),
      this.resolveWithin('dzi', [assetKey]),
      this.resolveWithin('overlays', [assetKey]),
    ];

    // The original's extension varies (jpg/png), so glob the bucket prefix.
    try {
      const entries = await fs.readdir(originalsDir);
      for (const entry of entries) {
        if (entry === `${assetKey}.jpg` || entry === `${assetKey}.png` || entry.startsWith(`${assetKey}.`)) {
          targets.push(path.join(originalsDir, entry));
        }
      }
    } catch {
      // Originals bucket may not exist yet.
    }

    for (const target of targets) {
      await this.removeIfExists(target);
    }
  }

  /** Clears stale temp upload files left behind by an earlier crash. */
  async cleanTempDirectory(): Promise<number> {
    const dir = this.bucketPath('tmp');
    let removed = 0;
    try {
      const entries = await fs.readdir(dir);
      for (const entry of entries) {
        await this.removeIfExists(path.join(dir, entry));
        removed += 1;
      }
    } catch {
      // Directory may not exist yet on first boot.
    }
    return removed;
  }
}
