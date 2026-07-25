import { type Admin, prisma, TermsDocumentStatus } from "@zedbot/database";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "terms-admin-tests-secret";

import { initialSession } from "../src/core/session.js";
import {
  OWNER_ONLY_TEXT,
  termsAdminHandler,
  termsAdminTextHandler,
  termsCommandEscapeHandler,
} from "../src/handlers/admin-settings/terms-admin.handler.js";
import { clearSettingsCache, getBooleanSettingFresh } from "../src/services/settings.service.js";
import {
  createTermsDraft,
  enableTermsRequirement,
  getDraftTerms,
  getPublishedTerms,
  publishTermsDraft,
  recordTermsAcceptance,
  TERMS_MAX_BODY_LENGTH,
  TERMS_REQUIRED_KEY,
  updateTermsDraftBody,
} from "../src/services/terms/terms-document.service.js";
import { toPersianDigits } from "../src/services/terms/terms-views.js";
import { clearTextCache } from "../src/services/text.service.js";

// =============================================================================
// Versioned mandatory terms — OWNER ADMIN UI (§8, §9, §13, §14).
//
// Covers the OWNER guard (fails closed), the overview, the draft text flow and
// its escapes, the publish confirmation and its staleness check, history
// pagination, and the privacy rule that no user identity ever reaches a page.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

const TELEGRAM_ID_BASE = 8_300_000_000_000n;
const RUN_TAG = BigInt(Date.now() % 1_000_000_000);
let seq = 0n;

const OWNER = {
  id: "terms-owner-admin",
  role: "OWNER",
  isActive: true,
  telegramId: 556_000_1n,
} as unknown as Admin;
const SELLER = {
  id: "terms-seller-admin",
  role: "SELLER",
  isActive: true,
  telegramId: 556_000_2n,
} as unknown as Admin;

interface Recorders {
  sent: Array<{ text: string; other?: Record<string, unknown> }>;
  toasts: Array<string | undefined>;
}

function baseCtx(
  admin: Admin | null,
  session: ReturnType<typeof initialSession>,
  rec: Recorders,
): Record<string, unknown> {
  return {
    admin,
    session,
    from: { id: Number(admin?.telegramId ?? 999n), is_bot: false, first_name: "Owner" },
    api: {},
    reply: async (text: string, other?: Record<string, unknown>) => {
      rec.sent.push({ text, other });
      return {};
    },
    editMessageText: async (text: string, other?: Record<string, unknown>) => {
      rec.sent.push({ text, other });
      return {};
    },
    answerCallbackQuery: async (payload?: { text?: string }) => {
      rec.toasts.push(payload?.text);
      return true;
    },
  };
}

function callbackCtx(data: string, admin: Admin | null, session = initialSession()) {
  const rec: Recorders = { sent: [], toasts: [] };
  const chat = { id: 1, type: "private" };
  const callback_query = {
    id: "cbq",
    chat_instance: "ci",
    from: { id: Number(admin?.telegramId ?? 999n), is_bot: false, first_name: "Owner" },
    data,
    message: { message_id: 1, date: 0, chat },
  };
  const ctx = {
    ...baseCtx(admin, session, rec),
    chat,
    callbackQuery: callback_query,
    update: { update_id: 1, callback_query },
  };
  return { ctx: ctx as never, rec, session };
}

function textCtx(text: string, admin: Admin | null, session = initialSession()) {
  const rec: Recorders = { sent: [], toasts: [] };
  const chat = { id: Number(admin?.telegramId ?? 999n), type: "private" };
  const message = {
    message_id: 2,
    date: 0,
    chat,
    from: { id: Number(admin?.telegramId ?? 999n), is_bot: false, first_name: "Owner" },
    text,
  };
  const ctx = {
    ...baseCtx(admin, session, rec),
    chat,
    message,
    update: { update_id: 2, message },
  };
  return { ctx: ctx as never, rec, session };
}

