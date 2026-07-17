import { unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  WORKER_CAPABILITIES_KEY,
  WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_HEARTBEAT_KEY,
  WORKER_HEARTBEAT_TTL_SECONDS,
  createLogger,
  errorMessage,
  type WorkerCapabilities,
} from "@zedbot/shared";

import { backupDir } from "./config.js";
import { pgDumpVersion } from "./backup/pg.js";
import type { RawRedis } from "./redis.js";

// =============================================================================
// Worker liveness + capability publishing. The bot's health page reads both
// keys: the heartbeat proves the worker process is alive, the capabilities
// snapshot carries the facts only THIS container can know (pg_dump presence,
// backup-dir writability) because the bot's own mount is read-only.
// =============================================================================

const logger = createLogger("worker:heartbeat");

/** write+unlink probe - the only reliable writability test on bind mounts. */
export async function probeBackupDirWritable(dir: string): Promise<boolean> {
  const probePath = path.join(dir, `.zedbot-write-test-${process.pid}`);
  try {
    await writeFile(probePath, "probe", { flag: "w" });
    await unlink(probePath);
    return true;
  } catch {
    await unlink(probePath).catch(() => undefined);
    return false;
  }
}

async function publishOnce(redis: RawRedis): Promise<void> {
  const now = new Date().toISOString();
  await redis.set(WORKER_HEARTBEAT_KEY, now, "EX", WORKER_HEARTBEAT_TTL_SECONDS);

  const dir = backupDir();
  const capabilities: WorkerCapabilities = {
    pgDumpVersion: await pgDumpVersion(),
    backupDirWritable: await probeBackupDirWritable(dir),
    backupDir: dir,
    checkedAt: now,
  };
  await redis.set(
    WORKER_CAPABILITIES_KEY,
    JSON.stringify(capabilities),
    "EX",
    WORKER_HEARTBEAT_TTL_SECONDS,
  );
}

/**
 * Starts the heartbeat/capabilities loop (immediate tick + fixed cadence).
 * Returns a stop function for graceful shutdown. Publish errors (Redis blips)
 * are logged and retried on the next tick - the TTL handles staleness.
 */
export function startHeartbeat(redis: RawRedis): () => void {
  let inFlight = false;
  const tick = (): void => {
    if (inFlight) {
      return; // A slow pg_dump probe must not stack ticks.
    }
    inFlight = true;
    publishOnce(redis)
      .catch((err: unknown) => {
        logger.warn("heartbeat publish failed", { error: errorMessage(err) });
      })
      .finally(() => {
        inFlight = false;
      });
  };
  tick();
  const timer = setInterval(tick, WORKER_HEARTBEAT_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
