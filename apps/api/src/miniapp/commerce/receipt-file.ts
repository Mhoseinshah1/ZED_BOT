// =============================================================================
// Browser receipt file validation (miniapp §13). Pure functions, no I/O.
//
// The client's claimed MIME type and filename are never trusted: the type is
// SNIFFED from the magic bytes, the size is bounded before decoding, image
// dimensions are bounded from the headers, and the stored identity is a
// server-minted uuid. Anything that fails any check is rejected with one
// stable code; nothing about the bytes is ever logged.
// =============================================================================

export const RECEIPT_MAX_BYTES = 5 * 1024 * 1024;
/** base64 expands ~4/3; cap the encoded form before decoding. */
export const RECEIPT_MAX_BASE64_CHARS = Math.ceil(RECEIPT_MAX_BYTES / 3) * 4 + 16;
export const RECEIPT_MAX_IMAGE_DIMENSION = 12_000;

export type SniffedReceiptType = "image/jpeg" | "image/png" | "application/pdf";

export type ReceiptFileVerdict =
  | { ok: true; mimeType: SniffedReceiptType; bytes: Buffer }
  | { ok: false; reason: "TOO_LARGE" | "UNRECOGNIZED_TYPE" | "BAD_DIMENSIONS" | "MALFORMED" };

function sniff(bytes: Buffer): SniffedReceiptType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString("latin1") === "%PDF-") {
    return "application/pdf";
  }
  return null;
}

/** PNG: IHDR is always the first chunk; width/height at fixed offsets. */
function pngDimensions(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 24) {
    return null;
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** JPEG: walk the marker stream to the first SOFn frame header. */
function jpegDimensions(bytes: Buffer): { width: number; height: number } | null {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2;
      continue;
    }
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2) {
      return null;
    }
    // SOF0..SOF15 except DHT(C4)/DAC(CC)/RST — the frame header carries size.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (offset + 9 > bytes.length) {
        return null;
      }
      return {
        height: bytes.readUInt16BE(offset + 5),
        width: bytes.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + length;
  }
  return null;
}

export function verifyReceiptFile(base64: unknown): ReceiptFileVerdict {
  if (typeof base64 !== "string" || base64.length === 0) {
    return { ok: false, reason: "MALFORMED" };
  }
  if (base64.length > RECEIPT_MAX_BASE64_CHARS) {
    return { ok: false, reason: "TOO_LARGE" };
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    return { ok: false, reason: "MALFORMED" };
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(base64, "base64");
  } catch {
    return { ok: false, reason: "MALFORMED" };
  }
  if (bytes.length === 0) {
    return { ok: false, reason: "MALFORMED" };
  }
  if (bytes.length > RECEIPT_MAX_BYTES) {
    return { ok: false, reason: "TOO_LARGE" };
  }
  const mimeType = sniff(bytes);
  if (mimeType === null) {
    return { ok: false, reason: "UNRECOGNIZED_TYPE" };
  }
  if (mimeType === "image/png" || mimeType === "image/jpeg") {
    const dims = mimeType === "image/png" ? pngDimensions(bytes) : jpegDimensions(bytes);
    if (dims === null) {
      return { ok: false, reason: "MALFORMED" };
    }
    if (
      dims.width < 1 ||
      dims.height < 1 ||
      dims.width > RECEIPT_MAX_IMAGE_DIMENSION ||
      dims.height > RECEIPT_MAX_IMAGE_DIMENSION
    ) {
      return { ok: false, reason: "BAD_DIMENSIONS" };
    }
  }
  return { ok: true, mimeType, bytes };
}