/** Runs a callback through the admin composer. */
async function runCallback(data: string, admin: Admin | null, session = initialSession()) {
  const t = callbackCtx(data, admin, session);
  let passedThrough = false;
  await termsAdminHandler.middleware()(t.ctx, async () => {
    passedThrough = true;
  });
  return { ...t, passedThrough };
}

/** Runs a text message through the flow composer. */
async function runText(text: string, admin: Admin | null, session = initialSession()) {
  const t = textCtx(text, admin, session);
  let passedThrough = false;
  await termsAdminTextHandler.middleware()(t.ctx, async () => {
    passedThrough = true;
  });
  return { ...t, passedThrough };
}

function allText(rec: Recorders): string {
  return rec.sent.map((s) => s.text).join("\n");
}

function buttonLabels(rec: Recorders): string[] {
  const labels: string[] = [];
  for (const s of rec.sent) {
    const markup = s.other?.reply_markup as { inline_keyboard?: { text: string }[][] } | undefined;
    for (const row of markup?.inline_keyboard ?? []) {
      for (const b of row) labels.push(b.text);
    }
  }
  return labels;
}

function buttonCallbacks(rec: Recorders): string[] {
  const data: string[] = [];
  for (const s of rec.sent) {
    const markup = s.other?.reply_markup as
      | { inline_keyboard?: { callback_data?: string }[][] }
      | undefined;
    for (const row of markup?.inline_keyboard ?? []) {
      for (const b of row) if (b.callback_data !== undefined) data.push(b.callback_data);
    }
  }
  return data;
}

/**
 * Users created by THIS file, tracked by id. Cleanup deletes exactly these
 * rows: a telegramId-range delete would also hit users created by other
 * suites in the shared test database, and those may own Orders whose
 * foreign key then refuses the delete.
 */
const createdUserIds: string[] = [];

async function makeUser(): Promise<string> {
  seq += 1n;
  const row = await prisma.user.create({
    data: { telegramId: TELEGRAM_ID_BASE + RUN_TAG * 1000n + seq, status: "ACTIVE" },
  });
  createdUserIds.push(row.id);
  return row.id;
}

async function publish(body: string): Promise<string> {
  const draft = await createTermsDraft(null);
  if (!draft.ok) throw new Error(`draft failed: ${draft.code}`);
  const updated = await updateTermsDraftBody(draft.draft.id, body);
  if (!updated.ok) throw new Error(`body failed: ${updated.code}`);
  const published = await publishTermsDraft(updated.draft.id, null);
  if (!published.ok) throw new Error(`publish failed: ${published.code}`);
  return published.document.id;
}

async function resetAll(): Promise<void> {
  await prisma.termsAcceptance.deleteMany({});
  await prisma.termsDocument.deleteMany({});
  if (createdUserIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    createdUserIds.length = 0;
  }
  await prisma.setting.deleteMany({ where: { key: TERMS_REQUIRED_KEY } });
  clearSettingsCache();
  clearTextCache();
}

