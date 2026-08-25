import { readFile } from "node:fs/promises";

import { BOT_READINESS_MARKER_PATH, linuxProcessStartTicks, readBotReadiness } from "../core/readiness-marker.js";

const expectedKeys = ["components", "formatVersion", "generation", "processId", "processInstanceId", "processStartTicks", "processStartedAt", "readyAt", "state"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateMarker(value: unknown): asserts value is Record<string, unknown> {
  if (!isRecord(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedKeys)) throw new Error("bot-readiness-schema-invalid");
  if (value.formatVersion !== 1 || value.state !== "ready") throw new Error("bot-readiness-state-invalid");
  // PID 1 is the bot's own, expected identity: docker-compose runs it as the
  // sole process in its container with no init/tini wrapper, so grammY's own
  // process is container PID 1. Only non-positive values are impossible.
  if (typeof value.processId !== "number" || !Number.isSafeInteger(value.processId) || value.processId < 1) throw new Error("bot-readiness-pid-invalid");
  if (typeof value.processInstanceId !== "string" || !/^[a-f0-9-]{36}$/.test(value.processInstanceId)) throw new Error("bot-readiness-instance-invalid");
  if (typeof value.processStartTicks !== "string" || !/^[0-9]+$/.test(value.processStartTicks)) throw new Error("bot-readiness-process-start-invalid");
  if (typeof value.processStartedAt !== "number" || typeof value.readyAt !== "number" || value.processStartedAt > value.readyAt) throw new Error("bot-readiness-time-invalid");
  if (typeof value.generation !== "string" || !/^[a-f0-9]{40}$/.test(value.generation)) throw new Error("bot-readiness-generation-invalid");
  if (!isRecord(value.components) || JSON.stringify(Object.keys(value.components).sort()) !== JSON.stringify(["application", "handlers", "localLoops", "shutdownHandlers"]) || !Object.values(value.components).every((entry) => entry === true)) throw new Error("bot-readiness-components-incomplete");
}

async function main(): Promise<void> {
  const marker = await readBotReadiness();
  validateMarker(marker);
  const pid = marker.processId as number;
  process.kill(pid, 0);
  const command = await readFile(`/proc/${pid}/cmdline`, "utf8");
  if (!command.includes("apps/bot/dist/index.js")) throw new Error("bot-readiness-process-mismatch");
  const currentStartTicks = linuxProcessStartTicks(await readFile(`/proc/${pid}/stat`, "utf8"));
  if (currentStartTicks !== marker.processStartTicks) throw new Error("bot-readiness-process-reused");
  process.stdout.write(`${JSON.stringify(marker)}\n`);
}

// Guarded so tests can import validateMarker() without triggering a live
// readiness probe (process.kill, /proc reads) as an import side effect.
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    if (isRecord(error) && error.code === "ENOENT") {
      process.stdout.write('{"formatVersion":1,"state":"starting"}\n');
      process.exitCode = 3;
      return;
    }
    // Fixed non-secret diagnostic only. Never print marker contents or env.
    process.stderr.write(`bot-readiness-unavailable:${BOT_READINESS_MARKER_PATH}\n`);
    process.exitCode = 1;
  });
}
