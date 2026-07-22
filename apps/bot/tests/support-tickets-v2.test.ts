import { type Panel, prisma, type Service, type User } from "@zedbot/database";
import { type SupportAttachmentInput, validateSupportAttachment } from "@zedbot/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "v2-test-secret-v2-test-secret-abc";

import {
  logSupportAttachmentAccepted,
  logSupportAttachmentRejected,
  supportAttachmentEventCounts,
} from "../src/services/support-attachment-log.service.js";
import {
  addAdminTicketReply,
  addUserTicketReply,
  closeSupportTicket,
  createSupportTicket,
  notifyAdminsAboutNewTicket,
  notifyUserAboutAdminReply,
  resolveAdminAttachment,
  resolveUserAttachment,
} from "../src/services/support-ticket.service.js";

// =============================================================================
// Support Tickets V2 — DB integration (§27): attachment persistence, structured
// category/origin/linked-Service, sourceUpdateId idempotency, owner/admin-scoped
// attachment retrieval, notification content (category + linked Service + 📎),
// and the privacy-safe aggregate counters. Shared disposable PostgreSQL; skips
// without DATABASE_URL.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const MiB = 1024 * 1024;
const GIB = 1024n * 1024n * 1024n;
const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));

// sourceUpdateId is a Postgres int8 (BigInt) and globally unique. runTag is
// derived from Date.now() (distinct per run/file) so `runTag + seq` never
// collides with another file's ids, and stays well within int8 range.
let updateSeq = 0n;
function nextUpdateId(): bigint {
  updateSeq += 1n;
  return runTag + updateSeq;
}

function photoInput(): SupportAttachmentInput {
  const r = validateSupportAttachment(
    { type: "PHOTO", fileId: "PHOTO_FILE_ID_XYZ", fileUniqueId: "puid", sizeBytes: BigInt(2 * MiB) },
    { maxBytes: 15 * MiB },
  );
  if (!r.ok) throw new Error("photo fixture invalid");
  return r.attachment;
}

const MIME_BY_EXT: Record<string, string> = {
  ".pdf": "application/pdf",
  ".log": "text/plain",
  ".txt": "text/plain",
  ".json": "application/json",
};

function docInput(name = "report.pdf"): SupportAttachmentInput {
  const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
  const r = validateSupportAttachment(
    { type: "DOCUMENT", fileId: "DOC_FILE_ID_XYZ", fileUniqueId: "duid", fileName: name, mimeType: MIME_BY_EXT[ext], sizeBytes: 4096n },
    { maxBytes: 15 * MiB },
  );
  if (!r.ok) throw new Error("document fixture invalid");
  return r.attachment;
}

function recorder(failChatIds: string[] = []) {
  const calls: Array<{ chatId: string; text: string; other?: Record<string, unknown> }> = [];
  return {
    calls,
    api: {
      sendMessage: async (chatId: string, text: string, other?: Record<string, unknown>): Promise<unknown> => {
        if (failChatIds.includes(chatId)) throw new Error("blocked");
        calls.push({ chatId, text, other });
        return {};
      },
    },
  };
}