describe.runIf(hasDb)("terms admin — OWNER guard (§8)", () => {
  beforeEach(resetAll);
  afterAll(async () => {
    await resetAll();
    await prisma.$disconnect();
  });

  it("A01 a non-OWNER admin is refused on the root page", async () => {
    const { rec } = await runCallback("admin:terms:root", SELLER);
    expect(rec.toasts).toEqual([OWNER_ONLY_TEXT]);
    expect(rec.sent).toHaveLength(0);
  });

  it("A02 a non-admin gets no answer at all", async () => {
    const { rec } = await runCallback("admin:terms:root", null);
    expect(rec.toasts).toHaveLength(0);
    expect(rec.sent).toHaveLength(0);
  });

  it("A03 EVERY mutating route refuses a non-OWNER", async () => {
    await publish("قوانین");
    const routes = [
      "admin:terms:enable",
      "admin:terms:disable",
      "admin:terms:draft_new",
      "admin:terms:draft_edit",
      "admin:terms:draft_del",
      "admin:terms:publish",
      "admin:terms:preview",
      "admin:terms:stats",
      "admin:terms:history:0",
    ];
    for (const route of routes) {
      const { rec } = await runCallback(route, SELLER);
      expect(rec.toasts, route).toEqual([OWNER_ONLY_TEXT]);
      expect(rec.sent, route).toHaveLength(0);
    }
    // Nothing changed.
    expect(await getDraftTerms()).toBeNull();
    expect(await getBooleanSettingFresh(TERMS_REQUIRED_KEY, false)).toBe(false);
  });

  it("A04 the text flow stops the moment the OWNER role is lost", async () => {
    const draft = await createTermsDraft(null);
    if (!draft.ok) throw new Error("draft failed");
    const session = initialSession();
    session.currentFlow = "terms:draft_body";
    session.temp.termsDraft = { documentId: draft.draft.id };

    // Same armed session, but the actor is no longer the OWNER.
    const { passedThrough } = await runText("متن جدید", SELLER, session);

    expect(passedThrough).toBe(true);
    expect(session.currentFlow).toBeNull();
    const row = await prisma.termsDocument.findUniqueOrThrow({ where: { id: draft.draft.id } });
    expect(row.body).toBe("");
  });
});

describe.runIf(hasDb)("terms admin — overview + buttons (§8)", () => {
  beforeEach(resetAll);
  afterAll(async () => {
    await resetAll();
    await prisma.$disconnect();
  });

  it("A05 the overview reports enforcement, version, date, draft state and counts", async () => {
    const id = await publish("متن قوانین منتشرشده");
    const user = await makeUser();
    await enableTermsRequirement();
    await recordTermsAcceptance(user, id);
    await runCallback("admin:terms:enable", OWNER);

    const { rec } = await runCallback("admin:terms:root", OWNER);
    const text = allText(rec);
    expect(text).toContain("📜 قوانین و شرایط");
    expect(text).toContain("وضعیت الزام: فعال ✅");
    expect(text).toContain(`نسخه منتشرشده: ${toPersianDigits(1)}`);
    expect(text).toContain("تاریخ انتشار:");
    expect(text).toContain("پیش‌نویس: ندارد");
    expect(text).toContain("پذیرفته‌اند:");
    expect(text).toContain("در انتظار پذیرش:");
    expect(text).toContain("متن قوانین منتشرشده");
  });

  it("A06 the overview NEVER shows a user identity", async () => {
    const id = await publish("قوانین");
    const userId = await makeUser();
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    await enableTermsRequirement();
    await recordTermsAcceptance(userId, id);

    const { rec } = await runCallback("admin:terms:root", OWNER);
    const text = allText(rec);
    expect(text).not.toContain(userId);
    expect(text).not.toContain(String(user.telegramId));
  });

  it("A07 the stats page shows aggregates only", async () => {
    const id = await publish("قوانین");
    const userId = await makeUser();
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    await enableTermsRequirement();
    await recordTermsAcceptance(userId, id);

    const { rec } = await runCallback("admin:terms:stats", OWNER);
    const text = allText(rec);
    expect(text).toContain("📊 آمار پذیرش");
    expect(text).toContain("پذیرفته‌اند:");
    expect(text).not.toContain(userId);
    expect(text).not.toContain(String(user.telegramId));
  });

  it("A08 the keyboard offers create-draft when none exists, edit/publish/delete when one does", async () => {
    await publish("قوانین");

    const before = await runCallback("admin:terms:root", OWNER);
    expect(buttonLabels(before.rec)).toContain("ایجاد پیش‌نویس جدید ➕");
    expect(buttonLabels(before.rec)).not.toContain("انتشار نسخه جدید 🚀");

    await createTermsDraft(null);

    const after = await runCallback("admin:terms:root", OWNER);
    const labels = buttonLabels(after.rec);
    expect(labels).toContain("ویرایش پیش‌نویس ✏️");
    expect(labels).toContain("انتشار نسخه جدید 🚀");
    expect(labels).toContain("حذف پیش‌نویس 🗑");
    expect(labels).not.toContain("ایجاد پیش‌نویس جدید ➕");
  });

  it("A09 the master-switch button reflects the current state", async () => {
    await publish("قوانین");

    const off = await runCallback("admin:terms:root", OWNER);
    expect(buttonLabels(off.rec)).toContain("فعال‌سازی تایید قوانین ✅");

    await runCallback("admin:terms:enable", OWNER);

    const on = await runCallback("admin:terms:root", OWNER);
    expect(buttonLabels(on.rec)).toContain("غیرفعال‌سازی تایید قوانین ❌");
  });

  it("A10 every keyboard route is a stable ASCII callback, never a Persian label", async () => {
    await publish("قوانین");
    await createTermsDraft(null);
    const { rec } = await runCallback("admin:terms:root", OWNER);
    for (const data of buttonCallbacks(rec)) {
      expect(data).toMatch(/^[\x20-\x7e]+$/);
    }
  });
});

