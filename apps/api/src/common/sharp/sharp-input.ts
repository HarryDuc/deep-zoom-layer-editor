import sharp, { type Sharp, type SharpOptions } from 'sharp';

/**
 * Input options for every sharp/libvips read in the API.
 *
 * libvips refuses to decode any image with more than `limitInputPixels` pixels
 * (268 402 689 by default, roughly 16 383 x 16 383) and fails with
 * `Input image exceeds pixel limit`. That guard is redundant here: every upload
 * is validated against `MAX_IMAGE_PIXELS` before a pipeline runs, so the
 * application limit is the only one that should apply.
 *
 * This matters because the two limits are independent. Raising
 * `MAX_IMAGE_PIXELS` past sharp's built-in cap used to let the upload through
 * and then fail much later, during DZI generation, with an error that has
 * nothing to do with the configured limit.
 */
export const SHARP_INPUT_OPTIONS: SharpOptions = { limitInputPixels: false };

/**
 * Opens an image for reading with the pixel cap disabled.
 *
 * All decoding in the API must go through this helper rather than calling
 * `sharp()` directly, otherwise a single forgotten call site silently
 * reintroduces sharp's 268 MP ceiling.
 */
export function openImage(input: string, options: SharpOptions = {}): Sharp {
  return sharp(input, { ...SHARP_INPUT_OPTIONS, ...options });
}
