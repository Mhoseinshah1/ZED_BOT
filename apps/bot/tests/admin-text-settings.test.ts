import { prisma, type Admin } from "@zedbot/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "phase34-test-secret-phase34-test-secret";

import {
  BUTTON_TEXT_MAX,
  getButtonTextByShortId,
  getMessageTemplateByShortId,
  INVALID_BUTTON_TEXT_TEXT,
  INVALID_TEMPLATE_CONTENT_TEXT,
  listButtonTexts,
  listMessageTemplates,
  NOT_EDITABLE_TEXT,
  resetButtonTextToDefault,
  resetMessageTemplateToDefault,
  TEMPLATE_CONTENT_MAX,
  TEXT_SETTINGS_PAGE_SIZE,
  updateButtonText,
  updateMessageTemplateContent,
} from "../src/services/admin-text-settings.service.js";
import { clearTextCache, getButtonText, getMessageTemplate } from "../src/services/text.service.js";

// =============================================================================
// Phase 34 admin text settings: list/lookup, editable-guarded update/reset
// with updatedByAdminId stamping, validation bounds and the cache
// round-trip. Shared disposable PostgreSQL (docs/testing.md); skips without
// DATABASE_URL.
// =============================================================================

const hasDb =
  typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
const tag = runTag.toString();

