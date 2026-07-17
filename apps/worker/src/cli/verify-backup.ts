import path from "node:path";

import { backupEncryptionPassword } from "../config.js";
import { verifyBackupFile } from "../backup/verify.js";

// =============================================================================
// CLI: verify one backup file (plain custom-format dump or ZBK1-encrypted
// dump). Usage:
//
//   node dist/cli/verify-backup.js <path-to-backup>
//
// Encrypted files need BACKUP_ENCRYPTION_PASSWORD in the environment.
// Prints JSON {ok, encrypted, reason} and exits 0 only on a verified file.
// =============================================================================

async function main(): Promise<void> {
  const target = process.argv[2];
  if (target === undefined || target.trim() === "") {
    process.stderr.write("usage: verify-backup <path-to-backup>\n");
    process.exit(1);
  }
  const result = await verifyBackupFile(path.resolve(target), backupEncryptionPassword());
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.ok ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(`verify-backup failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
