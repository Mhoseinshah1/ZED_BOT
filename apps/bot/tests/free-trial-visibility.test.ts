import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { prisma, type Panel, type User } from "@zedbot/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "free-trial-visibility-test-secret-0042";

import type { BotContext } from "../src/core/context.js";
import {
  TRIAL_HIDDEN_REASON_TEXT,
  TRIAL_INCOMPLETE_EMPTY_TEXT,
  TRIAL_READY_EMPTY_TEXT,
  TRIAL_SETTINGS_ALREADY_DISABLED_TEXT,
  TRIAL_SETTINGS_ALREADY_ENABLED_TEXT,
  TRIAL_SETTINGS_CB,
  TRIAL_SETTINGS_DISABLE_ASK_TEXT,
  TRIAL_SETTINGS_DISABLED_TOAST,
  TRIAL_SETTINGS_ENABLE_ASK_TEXT,
  TRIAL_SETTINGS_ENABLED_TOAST,
  TRIAL_SETTINGS_NO_READY_PANEL_TEXT,
  TRIAL_SETTINGS_OWNER_ONLY_TOAST,
  trialIncompleteListView,
  trialReadyListView,
  trialSettingsPageKeyboard,
  trialSettingsPageText,
} from "../src/handlers/admin-settings/text-settings.handler.js";
import { cb as panelCb } from "../src/handlers/panels/panel-cb.js";
import {
  ftCb,
  openFreeTrialSection,
} from "../src/handlers/user-free-trial/free-trial.handler.js";
import { buildUserMainKeyboard } from "../src/keyboards/user-main.keyboard.js";
import {
  buildUserMainMenuDefinition,
  buildUserMainReplyKeyboard,
  resolveMainMenuAction,
} from "../src/keyboards/user-menu-definition.js";
import {
  compareAndSetFreeTrialEnabled,
  FREE_TRIAL_ENABLED_KEY,
  isFreeTrialEnabled,
  setFreeTrialEnabled,
} from "../src/services/free-trial-settings.service.js";
import {
  checkTrialEligibility,
  getFreeTrialMenuAvailability,
  isFreeTrialVisible,
  listTrialIncompletePanels,
  listTrialReadyPanels,
  trialPanelProblemLabel,
  TRIAL_GLOBALLY_DISABLED_TEXT,
  TRIAL_NO_PANEL_TEXT,
  type FreeTrialMenuAvailability,
} from "../src/services/free-trial.service.js";
import { clearSettingsCache, deleteSetting } from "../src/services/settings.service.js";
import { clearTextCache } from "../src/services/text.service.js";

// =============================================================================
// fix/free-trial-button-visibility: the shared availability policy
// (getFreeTrialMenuAvailability - ONE classifier for the user menu button,
// the user panel list and the OWNER admin diagnostics page), the global
// «تنظیمات اکانت تست 🎁» admin page, the capacity-in-readiness rule and the
// globally-disabled vs no-ready-panel text split. Reproduces the original
// bug: on a fresh install the free_trial_enabled Setting row is ABSENT, the
// kill-switch falls back to false and the user button never appears even
// with fully configured trial panels - and PR #87 shipped no Telegram
// surface to flip the switch or explain the hidden button. Also locks the
// compare-and-set transition semantics and the inline/reply keyboard-mode
// parity (both renderers consume the one definition, so they show/hide the
// trial row under identical conditions and edited labels keep routing).
// Config-level only: no HTTP panel mocks, no Redis. DB parts skip without
// DATABASE_URL (docs/testing.md); runTag-unique fixtures; candidate panels
// from other suites are quarantined for the file and restored afterwards.
// =============================================================================

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const hasDb =
  typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));

type Button = { text: string; callback_data?: string };

function rows(kb: { inline_keyboard: unknown }): Button[][] {
  return kb.inline_keyboard as Button[][];
}

function callbacks(kb: { inline_keyboard: unknown }): string[] {
  return rows(kb)
    .flat()
    .map((b) => b.callback_data ?? "");
}

function src(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), "utf8");
}

function availability(
  overrides: Partial<FreeTrialMenuAvailability> = {},
): FreeTrialMenuAvailability {
  return {
    visible: false,
    globallyEnabled: false,
    readyPanelCount: 0,
    incompletePanelCount: 0,
    reason: "GLOBAL_DISABLED",
    ...overrides,
  };
}

function fakePanel(overrides: Record<string, unknown> = {}): Panel {
  return {
    id: "aabbccdd-0000-0000-0000-000000000000",
    type: "MARZBAN",
    name: "پنل آلمان",
    baseUrl: "https://secret-panel-host.example.com:8443",
    username: "admin",
    passwordEncrypted: "ENCRYPTED_SECRET_VALUE",
    tokenEncrypted: "SECRET_TOKEN_VALUE",
    status: "ACTIVE",
    testEnabled: true,
    testVolumeMb: 2048,
    testDurationMinutes: 1440,
    testMaxConcurrentAccounts: null,
    testInboundIds: null,
    inboundIds: null,
    templateUsername: "tpl",
    ...overrides,
  } as unknown as Panel;
}

