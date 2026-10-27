import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import sharp from 'sharp';
import { SHARP_INPUT_OPTIONS, openImage } from './sharp-input';

describe('sharp input options', () => {
  it('disables the libvips pixel cap', () => {
    // libvips defaults to 268 402 689 pixels and throws
    // "Input image exceeds pixel limit" above it. The application limit
    // (MAX_IMAGE_PIXELS) must be the only ceiling, otherwise raising it lets an
    // upload through and then fails during DZI generation instead.
    expect(SHARP_INPUT_OPTIONS.limitInputPixels).toBe(false);
  });

  describe('openImage', () => {
    let workDir: string;
    let sourcePath: string;

    beforeAll(async () => {
      workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sharp-input-'));
      sourcePath = path.join(workDir, 'source.png');
      await sharp({
        create: {
          width: 64,
          height: 48,
          channels: 3,
          background: { r: 10, g: 20, b: 30 },
        },
      })
        .png()
        .toFile(sourcePath);
    });

    afterAll(async () => {
      await fs.rm(workDir, { recursive: true, force: true });
    });

    it('reads metadata like a plain sharp instance', async () => {
      const metadata = await openImage(sourcePath).metadata();
      expect(metadata.format).toBe('png');
      expect(metadata.width).toBe(64);
      expect(metadata.height).toBe(48);
    });

    it('keeps caller-supplied options', async () => {
      const metadata = await openImage(sourcePath, { sequentialRead: false }).metadata();
      expect(metadata.width).toBe(64);
    });

    it('still decodes and re-encodes', async () => {
      const target = path.join(workDir, 'copy.jpg');
      await openImage(sourcePath).jpeg({ quality: 80 }).toFile(target);
      const metadata = await sharp(target).metadata();
      expect(metadata.format).toBe('jpeg');
    });
  });

  it('is the only way production code opens an image', async () => {
    // Guards against a new call site calling `sharp()` directly and thereby
    // silently reintroducing the 268 MP libvips ceiling.
    const srcRoot = path.resolve(__dirname, '../..');
    const offenders: string[] = [];

    const walk = async (directory: string): Promise<void> => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await walk(absolute);
          continue;
        }
        if (!entry.name.endsWith('.ts') || entry.name.endsWith('.spec.ts')) {
          continue;
        }
        if (entry.name === 'sharp-input.ts') {
          continue;
        }
        const content = await fs.readFile(absolute, 'utf8');
        // A bare `sharp(` call, i.e. not `openImage(` or a type annotation.
        if (/(^|[^A-Za-z0-9_.])sharp\s*\(/m.test(content)) {
          offenders.push(path.relative(srcRoot, absolute));
        }
      }
    };

    await walk(srcRoot);
    expect(offenders).toEqual([]);
  });
});
