import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync } from "node:crypto";

// AES-256-GCM secret encryption for credential-type fields
// (Panel.passwordEncrypted, Panel.tokenEncrypted, gateway configs, ...).
// Key material comes from APP_SECRET; the ciphertext format is
//   v1:<iv b64>:<authTag b64>:<ciphertext b64>
// so the algorithm can be rotated later without breaking stored values.

const FORMAT_VERSION = "v1";
const KEY_CONTEXT = "zedbot.secret.v1";

/** Thrown when APP_SECRET is missing - never fall back to weak encryption. */
export class SecretConfigError extends Error {
  constructor() {
    super(
      "APP_SECRET is not set. Add it to /opt/zedbot/app/.env (the installer generates it) before storing credentials.",
    );
    this.name = "SecretConfigError";
  }
}

let cachedKey: { secret: string; key: Buffer } | null = null;

function getKey(): Buffer {
  const secret = process.env.APP_SECRET ?? "";
  if (secret.trim() === "") {
    throw new SecretConfigError();
  }
  if (cachedKey !== null && cachedKey.secret === secret) {
    return cachedKey.key;
  }
  const key = scryptSync(secret, KEY_CONTEXT, 32);
  cachedKey = { secret, key };
  return key;
}

/** Encrypts a secret string. Throws SecretConfigError when APP_SECRET is unset. */
export function encryptSecret(plain: string): string {
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    FORMAT_VERSION,
    iv.toString("base64"),
    tag.toString("base64"),
    encrypted.toString("base64"),
  ].join(":");
}

/**
 * Decrypts a value produced by encryptSecret. Throws on tampered data, a
 * changed APP_SECRET, or an unknown format - callers must handle failures
 * without ever logging the payload.
 */
export function decryptSecret(payload: string): string {
  const key = getKey();
  const parts = payload.split(":");
  if (parts.length !== 4 || parts[0] !== FORMAT_VERSION) {
    throw new Error("Invalid encrypted secret format.");
  }
  const iv = Buffer.from(parts[1], "base64");
  const tag = Buffer.from(parts[2], "base64");
  const data = Buffer.from(parts[3], "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

/** "abcd...wxyz" for long values; full mask for short ones. Never the raw value. */
export function maskSecretEdges(value: string): string {
  if (value.length >= 10) {
    return `${value.slice(0, 4)}...${value.slice(-4)}`;
  }
  return "********";
}

// --- content fingerprinting ---------------------------------------------------

const FINGERPRINT_CONTEXT = "zedbot.fingerprint.v1";

let cachedFingerprintKey: { secret: string; key: Buffer } | null = null;

function getFingerprintKey(): Buffer {
  const secret = process.env.APP_SECRET;
  if (secret === undefined || secret.length === 0) {
    throw new SecretConfigError();
  }
  if (cachedFingerprintKey === null || cachedFingerprintKey.secret !== secret) {
    cachedFingerprintKey = {
      secret,
      key: scryptSync(secret, FINGERPRINT_CONTEXT, 32),
    };
  }
  return cachedFingerprintKey.key;
}

/**
 * Deterministic keyed hash (HMAC-SHA256) of a sensitive value, for duplicate
 * detection without decryption or exposure. The plaintext is normalized
 * (CRLF -> LF, trimmed) so cosmetically different pastes of the same content
 * collide. NEVER reversible; safe to store and index, never worth logging.
 */
export function fingerprintSecret(value: string): string {
  const normalized = value.replace(/\r\n/g, "\n").trim();
  return createHmac("sha256", getFingerprintKey()).update(normalized, "utf8").digest("hex");
}