// --- exact Persian texts (pure locks) ---------------------------------------------------------

describe("free-trial visibility: exact Persian texts", () => {
  it("splits globally-disabled from no-ready-panel (user texts)", () => {
    expect(TRIAL_GLOBALLY_DISABLED_TEXT).toBe("اکانت تست رایگان در حال حاضر غیرفعال است.");
    expect(TRIAL_NO_PANEL_TEXT).toBe("در حال حاضر پنل فعالی برای ارائه اکانت تست وجود ندارد.");
  });

  it("admin page flow texts are exact", () => {
    expect(TRIAL_SETTINGS_OWNER_ONLY_TOAST).toBe(
      "دسترسی به این بخش فقط برای مالک مجموعه فعال است.",
    );
    expect(TRIAL_SETTINGS_ALREADY_ENABLED_TEXT).toBe("اکانت تست رایگان از قبل فعال است.");
    expect(TRIAL_SETTINGS_ALREADY_DISABLED_TEXT).toBe("اکانت تست رایگان از قبل غیرفعال است.");
    expect(TRIAL_SETTINGS_NO_READY_PANEL_TEXT).toBe(
      "امکان فعال‌سازی وجود ندارد؛ ابتدا تنظیمات اکانت تست حداقل یک پنل را کامل کنید.",
    );
    expect(TRIAL_SETTINGS_ENABLE_ASK_TEXT).toBe(
      "آیا از فعال کردن اکانت تست رایگان برای کاربران مطمئن هستید؟",
    );
    expect(TRIAL_SETTINGS_DISABLE_ASK_TEXT).toBe(
      "آیا از غیرفعال کردن اکانت تست رایگان برای کاربران مطمئن هستید؟",
    );
    expect(TRIAL_SETTINGS_ENABLED_TOAST).toBe("اکانت تست رایگان برای کاربران فعال شد ✅");
    expect(TRIAL_SETTINGS_DISABLED_TOAST).toBe("اکانت تست رایگان برای کاربران غیرفعال شد.");
    expect(TRIAL_HIDDEN_REASON_TEXT).toEqual({
      GLOBAL_DISABLED: "تست رایگان به‌صورت سراسری غیرفعال است.",
      NO_READY_PANEL: "هیچ پنل آماده‌ای برای ساخت اکانت تست وجود ندارد.",
      PANEL_CONFIG_INCOMPLETE: "تنظیمات پنل‌های تست کامل نیست.",
      NO_VALID_XUI_INBOUND: "هیچ اینباند معتبری برای تست XUI انتخاب نشده است.",
    });
  });

  it("per-panel problem labels map every code safely (unknown collapses)", () => {
    expect(trialPanelProblemLabel("panel-not-active")).toBe("پنل غیرفعال است.");
    expect(trialPanelProblemLabel("trial-duration-missing")).toBe("مدت تست معتبر نیست.");
    expect(trialPanelProblemLabel("trial-traffic-missing")).toBe("حجم تست معتبر نیست.");
    expect(trialPanelProblemLabel("trial-inbounds-missing")).toBe(
      "اینباند تست XUI انتخاب نشده است.",
    );
    expect(trialPanelProblemLabel("trial-inbounds-outside-allowlist")).toBe(
      "اینباند انتخاب‌شده دیگر معتبر نیست.",
    );
    expect(trialPanelProblemLabel("capacity-full")).toBe(
      "ظرفیت اکانت‌های تست تکمیل شده است.",
    );
    for (const code of [
      "provisioning-readiness-failed",
      "create-capability-missing",
      "naming-config-incomplete",
      "panel-config-incomplete",
      "missing-credentials",
      "anything-else-entirely",
    ]) {
      expect(trialPanelProblemLabel(code), code).toBe("پنل برای ساخت سرویس آماده نیست.");
    }
  });
});

// --- page builders (pure) ----------------------------------------------------------------------

