import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { BACKUP_MANIFEST_SUFFIX, backupDumpFileName } from "@zedbot/shared";

// =============================================================================
// Backup file plumbing: timestamped names with collision avoidance, sha256,
// best-effort fsync durability and the non-secret sidecar manifest.
// =============================================================================

/** UTC YYYYMMDD-HHMMSS, the shortId embedded in every backup file name. */
export function formatUtcStamp(date: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  return (
    `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
    `-${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}`
  );
}

/**
 * Picks a final backup file name that does not collide with an existing
 * file (nor with an in-flight .partial); collisions only happen when two
 * backups start within the same second, so we walk forward one second at a
 * time. Bounded so a pathological directory cannot loop forever.
 */
export function pickBackupFileName(
  dir: string,
  encrypted: boolean,
  partialSuffix: string,
): { finalName: string; stamp: string } {
  let at = new Date();
  for (let i = 0; i < 120; i += 1) {
    const stamp = formatUtcStamp(at);
    const finalName = backupDumpFileName(stamp, encrypted);
    const finalPath = path.join(dir, finalName);
    if (!existsSync(finalPath) && !existsSync(`${finalPath}${partialSuffix}`)) {
      return { finalName, stamp };
    }
    at = new Date(at.getTime() + 1000);
  }
  throw new Error("filename-collision");
}

/** Streams a file through sha256; returns the lowercase hex digest. */
export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

/** Best-effort fsync of a file (durability before/after the atomic rename). */
export async function fsyncFile(filePath: string): Promise<void> {
  try {
    const handle = await open(filePath, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Best-effort only - some filesystems/bind mounts refuse it.
  }
}

/** Best-effort fsync of a directory so the rename itself is durable. */
export async function fsyncDir(dirPath: string): Promise<void> {
  try {
    const handle = await open(dirPath, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directory fsync is a Linux nicety, not a hard requirement.
  }
}

/** Atomic promote: fsync tmp, rename tmp -> final, fsync the directory. */
export async function promotePartialFile(tmpPath: string, finalPath: string): Promise<void> {
  await fsyncFile(tmpPath);
  await rename(tmpPath, finalPath);
  await fsyncDir(path.dirname(finalPath));
}

// --- manifest ---------------------------------------------------------------

export type ManifestVerification = "PENDING" | "VERIFIED" | "CORRUPT";

/** Non-secret sidecar describing one backup file (for humans + tooling). */
export interface BackupManifest {
  operationId: string;
  filename: string;
  createdAt: string;
  appVersion: string | null;
  pgClientVersion: string | null;
  dumpFormat: "custom";
  formatVersion: number;
  sizeBytes: number;
  sha256: string;
  encrypted: boolean;
  verification: ManifestVerification;
}

export function manifestPath(backupFilePath: string): string {
  return `${backupFilePath}${BACKUP_MANIFEST_SUFFIX}`;
}

export async function writeManifest(backupFilePath: string, manifest: BackupManifest): Promise<void> {
  await writeFile(manifestPath(backupFilePath), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

/** Rewrites only the verification field; missing/broken manifests are ignored. */
export async function updateManifestVerification(
  backupFilePath: string,
  verification: ManifestVerification,
): Promise<void> {
  try {
    const raw = await readFile(manifestPath(backupFilePath), "utf8");
    const parsed = JSON.parse(raw) as BackupManifest;
    parsed.verification = verification;
    await writeManifest(backupFilePath, parsed);
  } catch {
    // The manifest is a convenience sidecar - never fail the operation on it.
  }
}

/** Removes a file, swallowing ENOENT (used for tmp + manifest cleanup). */
export async function unlinkQuiet(filePath: string): Promise<void> {
  await unlink(filePath).catch(() => undefined);
}
