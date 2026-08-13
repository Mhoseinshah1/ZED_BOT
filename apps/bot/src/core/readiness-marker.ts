import { randomUUID } from "node:crypto";
import { lstat, open, readFile, rename, unlink } from "node:fs/promises";

export const BOT_READINESS_MARKER_PATH = "/tmp/zedbot-bot-readiness.json";
export const BOT_READINESS_FORMAT_VERSION = 1;

export type BotReadinessMarker = {
  formatVersion: 1;
  state: "ready";
  processId: number;
  processInstanceId: string;
  processStartTicks: string;
  processStartedAt: number;
  readyAt: number;
  generation: string;
  components: {
    application: true;
    handlers: true;
    localLoops: true;
    shutdownHandlers: true;
  };
};

const PROCESS_STARTED_AT = Date.now();
const PROCESS_INSTANCE_ID = randomUUID();

export function linuxProcessStartTicks(stat: string): string {
  const commandEnd = stat.lastIndexOf(")");
  if (commandEnd < 0) throw new Error("bot-readiness-proc-stat-invalid");
  const fieldsAfterCommand = stat.slice(commandEnd + 2).trim().split(/\s+/);
  const startTicks = fieldsAfterCommand[19];
  if (startTicks === undefined || !/^[0-9]+$/.test(startTicks)) throw new Error("bot-readiness-proc-stat-invalid");
  return startTicks;
}

function isFullGitSha(value: string): boolean {
  return /^[a-f0-9]{40}$/.test(value);
}

export async function publishBotReadiness(
  generation: string,
  markerPath = BOT_READINESS_MARKER_PATH,
  now = Date.now(),
): Promise<BotReadinessMarker> {
  if (!isFullGitSha(generation)) throw new Error("bot-readiness-generation-invalid");
  const processStartTicks = linuxProcessStartTicks(await readFile("/proc/self/stat", "utf8"));
  const marker: BotReadinessMarker = {
    formatVersion: BOT_READINESS_FORMAT_VERSION,
    state: "ready",
    processId: process.pid,
    processInstanceId: PROCESS_INSTANCE_ID,
    processStartTicks,
    processStartedAt: PROCESS_STARTED_AT,
    readyAt: now,
    generation,
    components: { application: true, handlers: true, localLoops: true, shutdownHandlers: true },
  };
  const temporary = `${markerPath}.${PROCESS_INSTANCE_ID}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(marker)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    const existing = await lstat(markerPath).catch(() => null);
    if (existing?.isSymbolicLink()) throw new Error("bot-readiness-marker-symlinked");
    await rename(temporary, markerPath);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  return marker;
}

export async function completeBotStartupReadiness(input: {
  databaseInitialized: boolean;
  generation: string;
  markerPath?: string;
  now?: number;
}): Promise<BotReadinessMarker> {
  if (!input.databaseInitialized) throw new Error("bot-readiness-database-initialization-incomplete");
  return publishBotReadiness(input.generation, input.markerPath, input.now);
}

export async function removeBotReadiness(markerPath = BOT_READINESS_MARKER_PATH): Promise<void> {
  const existing = await lstat(markerPath).catch(() => null);
  if (existing === null) return;
  if (existing.isSymbolicLink() || !existing.isFile()) throw new Error("bot-readiness-marker-unsafe");
  await unlink(markerPath);
}

export async function readBotReadiness(markerPath = BOT_READINESS_MARKER_PATH): Promise<unknown> {
  const stat = await lstat(markerPath);
  if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o777) !== 0o600) {
    throw new Error("bot-readiness-marker-unsafe");
  }
  const raw = await readFile(markerPath, "utf8");
  return JSON.parse(raw) as unknown;
}