describe("admin trial-settings page builders (pure)", () => {
  it("disabled + hidden page renders the exact layout with the reason block", () => {
    const text = trialSettingsPageText(
      availability({ readyPanelCount: 1, incompletePanelCount: 0 }),
    );
    expect(text).toBe(
      [
        "🎁 تنظیمات اکانت تست رایگان",
        "",
        "وضعیت سراسری:",
        "غیرفعال ❌",
        "",
        "پنل‌های آماده تست:",
        "1",
        "",
        "پنل‌های فعال ولی ناقص:",
        "0",
        "",
        "وضعیت نمایش دکمه کاربر:",
        "مخفی است ❌",
        "",
        "علت مخفی بودن دکمه:",
        "تست رایگان به‌صورت سراسری غیرفعال است.",
      ].join("\n"),
    );
  });

  it("enabled + visible page shows فعال/نمایش and NO reason block", () => {
    const text = trialSettingsPageText(
      availability({
        visible: true,
        globallyEnabled: true,
        readyPanelCount: 2,
        incompletePanelCount: 1,
        reason: "AVAILABLE",
      }),
    );
    expect(text).toContain("وضعیت سراسری:\nفعال ✅");
    expect(text).toContain("پنل‌های آماده تست:\n2");
    expect(text).toContain("پنل‌های فعال ولی ناقص:\n1");
    expect(text).toContain("وضعیت نمایش دکمه کاربر:\nنمایش داده می‌شود ✅");
    expect(text).not.toContain("علت مخفی بودن دکمه:");
  });

  it("every hidden reason renders its exact sentence", () => {
    for (const reason of [
      "NO_READY_PANEL",
      "PANEL_CONFIG_INCOMPLETE",
      "NO_VALID_XUI_INBOUND",
    ] as const) {
      const text = trialSettingsPageText(availability({ globallyEnabled: true, reason }));
      expect(text).toContain(`علت مخفی بودن دکمه:\n${TRIAL_HIDDEN_REASON_TEXT[reason]}`);
    }
  });

  it("keyboard: enable ONLY when disabled, disable ONLY when enabled + fixed rows", () => {
    const disabled = trialSettingsPageKeyboard(availability());
    const disabledButtons = rows(disabled).flat();
    expect(
      disabledButtons.find((b) => b.text === "فعال کردن تست رایگان")?.callback_data,
    ).toBe(TRIAL_SETTINGS_CB.enable);
    expect(callbacks(disabled)).not.toContain(TRIAL_SETTINGS_CB.disable);

    const enabled = trialSettingsPageKeyboard(availability({ globallyEnabled: true }));
    const enabledButtons = rows(enabled).flat();
    expect(
      enabledButtons.find((b) => b.text === "غیرفعال کردن تست رایگان")?.callback_data,
    ).toBe(TRIAL_SETTINGS_CB.disable);
    expect(callbacks(enabled)).not.toContain(TRIAL_SETTINGS_CB.enable);

    for (const kb of [disabled, enabled]) {
      const flat = rows(kb).flat();
      expect(flat.find((b) => b.text === "مشاهده پنل‌های آماده")?.callback_data).toBe(
        TRIAL_SETTINGS_CB.ready,
      );
      expect(flat.find((b) => b.text === "مشاهده پنل‌های ناقص")?.callback_data).toBe(
        TRIAL_SETTINGS_CB.incomplete,
      );
      expect(flat.find((b) => b.text === "بروزرسانی وضعیت ♻️")?.callback_data).toBe(
        TRIAL_SETTINGS_CB.root,
      );
      expect(flat.find((b) => b.text === "بازگشت به تنظیمات عمومی")?.callback_data).toBe(
        "admin:general_settings",
      );
    }
  });

  it("ready list: per-panel block + «تنظیمات پنل 🎁» to the existing trial page", () => {
    const panel = fakePanel();
    const view = trialReadyListView([panel]);
    expect(view.text).toContain("✅ پنل آلمان");
    expect(view.text).toContain("نوع: Marzban");
    expect(view.text).toContain("مدت تست: 1 روز");
    expect(view.text).toContain("حجم تست: 2 گیگابایت");
    const flat = rows(view.keyboard).flat();
    expect(flat.find((b) => b.text === "تنظیمات پنل 🎁")?.callback_data).toBe(
      panelCb.trial("aabbccdd"),
    );
    expect(flat.find((b) => b.text === "بازگشت")?.callback_data).toBe(TRIAL_SETTINGS_CB.root);
    // XUI type label + empty list line.
    expect(trialReadyListView([fakePanel({ type: "XUI" })]).text).toContain("نوع: XUI");
    expect(trialReadyListView([]).text).toContain(TRIAL_READY_EMPTY_TEXT);
  });

  it("incomplete list: name + first problem label only; empty gets its line", () => {
    const view = trialIncompleteListView([
      { panel: fakePanel(), reasons: ["trial-duration-missing", "trial-traffic-missing"] },
    ]);
    expect(view.text).toContain("❌ پنل آلمان");
    expect(view.text).toContain("مشکل: مدت تست معتبر نیست.");
    expect(view.text).not.toContain("حجم تست معتبر نیست."); // first reason only
    const flat = rows(view.keyboard).flat();
    expect(flat.find((b) => b.text === "تنظیمات پنل 🎁")?.callback_data).toBe(
      panelCb.trial("aabbccdd"),
    );
    expect(trialIncompleteListView([]).text).toContain(TRIAL_INCOMPLETE_EMPTY_TEXT);
  });

  it("no secrets ever surface on the diagnostics pages", () => {
    const panel = fakePanel();
    const texts = [
      trialReadyListView([panel]).text,
      trialIncompleteListView([{ panel, reasons: ["capacity-full"] }]).text,
      trialSettingsPageText(availability({ readyPanelCount: 3, incompletePanelCount: 2 })),
    ];
    for (const text of texts) {
      expect(text).not.toContain("secret-panel-host");
      expect(text).not.toContain("https://");
      expect(text).not.toContain("8443");
      expect(text).not.toContain("ENCRYPTED_SECRET_VALUE");
      expect(text).not.toContain("SECRET_TOKEN_VALUE");
    }
  });

  it("every new callback stays under Telegram's 64-byte limit", () => {
    const all = [
      ...Object.values(TRIAL_SETTINGS_CB),
      ...callbacks(trialSettingsPageKeyboard(availability())),
      ...callbacks(trialSettingsPageKeyboard(availability({ globallyEnabled: true }))),
      ...callbacks(trialReadyListView([fakePanel()]).keyboard),
      ...callbacks(
        trialIncompleteListView([{ panel: fakePanel(), reasons: ["capacity-full"] }]).keyboard,
      ),
      ftCb.root,
      panelCb.trial("0123abcd"),
    ];
    for (const data of all) {
      expect(Buffer.byteLength(data, "utf8"), data).toBeLessThan(64);
    }
  });
});

