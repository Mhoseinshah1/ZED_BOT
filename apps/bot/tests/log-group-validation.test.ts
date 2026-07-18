import { prisma, LogGroupSetupStatus, type Admin } from "@zedbot/database";
import { LOG_GROUP_SAFE_MESSAGES } from "@zedbot/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "log-group-validation-tests-secret";

import { initialSession } from "../src/core/session.js";
import {
  LOG_GROUP_ID_FLOW,
  logGroupIdTextHandler,
} from "../src/handlers/admin-settings/log-group-id.handler.js";
import {
  INVALID_CHAT_ID_TEXT,
  prepareLogGroupConnection,
} from "../src/services/log-group-connection.service.js";
import { resetOpsQueueForTests } from "../src/services/ops-queue.service.js";
import {
  clearLogGroupSettings,
  deleteAttemptsFor,
  flatButtons,
  makeProbeApi,
  textCtx,
  type ProbeApiConfig as HarnessProbeConfig,
} from "./helpers/log-group-harness.js";

// =============================================================================
// Scenarios 15-26: the ONE shared validation policy through
// prepareLogGroupConnection + probeLogGroupTarget. Every reject maps to a
// stable safe code (NOT_FOUND / NOT_SUPERGROUP / TOPICS_DISABLED /
// BOT_NOT_MEMBER / BOT_NOT_ADMIN / MISSING_TOPIC_PERMISSION /
// OWNER_NOT_MEMBER) and raw Telegram descriptions never surface. A valid
// private forum is accepted (isPublic false); a public one is accepted with
// isPublic true and the handler shows the public-group warning before preview.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const hasRedis = (process.env.REDIS_URL ?? "") !== "" || (process.env.REDIS_HOST ?? "") !== "";

const OWNER_TG = 999_777_020;
const VALID_ID = "-1002000800011";

const SAFE_VALUES = new Set<string>(Object.values(LOG_GROUP_SAFE_MESSAGES));

async function expectReject(config: HarnessProbeConfig, safeCode: string): Promise<void> {
  const api = makeProbeApi(config);
  const result = await prepareLogGroupConnection(api, VALID_ID, OWNER_TG);
  expect(result.ok, safeCode).toBe(false);
  if (!result.ok) {
    expect(result.safeCode, safeCode).toBe(safeCode);
    expect(result.safeMessage).toBe(LOG_GROUP_SAFE_MESSAGES[safeCode as keyof typeof LOG_GROUP_SAFE_MESSAGES]);
  }
}

