import { readFileSync } from "node:fs";

import { connectDatabase, disconnectDatabase, prisma } from "@zedbot/database";
import { APP_NAME, createLogger, errorMessage, getRedisOptions, intEnv, optionalEnv } from "@zedbot/shared";
import Fastify from "fastify";
import { Redis } from "ioredis";

const logger = createLogger("api");
const port = intEnv("API_PORT", 3000);
const host = "0.0.0.0";

function readOwnVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.1.0";
  } catch {
    return "0.1.0";
  }
}
const version = readOwnVersion();

// One long-lived Redis client for health probes. enableOfflineQueue=false
// makes pings fail immediately while disconnected instead of queueing
// forever; the retry strategy keeps reconnecting in the background.
const redisOptions = getRedisOptions();
const redis =
  redisOptions === null
    ? null
    : new Redis({
        ...redisOptions,
        lazyConnect: true,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        retryStrategy: () => 5000,
      });

if (redis !== null) {
  // ioredis crashes the process on unhandled "error" events.
  redis.on("error", (err) => {
    logger.debug("redis connection error", { error: errorMessage(err) });
  });
  redis.connect().catch(() => {
    // Initial connection failures are reported through /health.
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms).unref();
    }),
  ]);
}

const app = Fastify({ logger: false });

app.get("/health", async (_request, reply) => {
  let database = "ok";
  let redisStatus = "ok";
  const details: Record<string, string> = {};

  try {
    await withTimeout(prisma.$queryRaw`SELECT 1`, 3000);
  } catch (err) {
    database = "error";
    details.database = errorMessage(err);
  }

  if (redis === null) {
    redisStatus = "not_configured";
  } else {
    try {
      await withTimeout(redis.ping(), 3000);
    } catch (err) {
      redisStatus = "error";
      details.redis = errorMessage(err);
    }
  }

  const ok = database === "ok" && redisStatus !== "error";
  return reply.code(ok ? 200 : 503).send({
    ok,
    service: "api",
    database,
    redis: redisStatus,
    ...(Object.keys(details).length > 0 ? { details } : {}),
  });
});

app.get("/version", async () => ({
  app: APP_NAME,
  version,
  environment: optionalEnv("NODE_ENV", "development"),
}));

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info(`received ${signal}, shutting down`);
  try {
    await app.close();
    if (redis !== null) {
      redis.disconnect();
    }
    await disconnectDatabase();
  } catch (err) {
    logger.warn("error during shutdown", { error: errorMessage(err) });
  }
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

async function main(): Promise<void> {
  // A database that is briefly unavailable at boot must not crash the API -
  // /health reports the real state and Docker's healthcheck handles it.
  try {
    await connectDatabase();
    logger.info("database connection established");
  } catch (err) {
    logger.warn("database not reachable at startup, continuing", { error: errorMessage(err) });
  }
  await app.listen({ port, host });
  logger.info(`ZED_BOT api service started on http://${host}:${port}`);
}

main().catch((err: unknown) => {
  logger.error("api failed to start", { error: errorMessage(err) });
  process.exit(1);
});