describe.runIf(hasDb)("terms admin — enable/disable (§7)", () => {
  beforeEach(resetAll);
  afterAll(async () => {
    await resetAll();
    await prisma.$disconnect();
  });

  it("A11 enabling with no published version shows the exact required text", async () => {
    const { rec } = await runCallback("admin:terms:enable", OWNER);
    expect(allText(rec)).toContain("ابتدا یک نسخه معتبر از قوانین را منتشر کنید.");
    expect(await getBooleanSettingFresh(TERMS_REQUIRED_KEY, false)).toBe(false);
  });

  it("A12 enabling with only a draft shows the same refusal", async () => {
    const draft = await createTermsDraft(null);
    if (!draft.ok) throw new Error("draft failed");
    await updateTermsDraftBody(draft.draft.id, "متن پیش‌نویس");

    const { rec } = await runCallback("admin:terms:enable", OWNER);
    expect(allText(rec)).toContain("ابتدا یک نسخه معتبر از قوانین را منتشر کنید.");
    expect(await getBooleanSettingFresh(TERMS_REQUIRED_KEY, false)).toBe(false);
  });

  it("A13 enable then disable round-trips without touching documents", async () => {
    const id = await publish("قوانین");
    await runCallback("admin:terms:enable", OWNER);
    expect(await getBooleanSettingFresh(TERMS_REQUIRED_KEY, false)).toBe(true);

    await runCallback("admin:terms:disable", OWNER);
    expect(await getBooleanSettingFresh(TERMS_REQUIRED_KEY, false)).toBe(false);
    expect((await getPublishedTerms())?.id).toBe(id);
  });
});