describe.runIf(hasDb)("shared validation policy - scenarios 15-25", () => {
  afterAll(async () => {
    await clearLogGroupSettings();
    await resetOpsQueueForTests();
    await prisma.$disconnect();
  });

  it("15. chat not found -> NOT_FOUND", async () => {
    await expectReject({ chat: "not-found" }, "NOT_FOUND");
  });

  it("16. a normal (non-super) group -> NOT_SUPERGROUP", async () => {
    await expectReject({ chat: { type: "group", is_forum: false, title: "Basic" } }, "NOT_SUPERGROUP");
  });

  it("17. a channel -> NOT_SUPERGROUP", async () => {
    await expectReject(
      { chat: { type: "channel", is_forum: true, title: "News", username: "chan" } },
      "NOT_SUPERGROUP",
    );
  });

  it("18. a supergroup with Topics disabled -> TOPICS_DISABLED", async () => {
    await expectReject({ chat: { type: "supergroup", is_forum: false, title: "Flat" } }, "TOPICS_DISABLED");
  });

  it("19. the bot has left / lookup fails -> BOT_NOT_MEMBER", async () => {
    await expectReject({ botMember: { status: "left" } }, "BOT_NOT_MEMBER");
    await expectReject({ botMember: { status: "kicked" } }, "BOT_NOT_MEMBER");
    await expectReject({ botMember: "throw" }, "BOT_NOT_MEMBER");
  });

  it("20. the bot is a plain member -> BOT_NOT_ADMIN", async () => {
    await expectReject({ botMember: { status: "member" } }, "BOT_NOT_ADMIN");
  });

  it("21. the bot is admin without manage-topics -> MISSING_TOPIC_PERMISSION", async () => {
    await expectReject(
      { botMember: { status: "administrator", can_manage_topics: false } },
      "MISSING_TOPIC_PERMISSION",
    );
  });

  it("22. the OWNER is not a member of the target -> OWNER_NOT_MEMBER", async () => {
    await expectReject({ ownerMember: { status: "left" } }, "OWNER_NOT_MEMBER");
    await expectReject({ ownerMember: "throw" }, "OWNER_NOT_MEMBER");
  });

  it("23. a valid PRIVATE forum supergroup is accepted (isPublic false)", async () => {
    const api = makeProbeApi({
      chat: { type: "supergroup", is_forum: true, title: "Private Ops" },
    });
    const result = await prepareLogGroupConnection(api, VALID_ID, OWNER_TG);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.chatId).toBe(VALID_ID);
      expect(result.isPublic).toBe(false);
      expect(result.title).toBe("Private Ops");
    }
  });

  it("24. a valid PUBLIC forum supergroup is accepted with isPublic true", async () => {
    const api = makeProbeApi({
      chat: { type: "supergroup", is_forum: true, title: "Public Ops", username: "public_ops" },
    });
    const result = await prepareLogGroupConnection(api, VALID_ID, OWNER_TG);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.isPublic).toBe(true);
    }
  });

  it("25. every rejection is a safe message - raw Telegram text never leaks", async () => {
    const configs: Array<[string, HarnessProbeConfig]> = [
      ["NOT_FOUND", { chat: "not-found" }],
      ["NOT_SUPERGROUP", { chat: { type: "channel", is_forum: true } }],
      ["TOPICS_DISABLED", { chat: { type: "supergroup", is_forum: false } }],
      ["BOT_NOT_MEMBER", { botMember: "throw" }],
      ["BOT_NOT_ADMIN", { botMember: { status: "member" } }],
      ["MISSING_TOPIC_PERMISSION", { botMember: { status: "administrator", can_manage_topics: false } }],
      ["OWNER_NOT_MEMBER", { ownerMember: { status: "kicked" } }],
    ];
    for (const [label, config] of configs) {
      const api = makeProbeApi(config);
      const result = await prepareLogGroupConnection(api, VALID_ID, OWNER_TG);
      expect(result.ok, label).toBe(false);
      if (!result.ok) {
        expect(SAFE_VALUES.has(result.safeMessage), `${label} is a safe message`).toBe(true);
        for (const raw of ["Bad Request", "Forbidden", "chat not found", "GrammyError", "error_code"]) {
          expect(result.safeMessage.includes(raw), `${label} leaks "${raw}"`).toBe(false);
        }
      }
    }
    // The invalid-format path is safe too (and is not a probe verdict).
    const bad = await prepareLogGroupConnection(makeProbeApi(), "@nope", OWNER_TG);
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.safeMessage).toBe(INVALID_CHAT_ID_TEXT);
    }
  });
});

describe.runIf(hasDb && hasRedis)("public-group warning UI branch - scenario 26", () => {
  let owner: Admin;

  beforeAll(async () => {
    owner = await prisma.admin.create({
      data: { telegramId: BigInt(OWNER_TG + 1), role: "OWNER", isActive: true },
    });
    await clearLogGroupSettings();
  });

  afterEach(async () => {
    await deleteAttemptsFor([owner.id]);
  });

  afterAll(async () => {
    await deleteAttemptsFor([owner.id]);
    await prisma.auditLog.deleteMany({
      where: { entityType: "LogGroupSetupAttempt", actorTelegramId: owner.telegramId },
    });
    await prisma.admin.deleteMany({ where: { id: owner.id } });
    await resetOpsQueueForTests();
    await prisma.$disconnect();
  });

  it("26. a valid public group shows the ⚠️ public warning BEFORE the preview", async () => {
    const session = initialSession();
    session.currentFlow = LOG_GROUP_ID_FLOW;
    const { ctx, sent } = textCtx(VALID_ID, {
      admin: owner,
      session,
      probe: { chat: { type: "supergroup", is_forum: true, title: "Public Ops", username: "pub_ops" } },
    });
    await logGroupIdTextHandler.middleware()(ctx as never, async () => {});

    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("این گروه عمومی است");
    // The warning gates the preview: no confirmation body yet.
    expect(sent[0].text).not.toContain("تایید اتصال گروه لاگ");
    // Its keyboard offers the "continue with public" acknowledgement (pubok).
    const callbacks = flatButtons(sent[0]).map((b) => b.callback_data ?? "");
    expect(callbacks.some((c) => /^admin:lg:id_pubok:[0-9a-f]{4,12}$/.test(c))).toBe(true);
    // A VALIDATED attempt was created (not yet running).
    const attempt = await prisma.logGroupSetupAttempt.findFirst({
      where: { requestedByAdminId: owner.id },
    });
    expect(attempt?.status).toBe(LogGroupSetupStatus.VALIDATED);
  });
});