// --- OWNER gate + flow wiring (source locks) -----------------------------------------------------

describe("trial-settings routes: OWNER gate and safe flows (source)", () => {
  const handler = src("apps/bot/src/handlers/admin-settings/text-settings.handler.ts");

  it("the general-settings landing carries the new row before the back row", () => {
    const landing = handler.slice(
      handler.indexOf("async function renderSettingsLanding"),
      handler.indexOf("async function renderTextsLanding"),
    );
    const rowIdx = landing.indexOf('"تنظیمات اکانت تست 🎁", TRIAL_SETTINGS_CB.root');
    const backIdx = landing.indexOf('"بازگشت به منوی ادمین"');
    expect(rowIdx).toBeGreaterThan(0);
    expect(backIdx).toBeGreaterThan(rowIdx);
  });

  it("every trial-settings route is gated by the local requireOwner copy", () => {
    for (const route of [
      "TRIAL_SETTINGS_CB.root",
      "TRIAL_SETTINGS_CB.enable",
      "TRIAL_SETTINGS_CB.enableYes",
      "TRIAL_SETTINGS_CB.disable",
      "TRIAL_SETTINGS_CB.disableYes",
      "TRIAL_SETTINGS_CB.ready",
      "TRIAL_SETTINGS_CB.incomplete",
    ]) {
      const literal = `adminTextSettingsHandler.callbackQuery(${route},`;
      const idx = handler.indexOf(literal);
      expect(idx, `route missing: ${route}`).toBeGreaterThanOrEqual(0);
      expect(handler.slice(idx, idx + 220), `route not OWNER-gated: ${route}`).toContain(
        "requireOwner(ctx)",
      );
    }
    // requireOwner: non-OWNER active admins get ONLY the safe toast.
    const gate = handler.slice(
      handler.indexOf("async function requireOwner"),
      handler.indexOf("async function renderTrialSettingsPage"),
    );
    expect(gate).toContain("ctx.admin === null");
    expect(gate).toContain('ctx.admin.role === "OWNER"');
    expect(gate).toContain("safeAnswerCallback(ctx, TRIAL_SETTINGS_OWNER_ONLY_TOAST)");
  });

  it("enable confirm re-checks everything and refuses zero ready panels", () => {
    const confirm = handler.slice(
      handler.indexOf("adminTextSettingsHandler.callbackQuery(TRIAL_SETTINGS_CB.enableYes"),
      handler.indexOf("adminTextSettingsHandler.callbackQuery(TRIAL_SETTINGS_CB.disable,"),
    );
    expect(confirm).toContain("isFreeTrialEnabled()");
    expect(confirm).toContain("TRIAL_SETTINGS_ALREADY_ENABLED_TEXT");
    expect(confirm).toContain("readyPanelCount === 0");
    expect(confirm).toContain("TRIAL_SETTINGS_NO_READY_PANEL_TEXT");
    expect(confirm).toContain("compareAndSetFreeTrialEnabled(false, true)");
    expect(confirm).toContain("clearSettingsCache()");
    expect(confirm).toContain("adminId");
    expect(confirm).toContain("readyPanelCount:");
    // The ask route ALSO refuses early (both texts + gate present).
    const ask = handler.slice(
      handler.indexOf("adminTextSettingsHandler.callbackQuery(TRIAL_SETTINGS_CB.enable,"),
      handler.indexOf("adminTextSettingsHandler.callbackQuery(TRIAL_SETTINGS_CB.enableYes"),
    );
    expect(ask).toContain("readyPanelCount === 0");
    expect(ask).toContain("TRIAL_SETTINGS_ENABLE_ASK_TEXT");
  });

  it("disable confirm flips ONLY the Setting - panels/claims/services untouched", () => {
    const confirm = handler.slice(
      handler.indexOf("adminTextSettingsHandler.callbackQuery(TRIAL_SETTINGS_CB.disableYes"),
      handler.indexOf("adminTextSettingsHandler.callbackQuery(TRIAL_SETTINGS_CB.ready,"),
    );
    expect(confirm).toContain("TRIAL_SETTINGS_ALREADY_DISABLED_TEXT");
    expect(confirm).toContain("compareAndSetFreeTrialEnabled(true, false)");
    expect(confirm).toContain("clearSettingsCache()");
    expect(confirm).not.toContain("prisma.");
    expect(confirm).not.toContain("freeTrialClaim");
    expect(confirm).not.toContain("testEnabled");
    expect(confirm).not.toContain("service");
  });

  it("openFreeTrialSection answers the DEDICATED disabled text on the global gate", () => {
    const userHandler = src("apps/bot/src/handlers/user-free-trial/free-trial.handler.ts");
    const entry = userHandler.slice(
      userHandler.indexOf("export async function openFreeTrialSection"),
      userHandler.indexOf("freeTrialHandler.callbackQuery(ftCb.root, openFreeTrialSection)"),
    );
    const gateIdx = entry.indexOf("isFreeTrialEnabled()");
    expect(gateIdx).toBeGreaterThan(0);
    expect(entry.slice(gateIdx, gateIdx + 220)).toContain("TRIAL_GLOBALLY_DISABLED_TEXT");
    // The no-ready-panel case keeps the original text.
    expect(entry).toContain("TRIAL_NO_PANEL_TEXT");
  });
});