describe.runIf(hasDb)("terms admin — draft flow (§9)", () => {
  beforeEach(resetAll);
  afterAll(async () => {
    await resetAll();
    await prisma.$disconnect();
  });

  it("A14 creating a draft arms the body flow bound to that document", async () => {
    await publish("متن منتشرشده");
    const session = initialSession();
    const { rec } = await runCallback("admin:terms:draft_new", OWNER, session);

    expect(session.currentFlow).toBe("terms:draft_body");
    const draft = await getDraftTerms();
    expect(session.temp.termsDraft?.documentId).toBe(draft?.id);
    // Seeded from the published body, and the prompt shows it.
    expect(allText(rec)).toContain("متن منتشرشده");
  });

  it("A15 a typed body is saved to the draft and the flow unwinds", async () => {
    const session = initialSession();
    await runCallback("admin:terms:draft_new", OWNER, session);
    const draftId = session.temp.termsDraft?.documentId ?? "";

    await runText("متن تازه قوانین", OWNER, session);

    expect(session.currentFlow).toBeNull();
    expect(session.temp.termsDraft).toBeUndefined();
    const row = await prisma.termsDocument.findUniqueOrThrow({ where: { id: draftId } });
    expect(row.body).toBe("متن تازه قوانین");
    expect(row.status).toBe(TermsDocumentStatus.DRAFT);
  });

  it("A16 an empty body is rejected and the flow STAYS armed for a retype", async () => {
    const session = initialSession();
    await runCallback("admin:terms:draft_new", OWNER, session);

    const { rec } = await runText("    \n  ", OWNER, session);

    expect(allText(rec)).toContain("متن قوانین نمی‌تواند خالی باشد.");
    expect(session.currentFlow).toBe("terms:draft_body");
  });

  it("A17 an over-long body is rejected with the limit stated", async () => {
    const session = initialSession();
    await runCallback("admin:terms:draft_new", OWNER, session);

    const { rec } = await runText("ب".repeat(TERMS_MAX_BODY_LENGTH + 5), OWNER, session);

    expect(allText(rec)).toContain(toPersianDigits(TERMS_MAX_BODY_LENGTH));
    expect(session.currentFlow).toBe("terms:draft_body");
  });

  it("A18 cancel unwinds the flow and returns to the overview", async () => {
    const session = initialSession();
    await runCallback("admin:terms:draft_new", OWNER, session);

    const { rec } = await runCallback("admin:terms:cancel", OWNER, session);

    expect(session.currentFlow).toBeNull();
    expect(session.temp.termsDraft).toBeUndefined();
    expect(rec.toasts).toContain("لغو شد.");
  });

  it("A19 a command mid-flow unwinds and falls through to the command handler", async () => {
    const session = initialSession();
    await runCallback("admin:terms:draft_new", OWNER, session);
    const draftId = session.temp.termsDraft?.documentId ?? "";

    const { passedThrough } = await runText("/start", OWNER, session);

    expect(passedThrough).toBe(true);
    expect(session.currentFlow).toBeNull();
    // "/start" was NOT stored as the terms body.
    const row = await prisma.termsDocument.findUniqueOrThrow({ where: { id: draftId } });
    expect(row.body).toBe("");
  });

  it("A20 the pre-command escape composer unwinds an armed flow too", async () => {
    const session = initialSession();
    await runCallback("admin:terms:draft_new", OWNER, session);

    const t = textCtx("/admin", OWNER, session);
    let passedThrough = false;
    await termsCommandEscapeHandler.middleware()(t.ctx, async () => {
      passedThrough = true;
    });

    expect(passedThrough).toBe(true);
    expect(session.currentFlow).toBeNull();
  });

  it("A21 text handlers pass through untouched when no terms flow is armed", async () => {
    const session = initialSession();
    session.currentFlow = "force_join:add";
    const { passedThrough } = await runText("https://t.me/x", OWNER, session);
    expect(passedThrough).toBe(true);
    expect(session.currentFlow).toBe("force_join:add");
  });

  it("A22 typing a body after the draft was deleted saves nothing", async () => {
    const session = initialSession();
    await runCallback("admin:terms:draft_new", OWNER, session);
    const draftId = session.temp.termsDraft?.documentId ?? "";
    await prisma.termsDocument.delete({ where: { id: draftId } });

    const { rec } = await runText("متن یتیم", OWNER, session);

    expect(allText(rec)).toContain("درخواست منقضی شده است. دوباره تلاش کنید.");
    expect(session.currentFlow).toBeNull();
    expect(await prisma.termsDocument.count()).toBe(0);
  });

  it("A23 deleting a draft is confirmed first, then removes only the draft", async () => {
    const publishedId = await publish("منتشرشده");
    const draft = await createTermsDraft(null);
    if (!draft.ok) throw new Error("draft failed");

    const confirm = await runCallback("admin:terms:draft_del", OWNER);
    expect(buttonLabels(confirm.rec)).toContain("تایید حذف 🗑");

    const shortId = draft.draft.id.slice(0, 8);
    await runCallback(`admin:terms:del_ok:${shortId}`, OWNER);

    expect(await getDraftTerms()).toBeNull();
    expect((await getPublishedTerms())?.id).toBe(publishedId);
  });

  it("A24 a delete confirmation naming a PUBLISHED document deletes nothing", async () => {
    const publishedId = await publish("منتشرشده");

    await runCallback(`admin:terms:del_ok:${publishedId.slice(0, 8)}`, OWNER);

    // The service filters on DRAFT, so the published document is untouched.
    expect((await getPublishedTerms())?.id).toBe(publishedId);
  });
});

