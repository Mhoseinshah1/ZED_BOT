import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { prisma, type Panel } from "@zedbot/database";
import { afterAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "trial-admin-test-secret-trial-admin-0042";

import { cb } from "../src/handlers/panels/panel-cb.js";
import {
  findField,
  findToggle,
  validateFieldInput,
  type EditableField,
} from "../src/handlers/panels/panel-fields.js";
import {
  panelDetailKeyboard,
  panelTrialKeyboard,
  panelTrialStatsText,
  panelTrialText,
  trialDisableAskView,
  trialEnableAskView,
  TRIAL_CONFIG_INCOMPLETE_TEXT,
  TRIAL_DISABLE_ASK_TEXT,
  TRIAL_DISABLED_TEXT,
  TRIAL_ENABLE_ASK_TEXT,
  TRIAL_ENABLED_TEXT,
  TRIAL_NOT_SET_TEXT,
} from "../src/handlers/panels/panel-views.js";
import {
  assessTrialInboundInput,
  TRIAL_OWNER_ONLY_TOAST,
} from "../src/handlers/panels/panel.handler.js";
import {
  assessTrialPanelConfig,
  trialStatsForPanel,
  type TrialPanelStats,
} from "../src/services/free-trial.service.js";

// =============================================================================
// Free-trial ADMIN side (feat/admin-controlled-free-trial): the OWNER-only
// «اکانت تست 🎁» panel page - detail text, keyboard, two-step CAS
// enable/disable with re-validation, trial field validation (duration,
// traffic, capacity, XUI inbound subset), stats rendering and the exact
// Persian texts. Pure builders + source locks; DB parts skip without
// DATABASE_URL (docs/testing.md). runTag-unique fixtures.
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

const SID = "55667788";

function fakePanel(overrides: Record<string, unknown> = {}): Panel {
  return {
    id: "55667788-0000-0000-0000-000000000000",
    type: "MARZBAN",
    name: "پنل آلمان",
    baseUrl: "https://panel.example.com:8443",
    username: "admin",
    passwordEncrypted: "ENCRYPTED_SECRET_VALUE",
    tokenEncrypted: "SECRET_TOKEN_VALUE",
    status: "ACTIVE",
    isVisible: true,
    testEnabled: false,
    testVolumeMb: null,
    testDurationMinutes: null,
    testMaxConcurrentAccounts: null,
    testInboundIds: null,
    testAutoDisableAfterExpiry: false,
    inboundIds: null,
    protocolSettings: null,
    templateUsername: "tmpl_user",
    subscriptionDomain: null,
    provisioningReady: null,
    usernamePatternType: "TELEGRAM_ID_RANDOM",
    usernameCustomText: null,
    usernameRandomLength: null,
    usernameSequenceLastNumber: 0,
    representativeUsernamePrefix: null,
    representativeSequenceLastNumber: 0,
    renewalMethod: "RESET_VOLUME_AND_TIME",
    accountLimitEnabled: false,
    accountLimitCount: null,
    createdAccountsCount: 0,
    activeAccountsCount: 0,
    visibleForGroups: [],
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-06-01T00:00:00Z"),
    ...overrides,
  } as unknown as Panel;
}

function fakeStats(overrides: Partial<TrialPanelStats> = {}): TrialPanelStats {
  return {
    total: 0,
    active: 0,
    provisioning: 0,
    expired: 0,
    failed: 0,
    manualReview: 0,
    lastCreatedAt: null,
    capacityLimit: null,
    capacityUsed: 0,
    ...overrides,
  };
}

const OK = { ok: true, reasons: [] };
const NOT_OK = { ok: false, reasons: ["trial-duration-missing"] };

describe("panel detail entry: «اکانت تست 🎁» replaces «تنظیمات تست 🧪»", () => {
  it("the detail keyboard points at the new trial page, not the old test page", () => {
    const kb = panelDetailKeyboard(fakePanel());
    const flat = rows(kb).flat();
    const trialButton = flat.find((b) => b.callback_data === cb.trial(SID));
    expect(trialButton?.text).toBe("اکانت تست 🎁");
    expect(flat.map((b) => b.text)).not.toContain("تنظیمات تست 🧪");
    expect(flat.map((b) => b.callback_data)).not.toContain(cb.testSettings(SID));
  });

  it("the legacy admin:panel:ts route stays registered and renders the SAME trial page", () => {
    const handler = src("apps/bot/src/handlers/panels/panel.handler.ts");
    expect(handler).toContain(
      "for (const pattern of [/^admin:panel:trial:(.+)$/, /^admin:panel:ts:(.+)$/])",
    );
    // The old route left the generic page loop - it no longer renders the
    // legacy test page.
    const pageRoutes = handler.slice(
      handler.indexOf("const PAGE_ROUTES"),
      handler.indexOf("free-trial admin routes"),
    );
    expect(pageRoutes).not.toContain("admin:panel:ts");
  });
});

describe("trial page: OWNER-only gating (source)", () => {
  const handler = src("apps/bot/src/handlers/panels/panel.handler.ts");

  it("every trial route is gated by the local requireOwner copy", () => {
    for (const literal of [
      "for (const pattern of [/^admin:panel:trial:(.+)$/, /^admin:panel:ts:(.+)$/])",
      "/^admin:panel:tren:([^:]+)$/",
      "/^admin:panel:tren:([^:]+):yes$/",
      "/^admin:panel:trdis:([^:]+)$/",
      "/^admin:panel:trdis:([^:]+):yes$/",
      "/^admin:panel:trpn:(.+)$/",
      "/^admin:panel:trst:(.+)$/",
    ]) {
      const idx = handler.indexOf(literal);
      expect(idx, `route missing: ${literal}`).toBeGreaterThanOrEqual(0);
      expect(
        handler.slice(idx, idx + 350),
        `route not OWNER-gated: ${literal}`,
      ).toContain("requireOwner(ctx)");
    }
    // Trial fields + trial toggles reuse the same gate.
    expect(handler).toContain('knownField.page === "trial"');
    expect(handler).toContain('toggle.page === "trial" && !(await requireOwner(ctx))');
    // Stale testEnabled toggle buttons route into the guarded flow too.
    expect(handler).toContain('toggle.column === "testEnabled"');
  });

  it("non-OWNER active admins get the exact safe toast and no data", () => {
    expect(handler).toContain("ctx.admin === null");
    expect(handler).toContain('ctx.admin.role === "OWNER"');
    expect(handler).toContain("safeAnswerCallback(ctx, TRIAL_OWNER_ONLY_TOAST)");
    expect(TRIAL_OWNER_ONLY_TOAST).toBe(
      "دسترسی به این بخش فقط برای مالک مجموعه فعال است.",
    );
  });
});

describe("trial page: exact text", () => {
  it("renders the exact configured/enabled page", () => {
    const panel = fakePanel({
      testEnabled: true,
      testDurationMinutes: 1440,
      testVolumeMb: 2048,
    });
    const text = panelTrialText(panel, OK, fakeStats({ capacityUsed: 3, capacityLimit: 10 }));
    expect(text).toBe(
      [
        "🎁 تنظیمات اکانت تست",
        "",
        "پنل:",
        "پنل آلمان",
        "",
        "وضعیت:",
        "فعال ✅",
        "",
        "مدت تست:",
        "1 روز",
        "",
        "حجم تست:",
        "2 گیگابایت",
        "",
        "تعداد تست‌های فعال:",
        "3 / 10",
        "",
        "آمادگی ساخت:",
        "آماده ✅",
      ].join("\n"),
    );
  });

  it("renders «تنظیم نشده», «غیرفعال ❌», «ناقص ❌» and a limitless counter", () => {
    const text = panelTrialText(fakePanel(), NOT_OK, fakeStats({ capacityUsed: 2 }));
    expect(text).toContain("وضعیت:\nغیرفعال ❌");
    expect(text).toContain(`مدت تست:\n${TRIAL_NOT_SET_TEXT}`);
    expect(text).toContain(`حجم تست:\n${TRIAL_NOT_SET_TEXT}`);
    expect(text).toContain("تعداد تست‌های فعال:\n2\n");
    expect(text).toContain("آمادگی ساخت:\nناقص ❌");
    // Sub-day / sub-hour formatting comes from the shared core helpers.
    const minutes = panelTrialText(
      fakePanel({ testDurationMinutes: 90, testVolumeMb: 500 }),
      NOT_OK,
      fakeStats(),
    );
    expect(minutes).toContain("مدت تست:\n90 دقیقه");
    expect(minutes).toContain("حجم تست:\n500 مگابایت");
  });

  it("escapes the panel name (HTML parse mode) and leaks no secrets", () => {
    const panel = fakePanel({ name: "<b>پنل" });
    const text = panelTrialText(panel, OK, fakeStats());
    expect(text).toContain("&lt;b&gt;پنل");
    expect(text).not.toContain("<b>پنل");
    for (const rendered of [
      text,
      panelTrialStatsText(panel, fakeStats()),
      trialEnableAskView(panel).text,
      trialDisableAskView(panel).text,
    ]) {
      expect(rendered).not.toContain("ENCRYPTED_SECRET_VALUE");
      expect(rendered).not.toContain("SECRET_TOKEN_VALUE");
    }
  });
});

describe("trial page: keyboard", () => {
  it("disabled panel offers «فعال کردن» (two-step), enabled offers «غیرفعال کردن»", () => {
    const disabled = rows(panelTrialKeyboard(fakePanel())).flat();
    expect(disabled.find((b) => b.text === "فعال کردن")?.callback_data).toBe(
      cb.trialEnableAsk(SID),
    );
    expect(callbacks(panelTrialKeyboard(fakePanel()))).not.toContain(cb.trialDisableAsk(SID));
    const enabled = rows(panelTrialKeyboard(fakePanel({ testEnabled: true }))).flat();
    expect(enabled.find((b) => b.text === "غیرفعال کردن")?.callback_data).toBe(
      cb.trialDisableAsk(SID),
    );
  });

  it("carries duration/volume/capacity edits, tade toggle, preview, stats and back", () => {
    const cbs = callbacks(panelTrialKeyboard(fakePanel()));
    expect(cbs).toContain(cb.fieldEdit(SID, "tdm"));
    expect(cbs).toContain(cb.fieldEdit(SID, "tvm"));
    expect(cbs).toContain(cb.fieldEdit(SID, "tmc"));
    expect(cbs).toContain(cb.toggle(SID, "tade"));
    expect(cbs).toContain(cb.trialNamePreview(SID));
    expect(cbs).toContain(cb.trialStats(SID));
    expect(cbs).toContain(cb.view(SID));
    const flat = rows(panelTrialKeyboard(fakePanel())).flat();
    expect(flat.find((b) => b.callback_data === cb.view(SID))?.text).toBe(
      "بازگشت به جزئیات پنل",
    );
  });

  it("«تنظیم اینباندهای تست» renders for XUI panels ONLY", () => {
    expect(callbacks(panelTrialKeyboard(fakePanel({ type: "XUI" })))).toContain(
      cb.fieldEdit(SID, "tib"),
    );
    expect(callbacks(panelTrialKeyboard(fakePanel()))).not.toContain(cb.fieldEdit(SID, "tib"));
  });

  it("rows never exceed 2 buttons; every callback stays under 64 bytes", () => {
    for (const panel of [fakePanel(), fakePanel({ type: "XUI", testEnabled: true })]) {
      for (const row of rows(panelTrialKeyboard(panel))) {
        expect(row.length).toBeLessThanOrEqual(2);
      }
      for (const data of [
        ...callbacks(panelTrialKeyboard(panel)),
        ...callbacks(trialEnableAskView(panel).keyboard),
        ...callbacks(trialDisableAskView(panel).keyboard),
        cb.trial(SID),
        cb.testSettings(SID),
        cb.trialEnableConfirm(SID),
        cb.trialDisableConfirm(SID),
      ]) {
        expect(Buffer.byteLength(data, "utf8"), data).toBeLessThan(64);
      }
    }
  });
});

describe("two-step enable/disable (texts + CAS, source)", () => {
  const handler = src("apps/bot/src/handlers/panels/panel.handler.ts");

  it("ask views carry the exact confirmation texts and confirm/back buttons", () => {
    expect(TRIAL_ENABLE_ASK_TEXT).toBe("آیا از فعال کردن اکانت تست برای این پنل مطمئن هستید؟");
    expect(TRIAL_DISABLE_ASK_TEXT).toBe(
      "آیا از غیرفعال کردن اکانت تست برای این پنل مطمئن هستید؟",
    );
    const enable = trialEnableAskView(fakePanel());
    expect(enable.text).toBe(TRIAL_ENABLE_ASK_TEXT);
    expect(callbacks(enable.keyboard)).toEqual([cb.trialEnableConfirm(SID), cb.trial(SID)]);
    const disable = trialDisableAskView(fakePanel({ testEnabled: true }));
    expect(disable.text).toBe(TRIAL_DISABLE_ASK_TEXT);
    expect(callbacks(disable.keyboard)).toEqual([cb.trialDisableConfirm(SID), cb.trial(SID)]);
  });

  it("enable confirm re-fetches, re-validates and refuses incomplete configs", () => {
    const confirm = handler.slice(
      handler.indexOf("/^admin:panel:tren:([^:]+):yes$/"),
      handler.indexOf("/^admin:panel:trdis:([^:]+)$/"),
    );
    // resolvePanel re-reads the row from the DB on every confirm.
    expect(confirm).toContain("resolvePanel(ctx");
    expect(confirm).toContain("assessTrialPanelConfig(panel)");
    expect(confirm).toContain("TRIAL_CONFIG_INCOMPLETE_TEXT");
    expect(TRIAL_CONFIG_INCOMPLETE_TEXT).toBe("تنظیمات اکانت تست این پنل کامل نیست.");
    // CAS flip - concurrent/stale confirms can never double-apply.
    expect(confirm).toContain("where: { id: panel.id, testEnabled: false }");
    expect(confirm).toContain("data: { testEnabled: true }");
    expect(confirm).toContain("TRIAL_ENABLED_TEXT");
    expect(TRIAL_ENABLED_TEXT).toBe("اکانت تست برای این پنل فعال شد ✅");
  });

  it("disable confirm is a CAS flip that never touches claims or services", () => {
    const confirm = handler.slice(
      handler.indexOf("/^admin:panel:trdis:([^:]+):yes$/"),
      handler.indexOf("/^admin:panel:trpn:(.+)$/"),
    );
    expect(confirm).toContain("where: { id: panel.id, testEnabled: true }");
    expect(confirm).toContain("data: { testEnabled: false }");
    expect(confirm).toContain("TRIAL_DISABLED_TEXT");
    expect(TRIAL_DISABLED_TEXT).toBe("اکانت تست برای این پنل غیرفعال شد.");
    expect(confirm).not.toContain("freeTrialClaim");
    expect(confirm).not.toContain("service.");
  });

  it("enable/disable/field changes write safe audit logs (no secret fields)", () => {
    expect(handler).toContain('logger.info("panel trial enabled"');
    expect(handler).toContain('logger.info("panel trial disabled"');
    expect(handler.match(/logger\.info\("panel trial config changed"/g)?.length).toBe(2);
    for (const idx of [
      handler.indexOf('logger.info("panel trial enabled"'),
      handler.indexOf('logger.info("panel trial disabled"'),
    ]) {
      const block = handler.slice(idx, idx + 300);
      expect(block).toContain("adminId");
      expect(block).toContain("panelId");
      expect(block).toContain("action");
      expect(block).not.toContain("passwordEncrypted");
      expect(block).not.toContain("tokenEncrypted");
    }
  });
});

describe("trial field registry + validation", () => {
  it("tdm/tvm/tmc are positive-int trial-page fields; tade toggles auto-disable", () => {
    for (const [key, column] of [
      ["tdm", "testDurationMinutes"],
      ["tvm", "testVolumeMb"],
      ["tmc", "testMaxConcurrentAccounts"],
    ] as const) {
      const field = findField(key);
      expect(field?.column).toBe(column);
      expect(field?.kind).toBe("positive-int");
      expect(field?.page).toBe("trial");
      expect(field?.nullable).toBe(true);
    }
    const tib = findField("tib");
    expect(tib?.column).toBe("testInboundIds");
    expect(tib?.page).toBe("trial");
    expect(tib?.onlyFor).toBe("XUI");
    expect(tib?.nullable).toBe(false);
    const tade = findToggle("tade");
    expect(tade?.column).toBe("testAutoDisableAfterExpiry");
    expect(tade?.page).toBe("trial");
  });

  it("duration/traffic/capacity reject 0, negatives and junk; accept positives", () => {
    for (const key of ["tdm", "tvm", "tmc"]) {
      const field = findField(key) as EditableField;
      expect(validateFieldInput(field, "0").ok).toBe(false);
      expect(validateFieldInput(field, "-5").ok).toBe(false);
      expect(validateFieldInput(field, "abc").ok).toBe(false);
      expect(validateFieldInput(field, "")).toEqual(
        expect.objectContaining({ ok: false }),
      );
      expect(validateFieldInput(field, "90")).toEqual({ ok: true, value: 90 });
      // Nullable trial numbers clear with "-".
      expect(validateFieldInput(field, "-")).toEqual({ ok: true, value: null });
    }
  });

  it("tib accepts comma/space/JSON positive int lists, deduped; rejects junk", () => {
    const tib = findField("tib") as EditableField;
    expect(validateFieldInput(tib, "1,2,3")).toEqual({ ok: true, value: [1, 2, 3] });
    expect(validateFieldInput(tib, "4 5  6")).toEqual({ ok: true, value: [4, 5, 6] });
    expect(validateFieldInput(tib, "[7,8]")).toEqual({ ok: true, value: [7, 8] });
    expect(validateFieldInput(tib, "1, 1, 2")).toEqual({ ok: true, value: [1, 2] });
    for (const bad of ["", "0", "1,0", "-1", "1,x", "1.5", "-"]) {
      expect(validateFieldInput(tib, bad).ok, `must reject: ${JSON.stringify(bad)}`).toBe(false);
    }
  });

  it("assessTrialInboundInput enforces the panel allowlist subset", () => {
    const panel = fakePanel({ type: "XUI", inboundIds: [1, 2, 3] });
    expect(assessTrialInboundInput(panel, [1, 3])).toEqual({ ok: true });
    const outside = assessTrialInboundInput(panel, [1, 5, 9]);
    expect(outside.ok).toBe(false);
    if (!outside.ok) {
      expect(outside.error).toContain("5, 9");
    }
    // No allowlist configured at all -> safe Persian error, never a save.
    expect(assessTrialInboundInput(fakePanel({ type: "XUI" }), [1]).ok).toBe(false);
    // The pre-save hook is wired in handleEditField for tib.
    const handler = src("apps/bot/src/handlers/panels/panel.handler.ts");
    expect(handler).toContain('field.key === "tib"');
    expect(handler).toContain("assessTrialInboundInput(panelBefore");
  });
});

describe("trial stats page (pure)", () => {
  it("renders counters/dates only", () => {
    const text = panelTrialStatsText(
      fakePanel(),
      fakeStats({
        total: 12,
        active: 4,
        provisioning: 1,
        expired: 5,
        failed: 1,
        manualReview: 1,
        lastCreatedAt: new Date("2026-07-01T10:20:00Z"),
        capacityLimit: 10,
        capacityUsed: 5,
      }),
    );
    expect(text).toContain("📊 آمار اکانت‌های تست");
    expect(text).toContain("کل تست‌ها: 12");
    expect(text).toContain("فعال: 4");
    expect(text).toContain("در حال ساخت: 1");
    expect(text).toContain("منقضی‌شده: 5");
    expect(text).toContain("ناموفق/لغوشده: 1");
    expect(text).toContain("نیازمند بررسی: 1");
    expect(text).toContain("آخرین ساخت: 2026-07-01 10:20");
    expect(text).toContain("ظرفیت: 5 / 10");
    expect(panelTrialStatsText(fakePanel(), fakeStats())).toContain("آخرین ساخت: -");
    expect(panelTrialStatsText(fakePanel(), fakeStats())).toContain("ظرفیت: 0 (بدون سقف)");
    // Never subscription URLs or credentials on the stats page.
    expect(text).not.toContain("http");
  });
});

describe.runIf(hasDb)("trial admin flows against the real schema (DB)", () => {
  const panelIds: string[] = [];

  interface TestPanelInput {
    type?: "MARZBAN" | "XUI";
    templateUsername?: string;
    testDurationMinutes?: number;
    testVolumeMb?: number;
    testMaxConcurrentAccounts?: number;
    inboundIds?: number[];
  }

  async function createTestPanel(input: TestPanelInput = {}): Promise<Panel> {
    const panel = await prisma.panel.create({
      data: {
        type: input.type ?? "MARZBAN",
        name: `trial-admin-${runTag}-${panelIds.length}`,
        baseUrl: "https://trial-admin.example.com",
        username: "admin",
        passwordEncrypted: `enc-secret-${runTag}`,
        templateUsername: input.templateUsername ?? null,
        testDurationMinutes: input.testDurationMinutes ?? null,
        testVolumeMb: input.testVolumeMb ?? null,
        testMaxConcurrentAccounts: input.testMaxConcurrentAccounts ?? null,
        ...(input.inboundIds === undefined ? {} : { inboundIds: input.inboundIds }),
      },
    });
    panelIds.push(panel.id);
    return panel;
  }

  afterAll(async () => {
    await prisma.panel.deleteMany({ where: { id: { in: panelIds } } });
    await prisma.$disconnect();
  });

  it("a fresh panel has trials disabled by default", async () => {
    const panel = await createTestPanel();
    expect(panel.testEnabled).toBe(false);
    expect(panel.testAutoDisableAfterExpiry).toBe(false);
    expect(panel.testMaxConcurrentAccounts).toBeNull();
  });

  it("valid Marzban config assesses ok; enable CAS applies exactly once", async () => {
    const panel = await createTestPanel({
      templateUsername: "tmpl_user",
      testDurationMinutes: 60,
      testVolumeMb: 1024,
    });
    expect(assessTrialPanelConfig(panel)).toEqual({ ok: true, reasons: [] });
    // CAS enable (the exact statement the confirm handler runs).
    const first = await prisma.panel.updateMany({
      where: { id: panel.id, testEnabled: false },
      data: { testEnabled: true },
    });
    expect(first.count).toBe(1);
    // Double-click / concurrent confirm: idempotent, applies nothing.
    const second = await prisma.panel.updateMany({
      where: { id: panel.id, testEnabled: false },
      data: { testEnabled: true },
    });
    expect(second.count).toBe(0);
    // CAS disable mirrors it.
    const disable = await prisma.panel.updateMany({
      where: { id: panel.id, testEnabled: true },
      data: { testEnabled: false },
    });
    expect(disable.count).toBe(1);
    expect(
      (
        await prisma.panel.updateMany({
          where: { id: panel.id, testEnabled: true },
          data: { testEnabled: false },
        })
      ).count,
    ).toBe(0);
  });

  it("incomplete configs are refused: missing duration/traffic", async () => {
    const noDuration = await createTestPanel({
      templateUsername: "tmpl_user",
      testVolumeMb: 1024,
    });
    const a = assessTrialPanelConfig(noDuration);
    expect(a.ok).toBe(false);
    expect(a.reasons).toContain("trial-duration-missing");
    const noTraffic = await createTestPanel({
      templateUsername: "tmpl_user",
      testDurationMinutes: 60,
    });
    const b = assessTrialPanelConfig(noTraffic);
    expect(b.ok).toBe(false);
    expect(b.reasons).toContain("trial-traffic-missing");
  });

  it("XUI: enable requires testInboundIds inside the panel allowlist", async () => {
    const panel = await createTestPanel({
      type: "XUI",
      inboundIds: [1, 2],
      testDurationMinutes: 60,
      testVolumeMb: 1024,
    });
    // No trial inbounds at all.
    expect(assessTrialPanelConfig(panel).reasons).toContain("trial-inbounds-missing");
    // Outside the allowlist.
    const outside = await prisma.panel.update({
      where: { id: panel.id },
      data: { testInboundIds: [5] },
    });
    expect(assessTrialPanelConfig(outside).reasons).toContain(
      "trial-inbounds-outside-allowlist",
    );
    // A valid subset clears both inbound reasons (and the whole config).
    const valid = await prisma.panel.update({
      where: { id: panel.id },
      data: { testInboundIds: [1] },
    });
    const assessment = assessTrialPanelConfig(valid);
    expect(assessment.reasons).not.toContain("trial-inbounds-missing");
    expect(assessment.reasons).not.toContain("trial-inbounds-outside-allowlist");
    expect(assessment).toEqual({ ok: true, reasons: [] });
  });

  it("OWNER page render path: real panel + real stats produce the exact page", async () => {
    const panel = await createTestPanel({
      templateUsername: "tmpl_user",
      testDurationMinutes: 2880,
      testVolumeMb: 3072,
      testMaxConcurrentAccounts: 7,
    });
    const stats = await trialStatsForPanel(panel);
    expect(stats).toEqual(
      expect.objectContaining({
        total: 0,
        active: 0,
        provisioning: 0,
        expired: 0,
        failed: 0,
        manualReview: 0,
        lastCreatedAt: null,
        capacityLimit: 7,
        capacityUsed: 0,
      }),
    );
    const text = panelTrialText(panel, assessTrialPanelConfig(panel), stats);
    expect(text).toContain("🎁 تنظیمات اکانت تست");
    expect(text).toContain("مدت تست:\n2 روز");
    expect(text).toContain("حجم تست:\n3 گیگابایت");
    expect(text).toContain("تعداد تست‌های فعال:\n0 / 7");
    expect(text).toContain("آمادگی ساخت:\nآماده ✅");
    // Secrets never surface anywhere on the page or its keyboard labels.
    expect(text).not.toContain(`enc-secret-${runTag}`);
    for (const row of rows(panelTrialKeyboard(panel))) {
      for (const button of row) {
        expect(button.text).not.toContain(`enc-secret-${runTag}`);
        expect(Buffer.byteLength(button.callback_data ?? "", "utf8")).toBeLessThan(64);
      }
    }
  });
});
