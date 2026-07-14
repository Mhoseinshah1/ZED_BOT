import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { INITIAL_BUTTON_TEXTS, INITIAL_MESSAGE_TEMPLATES, prisma } from "@zedbot/database";
import { SUPPORTED_ONLINE_PROVIDERS } from "@zedbot/payments";
import type { InlineKeyboard } from "grammy";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "payment-provider-navigation-tests-01";

import {
  BACK_TO_FINANCE_LABEL,
  FIN_CB,
  PROV_CB,
  providerConfigText,
  providerDetailKeyboard,
  providerDetailText,
  providerListButtonLabel,
  providerListKeyboard,
  providerListText,
  providerSettingsBackKeyboard,
  providerToggleConfirmKeyboard,
  providerToggleConfirmText,
  type ProviderButtonLabels,
} from "../src/handlers/admin-finance/admin-finance-views.js";
import {
  ensureProviderGateways,
  listManagedProviders,
  MANAGED_PROVIDERS,
  setProviderEnabled,
  testProviderConnection,
  type ManagedProviderRow,
} from "../src/services/admin-payment-provider.service.js";
import { clearGatewayManagerCache } from "../src/services/gateway-payment.service.js";
import {
  isWalletPaymentEnabled,
  WALLET_PAYMENT_ENABLED_KEY,
} from "../src/services/payment-settings.service.js";
import { clearSettingsCache } from "../src/services/settings.service.js";

// =============================================================================
// Payment provider admin NAVIGATION tests (provider-navigation phase): the
// compact list -> detail redesign.
//
//   LIST PAGE      - one payprov:view button per provider with a live status
//                    label, NO generic action buttons, back-to-finance row
//   DETAIL PAGES   - per-provider fields (always non-empty), provider-specific
//                    actions, connection test only where a meaningful test
//                    exists, secrets never rendered
//   NAVIGATION     - every emitted callback stays under Telegram's 64-byte
//                    limit and resolves to a registered route; every child
//                    page has a working back; settings route to the EXISTING
//                    provider-specific flows
//   ENABLE/DISABLE - enable requires complete config, disable never deletes
//                    config/cards/Payment rows, duplicate actions are
//                    reported as already-in-state
//   USER/SECURITY  - forged callbacks for disabled providers are rejected,
//                    empty state text, admin gate, no secrets in rendered text
//
// Pure view/service-shape tests run without a database; the flows that read
// gateway rows gate on hasDb (docs/testing.md).
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

const ONLINE_TYPES = [...SUPPORTED_ONLINE_PROVIDERS];
const PROVIDER_KEYS = MANAGED_PROVIDERS.map((meta) => meta.key);

// Fixture secrets - the SECURITY tests assert these literals never render.
const ZP_SECRET_MERCHANT_ID = "zp-nav-secret-mid-123";
const NP_SECRET_API_KEY = "np-nav-secret-key-456";
const NP_SECRET_IPN = "np-nav-ipn-789";

const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
const ADMIN_ID = `admin-pm-nav-${runTag}`;

// ButtonText defaults from the registry - the single source of label truth.
function buttonDefault(key: string): string {
  const seed = INITIAL_BUTTON_TEXTS.find((entry) => entry.key === key);
  if (seed === undefined) {
    throw new Error(`missing ButtonText seed: ${key}`);
  }
  return seed.text;
}

function templateDefault(key: string): string {
  const seed = INITIAL_MESSAGE_TEMPLATES.find((entry) => entry.key === key);
  if (seed === undefined) {
    throw new Error(`missing MessageTemplate seed: ${key}`);
  }
  return seed.defaultContent;
}

const LABELS: ProviderButtonLabels = {
  enable: buttonDefault("pm_enable"),
  disable: buttonDefault("pm_disable"),
  settings: buttonDefault("pm_settings"),
  settingsWallet: buttonDefault("pm_settings_wallet"),
  settingsCard: buttonDefault("pm_settings_card"),
  test: buttonDefault("pm_test"),
  backProviders: buttonDefault("pm_back_providers"),
};

/** Flattened [label, callback] pairs of an InlineKeyboard. */
function keyboardButtons(kb: InlineKeyboard): Array<{ label: string; data: string }> {
  const buttons: Array<{ label: string; data: string }> = [];
  for (const row of kb.inline_keyboard) {
    for (const button of row) {
      if ("callback_data" in button) {
        buttons.push({ label: button.text, data: button.callback_data });
      }
    }
  }
  return buttons;
}