// --- DB scenarios ----------------------------------------------------------------------------------

describe.runIf(hasDb)("free-trial visibility against the real schema (DB)", () => {
  const panelIds: string[] = [];
  const userIds: string[] = [];
  const quarantinedPanelIds: string[] = [];
  let seq = 0;
  let marzbanPanel: Panel;

  async function makeUser(overrides: Record<string, unknown> = {}): Promise<User> {
    seq += 1;
    const user = await prisma.user.create({
      data: { telegramId: runTag + BigInt(seq), ...overrides },
    });
    userIds.push(user.id);
    return user;
  }

  async function makePanel(
    type: "MARZBAN" | "XUI",
    overrides: Record<string, unknown> = {},
  ): Promise<Panel> {
    seq += 1;
    const panel = await prisma.panel.create({
      data: {
        type,
        name: `ftvis-${type.toLowerCase()}-${runTag}-${seq}`,
        baseUrl: "https://ftvis-config-only.example.com:8443",
        username: "admin",
        passwordEncrypted: `ftvis-enc-secret-${runTag}`,
        status: "ACTIVE",
        testEnabled: true,
        testDurationMinutes: 120,
        testVolumeMb: 512,
        ...(type === "MARZBAN"
          ? { templateUsername: "tpl" }
          : { inboundIds: [1, 2], testInboundIds: [2] }),
        ...overrides,
      },
    });
    panelIds.push(panel.id);
    return panel;
  }

  function fakeUserCtx(user: User): { ctx: BotContext; replies: string[] } {
    const replies: string[] = [];
    const ctx = {
      dbUser: user,
      admin: null,
      session: { lastMenu: null, currentFlow: null, temp: {} },
      callbackQuery: undefined,
      reply: async (text: string): Promise<unknown> => {
        replies.push(text);
        return {};
      },
      answerCallbackQuery: async (): Promise<boolean> => true,
    } as unknown as BotContext;
    return { ctx, replies };
  }

  beforeAll(async () => {
    // Visibility policy is DB-global: quarantine candidate panels left over
    // from other suites so this file fully controls the candidate set.
    const others = await prisma.panel.findMany({
      where: { status: "ACTIVE", testEnabled: true },
      select: { id: true },
    });
    quarantinedPanelIds.push(...others.map((p) => p.id));
    await prisma.panel.updateMany({
      where: { id: { in: quarantinedPanelIds } },
      data: { testEnabled: false },
    });
    // Fresh-install state: the Setting row is ABSENT (not "false").
    await deleteSetting(FREE_TRIAL_ENABLED_KEY);
    clearSettingsCache();
  });

  afterAll(async () => {
    await prisma.freeTrialClaim.deleteMany({ where: { panelId: { in: panelIds } } });
    await prisma.service.deleteMany({ where: { panelId: { in: panelIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.panel.deleteMany({ where: { id: { in: panelIds } } });
    await prisma.panel.updateMany({
      where: { id: { in: quarantinedPanelIds } },
      data: { testEnabled: true },
    });
    await setFreeTrialEnabled(false); // repo default: disabled
    clearSettingsCache();
    await prisma.$disconnect();
  });

  it("ORIGINAL BUG: fresh install (Setting absent) hides the button even with a ready panel", async () => {
    marzbanPanel = await makePanel("MARZBAN");
    expect(await isFreeTrialEnabled()).toBe(false); // absent row -> fallback false
    const result = await getFreeTrialMenuAvailability();
    expect(result).toEqual({
      visible: false,
      globallyEnabled: false,
      readyPanelCount: 1,
      incompletePanelCount: 0,
      reason: "GLOBAL_DISABLED",
    });
    expect(await isFreeTrialVisible()).toBe(false);
    const kb = JSON.stringify((await buildUserMainKeyboard()).inline_keyboard);
    expect(kb).not.toContain("user:free_test");
  });

  it("admin page over the real state explains the hidden button (غیرفعال + reason)", async () => {
    const text = trialSettingsPageText(await getFreeTrialMenuAvailability());
    expect(text).toContain("وضعیت سراسری:\nغیرفعال ❌");
    expect(text).toContain("پنل‌های آماده تست:\n1");
    expect(text).toContain("وضعیت نمایش دکمه کاربر:\nمخفی است ❌");
    expect(text).toContain("علت مخفی بودن دکمه:\nتست رایگان به‌صورت سراسری غیرفعال است.");
  });

  it("forged/stale callback while disabled answers the DEDICATED disabled text", async () => {
    const user = await makeUser();
    const { ctx, replies } = fakeUserCtx(user);
    await openFreeTrialSection(ctx);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toBe(TRIAL_GLOBALLY_DISABLED_TEXT);
    expect(replies[0]).not.toBe(TRIAL_NO_PANEL_TEXT);
  });

  it("enable precondition: zero ready panels means refusal (readyPanelCount gate)", async () => {
    await prisma.panel.update({
      where: { id: marzbanPanel.id },
      data: { testEnabled: false },
    });
    const result = await getFreeTrialMenuAvailability();
    expect(result.readyPanelCount).toBe(0);
    // The exact refusal both routes render on this state.
    expect(TRIAL_SETTINGS_NO_READY_PANEL_TEXT).toBe(
      "امکان فعال‌سازی وجود ندارد؛ ابتدا تنظیمات اکانت تست حداقل یک پنل را کامل کنید.",
    );
  });

  it("enabled with zero candidates -> NO_READY_PANEL and the button stays hidden", async () => {
    await setFreeTrialEnabled(true);
    clearSettingsCache();
    const result = await getFreeTrialMenuAvailability();
    expect(result.reason).toBe("NO_READY_PANEL");
    expect(result.visible).toBe(false);
    expect(trialSettingsPageText(result)).toContain(
      "علت مخفی بودن دکمه:\nهیچ پنل آماده‌ای برای ساخت اکانت تست وجود ندارد.",
    );
    const kb = JSON.stringify((await buildUserMainKeyboard()).inline_keyboard);
    expect(kb).not.toContain("user:free_test");
  });

  it("valid Marzban panel + enabled -> AVAILABLE and the user button renders", async () => {
    await prisma.panel.update({
      where: { id: marzbanPanel.id },
      data: { testEnabled: true },
    });
    const result = await getFreeTrialMenuAvailability();
    expect(result).toEqual({
      visible: true,
      globallyEnabled: true,
      readyPanelCount: 1,
      incompletePanelCount: 0,
      reason: "AVAILABLE",
    });
    expect((await listTrialReadyPanels()).map((p) => p.id)).toContain(marzbanPanel.id);
    const kb = JSON.stringify((await buildUserMainKeyboard()).inline_keyboard);
    expect(kb).toContain("user:free_test");
    // Page text + keyboard flip to the enabled/visible variant.
    const text = trialSettingsPageText(result);
    expect(text).toContain("وضعیت سراسری:\nفعال ✅");
    expect(text).toContain("وضعیت نمایش دکمه کاربر:\nنمایش داده می‌شود ✅");
    expect(text).not.toContain("علت مخفی بودن دکمه:");
    expect(callbacks(trialSettingsPageKeyboard(result))).toContain(TRIAL_SETTINGS_CB.disable);
  });

  it("incomplete candidate (missing duration) -> PANEL_CONFIG_INCOMPLETE diagnostics", async () => {
    await prisma.panel.update({
      where: { id: marzbanPanel.id },
      data: { testEnabled: false },
    });
    const broken = await makePanel("MARZBAN", { testDurationMinutes: null });
    const result = await getFreeTrialMenuAvailability();
    expect(result.reason).toBe("PANEL_CONFIG_INCOMPLETE");
    expect(result.readyPanelCount).toBe(0);
    expect(result.incompletePanelCount).toBe(1);
    expect(result.visible).toBe(false);
    const incomplete = await listTrialIncompletePanels();
    expect(incomplete).toHaveLength(1);
    expect(incomplete[0].panel.id).toBe(broken.id);
    expect(incomplete[0].reasons).toContain("trial-duration-missing");
    const view = trialIncompleteListView(incomplete);
    expect(view.text).toContain("مشکل: مدت تست معتبر نیست.");
    expect(view.text).not.toContain(`ftvis-enc-secret-${runTag}`);
    expect(view.text).not.toContain("https://");
    await prisma.panel.update({ where: { id: broken.id }, data: { testEnabled: false } });
  });

  it("XUI: valid testInboundIds is ready; missing/outside-allowlist -> NO_VALID_XUI_INBOUND", async () => {
    const xui = await makePanel("XUI");
    expect((await getFreeTrialMenuAvailability()).reason).toBe("AVAILABLE");
    expect((await listTrialReadyPanels()).map((p) => p.id)).toContain(xui.id);

    // The ONLY candidate loses its trial inbounds entirely.
    await prisma.panel.update({ where: { id: xui.id }, data: { testInboundIds: [] } });
    let result = await getFreeTrialMenuAvailability();
    expect(result.reason).toBe("NO_VALID_XUI_INBOUND");
    expect(result.visible).toBe(false);
    let incomplete = await listTrialIncompletePanels();
    expect(incomplete[0].reasons).toEqual(["trial-inbounds-missing"]);

    // Or keeps ids that left the panel allowlist.
    await prisma.panel.update({ where: { id: xui.id }, data: { testInboundIds: [9] } });
    result = await getFreeTrialMenuAvailability();
    expect(result.reason).toBe("NO_VALID_XUI_INBOUND");
    incomplete = await listTrialIncompletePanels();
    expect(incomplete[0].reasons).toEqual(["trial-inbounds-outside-allowlist"]);
    expect(trialIncompleteListView(incomplete).text).toContain(
      "مشکل: اینباند انتخاب‌شده دیگر معتبر نیست.",
    );
    await prisma.panel.update({ where: { id: xui.id }, data: { testEnabled: false } });
  });

  it("capacity counts toward readiness: a full panel is NOT ready (capacity-full)", async () => {
    const capped = await makePanel("MARZBAN", { testMaxConcurrentAccounts: 1 });
    const occupant = await makeUser();
    const claim = await prisma.freeTrialClaim.create({
      data: {
        userId: occupant.id,
        panelId: capped.id,
        status: "ACTIVE",
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    const result = await getFreeTrialMenuAvailability();
    expect(result.readyPanelCount).toBe(0);
    expect(result.incompletePanelCount).toBe(1);
    expect(result.reason).toBe("PANEL_CONFIG_INCOMPLETE");
    expect(result.visible).toBe(false);
    expect((await listTrialReadyPanels()).map((p) => p.id)).not.toContain(capped.id);
    const incomplete = await listTrialIncompletePanels();
    expect(incomplete[0].reasons).toEqual(["capacity-full"]);
    expect(trialIncompleteListView(incomplete).text).toContain(
      "مشکل: ظرفیت اکانت‌های تست تکمیل شده است.",
    );
    const kb = JSON.stringify((await buildUserMainKeyboard()).inline_keyboard);
    expect(kb).not.toContain("user:free_test");

    // The slot frees (claim expires) -> the same panel is ready again,
    // without any restart or cache poke on the panel side.
    await prisma.freeTrialClaim.update({
      where: { id: claim.id },
      data: { status: "EXPIRED" },
    });
    const freed = await getFreeTrialMenuAvailability();
    expect(freed.reason).toBe("AVAILABLE");
    expect(freed.visible).toBe(true);
    expect((await listTrialReadyPanels()).map((p) => p.id)).toContain(capped.id);
    await prisma.panel.update({ where: { id: capped.id }, data: { testEnabled: false } });
  });

  it("disabling hides the button and NEVER touches existing claims/services/panels", async () => {
    const panel = await makePanel("MARZBAN");
    const owner = await makeUser();
    const service = await prisma.service.create({
      data: {
        userId: owner.id,
        panelId: panel.id,
        panelType: "MARZBAN",
        username: `ftvis_svc_${runTag}`,
        status: "ACTIVE",
        source: "FREE_TRIAL",
        serviceLocation: "TEST",
      },
    });
    const claim = await prisma.freeTrialClaim.create({
      data: {
        userId: owner.id,
        panelId: panel.id,
        serviceId: service.id,
        status: "ACTIVE",
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    await setFreeTrialEnabled(true);
    clearSettingsCache();
    expect(await isFreeTrialVisible()).toBe(true);

    await setFreeTrialEnabled(false);
    clearSettingsCache();
    expect(await isFreeTrialVisible()).toBe(false);
    const kb = JSON.stringify((await buildUserMainKeyboard()).inline_keyboard);
    expect(kb).not.toContain("user:free_test");

    // Nothing but the Setting changed.
    const freshClaim = await prisma.freeTrialClaim.findUniqueOrThrow({ where: { id: claim.id } });
    expect(freshClaim.status).toBe("ACTIVE");
    expect(freshClaim.serviceId).toBe(service.id);
    const freshService = await prisma.service.findUniqueOrThrow({ where: { id: service.id } });
    expect(freshService.status).toBe("ACTIVE");
    expect(freshService.source).toBe("FREE_TRIAL");
    const freshPanel = await prisma.panel.findUniqueOrThrow({ where: { id: panel.id } });
    expect(freshPanel.testEnabled).toBe(true);
    await prisma.panel.update({ where: { id: panel.id }, data: { testEnabled: false } });
  });

  it("visibility flips WITHOUT restart: Setting write + clearSettingsCache is enough", async () => {
    await prisma.panel.update({
      where: { id: marzbanPanel.id },
      data: { testEnabled: true },
    });
    await setFreeTrialEnabled(true);
    clearSettingsCache();
    expect(await isFreeTrialVisible()).toBe(true);
    expect(JSON.stringify((await buildUserMainKeyboard()).inline_keyboard)).toContain(
      "user:free_test",
    );
    await setFreeTrialEnabled(false);
    clearSettingsCache();
    expect(await isFreeTrialVisible()).toBe(false);
    expect(JSON.stringify((await buildUserMainKeyboard()).inline_keyboard)).not.toContain(
      "user:free_test",
    );
  });

  it("user-level eligibility is NOT bypassed by availability: BLOCKED users stay denied", async () => {
    await setFreeTrialEnabled(true);
    clearSettingsCache();
    const blocked = await makeUser({ status: "BLOCKED" });
    const denied = await checkTrialEligibility(blocked);
    expect(denied.ok).toBe(false);
    await setFreeTrialEnabled(false);
    clearSettingsCache();
    await prisma.panel.update({
      where: { id: marzbanPanel.id },
      data: { testEnabled: false },
    });
  });

  it("compare-and-set: only the expected state wins; stale confirmations lose", async () => {
    // Fresh-install shape again: the Setting row is ABSENT (boolean false).
    await deleteSetting(FREE_TRIAL_ENABLED_KEY);
    clearSettingsCache();
    // A stale disable confirmation on a disabled feature loses.
    expect(await compareAndSetFreeTrialEnabled(true, false)).toBe(false);
    expect(await isFreeTrialEnabled()).toBe(false);
    // Enabling from the absent row claims the transition exactly once.
    expect(await compareAndSetFreeTrialEnabled(false, true)).toBe(true);
    expect(await isFreeTrialEnabled()).toBe(true);
    expect(await compareAndSetFreeTrialEnabled(false, true)).toBe(false);
    expect(await isFreeTrialEnabled()).toBe(true);
    // And back down, again exactly once.
    expect(await compareAndSetFreeTrialEnabled(true, false)).toBe(true);
    expect(await isFreeTrialEnabled()).toBe(false);
    expect(await compareAndSetFreeTrialEnabled(true, false)).toBe(false);
    expect(await isFreeTrialEnabled()).toBe(false);
  });

  it("inline AND reply menus show/hide the trial button under IDENTICAL conditions", async () => {
    await prisma.panel.update({
      where: { id: marzbanPanel.id },
      data: { testEnabled: true },
    });
    await setFreeTrialEnabled(true);
    clearSettingsCache();
    clearTextCache();
    const trialLabel = (
      await prisma.buttonText.findUniqueOrThrow({ where: { key: "free_test" } })
    ).currentText;

    // Visible: the shared definition carries FREE_TRIAL, both renderers
    // surface it and the reply text routes to the stable action.
    const visibleRows = await buildUserMainMenuDefinition();
    const visibleButtons = visibleRows.flat();
    expect(visibleButtons.filter((b) => b.action === "FREE_TRIAL")).toHaveLength(1);
    expect(JSON.stringify((await buildUserMainKeyboard()).inline_keyboard)).toContain(
      "user:free_test",
    );
    const visibleReply = (await buildUserMainReplyKeyboard()) as unknown as {
      keyboard: Array<Array<{ text: string }>>;
    };
    const visibleReplyLabels = visibleReply.keyboard.flat().map((b) => b.text);
    expect(visibleReplyLabels).toContain(trialLabel);
    // Reply rows mirror the definition exactly (one policy, two renderings).
    expect(visibleReply.keyboard.map((row) => row.map((b) => b.text))).toEqual(
      visibleRows.map((row) => row.map((b) => b.label)),
    );
    expect(await resolveMainMenuAction(trialLabel)).toBe("FREE_TRIAL");

    // Hidden (globally disabled): SAME condition removes it from both modes
    // and the label stops routing - no dead button in either rendering.
    await setFreeTrialEnabled(false);
    clearSettingsCache();
    const hiddenRows = await buildUserMainMenuDefinition();
    expect(hiddenRows.flat().map((b) => b.action)).not.toContain("FREE_TRIAL");
    expect(JSON.stringify((await buildUserMainKeyboard()).inline_keyboard)).not.toContain(
      "user:free_test",
    );
    const hiddenReply = (await buildUserMainReplyKeyboard()) as unknown as {
      keyboard: Array<Array<{ text: string }>>;
    };
    expect(hiddenReply.keyboard.flat().map((b) => b.text)).not.toContain(trialLabel);
    expect(await resolveMainMenuAction(trialLabel)).toBeNull();
  });

  it("edited free_test label keeps routing to FREE_TRIAL - behavior never binds to the Persian text", async () => {
    await setFreeTrialEnabled(true);
    clearSettingsCache();
    const row = await prisma.buttonText.findUniqueOrThrow({ where: { key: "free_test" } });
    const edited = `تست ویژه ${runTag}`;
    await prisma.buttonText.update({
      where: { id: row.id },
      data: { currentText: edited },
    });
    clearTextCache();
    try {
      expect(await resolveMainMenuAction(edited)).toBe("FREE_TRIAL");
      expect(await resolveMainMenuAction(row.currentText)).toBeNull();
      // Both renderers carry the edited label; the inline callback stays stable.
      const inline = JSON.stringify((await buildUserMainKeyboard()).inline_keyboard);
      expect(inline).toContain(edited);
      expect(inline).toContain("user:free_test");
      const reply = (await buildUserMainReplyKeyboard()) as unknown as {
        keyboard: Array<Array<{ text: string }>>;
      };
      expect(reply.keyboard.flat().map((b) => b.text)).toContain(edited);
    } finally {
      await prisma.buttonText.update({
        where: { id: row.id },
        data: { currentText: row.currentText },
      });
      clearTextCache();
      await setFreeTrialEnabled(false);
      clearSettingsCache();
      await prisma.panel.update({
        where: { id: marzbanPanel.id },
        data: { testEnabled: false },
      });
    }
  });
});

describe.skipIf(hasDb)("free-trial visibility (skipped)", () => {
  it("DB scenarios require DATABASE_URL - see docs/testing.md", () => {
    expect(hasDb).toBe(false);
  });
});