describe.runIf(hasDb)("terms admin — publishing (§9, §10)", () => {
  beforeEach(resetAll);
  afterAll(async () => {
    await resetAll();
    await prisma.$disconnect();
  });

  it("A25 the confirmation shows old version, new version, warning and preview", async () => {
    await publish("نسخه یک");
    const draft = await createTermsDraft(null);
    if (!draft.ok) throw new Error("draft failed");
    await updateTermsDraftBody(draft.draft.id, "متن نسخه دو");

    const { rec } = await runCallback("admin:terms:publish", OWNER);
    const text = allText(rec);
    expect(text).toContain(`نسخه فعلی: ${toPersianDigits(1)}`);
    expect(text).toContain(`نسخه جدید: ${toPersianDigits(2)}`);
    expect(text).toContain("⚠️ با انتشار این نسخه، همه کاربران باید قوانین را دوباره تایید کنند.");
    expect(text).toContain("متن نسخه دو");
    expect(buttonLabels(rec)).toContain("انتشار و الزام پذیرش مجدد 🚀");
  });

  it("A26 confirming publishes the named draft and reports the new version", async () => {
    await publish("نسخه یک");
    const draft = await createTermsDraft(null);
    if (!draft.ok) throw new Error("draft failed");
    await updateTermsDraftBody(draft.draft.id, "متن نسخه دو");

    const { rec } = await runCallback(
      `admin:terms:pub_ok:${draft.draft.id.slice(0, 8)}`,
      OWNER,
    );

    expect(rec.toasts).toContain(`نسخه ${toPersianDigits(2)} منتشر شد 🚀`);
    const published = await getPublishedTerms();
    expect(published?.id).toBe(draft.draft.id);
    expect(published?.version).toBe(2);
  });

  it("A27 a STALE confirmation cannot publish a different draft", async () => {
    await publish("نسخه یک");
    const first = await createTermsDraft(null);
    if (!first.ok) throw new Error("draft failed");
    const staleId = first.draft.id;
    // The OWNER deletes that draft and starts a different one.
    await prisma.termsDocument.delete({ where: { id: staleId } });
    const second = await createTermsDraft(null);
    if (!second.ok) throw new Error("draft failed");
    await updateTermsDraftBody(second.draft.id, "پیش‌نویس متفاوت");

    // Pressing the OLD confirmation must publish NOTHING — not "whatever draft
    // happens to exist now".
    const { rec } = await runCallback(`admin:terms:pub_ok:${staleId.slice(0, 8)}`, OWNER);

    expect(rec.toasts).toContain("درخواست منقضی شده است. دوباره تلاش کنید.");
    expect((await getPublishedTerms())?.version).toBe(1);
    expect((await getDraftTerms())?.id).toBe(second.draft.id);
  });

  it("A28 a confirmation naming an already-PUBLISHED document publishes nothing", async () => {
    const publishedId = await publish("نسخه یک");

    const { rec } = await runCallback(`admin:terms:pub_ok:${publishedId.slice(0, 8)}`, OWNER);

    expect(rec.toasts).toContain("درخواست منقضی شده است. دوباره تلاش کنید.");
    const versions = await prisma.termsDocument.findMany({ select: { version: true } });
    expect(versions.map((v) => v.version)).toEqual([1]);
  });

  it("A29 publishing an empty draft is refused with the empty-body message", async () => {
    const draft = await createTermsDraft(null);
    if (!draft.ok) throw new Error("draft failed");

    const { rec } = await runCallback(`admin:terms:pub_ok:${draft.draft.id.slice(0, 8)}`, OWNER);

    expect(allText(rec)).toContain("متن قوانین نمی‌تواند خالی باشد.");
    expect(await getPublishedTerms()).toBeNull();
  });
});

