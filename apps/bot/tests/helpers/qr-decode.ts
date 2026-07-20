import jsQR from "jsqr";
import { PNG } from "pngjs";

/**
 * Decodes a QR PNG buffer back to its encoded string (or null when undecodable).
 * Used by the QR round-trip tests to prove the encoder stored the EXACT raw
 * payload byte-for-byte (jsQR reconstructs the original string, UTF-8 included).
 */
export function decodeQrPng(png: Buffer): string | null {
  const img = PNG.sync.read(png);
  const result = jsQR(new Uint8ClampedArray(img.data), img.width, img.height);
  return result === null ? null : result.data;
}

/** The 8-byte PNG file signature - used to assert the buffer really is a PNG. */
export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