/** Fixture detail row - view tests never need a database. */
function fixtureRow(overrides: Partial<ManagedProviderRow> = {}): ManagedProviderRow {
  return {
    providerKey: "ZARINPAL",
    displayName: "زرین‌پال",
    listEmoji: "🇮🇷",
    enabled: false,
    kindLabel: "پرداخت آنلاین ریالی",
    configured: false,
    configLines: ["Merchant ID: تنظیم نشده ❌"],
    supportsConnectionTest: true,
    lastCheckedAt: null,
    healthStatus: null,
    ...overrides,
  };
}

function fixtureRows(): ManagedProviderRow[] {
  return MANAGED_PROVIDERS.map((meta, index) =>
    fixtureRow({
      providerKey: meta.key,
      displayName: meta.displayName,
      listEmoji: meta.listEmoji,
      kindLabel: meta.kindLabel,
      supportsConnectionTest: meta.supportsConnectionTest,
      enabled: index % 2 === 0,
    }),
  );
}

// --- env fixtures (mirrors payment-provider-admin.test.ts) -------------------------------

const PROVIDER_ENV_KEYS = [
  "ZARINPAL_MERCHANT_ID",
  "ZARINPAL_CALLBACK_URL",
  "ZARINPAL_BASE_URL",
  "ZARINPAL_SANDBOX",
  "NOWPAYMENTS_API_KEY",
  "NOWPAYMENTS_IPN_SECRET",
  "NOWPAYMENTS_CALLBACK_URL",
  "NOWPAYMENTS_BASE_URL",
  "NOWPAYMENTS_SANDBOX",
  "NOWPAYMENTS_TOMAN_PER_UNIT",
  "TELEGRAM_STARS_ENABLED",
] as const;
const savedEnv: Partial<Record<(typeof PROVIDER_ENV_KEYS)[number], string | undefined>> = {};

function clearProviderEnv(): void {
  for (const key of PROVIDER_ENV_KEYS) {
    delete process.env[key];
  }
  clearGatewayManagerCache();
}

function setSecretEnv(): void {
  process.env.ZARINPAL_MERCHANT_ID = ZP_SECRET_MERCHANT_ID;
  process.env.ZARINPAL_CALLBACK_URL = "https://bot.example.com/payments/zarinpal/callback";
  process.env.NOWPAYMENTS_API_KEY = NP_SECRET_API_KEY;
  process.env.NOWPAYMENTS_IPN_SECRET = NP_SECRET_IPN;
  process.env.NOWPAYMENTS_CALLBACK_URL = "https://bot.example.com/payments/nowpayments/ipn";
  process.env.NOWPAYMENTS_TOMAN_PER_UNIT = "60000";
  clearGatewayManagerCache();
}

let savedWalletSettingValue: string | null = null;

beforeAll(async () => {
  for (const key of PROVIDER_ENV_KEYS) {
    savedEnv[key] = process.env[key];
  }
  clearProviderEnv();

  if (!hasDb) {
    return;
  }
  // Clean online-provider slate (other suites leave uniquely-named rows).
  await prisma.userHiddenPaymentGateway.deleteMany({
    where: { paymentGateway: { type: { in: ONLINE_TYPES } } },
  });
  await prisma.paymentGateway.deleteMany({ where: { type: { in: ONLINE_TYPES } } });
  savedWalletSettingValue =
    (await prisma.setting.findUnique({ where: { key: WALLET_PAYMENT_ENABLED_KEY } }))?.value ??
    null;
  clearSettingsCache();
  await ensureProviderGateways();
});

