import sharp from 'sharp';
import { AppError } from '../errors.js';

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const IMAGE_RULE_MESSAGE = 'Use a PNG or JPG photo under 2 MB.';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

/** The real type from the first bytes; the client's Content-Type is not trusted. */
export function detectImageType(buffer: Buffer): 'png' | 'jpeg' | null {
  if (buffer.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) return 'png';
  if (buffer.subarray(0, JPEG_MAGIC.length).equals(JPEG_MAGIC)) return 'jpeg';
  return null;
}

/** Luminance at or above this is paper (fully transparent); at or below INK it is fully opaque. */
const PAPER = 200;
const INK = 90;
const MAX_WIDTH = 900;
/** The ink colour of the output; transparency carries the shape. */
const INK_RGB = [17, 24, 39] as const;

/**
 * Turns a photo of a signature or stamp on paper into a clean PNG:
 * EXIF rotate -> trim the near-white border -> greyscale -> paper becomes transparent and the
 * ink dark (alpha from inverted luminance) -> at most 900 px wide.
 */
export async function processInkImage(input: Buffer): Promise<Buffer> {
  if (input.length > MAX_IMAGE_BYTES || !detectImageType(input)) {
    throw new AppError('UNSUPPORTED_FILE', IMAGE_RULE_MESSAGE);
  }

  let rotated: Buffer;
  try {
    rotated = await sharp(input).rotate().toBuffer();
  } catch {
    throw new AppError('UNSUPPORTED_FILE', 'This image could not be read. ' + IMAGE_RULE_MESSAGE);
  }

  // Trim fails on a blank image; then keep it as it is and let the ink check below decide.
  let trimmed = rotated;
  try {
    trimmed = await sharp(rotated).trim({ background: '#ffffff', threshold: 60 }).toBuffer();
  } catch {
    /* nothing to trim */
  }

  const { data, info } = await sharp(trimmed)
    .flatten({ background: '#ffffff' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixels = info.width * info.height;
  const rgba = Buffer.alloc(pixels * 4);
  let inkPixels = 0;
  for (let i = 0; i < pixels; i += 1) {
    const lum = data[i * info.channels] ?? 255;
    const alpha =
      lum >= PAPER ? 0 : lum <= INK ? 255 : Math.round(((PAPER - lum) / (PAPER - INK)) * 255);
    if (alpha > 0) inkPixels += 1;
    rgba[i * 4] = INK_RGB[0];
    rgba[i * 4 + 1] = INK_RGB[1];
    rgba[i * 4 + 2] = INK_RGB[2];
    rgba[i * 4 + 3] = alpha;
  }
  if (inkPixels < Math.max(20, pixels * 0.0005)) {
    throw new AppError(
      'VALIDATION_ERROR',
      'No signature or stamp was found in the photo. Use dark ink on white paper.',
    );
  }

  return sharp(rgba, { raw: { width: info.width, height: info.height, channels: 4 } })
    .resize({ width: MAX_WIDTH, withoutEnlargement: true })
    .png({ compressionLevel: 9 })
    .toBuffer();
}
