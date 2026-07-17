import { Prisma, prisma, type SystemLog } from "@zedbot/database";
import {
  getRedisOptions,
  LOG_DELIVERY_QUEUE_NAME,
  OPS_LOG_TOPIC_KEYS,
  OPS_LOG_TOPIC_TITLES,
  REDACTED_VALUE,
  type OpsLogTopicKey,
} from "@zedbot/shared";
import { Queue } from "bullmq";
import { GrammyError } from "grammy";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "ops-log-delivery-tests-secret-01";

import { classifyTelegramError, maskChatId } from "../src/services/log-group.service.js";
import { resetOpsQueueForTests } from "../src/services/ops-queue.service.js";
import {
  clearSettingsCache,
  deleteSetting,
  setSetting,
} from "../src/services/settings.service.js";
import {
  LOG_GROUP_CHAT_ID_KEY,
  writeSystemLog,
} from "../src/services/system-log.service.js";

// =============================================================================
// Telegram operational logging (bot side): writeSystemLog ALWAYS persists the
// SystemLog row first; a SystemLogDelivery is created only when the topicKey
// maps to an ENABLED LogTopic AND the log group chat id Setting exists. The
// [systemLogId, logTopicId] unique makes duplicate deliveries impossible,
// metadata/messages are scrubbed before persistence, and a dead Redis can
// never make writeSystemLog throw. Telegram error classification and chat-id
// masking are covered as pure functions.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

const runTag = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const evPrefix = `ops-log-test.${runTag}`;
const CHAT_ID = "-1001234";
const DISABLED_KEY: OpsLogTopicKey = "ORDER";

async function fetchLog(eventType: string): Promise<SystemLog | null> {
  return prisma.systemLog.findFirst({ where: { eventType } });
}

async function deliveriesOf(systemLogId: string) {
  return prisma.systemLogDelivery.findMany({ where: { systemLogId } });
}

function tgError(errorCode: number, description: string): GrammyError {
  return new GrammyError(
    "Call to 'sendMessage' failed!",
    { ok: false, error_code: errorCode, description },
    "sendMessage",
    {},
  );
}