afterAll(async () => {
  for (const key of PROVIDER_ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
  clearGatewayManagerCache();

  if (!hasDb) {
    return;
  }
  await prisma.paymentGateway.deleteMany({ where: { type: { in: ONLINE_TYPES } } });
  if (savedWalletSettingValue === null) {
    await prisma.setting.deleteMany({ where: { key: WALLET_PAYMENT_ENABLED_KEY } });
  } else {
    await prisma.setting.upsert({
      where: { key: WALLET_PAYMENT_ENABLED_KEY },
      update: { value: savedWalletSettingValue },
      create: { key: WALLET_PAYMENT_ENABLED_KEY, value: savedWalletSettingValue, type: "BOOLEAN" },
    });
  }
  clearSettingsCache();
  await prisma.$disconnect();
});

afterEach(() => {
  clearProviderEnv();
});

// =============================================================================
// LIST PAGE
// =============================================================================

describe("LIST PAGE: one button per provider, no generic actions (1-4)", () => {
  it("1. every managed provider gets exactly ONE button, in registry order, targeting its detail page", () => {
    const kb = providerListKeyboard(fixtureRows());
    const buttons = keyboardButtons(kb);
    const providerButtons = buttons.filter((button) => button.data.startsWith("payprov:view:"));
    expect(providerButtons.map((button) => button.data)).toEqual(
      PROVIDER_KEYS.map((key) => `payprov:view:${key}`),
    );
    // One button per provider and nothing else besides the back row.
    expect(buttons).toHaveLength(PROVIDER_KEYS.length + 1);
  });

  it("2. list button labels carry the LIVE status; callback data never carries the label", () => {
    const enabled = fixtureRow({ providerKey: "WALLET", displayName: "کیف پول", listEmoji: "🏦", enabled: true });
    const disabled = fixtureRow({ enabled: false });
    expect(providerListButtonLabel(enabled)).toBe("🏦 کیف پول — فعال ✅");
    expect(providerListButtonLabel(disabled)).toBe("🇮🇷 زرین‌پال — غیرفعال ❌");
    // A renamed provider changes the LABEL only - the callback stays stable.
    const renamed = fixtureRow({ displayName: `درگاه ریالی ${runTag}` });
    const kb = providerListKeyboard([renamed]);
    expect(keyboardButtons(kb)[0].label).toContain(`درگاه ریالی ${runTag}`);
    expect(keyboardButtons(kb)[0].data).toBe("payprov:view:ZARINPAL");
  });

  it("3. NO generic action buttons on the list page (enable/disable/settings/test live on detail pages)", () => {
    const buttons = keyboardButtons(providerListKeyboard(fixtureRows()));
    const forbidden = [LABELS.enable, LABELS.disable, LABELS.settings, LABELS.test];
    for (const button of buttons) {
      expect(forbidden).not.toContain(button.label);
      expect(button.data.startsWith("payprov:toggle:")).toBe(false);
      expect(button.data.startsWith("payprov:settings:")).toBe(false);
      expect(button.data.startsWith("payprov:test:")).toBe(false);
    }
  });

  it("4. list page text is header + pick line; the back row returns to the finance landing", () => {
    const header = templateDefault("payment_methods_admin_header");
    const pick = templateDefault("payment_provider_pick_text");
    expect(header).toBe("مدیریت روش‌های پرداخت 💳");
    expect(pick).toBe("روش پرداخت موردنظر را انتخاب کنید.");
    expect(providerListText(header, pick)).toBe(`${header}\n\n${pick}`);

    const buttons = keyboardButtons(providerListKeyboard(fixtureRows()));
    const back = buttons[buttons.length - 1];
    expect(back.label).toBe(BACK_TO_FINANCE_LABEL);
    expect(back.data).toBe(FIN_CB.root);
  });
});

// =============================================================================
// DETAIL PAGES (view shape - no DB)
// =============================================================================

describe("DETAIL PAGES: fields and provider-specific actions (5-9)", () => {
  it("5. detail text always renders name, status, type and readiness - no empty fields", () => {
    for (const row of fixtureRows()) {
      const text = providerDetailText(row);
      expect(text).toContain(row.displayName);
      expect(text).toContain(`وضعیت: ${row.enabled ? "فعال ✅" : "غیرفعال ❌"}`);
      expect(text).toContain(`نوع: ${row.kindLabel}`);
      expect(text).toContain("آمادگی استفاده: ناقص ❌");
      for (const line of text.split("\n")) {
        expect(line.endsWith(":"), `dangling empty field: "${line}"`).toBe(false);
      }
    }
    expect(providerDetailText(fixtureRow({ configured: true }))).toContain(
      "آمادگی استفاده: آماده ✅",
    );
  });

  it("6. last connection test renders only for testable providers - «بررسی نشده» before the first run", () => {
    const never = fixtureRow();
    expect(providerDetailText(never)).toContain("آخرین تست اتصال: بررسی نشده");

    const checkedAt = new Date("2026-07-14T10:30:00Z");
    const okRow = fixtureRow({ lastCheckedAt: checkedAt, healthStatus: "OK" });
    expect(providerDetailText(okRow)).toContain("آخرین تست اتصال: موفق ✅");
    const failedRow = fixtureRow({ lastCheckedAt: checkedAt, healthStatus: "FAILED" });
    expect(providerDetailText(failedRow)).toContain("آخرین تست اتصال: ناموفق ❌");

    // Providers with no meaningful test never show the line (and never get
    // an invented fake test).
    for (const key of ["CARD_TO_CARD", "WALLET", "TELEGRAM_STARS"] as const) {
      const meta = MANAGED_PROVIDERS.find((candidate) => candidate.key === key);
      const row = fixtureRow({
        providerKey: key,
        supportsConnectionTest: meta?.supportsConnectionTest ?? false,
      });
      expect(row.supportsConnectionTest).toBe(false);
      expect(providerDetailText(row)).not.toContain("آخرین تست اتصال");
    }
  });

  it("7. detail actions: ONE state-matching toggle, provider-specific settings, back to the list", () => {
    for (const row of fixtureRows()) {
      const buttons = keyboardButtons(providerDetailKeyboard(row, LABELS));

      const toggles = buttons.filter((button) => button.data === `payprov:toggle:${row.providerKey}`);
      expect(toggles).toHaveLength(1);
      expect(toggles[0].label).toBe(row.enabled ? LABELS.disable : LABELS.enable);

      const settings = buttons.filter(
        (button) => button.data === `payprov:settings:${row.providerKey}`,
      );
      expect(settings).toHaveLength(1);
      const expectedSettingsLabel =
        row.providerKey === "WALLET"
          ? LABELS.settingsWallet
          : row.providerKey === "CARD_TO_CARD"
            ? LABELS.settingsCard
            : LABELS.settings;
      expect(settings[0].label).toBe(expectedSettingsLabel);

      const back = buttons[buttons.length - 1];
      expect(back.label).toBe(LABELS.backProviders);
      expect(back.data).toBe(FIN_CB.methods);
    }
  });

  it("8. the connection-test button exists ONLY on ZARINPAL and NOWPAYMENTS detail pages", () => {
    for (const row of fixtureRows()) {
      const buttons = keyboardButtons(providerDetailKeyboard(row, LABELS));
      const testButtons = buttons.filter((button) =>
        button.data.startsWith("payprov:test:"),
      );
      if (row.providerKey === "ZARINPAL" || row.providerKey === "NOWPAYMENTS") {
        expect(testButtons).toEqual([
          { label: LABELS.test, data: `payprov:test:${row.providerKey}` },
        ]);
      } else {
        expect(testButtons).toHaveLength(0);
      }
    }
  });

  it("9. confirmation and settings sub-pages navigate back to the DETAIL page, never a dead end", () => {
    const confirmKb = keyboardButtons(providerToggleConfirmKeyboard("ZARINPAL", true));
    expect(confirmKb[0]).toEqual({ label: "تایید", data: "payprov:toggle:ZARINPAL:on" });
    expect(confirmKb[1]).toEqual({ label: "انصراف", data: "payprov:view:ZARINPAL" });
    const confirmOff = keyboardButtons(providerToggleConfirmKeyboard("WALLET", false));
    expect(confirmOff[0].data).toBe("payprov:toggle:WALLET:off");

    const question = templateDefault("payment_provider_enable_confirm");
    expect(question).toBe("آیا از فعال کردن این روش پرداخت مطمئن هستید؟");
    expect(providerToggleConfirmText(question, fixtureRow())).toContain(question);
    expect(templateDefault("payment_provider_disable_confirm")).toBe(
      "آیا از غیرفعال کردن این روش پرداخت مطمئن هستید؟",
    );

    const settingsBack = keyboardButtons(providerSettingsBackKeyboard("NOWPAYMENTS", LABELS));
    expect(settingsBack[0].data).toBe("payprov:view:NOWPAYMENTS");
    expect(settingsBack[1].data).toBe(FIN_CB.methods);
  });
});

// =============================================================================
// NAVIGATION INTEGRITY (callback contracts + source assertions)
// =============================================================================

describe("NAVIGATION: stable callbacks under 64 bytes, routed and gated (10-12)", () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const appSrc = readFileSync(path.join(repoRoot, "apps/bot/src/app.ts"), "utf8");
  const handlerSrc = readFileSync(
    path.join(repoRoot, "apps/bot/src/handlers/admin-finance/admin-finance.handler.ts"),
    "utf8",
  );
  const paymentHandlerSrc = readFileSync(
    path.join(repoRoot, "apps/bot/src/handlers/user-checkout/payment.handler.ts"),
    "utf8",
  );

  it("10. every emitted provider callback stays under Telegram's 64-byte limit", () => {
    for (const key of PROVIDER_KEYS) {
      const emitted = [
        PROV_CB.view(key),
        PROV_CB.toggle(key),
        PROV_CB.toggleConfirm(key, true),
        PROV_CB.toggleConfirm(key, false),
        PROV_CB.settings(key),
        PROV_CB.test(key),
      ];
      for (const data of emitted) {
        expect(Buffer.byteLength(data, "utf8"), data).toBeLessThanOrEqual(64);
      }
    }
  });

  it("11. every emitted provider callback resolves to a registered route (no orphans)", () => {
    const routes: RegExp[] = [];
    for (const match of handlerSrc.matchAll(/callbackQuery\(\s*\/(\^payprov:[^/]+)\/,/g)) {
      routes.push(new RegExp(match[1]));
    }
    expect(routes.length).toBe(5);
    for (const key of PROVIDER_KEYS) {
      for (const data of [
        PROV_CB.view(key),
        PROV_CB.toggle(key),
        PROV_CB.toggleConfirm(key, true),
        PROV_CB.toggleConfirm(key, false),
        PROV_CB.settings(key),
        PROV_CB.test(key),
      ]) {
        expect(
          routes.some((route) => route.test(data)),
          `no registered route matches ${data}`,
        ).toBe(true);
      }
    }
    // payprov callbacks pass through the SAME admin-gated area as admin:*.
    expect(appSrc).toMatch(/callbackQuery\(\/\^payprov:\/, adminArea\.middleware\(\)\)/);
    expect(appSrc.indexOf("adminArea.use(adminAuthMiddleware())")).toBeLessThan(
      appSrc.indexOf("adminArea.use(adminFinanceHandler)"),
    );
  });

  it("12. «تنظیمات» routes to the EXISTING provider-specific flows; forged user callbacks are rejected", () => {
    // CARD_TO_CARD -> the existing card-management pages; WALLET -> the
    // existing wallet/payment settings page; no generic settings form.
    const settingsHandler = handlerSrc.slice(handlerSrc.indexOf("async function handleProviderSettings"));
    expect(settingsHandler).toContain("renderCardManagementEntry(ctx)");
    expect(settingsHandler).toContain("renderSettingsPage(ctx)");
    expect(settingsHandler).toContain("providerConfigText");

    // The user checkout handler re-checks isEnabled on gateway pick - a
    // forged/stale callback for a disabled provider answers the template.
    expect(paymentHandlerSrc).toContain("if (!gateway.isEnabled)");
    expect(paymentHandlerSrc).toContain("payment_gateway_unavailable_text");
    expect(templateDefault("payment_gateway_unavailable_text")).toBe(
      "این روش پرداخت در حال حاضر فعال نیست.",
    );
    // Empty state when nothing is selectable.
    expect(paymentHandlerSrc).toContain("payment_no_online_methods_text");
    expect(templateDefault("payment_no_online_methods_text")).toBe(
      "در حال حاضر روش پرداخت فعالی وجود ندارد. لطفاً با پشتیبانی تماس بگیرید.",
    );
  });
});

// =============================================================================
// ENABLE / DISABLE FLOWS (real DB)
// =============================================================================

describe.runIf(hasDb)("ENABLE/DISABLE: config guard, idempotency, nothing deleted (13-16)", () => {
  async function zarinpalRow() {
    return prisma.paymentGateway.findFirst({
      where: { type: "ZARINPAL" },
      orderBy: { createdAt: "asc" },
    });
  }

  it("13. a provider with COMPLETE config enables once; repeats report already-enabled", async () => {
    setSecretEnv();
    expect(await setProviderEnabled("ZARINPAL", true, ADMIN_ID)).toEqual({
      ok: true,
      changed: true,
    });
    expect((await zarinpalRow())?.isEnabled).toBe(true);
    // Duplicate confirmation (double click / stale button).
    expect(await setProviderEnabled("ZARINPAL", true, ADMIN_ID)).toEqual({
      ok: true,
      changed: false,
    });
    expect(templateDefault("payment_provider_already_enabled_text")).toBe(
      "این روش پرداخت از قبل فعال است.",
    );
    expect(templateDefault("payment_provider_enabled_text")).toBe(
      "روش پرداخت با موفقیت فعال شد ✅",
    );
    // Clean up for the next tests.
    expect(await setProviderEnabled("ZARINPAL", false, ADMIN_ID)).toEqual({
      ok: true,
      changed: true,
    });
  });

  it("14. a provider with INCOMPLETE config cannot be enabled (guard re-checks at action time)", async () => {
    clearProviderEnv();
    for (const key of ["ZARINPAL", "NOWPAYMENTS", "TELEGRAM_STARS"] as const) {
      expect(await setProviderEnabled(key, true, ADMIN_ID)).toEqual({
        ok: false,
        changed: false,
        reason: "incomplete_config",
      });
    }
    const rows = await prisma.paymentGateway.findMany({ where: { type: { in: ONLINE_TYPES } } });
    expect(rows.every((row) => !row.isEnabled)).toBe(true);
    expect(templateDefault("payment_provider_config_incomplete_text")).toBe(
      "تنظیمات این درگاه کامل نیست و امکان فعال‌سازی آن وجود ندارد.",
    );
  });

  it("15. disable flips the switch ONLY: config, card accounts and the wallet Setting survive", async () => {
    setSecretEnv();
    const before = await zarinpalRow();
    expect(before).not.toBeNull();
    // Provider config on the row must survive a disable untouched.
    await prisma.paymentGateway.update({
      where: { id: before?.id ?? "" },
      data: { configEncrypted: `cfg-${runTag}` },
    });

    expect(await setProviderEnabled("ZARINPAL", true, ADMIN_ID)).toEqual({
      ok: true,
      changed: true,
    });
    expect(await setProviderEnabled("ZARINPAL", false, ADMIN_ID)).toEqual({
      ok: true,
      changed: true,
    });
    // Repeat disable = already disabled, still nothing deleted.
    expect(await setProviderEnabled("ZARINPAL", false, ADMIN_ID)).toEqual({
      ok: true,
      changed: false,
    });
    expect(templateDefault("payment_provider_already_disabled_text")).toBe(
      "این روش پرداخت از قبل غیرفعال است.",
    );

    const after = await zarinpalRow();
    expect(after?.isEnabled).toBe(false);
    expect(after?.configEncrypted).toBe(`cfg-${runTag}`); // config NOT deleted
    expect(after?.id).toBe(before?.id); // same row, not recreated

    // WALLET disable writes the Setting to false - it never deletes it.
    await setProviderEnabled("WALLET", true, ADMIN_ID);
    expect(await setProviderEnabled("WALLET", false, ADMIN_ID)).toEqual({
      ok: true,
      changed: true,
    });
    expect(await isWalletPaymentEnabled()).toBe(false);
    expect(
      (await prisma.setting.findUnique({ where: { key: WALLET_PAYMENT_ENABLED_KEY } }))?.value,
    ).toBe("false");
    await setProviderEnabled("WALLET", true, ADMIN_ID);
  });

  it("16. disabling a provider leaves existing Payment rows completely untouched", async () => {
    setSecretEnv();
    const gateway = await zarinpalRow();
    expect(gateway).not.toBeNull();
    const user = await prisma.user.create({ data: { telegramId: runTag + 777n } });
    const payment = await prisma.payment.create({
      data: {
        userId: user.id,
        gatewayId: gateway?.id,
        purpose: "ORDER_PAYMENT",
        status: "PENDING",
        amountToman: 50_000,
        payableAmountToman: 50_000,
        provider: "ZARINPAL",
        authority: `A-nav-${runTag}`,
        providerStatus: "SUCCESS",
      },
    });

    expect(await setProviderEnabled("ZARINPAL", true, ADMIN_ID)).toEqual({
      ok: true,
      changed: true,
    });
    expect(await setProviderEnabled("ZARINPAL", false, ADMIN_ID)).toEqual({
      ok: true,
      changed: true,
    });

    const after = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(after).not.toBeNull();
    expect(after?.status).toBe("PENDING"); // NOT cancelled/invalidated
    expect(after?.providerStatus).toBe("SUCCESS"); // external state untouched
    expect(after?.authority).toBe(`A-nav-${runTag}`);
    expect(after?.updatedAt.getTime()).toBe(payment.updatedAt.getTime());
  });
});

// =============================================================================
// DETAIL PAGES OVER REAL DATA + SECURITY (real DB)
// =============================================================================

describe.runIf(hasDb)("DETAIL DATA + SECURITY: rendered pages carry no secrets (17-19)", () => {
  it("17. each provider's detail page renders its provider-specific fields", async () => {
    setSecretEnv();
    process.env.TELEGRAM_STARS_ENABLED = "true";
    const rows = await listManagedProviders();
    expect(rows.map((row) => row.providerKey)).toEqual(PROVIDER_KEYS);
    const byKey = new Map(rows.map((row) => [row.providerKey, row]));

    const card = providerDetailText(byKey.get("CARD_TO_CARD") ?? fixtureRow());
    expect(card).toContain("نوع: پرداخت دستی با رسید");
    expect(card).toContain("کارت‌های فعال:");

    const wallet = providerDetailText(byKey.get("WALLET") ?? fixtureRow());
    expect(wallet).toContain("نوع: پرداخت از موجودی داخلی کاربر");
    expect(wallet).toContain("حداقل/حداکثر شارژ:");

    const zarinpal = providerDetailText(byKey.get("ZARINPAL") ?? fixtureRow());
    expect(zarinpal).toContain("نوع: پرداخت آنلاین ریالی");
    expect(zarinpal).toContain("Merchant ID: تنظیم شده ✅");
    expect(zarinpal).toContain("Callback: تنظیم شده ✅");
    expect(zarinpal).toContain("Sandbox:");
    expect(zarinpal).toContain("آمادگی استفاده: آماده ✅");

    const nowpayments = providerDetailText(byKey.get("NOWPAYMENTS") ?? fixtureRow());
    expect(nowpayments).toContain("نوع: پرداخت کریپتویی");
    expect(nowpayments).toContain("API Key: تنظیم شده ✅");
    expect(nowpayments).toContain("IPN Secret: تنظیم شده ✅");
    expect(nowpayments).toContain("Sandbox:");

    const stars = providerDetailText(byKey.get("TELEGRAM_STARS") ?? fixtureRow());
    expect(stars).toContain("نوع: پرداخت داخل تلگرام");
    expect(stars).toContain("اتصال ربات: فعال ✅");
    expect(stars).toContain("واحد پرداخت: XTR");
    expect(stars).toContain("نرخ ستاره:");
  });

  it("18. no secret literal ever reaches a rendered admin page", async () => {
    setSecretEnv();
    const rows = await listManagedProviders();
    const rendered = rows
      .flatMap((row) => [
        providerListButtonLabel(row),
        providerDetailText(row),
        providerConfigText(row),
        providerToggleConfirmText("آیا مطمئن هستید؟", row),
      ])
      .join("\n");
    for (const secret of [ZP_SECRET_MERCHANT_ID, NP_SECRET_API_KEY, NP_SECRET_IPN]) {
      expect(rendered).not.toContain(secret);
    }
    // The bot token env is never even read by the provider service.
    expect(rendered).not.toContain(process.env.TELEGRAM_BOT_TOKEN ?? "no-token-set-nav");
  });

  it("19. connection-test result texts are fixed templates - raw provider errors never render", async () => {
    // Unconfigured -> INCOMPLETE template, no probe fired.
    clearProviderEnv();
    expect(await testProviderConnection("ZARINPAL")).toEqual({ status: "INCOMPLETE" });
    expect(templateDefault("payment_provider_test_incomplete_text")).toBe(
      "تنظیمات این درگاه ناقص است.",
    );
    expect(templateDefault("payment_provider_test_ok_text")).toBe(
      "اتصال با موفقیت برقرار شد ✅",
    );
    expect(templateDefault("payment_provider_test_failed_text")).toBe(
      "اتصال به سرویس پرداخت برقرار نشد.",
    );
  });
});

describe.skipIf(hasDb)("payment provider navigation (skipped)", () => {
  it("navigation flow tests require DATABASE_URL - see docs/testing.md", () => {
    expect(hasDb).toBe(false);
  });
});
