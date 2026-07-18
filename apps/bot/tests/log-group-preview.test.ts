import { prisma, LogGroupSetupStatus, type Admin } from "@zedbot/database";
import { OPS_LOG_TOPIC_KEYS } from "@zedbot/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "log-group-preview-tests-secret-01";

import { initialSession } from "../src/core/session.js";
import {
  LOG_GROUP_ID_FLOW,
  logGroupIdHandler,
  logGroupIdTextHandler,
} from "../src/handlers/admin-settings/log-group-id.handler.js";
import {
  attemptShortId,
} from "../src/services/log-group-connection.service.js";
import { maskChatId, saveLogGroup } from "../src/services/log-group.service.js";
import { resetOpsQueueForTests } from "../src/services/ops-queue.service.js";
import {
  callbackCtx,
  clearLogGroupSettings,
  deleteAttemptsFor,
  flatButtons,
  textCtx,
  type SentMessage,
} from "./helpers/log-group-harness.js";

// =============================================================================
// Scenarios 27-32: the masked confirmation preview. The preview shows the safe
// title, the MASKED chat id (never the full id), the number of default topics
// (OPS_LOG_TOPIC_KEYS.length) and a confirm button whose callback carries ONLY
// the attempt short id - the chat id NEVER travels in callback data. A
// replacement warning appears only when a group is already active. Confirming
// is OWNER-only: a SUPPORT admin is denied and the attempt stays VALIDATED.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const hasRedis = (process.env.REDIS_URL ?? "") !== "" || (process.env.REDIS_HOST ?? "") !== "";

const OWNER_TG = 999_777_030;
const SUPPORT_TG = 999_777_031;
const VALID_ID = "-1002000900011";
const OWNER_ONLY_TEXT = "این عملیات فقط برای مدیر اصلی (OWNER) مجاز است.";

describe.runIf(hasDb && hasRedis)("masked confirmation preview - scenarios 27-32", () => {
  let owner: Admin;
  let support: Admin;

  beforeAll(async () => {
    owner = await prisma.admin.create({
      data: { telegramId: BigInt(OWNER_TG), role: "OWNER", isActive: true },
    });
    support = await prisma.admin.create({
      data: { telegramId: BigInt(SUPPORT_TG), role: "SUPPORT", isActive: true },
    });
    await clearLogGroupSettings();
  });

  afterEach(async () => {
    await deleteAttemptsFor([owner.id]);
    await clearLogGroupSettings();
  });

  afterAll(async () => {
    await deleteAttemptsFor([owner.id]);
    await prisma.auditLog.deleteMany({
      where: {
        entityType: "LogGroupSetupAttempt",
        actorTelegramId: { in: [owner.telegramId, support.telegramId] },
      },
    });
    await prisma.admin.deleteMany({ where: { id: { in: [owner.id, support.id] } } });
    await resetOpsQueueForTests();
    await prisma.$disconnect();
  });

  /** Drives the valid-private-id text flow and returns the preview message. */
  async function renderPreview(): Promise<{ preview: SentMessage; attemptId: string }> {
    const session = initialSession();
    session.currentFlow = LOG_GROUP_ID_FLOW;
    const { ctx, sent } = textCtx(VALID_ID, {
      admin: owner,
      session,
      probe: { chat: { type: "supergroup", is_forum: true, title: "Private Ops Log" } },
    });
    await logGroupIdTextHandler.middleware()(ctx as never, async () => {});
    const attempt = await prisma.logGroupSetupAttempt.findFirstOrThrow({
      where: { requestedByAdminId: owner.id },
    });
    return { preview: sent[sent.length - 1], attemptId: attempt.id };
  }

  it("27. the preview shows the safe title + MASKED chat id (full id absent)", async () => {
    const { preview } = await renderPreview();
    expect(preview.text).toContain("Private Ops Log");
    expect(preview.text).toContain(maskChatId(VALID_ID));
    expect(preview.text).not.toContain(VALID_ID); // full id never rendered
    expect(preview.text).not.toContain("2000900011"); // nor its raw tail
  });

  it("28. the preview states the default-topic count = OPS_LOG_TOPIC_KEYS.length", async () => {
    const { preview } = await renderPreview();
    expect(preview.text).toContain(String(OPS_LOG_TOPIC_KEYS.length));
    expect(OPS_LOG_TOPIC_KEYS.length).toBe(11);
  });

  it("29. the confirm callback carries ONLY the attempt short id - no chat id", async () => {
    const { preview, attemptId } = await renderPreview();
    const sid = attemptShortId(attemptId);
    const callbacks = flatButtons(preview).map((b) => b.callback_data ?? "");
    expect(callbacks).toContain(`admin:lg:id_confirm:${sid}`);
    // No callback in the whole keyboard leaks the chat id (full or tail).
    for (const cb of callbacks) {
      expect(cb.includes(VALID_ID), cb).toBe(false);
      expect(cb.includes("2000900011"), cb).toBe(false);
    }
  });

  it("30. a replacement warning appears only when a group is already active", async () => {
    // Clean install: no replacement warning.
    const clean = await renderPreview();
    expect(clean.preview.text).not.toContain("جایگزین");
    await deleteAttemptsFor([owner.id]);

    // With an active group, the same preview warns about replacement.
    await saveLogGroup("-1002000900099", "Previous Group");
    const replacing = await renderPreview();
    expect(replacing.preview.text).toContain("جایگزین");
  });

  it("31. a SUPPORT admin cannot confirm - denial and the attempt stays VALIDATED", async () => {
    const { attemptId } = await renderPreview();
    const sid = attemptShortId(attemptId);
    const { ctx, toasts } = callbackCtx(`admin:lg:id_confirm:${sid}`, { admin: support });
    await logGroupIdHandler.middleware()(ctx as never, async () => {});
    expect(toasts).toContain(OWNER_ONLY_TEXT);
    const attempt = await prisma.logGroupSetupAttempt.findUnique({ where: { id: attemptId } });
    expect(attempt?.status).toBe(LogGroupSetupStatus.VALIDATED);
    expect(attempt?.activeSlot).toBeNull();
  });

  it("32. a SUPPORT admin typing an id mid-flow is denied by the OWNER gate", async () => {
    const session = initialSession();
    session.currentFlow = LOG_GROUP_ID_FLOW;
    const { ctx, sent } = textCtx(VALID_ID, { admin: support, session });
    await logGroupIdTextHandler.middleware()(ctx as never, async () => {});
    expect(sent[sent.length - 1].text).toBe(OWNER_ONLY_TEXT);
    expect(session.currentFlow).toBeNull(); // flow cleared on denial
    // No attempt was created for a non-owner.
    const count = await prisma.logGroupSetupAttempt.count({
      where: { requestedByAdminId: support.id },
    });
    expect(count).toBe(0);
  });
});
