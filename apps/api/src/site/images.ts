import type { ImageMime } from "../db/types.js";
import { unprocessable } from "../errors.js";

/** Largest media file, in bytes; the database enforces the same limit. */
export const MEDIA_MAX_BYTES = 5 * 1024 * 1024;

export interface DecodedImage {
  bytes: Buffer;
  mime: ImageMime;
  width: number;
  height: number;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Identifies the image from its first bytes, so a file is never stored under a type it does not have. */
function sniffImage(bytes: Buffer): ImageMime | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

/** Width and height from the IHDR chunk, which the PNG format requires first. */
function pngSize(bytes: Buffer): [number, number] | null {
  if (bytes.length < 24 || bytes.toString("ascii", 12, 16) !== "IHDR") return null;
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

/**
 * Walks the JPEG markers up to the first start-of-frame segment (SOF0 to SOF15, except DHT C4, JPG C8 and DAC
 * CC which share the range), whose header carries the height then the width.
 */
function jpegSize(bytes: Buffer): [number, number] | null {
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1]!;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2) return null;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (offset + 9 > bytes.length) return null;
      return [bytes.readUInt16BE(offset + 7), bytes.readUInt16BE(offset + 5)];
    }
    offset += 2 + length;
  }
  return null;
}

/** Canvas size of a WebP file from its first chunk: lossy (VP8), lossless (VP8L) or extended (VP8X). */
function webpSize(bytes: Buffer): [number, number] | null {
  if (bytes.length < 30) return null;
  const chunk = bytes.toString("ascii", 12, 16);
  if (chunk === "VP8 ") {
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    return [bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff];
  }
  if (chunk === "VP8L") {
    if (bytes[20] !== 0x2f) return null;
    const b1 = bytes[21]!;
    const b2 = bytes[22]!;
    const b3 = bytes[23]!;
    const b4 = bytes[24]!;
    return [1 + (b1 | ((b2 & 0x3f) << 8)), 1 + ((b2 >> 6) | (b3 << 2) | ((b4 & 0x0f) << 10))];
  }
  if (chunk === "VP8X") return [1 + bytes.readUIntLE(24, 3), 1 + bytes.readUIntLE(27, 3)];
  return null;
}

const SIZE_READERS: Record<ImageMime, (bytes: Buffer) => [number, number] | null> = {
  "image/png": pngSize,
  "image/jpeg": jpegSize,
  "image/webp": webpSize,
};

/**
 * Decodes a `data:image/...;base64,` URL into a PNG, JPEG or WebP image within the size limit, checking that the
 * content matches the declared type and that its pixel size can be read from the file headers.
 */
export function decodeImage(dataUrl: string): DecodedImage {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match) throw unprocessable("invalid_image", "the file must be a PNG, JPEG or WebP image");
  const bytes = Buffer.from(match[2]!, "base64");
  if (bytes.length === 0) throw unprocessable("invalid_image", "the image is empty");
  if (bytes.length > MEDIA_MAX_BYTES) throw unprocessable("image_too_large", `an image cannot exceed ${MEDIA_MAX_BYTES} bytes`, { maxBytes: MEDIA_MAX_BYTES });
  const mime = sniffImage(bytes);
  if (!mime || mime !== match[1]) throw unprocessable("invalid_image", "the file content does not match its declared image type");
  const size = SIZE_READERS[mime](bytes);
  if (!size || size[0] <= 0 || size[1] <= 0) throw unprocessable("invalid_image", "the image dimensions cannot be read");
  return { bytes, mime, width: size[0], height: size[1] };
}
