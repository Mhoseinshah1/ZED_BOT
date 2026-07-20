import QRCode from "qrcode";

// =============================================================================
// QR-code generation (service-config-qrcode phase) - turns a raw subscription /
// config string into an in-memory PNG for Telegram photo delivery. This module
// is DELIBERATELY pure and side-effect free:
//   - generates the PNG entirely in memory (no temp files, no disk writes);
//   - NEVER calls an external QR API (the `qrcode` library is a local encoder);
//   - encodes the EXACT raw payload byte-for-byte - no HTML-escaping, trimming,
//     normalization or any other alteration (a decoded QR must equal the input);
//   - NEVER logs, throws-with, or otherwise exposes the raw payload - a failure
//     returns a typed, payload-free reason so callers can fall back to the text.
// The output Buffer is ready to wrap in a grammY InputFile.
// =============================================================================

/** The generator's result - a PNG buffer, or a typed reason that carries no payload. */
export type QrCodeResult =
  | { ok: true; png: Buffer }
  | { ok: false; reason: "EMPTY" | "TOO_LARGE" | "UNENCODABLE" };

/**
 * Upper bound (UTF-8 bytes) on what we will encode. Bounds the QR density so the
 * image still scans from a Telegram photo preview, and guards against a
 * pathological payload. A level-M version-40 byte-mode QR holds ~2331 bytes, so
 * this stays comfortably within capacity while keeping the code scannable.
 */
export const QR_MAX_PAYLOAD_BYTES = 1500;

// Clear white background + solid black modules + a 4-module quiet zone (the QR
// spec minimum). 512px scales the modules large enough to scan from a Telegram
// image preview. Error-correction level M is the standard reliable middle ground.
const QR_OPTIONS = {
  errorCorrectionLevel: "M" as const,
  margin: 4,
  width: 512,
  color: { dark: "#000000ff", light: "#ffffffff" },
};

/**
 * Encodes `payload` as an in-memory PNG QR code. Returns a typed failure for an
 * empty, over-sized, or otherwise unencodable payload instead of throwing the raw
 * value. The payload is passed to the encoder verbatim (byte-for-byte); no
 * escaping/normalization is applied, so `decode(generateQrPng(x)) === x`.
 */
export async function generateQrPng(payload: string): Promise<QrCodeResult> {
  if (typeof payload !== "string" || payload.length === 0) {
    return { ok: false, reason: "EMPTY" };
  }
  if (Buffer.byteLength(payload, "utf8") > QR_MAX_PAYLOAD_BYTES) {
    return { ok: false, reason: "TOO_LARGE" };
  }
  try {
    const png = await QRCode.toBuffer(payload, QR_OPTIONS);
    return { ok: true, png };
  } catch {
    // The exact payload is NEVER surfaced - only the diagnostic class.
    return { ok: false, reason: "UNENCODABLE" };
  }
}
