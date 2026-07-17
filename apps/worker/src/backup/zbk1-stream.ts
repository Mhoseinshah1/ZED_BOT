import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";

import { createBackupEncryptor, type BackupEncryptor } from "@zedbot/shared";

// =============================================================================
// Streaming ZBK1 envelope writer shared by the pg_dump pipeline and the
// encrypt-backup CLI: header once, ciphertext chunks, auth tag last.
// =============================================================================

/** ZBK1 envelope as an async-generator transform: header, ciphertext, tag. */
export async function* zbk1Stream(
  source: AsyncIterable<Buffer>,
  encryptor: BackupEncryptor,
): AsyncGenerator<Buffer> {
  yield encryptor.header;
  for await (const chunk of source) {
    const cipherText = encryptor.cipher.update(chunk);
    if (cipherText.length > 0) {
      yield cipherText;
    }
  }
  const finalChunk = encryptor.cipher.final();
  if (finalChunk.length > 0) {
    yield finalChunk;
  }
  yield encryptor.cipher.getAuthTag();
}

/** Encrypts an existing file into a new ZBK1 envelope (exclusive create). */
export async function encryptFileToZbk1(
  inputPath: string,
  outputPath: string,
  password: string,
): Promise<void> {
  const encryptor = createBackupEncryptor(password);
  await pipeline(
    createReadStream(inputPath),
    (source) => zbk1Stream(source as AsyncIterable<Buffer>, encryptor),
    createWriteStream(outputPath, { flags: "wx", mode: 0o600 }),
  );
}