describe.runIf(hasDb)("support tickets V2", () => {
  let owner: User;
  let foreigner: User;
  let admin: { id: string; telegramId: bigint };
  let panel: Panel;
  let service: Service;

  beforeAll(async () => {
    owner = await prisma.user.create({ data: { telegramId: runTag + 1n } });
    foreigner = await prisma.user.create({ data: { telegramId: runTag + 2n } });
    admin = await prisma.admin.create({
      data: { telegramId: runTag + 3n, role: "OWNER", isActive: true },
    });
    panel = await prisma.panel.create({
      data: {
        type: "MARZBAN",
        name: `v2-mz-${runTag}`,
        baseUrl: "http://127.0.0.1:1/api",
        username: "u",
        passwordEncrypted: "enc",
        status: "ACTIVE",
        provisioningReady: true,
      },
    });
    service = await prisma.service.create({
      data: {
        userId: owner.id,
        panelId: panel.id,
        panelType: "MARZBAN",
        username: `v2-svc-${runTag}`,
        status: "ACTIVE",
        volumeBytes: 10n * GIB,
        usedBytes: 0n,
        remainingBytes: 10n * GIB,
        expiresAt: new Date(Date.now() + 30 * 86_400_000),
      },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("persists an attachment reference + category/origin/serviceId (schema)", async () => {
    const outcome = await createSupportTicket({
      userId: owner.id,
      subject: `ضمیمه ${runTag}`,
      content: { text: "توضیح", attachment: photoInput(), sourceUpdateId: nextUpdateId() },
      category: "CONNECTION",
      origin: "SERVICE_DETAIL",
      serviceId: service.id,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.ticket.category).toBe("CONNECTION");
    expect(outcome.ticket.origin).toBe("SERVICE_DETAIL");
    expect(outcome.ticket.serviceId).toBe(service.id);

    const message = await prisma.supportMessage.findFirstOrThrow({ where: { ticketId: outcome.ticket.id } });
    expect(message.attachmentType).toBe("PHOTO");
    expect(message.fileId).toBe("PHOTO_FILE_ID_XYZ");
    expect(message.fileUniqueId).toBe("puid");
    expect(message.fileSizeBytes).toBe(BigInt(2 * MiB));
    expect(message.text).toBe("توضیح");
  });

  it("a text-only ticket keeps every V2 field null (additive regression)", async () => {
    const outcome = await createSupportTicket({
      userId: owner.id,
      subject: `متن ${runTag}`,
      content: { text: "فقط متن" },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.ticket.category).toBeNull();
    expect(outcome.ticket.origin).toBeNull();
    expect(outcome.ticket.serviceId).toBeNull();
    const message = await prisma.supportMessage.findFirstOrThrow({ where: { ticketId: outcome.ticket.id } });
    expect(message.attachmentType).toBeNull();
    expect(message.fileId).toBeNull();
    expect(message.sourceUpdateId).toBeNull();
  });

  it("is idempotent on a duplicate inbound update_id (one ticket, created:false)", async () => {
    const sourceUpdateId = nextUpdateId();
    const first = await createSupportTicket({
      userId: owner.id,
      subject: `تکراری ${runTag}`,
      content: { text: "بار اول", sourceUpdateId },
    });
    const second = await createSupportTicket({
      userId: owner.id,
      subject: `تکراری ${runTag}`,
      content: { text: "بار دوم", sourceUpdateId },
    });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.ticket.id).toBe(first.ticket.id);
    // Exactly one message carries that update id; no second ticket exists.
    expect(await prisma.supportMessage.count({ where: { sourceUpdateId } })).toBe(1);
  });

  it("accepts user + admin replies with attachments; a duplicate update is a no-op", async () => {
    const created = await createSupportTicket({
      userId: owner.id,
      subject: `پاسخ‌ها ${runTag}`,
      content: { text: "شروع" },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const ticketId = created.ticket.id;

    await addAdminTicketReply(admin.id, {
      ticketId,
      content: { text: "پاسخ ادمین", attachment: docInput("guide.pdf"), sourceUpdateId: nextUpdateId() },
    });
    const adminMsg = await prisma.supportMessage.findFirstOrThrow({
      where: { ticketId, senderType: "ADMIN" },
    });
    expect(adminMsg.attachmentType).toBe("DOCUMENT");
    expect(adminMsg.fileName).toBe("guide.pdf");

    const replyUpdate = nextUpdateId();
    const r1 = await addUserTicketReply(owner.id, {
      ticketId,
      content: { text: null, attachment: photoInput(), sourceUpdateId: replyUpdate },
    });
    const r2 = await addUserTicketReply(owner.id, {
      ticketId,
      content: { text: null, attachment: photoInput(), sourceUpdateId: replyUpdate },
    });
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r1.created).toBe(true);
    expect(r2.created).toBe(false);
    expect(await prisma.supportMessage.count({ where: { sourceUpdateId: replyUpdate } })).toBe(1);
  });

  it("refuses any reply once the ticket is CLOSED", async () => {
    const created = await createSupportTicket({
      userId: owner.id,
      subject: `بسته ${runTag}`,
      content: { text: "شروع" },
    });
    if (!created.ok) throw new Error("setup failed");
    await closeSupportTicket(admin.id, created.ticket.id);
    const userReply = await addUserTicketReply(owner.id, {
      ticketId: created.ticket.id,
      content: { text: "بعد از بستن", attachment: photoInput(), sourceUpdateId: nextUpdateId() },
    });
    expect(userReply.ok).toBe(false);
    const adminReply = await addAdminTicketReply(admin.id, {
      ticketId: created.ticket.id,
      content: { text: "دیر", sourceUpdateId: nextUpdateId() },
    });
    expect(adminReply.ok).toBe(false);
  });

  it("resolves attachments owner/admin-scoped; foreign & non-attachment fail", async () => {
    const created = await createSupportTicket({
      userId: owner.id,
      subject: `دریافت ${runTag}`,
      content: { text: null, attachment: docInput("dump.log"), sourceUpdateId: nextUpdateId() },
      category: "CONNECTION",
    });
    if (!created.ok) throw new Error("setup failed");
    const ticketId = created.ticket.id;
    const ts = ticketId.slice(0, 8);
    const attMsg = await prisma.supportMessage.findFirstOrThrow({ where: { ticketId, fileId: { not: null } } });
    const ms = attMsg.id.slice(0, 8);

    const owned = await resolveUserAttachment(owner.id, ts, ms);
    expect(owned?.type).toBe("DOCUMENT");
    expect(owned?.fileId).toBe("DOC_FILE_ID_XYZ");
    // Foreign user cannot resolve the owner's attachment.
    expect(await resolveUserAttachment(foreigner.id, ts, ms)).toBeNull();
    // Admin can resolve any ticket's attachment.
    expect((await resolveAdminAttachment(ts, ms))?.fileId).toBe("DOC_FILE_ID_XYZ");
    // A message short id that does not belong to the ticket fails.
    expect(await resolveUserAttachment(owner.id, ts, "ffffffff")).toBeNull();
    // A gibberish short id fails.
    expect(await resolveUserAttachment(owner.id, "zz", ms)).toBeNull();
  });

  it("notifications carry category + linked Service label + the 📎 indicator", async () => {
    const created = await createSupportTicket({
      userId: owner.id,
      subject: `اعلان ${runTag}`,
      content: { text: "متن", attachment: photoInput(), sourceUpdateId: nextUpdateId() },
      category: "CONNECTION",
      origin: "SERVICE_DETAIL",
      serviceId: service.id,
    });
    if (!created.ok) throw new Error("setup failed");

    const adminNotice = recorder();
    await notifyAdminsAboutNewTicket(adminNotice.api, created.ticket.id);
    const adminText = adminNotice.calls.find((c) => c.chatId === admin.telegramId.toString())?.text ?? "";
    expect(adminText).toContain("دسته: اتصال");
    expect(adminText).toContain(`سرویس مرتبط: ${service.username}`);
    expect(adminText).toContain("📎 دارای ضمیمه");

    // Admin replies with TEXT only → the user notice must NOT show the 📎 line.
    await addAdminTicketReply(admin.id, {
      ticketId: created.ticket.id,
      content: { text: "پاسخ بدون فایل", sourceUpdateId: nextUpdateId() },
    });
    const userNotice = recorder();
    await notifyUserAboutAdminReply(userNotice.api, created.ticket.id);
    const userText = userNotice.calls[0]?.text ?? "";
    expect(userText).toContain("دسته: اتصال");
    expect(userText).not.toContain("📎 دارای ضمیمه");
  });

  it("privacy-safe counters increment on accepted + rejected events", async () => {
    const before = await supportAttachmentEventCounts(1);
    await logSupportAttachmentAccepted({
      operation: "new_ticket",
      senderType: "USER",
      attachmentType: "PHOTO",
      sizeBytes: BigInt(2 * MiB),
      category: "CONNECTION",
      origin: "SERVICE_DETAIL",
      userId: owner.id,
      ticketId: null,
    });
    await logSupportAttachmentRejected({
      operation: "user_reply",
      senderType: "USER",
      reason: "TOO_LARGE",
      userId: owner.id,
      ticketId: null,
    });
    const after = await supportAttachmentEventCounts(1);
    expect(after.accepted).toBeGreaterThanOrEqual(before.accepted + 1);
    expect(after.rejected).toBeGreaterThanOrEqual(before.rejected + 1);

    // The persisted rows never carry raw content (text/caption/fileId/filename).
    const row = await prisma.systemLog.findFirstOrThrow({
      where: { eventType: "support.attachment_accepted" },
      orderBy: { createdAt: "desc" },
    });
    const serialized = JSON.stringify(row.metadata);
    expect(serialized).not.toContain("PHOTO_FILE_ID_XYZ");
    expect(serialized).not.toContain("report.pdf");
    expect(serialized).toContain("sizeBucket");
  });
});

describe.skipIf(hasDb)("support tickets V2 (skipped)", () => {
  it("requires DATABASE_URL — see docs/testing.md", () => {
    expect(hasDb).toBe(false);
  });
});
