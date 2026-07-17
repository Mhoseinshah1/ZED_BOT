import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  type CipherGCM,
  type DecipherGCM,
} from "node:crypto";

// =============================================================================
// Versioned backup encryption envelope (ops phase). Authenticated encryption
// only: AES-256-GCM with a per-backup random salt + nonce, key derived from
// BACKUP_ENCRYPTION_PASSWORD via scrypt. File layout ("ZBK1" envelope v1):
//
//   [ 4 bytes magic "ZBK1" ][ 1 byte version = 0x01 ]
//   [ 16 bytes scrypt salt ][ 12 bytes GCM nonce ]
//   [ ciphertext ... ][ 16 bytes GCM auth tag ]
//
// Everything before the ciphertext is NON-SECRET metadata required for
// decryption; the password and derived key are never stored, logged or
// transmitted. No custom cryptography - Node's audited primitives only.
// =============================================================================

export const BACKUP_ENVELOPE_MAGIC = Buffer.from("ZBK1", "ascii");
export const BACKUP_ENVELOPE_VERSION = 1;
export const BACKUP_ENVELOPE_SALT_BYTES = 16;
export const BACKUP_ENVELOPE_NONCE_BYTES = 12;
export const BACKUP_ENVELOPE_TAG_BYTES = 16;
export const BACKUP_ENVELOPE_HEADER_BYTES =
  BACKUP_ENVELOPE_MAGIC.length + 1 + BACKUP_ENVELOPE_SALT_BYTES + BACKUP_ENVELOPE_NONCE_BYTES;

/** scrypt parameters (N=2^15, r=8, p=1) - interactive-grade, documented. */
const SCRYPT_COST = { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };

export function deriveBackupKey(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, 32, SCRYPT_COST);
}

export interface BackupEncryptor {
  /** Write this ONCE before any ciphertext. */
  header: Buffer;
  /** Pipe plaintext through this; append getAuthTag() after final(). */
  cipher: CipherGCM;
}

/** Fresh salt + nonce per backup - never reused across files. */
export function createBackupEncryptor(password: string): BackupEncryptor {
  const salt = randomBytes(BACKUP_ENVELOPE_SALT_BYTES);
  const nonce = randomBytes(BACKUP_ENVELOPE_NONCE_BYTES);
  const key = deriveBackupKey(password, salt);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const header = Buffer.concat([
    BACKUP_ENVELOPE_MAGIC,
    Buffer.from([BACKUP_ENVELOPE_VERSION]),
    salt,
    nonce,
  ]);
  return { header, cipher };
}

export interface BackupEnvelopeHeader {
  version: number;
  salt: Buffer;
  nonce: Buffer;
  /** Byte offset where ciphertext starts. */
  dataStart: number;
}

/** Parses and validates the envelope header from the file's first bytes. */
export function parseBackupEnvelopeHeader(head: Buffer): BackupEnvelopeHeader {
  if (head.length < BACKUP_ENVELOPE_HEADER_BYTES) {
    throw new Error("backup envelope: header too short");
  }
  if (!head.subarray(0, 4).equals(BACKUP_ENVELOPE_MAGIC)) {
    throw new Error("backup envelope: bad magic");
  }
  const version = head[4];
  if (version !== BACKUP_ENVELOPE_VERSION) {
    throw new Error(`backup envelope: unsupported version ${version}`);
  }
  const salt = Buffer.from(head.subarray(5, 5 + BACKUP_ENVELOPE_SALT_BYTES));
  const nonce = Buffer.from(
    head.subarray(
      5 + BACKUP_ENVELOPE_SALT_BYTES,
      5 + BACKUP_ENVELOPE_SALT_BYTES + BACKUP_ENVELOPE_NONCE_BYTES,
    ),
  );
  return { version, salt, nonce, dataStart: BACKUP_ENVELOPE_HEADER_BYTES };
}

/**
 * Decryptor for a parsed header + the auth tag read from the file's LAST 16
 * bytes. Authentication failure (wrong password / tampering) throws on
 * final() - callers must treat any throw as "corrupt or wrong password"
 * without echoing details.
 */
export function createBackupDecryptor(
  password: string,
  header: BackupEnvelopeHeader,
  authTag: Buffer,
): DecipherGCM {
  const key = deriveBackupKey(password, header.salt);
  const decipher = createDecipheriv("aes-256-gcm", key, header.nonce);
  decipher.setAuthTag(authTag);
  return decipher;
}
