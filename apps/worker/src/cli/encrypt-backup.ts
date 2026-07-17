import path from "node:path";

import { backupEncryptionPassword } from "../config.js";
import { encryptFileToZbk1 } from "../backup/zbk1-stream.js";

// =============================================================================
// CLI: wrap an existing (plain) backup file in the ZBK1 AES-256-GCM
// envelope. Usage:
//
//   node dist/cli/encrypt-backup.js <input> <output>
//
// Requires BACKUP_ENCRYPTION_PASSWORD. The output is created exclusively
// (never overwrites) and the input file is left untouched.
// =============================================================================

async function main(): Promise<void> {
  const [input, output] = process.argv.slice(2);
  if (input === undefined || output === undefined) {
    process.stderr.write("usage: encrypt-backup <input> <output>\n");
    process.exit(1);
  }
  const password = backupEncryptionPassword();
  if (password === null) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: "password-missing" })}\n`);
    process.exit(1);
  }
  try {
    await encryptFileToZbk1(path.resolve(input), path.resolve(output), password);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const reason =
      code === "ENOENT" ? "input-missing" : code === "EEXIST" ? "output-exists" : "encrypt-failed";
    process.stdout.write(`${JSON.stringify({ ok: false, error: reason })}\n`);
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, output: path.resolve(output) })}\n`);
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`encrypt-backup failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