describe.runIf(hasDb)("ops log delivery pipeline", () => {
  beforeAll(async () => {
    // Robust seed: every stable ops topic key must have a LogTopic row.
    for (const key of OPS_LOG_TOPIC_KEYS) {
      await prisma.logTopic.upsert({
        where: { key },
        update: {},
        create: { key, title: OPS_LOG_TOPIC_TITLES[key] },
      });
    }
    await prisma.logTopic.update({ where: { key: DISABLED_KEY }, data: { isEnabled: true } });
    // Deterministic start: the log group is NOT configured.
    await deleteSetting(LOG_GROUP_CHAT_ID_KEY);
    clearSettingsCache();
  });

  afterAll(async () => {
    // Undo every global mutation so other suites stay green.
    await prisma.logTopic.update({ where: { key: DISABLED_KEY }, data: { isEnabled: true } });
    await deleteSetting(LOG_GROUP_CHAT_ID_KEY);
    clearSettingsCache();
    await prisma.systemLogDelivery.deleteMany({
      where: { systemLog: { is: { eventType: { startsWith: evPrefix } } } },
    });
    await prisma.systemLog.deleteMany({ where: { eventType: { startsWith: evPrefix } } });
    const options = getRedisOptions();
    if (options !== null) {
      const queue = new Queue(LOG_DELIVERY_QUEUE_NAME, {
        connection: { ...options, maxRetriesPerRequest: null },
      });
      await queue.obliterate({ force: true }).catch(() => undefined);
      await queue.close();
    }
    await resetOpsQueueForTests();
    await prisma.$disconnect();
  });

  it("persists the SystemLog but creates NO delivery while the log group is unconfigured", async () => {
    const eventType = `${evPrefix}.unconfigured`;
    await writeSystemLog({
      level: "INFO",
      eventType,
      message: "unconfigured group event",
      topicKey: "SYSTEM",
    });
    const log = await fetchLog(eventType);
    expect(log).not.toBeNull();
    expect(await deliveriesOf(log?.id ?? "")).toHaveLength(0);
  });

  it("creates exactly one PENDING delivery for an enabled topic once the group is configured", async () => {
    await setSetting(LOG_GROUP_CHAT_ID_KEY, CHAT_ID, "STRING");
    const eventType = `${evPrefix}.configured`;
    await writeSystemLog({
      level: "INFO",
      eventType,
      message: "configured group event",
      topicKey: "SYSTEM",
    });
    const log = await fetchLog(eventType);
    expect(log).not.toBeNull();
    const deliveries = await deliveriesOf(log?.id ?? "");
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].status).toBe("PENDING");
    const systemTopic = await prisma.logTopic.findUnique({ where: { key: "SYSTEM" } });
    expect(deliveries[0].logTopicId).toBe(systemTopic?.id);
  });

  it("skips delivery for a disabled topic while still writing the SystemLog row", async () => {
    await setSetting(LOG_GROUP_CHAT_ID_KEY, CHAT_ID, "STRING");
    await prisma.logTopic.update({ where: { key: DISABLED_KEY }, data: { isEnabled: false } });
    try {
      const eventType = `${evPrefix}.disabled-topic`;
      await writeSystemLog({
        level: "WARN",
        eventType,
        message: "disabled topic event",
        topicKey: DISABLED_KEY,
      });
      const log = await fetchLog(eventType);
      expect(log).not.toBeNull(); // source of truth is preserved
      expect(await deliveriesOf(log?.id ?? "")).toHaveLength(0);
    } finally {
      await prisma.logTopic.update({ where: { key: DISABLED_KEY }, data: { isEnabled: true } });
    }
  });

  it("enforces the [systemLogId, logTopicId] unique pair with P2002", async () => {
    const log = await fetchLog(`${evPrefix}.configured`);
    const delivery = (await deliveriesOf(log?.id ?? ""))[0];
    expect(delivery).toBeDefined();
    let caught: unknown = null;
    try {
      await prisma.systemLogDelivery.create({
        data: { systemLogId: delivery.systemLogId, logTopicId: delivery.logTopicId },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((caught as Prisma.PrismaClientKnownRequestError).code).toBe("P2002");
  });

  it("routes PAYMENT/BACKUP/PANEL/SECURITY/AUDIT logs to their own LogTopic rows", async () => {
    await setSetting(LOG_GROUP_CHAT_ID_KEY, CHAT_ID, "STRING");
    const keys: OpsLogTopicKey[] = ["PAYMENT", "BACKUP", "PANEL", "SECURITY", "AUDIT"];
    for (const key of keys) {
      const eventType = `${evPrefix}.route.${key}`;
      await writeSystemLog({
        level: "INFO",
        eventType,
        message: `routing check ${key}`,
        topicKey: key,
      });
      const log = await fetchLog(eventType);
      expect(log, key).not.toBeNull();
      const deliveries = await deliveriesOf(log?.id ?? "");
      expect(deliveries, key).toHaveLength(1);
      const topic = await prisma.logTopic.findUnique({ where: { key } });
      expect(deliveries[0].logTopicId, key).toBe(topic?.id);
    }
  });

  it("redacts metadata keys and scrubs secret-shaped values end-to-end", async () => {
    const eventType = `${evPrefix}.redaction`;
    await writeSystemLog({
      level: "ERROR",
      eventType,
      message: "cache redis://:cache-pw@127.0.0.1:6379 unreachable",
      metadata: { token: "x", note: "postgres://user:pass@h/db", orderId: "o-1" },
      topicKey: "SYSTEM",
    });
    const log = await fetchLog(eventType);
    expect(log).not.toBeNull();
    const metadata = log?.metadata as { token: string; note: string; orderId: string };
    expect(metadata.token).toBe(REDACTED_VALUE);
    expect(metadata.note).toContain(REDACTED_VALUE);
    expect(metadata.note).not.toContain("postgres://");
    expect(metadata.orderId).toBe("o-1");
    expect(log?.message).not.toContain("redis://");
    expect(log?.message).not.toContain("cache-pw");
  });

  it(
    "never throws when the delivery queue is unreachable - the row stays PENDING for the sweep",
    async () => {
      await setSetting(LOG_GROUP_CHAT_ID_KEY, CHAT_ID, "STRING");
      const originalRedisUrl = process.env.REDIS_URL;
      process.env.REDIS_URL = "redis://127.0.0.1:6499"; // nothing listens here
      await resetOpsQueueForTests();
      try {
        const eventType = `${evPrefix}.redis-down`;
        await expect(
          writeSystemLog({
            level: "WARN",
            eventType,
            message: "redis down event",
            topicKey: "SYSTEM",
          }),
        ).resolves.toBeUndefined();
        const log = await fetchLog(eventType);
        expect(log).not.toBeNull();
        const deliveries = await deliveriesOf(log?.id ?? "");
        expect(deliveries).toHaveLength(1);
        expect(deliveries[0].status).toBe("PENDING");
      } finally {
        if (originalRedisUrl === undefined) {
          delete process.env.REDIS_URL;
        } else {
          process.env.REDIS_URL = originalRedisUrl;
        }
        await resetOpsQueueForTests();
      }
    },
    30_000,
  );

  it("classifies Telegram failures into safe Persian lines (never raw payloads)", () => {
    expect(classifyTelegramError(tgError(429, "Too Many Requests: retry after 5"))).toBe(
      "محدودیت نرخ تلگرام (429) - کمی بعد دوباره تلاش کنید.",
    );
    expect(classifyTelegramError(tgError(400, "Bad Request: chat not found"))).toBe(
      "گروه پیدا نشد. ربات باید عضو گروه باشد.",
    );
    expect(
      classifyTelegramError(tgError(403, "Forbidden: bot was kicked from the supergroup chat")),
    ).toBe("ربات از گروه حذف شده است.");
    expect(
      classifyTelegramError(tgError(403, "Forbidden: bot is not a member of the supergroup chat")),
    ).toBe("ربات از گروه حذف شده است.");
    expect(
      classifyTelegramError(tgError(400, "Bad Request: not enough rights to manage topics")),
    ).toBe("ربات باید در این گروه مدیر باشد و دسترسی مدیریت موضوعات داشته باشد.");
    expect(classifyTelegramError(tgError(400, "Bad Request: CHAT_ADMIN_REQUIRED"))).toBe(
      "ربات باید در این گروه مدیر باشد و دسترسی مدیریت موضوعات داشته باشد.",
    );
    expect(
      classifyTelegramError(tgError(400, "Bad Request: message thread not found")),
    ).toContain("موضوع (تاپیک)");
    expect(classifyTelegramError(tgError(400, "Bad Request: TOPIC_CLOSED"))).toContain(
      "موضوع (تاپیک)",
    );
    expect(
      classifyTelegramError(tgError(400, "Bad Request: the chat is not a forum supergroup")),
    ).toBe("قابلیت موضوعات (Topics) گروه فعال نیست.");
    // Unmatched Telegram error: generic safe line, no description echoed.
    const generic = classifyTelegramError(tgError(400, "Bad Request: MESSAGE_TOO_LONG"));
    expect(generic).toBe("ارسال به گروه لاگ ناموفق بود. دسترسی‌های ربات را بررسی کنید.");
    expect(generic).not.toContain("MESSAGE_TOO_LONG");
    // Non-Telegram failure: network line.
    expect(classifyTelegramError(new Error("ECONNRESET"))).toBe(
      "ارسال به گروه لاگ ناموفق بود. اتصال شبکه را بررسی کنید.",
    );
  });

  it("masks chat ids to first-4 + last-2 digits", () => {
    expect(maskChatId("-1001234567890")).toBe("-1001…90");
    expect(maskChatId("1234567")).toBe("1234…67");
    expect(maskChatId("-100123")).toBe("-100123"); // short ids stay whole
    expect(maskChatId("123456")).toBe("123456");
    expect(maskChatId("")).toBe("");
  });
});

describe.skipIf(hasDb)("ops log delivery (skipped)", () => {
  it("log delivery tests require DATABASE_URL - see docs/testing.md", () => {
    expect(hasDb).toBe(false);
  });
});