describe.runIf(hasDb)("terms admin — history + preview (§8)", () => {
  beforeEach(resetAll);
  afterAll(async () => {
    await resetAll();
    await prisma.$disconnect();
  });

  it("A30 history lists versions newest-first with page navigation", async () => {
    for (let i = 1; i <= 10; i += 1) await publish(`نسخه ${i}`);

    const page0 = await runCallback("admin:terms:history:0", OWNER);
    const text0 = allText(page0.rec);
    expect(text0).toContain("📚 تاریخچه نسخه‌ها");
    expect(text0).toContain(`نسخه ${toPersianDigits(10)}`);
    expect(text0).toContain("فعال ✅");
    expect(text0).toContain("بایگانی 📦");
    // Page size is 8, so version 2 belongs to page 1.
    expect(text0).not.toContain(`نسخه ${toPersianDigits(2)} —`);
    expect(buttonCallbacks(page0.rec)).toContain("admin:terms:history:1");

    const page1 = await runCallback("admin:terms:history:1", OWNER);
    expect(allText(page1.rec)).toContain(`نسخه ${toPersianDigits(2)}`);
  });

  it("A31 history is empty-safe before anything is published", async () => {
    const { rec } = await runCallback("admin:terms:history:0", OWNER);
    expect(allText(rec)).toContain("هنوز نسخه‌ای منتشر نشده است.");
  });

  it("A32 a negative page index is clamped instead of failing", async () => {
    await publish("قوانین");
    const { rec } = await runCallback("admin:terms:history:0", OWNER);
    expect(allText(rec)).toContain(`نسخه ${toPersianDigits(1)}`);
  });

  it("A32b an absurd page number is clamped to the last real page", async () => {
    for (let i = 1; i <= 3; i += 1) await publish(`نسخه ${i}`);
    // The callback regex accepts any digit run; unclamped this became an
    // out-of-range Prisma `skip` and rendered "page 99999999 of 1".
    const { rec } = await runCallback("admin:terms:history:99999999", OWNER);
    const text = allText(rec);
    expect(text).toContain(`نسخه ${toPersianDigits(3)}`);
    expect(text).toContain(`صفحه ${toPersianDigits(1)} از ${toPersianDigits(1)}`);
  });

  it("A33b the preview stays inside Telegram's limit with a large published+draft pair", async () => {
    // A new draft is SEEDED from the published body, so both are large at once.
    await publish("ب".repeat(3000));
    const draft = await createTermsDraft(null);
    if (!draft.ok) throw new Error("draft failed");

    const { rec } = await runCallback("admin:terms:preview", OWNER);
    for (const sent of rec.sent) {
      expect(sent.text.length).toBeLessThanOrEqual(4096);
    }
    expect(rec.sent.length).toBeGreaterThan(0);
  });

  it("A33 preview shows the published version and the draft side by side", async () => {
    await publish("متن منتشرشده");
    const draft = await createTermsDraft(null);
    if (!draft.ok) throw new Error("draft failed");
    await updateTermsDraftBody(draft.draft.id, "متن پیش‌نویس");

    const { rec } = await runCallback("admin:terms:preview", OWNER);
    const text = allText(rec);
    expect(text).toContain("👁 پیش‌نمایش");
    expect(text).toContain("متن منتشرشده");
    expect(text).toContain("متن پیش‌نویس");
  });

  it("A34 preview renders operator HTML literally, never as markup", async () => {
    const draft = await createTermsDraft(null);
    if (!draft.ok) throw new Error("draft failed");
    await updateTermsDraftBody(draft.draft.id, "<b>قوانین</b> <script>x</script>");

    const { rec } = await runCallback("admin:terms:preview", OWNER);
    // Plain text: the tags appear verbatim and no parse_mode is set, so they
    // cannot become markup or break the message.
    expect(allText(rec)).toContain("<b>قوانین</b>");
    for (const s of rec.sent) {
      expect(s.other?.parse_mode).toBeUndefined();
    }
  });
});
