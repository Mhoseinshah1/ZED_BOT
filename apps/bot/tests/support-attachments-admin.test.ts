import { type Admin, prisma } from "@zedbot/database";
import { SUPPORT_ATTACHMENT_MAX_BYTES_DEFAULT, SUPPORT_ATTACHMENTS_ENABLED_KEY } from "@zedbot/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "supatt-admin-secret-0123456789abc";

import { initialSession } from "../src/core/session.js";
import { supportAttachmentsAdminHandler } from "../src/handlers/admin-settings/support-attachments-admin.handler.js";
import {
  isSupportAttachmentsEnabled,
  supportAttachmentMaxBytes,
} from "../src/services/support-attachment-settings.service.js";
import { clearSettingsCache, setSetting } from "../src/services/settings.service.js";

// =============================================================================
// Support Tickets V2 — §24 OWNER attachment-settings page: OWNER-only guard,
// master-switch toggle (CAS), size presets, reset-to-default, and the synthetic
// preview. Real DB; captured fake ctx.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const d = hasDb ? describe : describe.skip;
const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
const MiB = 1024 * 1024;

interface Btn {
  text: string;
  data?: string;
}
interface Cap {
  edits: Array<{ text: string; buttons: Btn[] }>;
  toasts: Array<string | undefined>;
  session: ReturnType<typeof initialSession>;
  admin: Admin | null;
}

function flatButtons(markup: unknown): Btn[] {
  const kb = (markup as { inline_keyboard?: Array<Array<Record<string, string>>> })?.inline_keyboard;
  if (!Array.isArray(kb)) return [];
  return kb.flat().map((b) => ({ text: b.text, data: b.callback_data }));
}

function ctxFor(cap: Cap, data: string) {
  const callbackQuery = { id: "cbq", data, message: { message_id: 5, chat: { id: 9, type: "private" } } };
  return {
    session: cap.session,
    admin: cap.admin,
    from: { id: 9, first_name: "A" },
    callbackQuery,
    update: { update_id: 1, callback_query: callbackQuery },
    match: undefined as unknown,
    reply: async () => ({}),
    editMessageText: async (text: string, other?: { reply_markup?: unknown }) => {
      cap.edits.push({ text, buttons: flatButtons(other?.reply_markup) });
      return {};
    },
    answerCallbackQuery: async (p?: { text?: string }) => {
      cap.toasts.push(p?.text);
      return true;
    },
  } as never;
}

async function cb(cap: Cap, data: string): Promise<void> {
  await supportAttachmentsAdminHandler.middleware()(ctxFor(cap, data), async () => undefined);
}

d("support attachments OWNER settings (§24)", () => {
  let owner: Admin;
  let support: Admin;

  beforeAll(async () => {
    owner = await prisma.admin.create({ data: { telegramId: runTag + 1n, role: "OWNER", isActive: true } });
    support = await prisma.admin.create({ data: { telegramId: runTag + 2n, role: "SUPPORT", isActive: true } });
    await setSetting(SUPPORT_ATTACHMENTS_ENABLED_KEY, "false", "BOOLEAN");
    clearSettingsCache();
  });

  afterAll(async () => {
    // Never leak an enabled flag / non-default ceiling into other suites.
    await setSetting(SUPPORT_ATTACHMENTS_ENABLED_KEY, "false", "BOOLEAN").catch(() => undefined);
    await prisma.setting
      .delete({ where: { key: "support_attachment_max_bytes" } })
      .catch(() => undefined);
    clearSettingsCache();
  });

  it("denies a non-OWNER admin (no page rendered)", async () => {
    const cap: Cap = { edits: [], toasts: [], session: initialSession(), admin: support };
    await cb(cap, "admin:supatt:root");
    expect(cap.edits).toHaveLength(0);
    expect(cap.toasts[0]).toContain("مالک");
  });

  it("renders the landing with status, ceiling and formats for the OWNER", async () => {
    const cap: Cap = { edits: [], toasts: [], session: initialSession(), admin: owner };
    await cb(cap, "admin:supatt:root");
    expect(cap.edits).toHaveLength(1);
    const page = cap.edits[0];
    expect(page.text).toContain("تنظیمات ضمیمه‌ها");
    expect(page.text).toContain("غیرفعال");
    expect(page.text).toContain(".pdf");
    expect(page.buttons.some((b) => b.data === "admin:supatt:toggle")).toBe(true);
    expect(page.buttons.some((b) => b.data === "admin:supatt:preview")).toBe(true);
  });

  it("toggles the master switch (CAS) on and back off", async () => {
    const cap: Cap = { edits: [], toasts: [], session: initialSession(), admin: owner };
    await cb(cap, "admin:supatt:toggle");
    clearSettingsCache();
    expect(await isSupportAttachmentsEnabled()).toBe(true);
    await cb(cap, "admin:supatt:toggle");
    clearSettingsCache();
    expect(await isSupportAttachmentsEnabled()).toBe(false);
  });

  it("applies a size preset and resets to the code default", async () => {
    const cap: Cap = { edits: [], toasts: [], session: initialSession(), admin: owner };
    await cb(cap, `admin:supatt:size:${10 * MiB}`);
    clearSettingsCache();
    expect(await supportAttachmentMaxBytes()).toBe(10 * MiB);
    await cb(cap, "admin:supatt:reset");
    clearSettingsCache();
    expect(await supportAttachmentMaxBytes()).toBe(SUPPORT_ATTACHMENT_MAX_BYTES_DEFAULT);
  });

  it("renders a synthetic preview without touching a real ticket", async () => {
    const cap: Cap = { edits: [], toasts: [], session: initialSession(), admin: owner };
    await cb(cap, "admin:supatt:preview");
    expect(cap.edits).toHaveLength(1);
    const text = cap.edits[0].text;
    expect(text).toContain("پیش‌نمایش");
    expect(text).toContain("📷 تصویر");
    expect(text).toContain("📎 فایل");
  });
});
