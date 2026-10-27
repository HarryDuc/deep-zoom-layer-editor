import sharp from 'sharp';

/**
 * Global libvips cache configuration.
 *
 * libvips keeps source file handles open in its file cache. On Windows that
 * makes those files undeletable while the process lives, which broke cleanup
 * of the temporary upload files and of the per-level TIFF intermediates used
 * during DZI generation.
 *
 * Neither cache is useful for this application: every input is decoded once
 * and every intermediate is written then read exactly once, so caching only
 * holds file handles open. The in-memory operation cache is trimmed to 64 MB
 * so a 500 MB upload cannot be fully buffered.
 *
 * This is intentionally idempotent: it is called from the DZI generator's
 * constructor, from the API bootstrap and from the Jest setup file, so every
 * entry point gets the same behaviour.
 */
export function configureSharpCache(): void {
  sharp.cache({ files: 0, items: 0, memory: 64 });
}