describe.runIf(hasDb)("admin text settings (Phase 34)", () => {
  let admin: Admin;

  async function createTemplate(key: string, editable = true) {
    return prisma.messageTemplate.create({
      data: {
        key,
        title: `عنوان ${key}`,
        category: "test",
        defaultContent: `پیش‌فرض ${key}`,
        currentContent: `پیش‌فرض ${key}`,
        allowedVariables: ["name"],
        isEditable: editable,
      },
    });
  }

  async function createButton(key: string, editable = true) {
    return prisma.buttonText.create({
      data: {
        key,
        title: `عنوان ${key}`,
        defaultText: `پیش‌فرض ${key}`.slice(0, BUTTON_TEXT_MAX),
        currentText: `پیش‌فرض ${key}`.slice(0, BUTTON_TEXT_MAX),
        isEditable: editable,
      },
    });
  }

  beforeAll(async () => {
    admin = await prisma.admin.create({
      data: { telegramId: runTag + 945n, role: "OWNER", isActive: true },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("paginates templates and buttons; short ids resolve, gibberish fails", async () => {
    const template = await createTemplate(`p34_tpl_page_${tag}`);
    const button = await createButton(`p34_btn_page_${tag}`);

    const templates = await listMessageTemplates(1);
    expect(templates.templates.length).toBeLessThanOrEqual(TEXT_SETTINGS_PAGE_SIZE);
    expect(templates.total).toBeGreaterThanOrEqual(1);
    expect((await listMessageTemplates(9999)).page).toBe(
      (await listMessageTemplates(9999)).pages,
    );
    const buttons = await listButtonTexts(1);
    expect(buttons.buttons.length).toBeLessThanOrEqual(TEXT_SETTINGS_PAGE_SIZE);

    expect((await getMessageTemplateByShortId(template.id.slice(0, 8)))?.id).toBe(template.id);
    expect((await getButtonTextByShortId(button.id.slice(0, 8)))?.id).toBe(button.id);
    expect(await getMessageTemplateByShortId("zzzz")).toBeNull();
    expect(await getButtonTextByShortId("")).toBeNull();
  });

  it("updates and resets an editable template, stamping updatedByAdminId", async () => {
    const template = await createTemplate(`p34_tpl_edit_${tag}`);

    const updated = await updateMessageTemplateContent(
      template.id,
      "  متن جدید\nچندخطی  ",
      admin.id,
    );
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.template.currentContent).toBe("متن جدید\nچندخطی");
    expect(updated.template.updatedByAdminId).toBe(admin.id);
    expect(updated.template.defaultContent).toBe(`پیش‌فرض p34_tpl_edit_${tag}`);

    const reset = await resetMessageTemplateToDefault(template.id, admin.id);
    expect(reset.ok).toBe(true);
    if (!reset.ok) return;
    expect(reset.template.currentContent).toBe(reset.template.defaultContent);
    expect(reset.template.updatedByAdminId).toBe(admin.id);
  });

  it("refuses update/reset on a non-editable template", async () => {
    const locked = await createTemplate(`p34_tpl_lock_${tag}`, false);
    expect(await updateMessageTemplateContent(locked.id, "متن تازه", admin.id)).toEqual({
      ok: false,
      safeMessage: NOT_EDITABLE_TEXT,
    });
    expect(await resetMessageTemplateToDefault(locked.id, admin.id)).toEqual({
      ok: false,
      safeMessage: NOT_EDITABLE_TEXT,
    });
    const after = await prisma.messageTemplate.findUniqueOrThrow({ where: { id: locked.id } });
    expect(after.currentContent).toBe(`پیش‌فرض p34_tpl_lock_${tag}`);
    expect(after.updatedByAdminId).toBeNull();
  });

  it("updates and resets an editable button, stamping updatedByAdminId", async () => {
    const button = await createButton(`p34_btn_edit_${tag}`);

    const updated = await updateButtonText(button.id, "  دکمه جدید 🔘 ", admin.id);
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.button.currentText).toBe("دکمه جدید 🔘");
    expect(updated.button.updatedByAdminId).toBe(admin.id);

    const reset = await resetButtonTextToDefault(button.id, admin.id);
    expect(reset.ok).toBe(true);
    if (!reset.ok) return;
    expect(reset.button.currentText).toBe(reset.button.defaultText);
  });

  it("refuses update/reset on a non-editable button", async () => {
    const locked = await createButton(`p34_btn_lock_${tag}`, false);
    expect(await updateButtonText(locked.id, "متن", admin.id)).toEqual({
      ok: false,
      safeMessage: NOT_EDITABLE_TEXT,
    });
    expect(await resetButtonTextToDefault(locked.id, admin.id)).toEqual({
      ok: false,
      safeMessage: NOT_EDITABLE_TEXT,
    });
  });

  it("validates length bounds for both kinds", async () => {
    const template = await createTemplate(`p34_tpl_len_${tag}`);
    const button = await createButton(`p34_btn_len_${tag}`);

    expect(await updateMessageTemplateContent(template.id, "   ", admin.id)).toEqual({
      ok: false,
      safeMessage: INVALID_TEMPLATE_CONTENT_TEXT,
    });
    expect(
      await updateMessageTemplateContent(template.id, "x".repeat(TEMPLATE_CONTENT_MAX + 1), admin.id),
    ).toEqual({ ok: false, safeMessage: INVALID_TEMPLATE_CONTENT_TEXT });
    expect(await updateButtonText(button.id, "", admin.id)).toEqual({
      ok: false,
      safeMessage: INVALID_BUTTON_TEXT_TEXT,
    });
    expect(await updateButtonText(button.id, "y".repeat(BUTTON_TEXT_MAX + 1), admin.id)).toEqual({
      ok: false,
      safeMessage: INVALID_BUTTON_TEXT_TEXT,
    });
  });

  it("clears the text cache: reads see the new value immediately", async () => {
    const buttonKey = `p34_btn_cache_${tag}`;
    const templateKey = `p34_tpl_cache_${tag}`;
    const button = await createButton(buttonKey);
    const template = await createTemplate(templateKey);
    clearTextCache();

    // Warm the cache with the old values.
    expect(await getButtonText(buttonKey)).toBe(`پیش‌فرض ${buttonKey}`.slice(0, BUTTON_TEXT_MAX));
    expect(await getMessageTemplate(templateKey)).toBe(`پیش‌فرض ${templateKey}`);

    expect((await updateButtonText(button.id, "متن کش‌شکن", admin.id)).ok).toBe(true);
    expect(
      (await updateMessageTemplateContent(template.id, "قالب کش‌شکن", admin.id)).ok,
    ).toBe(true);

    // Within the 30s TTL - only clearTextCache() makes these visible now.
    expect(await getButtonText(buttonKey)).toBe("متن کش‌شکن");
    expect(await getMessageTemplate(templateKey)).toBe("قالب کش‌شکن");
  });
});

describe.skipIf(hasDb)("admin text settings (skipped)", () => {
  it("text settings tests require DATABASE_URL - see docs/testing.md", () => {
    expect(hasDb).toBe(false);
  });
});
