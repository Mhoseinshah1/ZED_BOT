import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import {
  BACKUP_ENVELOPE_HEADER_BYTES,
  BACKUP_ENVELOPE_MAGIC,
  BACKUP_ENVELOPE_TAG_BYTES,
  createBackupDecryptor,
  parseBackupEnvelopeHeader,
} from "@zedbot/shared";

import { pgRestoreList } from "./pg.js";
import { unlinkQuiet } from "./files.js";

// =============================================================================
// Backup verification: plain custom-format dumps are checked directly with
// `pg_restore --list`; ZBK1-encrypted dumps are stream-decrypted to a
// short-lived plaintext temp file first (ALWAYS removed in finally). All
// failures collapse to short safe reason codes - never crypto/pg output.
// =============================================================================

export interface VerifyResult {
  ok: boolean;
  encrypted: boolean;
  /** Short safe reason when ok=false ("decrypt-failed", "pg-restore-exit-1"). */
  reason: string | null;
}

/** Reads the first bytes to decide whether the file is a ZBK1 envelope. */
async function readHead(filePath: string, bytes: number): Promise<Buffer> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Reads the GCM auth tag from the file's last 16 bytes. */
async function readAuthTag(filePath: string, fileSize: number): Promise<Buffer> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(BACKUP_ENVELOPE_TAG_BYTES);
    await handle.read(buffer, 0, BACKUP_ENVELOPE_TAG_BYTES, fileSize - BACKUP_ENVELOPE_TAG_BYTES);
    return buffer;
  } finally {
    await handle.close();
  }
}

/**
 * Decrypts a ZBK1 file to plainPath (exclusive create). Throws on any
 * parse/authentication failure - callers map that to "corrupt or wrong
 * password" without echoing details.
 */
export async function decryptBackupToFile(
  encryptedPath: string,
  plainPath: string,
  password: string,
): Promise<void> {
  const { size } = await stat(encryptedPath);
  if (size < BACKUP_ENVELOPE_HEADER_BYTES + BACKUP_ENVELOPE_TAG_BYTES + 1) {
    throw new Error("envelope-too-short");
  }
  const header = parseBackupEnvelopeHeader(await readHead(encryptedPath, BACKUP_ENVELOPE_HEADER_BYTES));
  const authTag = await readAuthTag(encryptedPath, size);
  const decipher = createBackupDecryptor(password, header, authTag);
  // Ciphertext spans [dataStart, size - tag); decipher.final() (invoked by
  // the stream on end) throws when authentication fails.
  const source = createReadStream(encryptedPath, {
    start: header.dataStart,
    end: size - BACKUP_ENVELOPE_TAG_BYTES - 1,
  });
  await pipeline(source, decipher, createWriteStream(plainPath, { flags: "wx", mode: 0o600 }));
}

/**
 * Verifies one backup file (plain dump or ZBK1-encrypted dump). Encrypted
 * verification needs the encryption password; the temporary plaintext copy
 * lives under os.tmpdir() and is unconditionally unlinked.
 */
export async function verifyBackupFile(
  filePath: string,
  password: string | null,
): Promise<VerifyResult> {
  let head: Buffer;
  try {
    head = await readHead(filePath, BACKUP_ENVELOPE_MAGIC.length);
  } catch {
    return { ok: false, encrypted: false, reason: "file-missing" };
  }
  const isEncrypted = head.length >= BACKUP_ENVELOPE_MAGIC.length && head.subarray(0, 4).equals(BACKUP_ENVELOPE_MAGIC);

  if (!isEncrypted) {
    const listed = await pgRestoreList(filePath);
    return { ok: listed.ok, encrypted: false, reason: listed.reason };
  }

  if (password === null) {
    return { ok: false, encrypted: true, reason: "password-missing" };
  }
  const tmpPlain = path.join(os.tmpdir(), `zedbot-verify-${process.pid}-${randomUUID()}.dump`);
  try {
    try {
      await decryptBackupToFile(filePath, tmpPlain, password);
    } catch {
      // Wrong password and tampering are indistinguishable by design.
      return { ok: false, encrypted: true, reason: "decrypt-failed" };
    }
    const listed = await pgRestoreList(tmpPlain);
    return { ok: listed.ok, encrypted: true, reason: listed.reason };
  } finally {
    // NEVER leave a plaintext dump behind.
    await unlinkQuiet(tmpPlain);
  }
}
