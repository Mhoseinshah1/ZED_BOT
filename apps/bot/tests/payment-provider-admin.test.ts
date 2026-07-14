import { readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { prisma, type CheckoutSession, type User } from "@zedbot/database";
import { SUPPORTED_ONLINE_PROVIDERS } from "@zedbot/payments";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "payment-provider-admin-tests-secret-01";

import {
  ensureProviderGateways,
  listManagedProviders,
  MANAGED_PROVIDERS,
  managedProviderMeta,
  setProviderEnabled,
  testProviderConnection,
} from "../src/services/admin-payment-provider.service.js";
import { clearGatewayManagerCache } from "../src/services/gateway-payment.service.js";
import {
  getAvailablePaymentMethods,
  hasDormantOnlineGateways,
} from "../src/services/payment-method.service.js";
import {
  isWalletPaymentEnabled,
  WALLET_PAYMENT_ENABLED_KEY,
} from "../src/services/payment-settings.service.js";
import { clearSettingsCache } from "../src/services/settings.service.js";

// =============================================================================
// Admin payment provider management tests (provider-management phase):
//
//   ADMIN ACCESS   - source assertions: the admin-finance composer runs behind
//                    adminAuthMiddleware and every admin:fin:pm:* route is
//                    registered (navigation-integrity style, no DB)
//   BOOTSTRAP      - ensureProviderGateways: one row per real provider type,
//                    online providers DISABLED, idempotent, never touches
//                    existing rows
//   ENABLE/DISABLE - setProviderEnabled CAS semantics + duplicate action
//                    protection, incl. the virtual WALLET Setting
//   USER VISIBILITY- enabled+configured rows reach getAvailablePaymentMethods,
//                    disabled rows never do; hasDormantOnlineGateways drives
//                    the payment_no_online_methods_text empty state
//   SECURITY       - presence-only config markers and provider+admin-id-only
//                    logging: env secrets never appear in output or logs
//   CONNECTION TEST- NOWPayments GET /status and the Zarinpal dummy-verify
//                    envelope probe against a local mock, with
//                    lastCheckedAt/healthStatus persistence
//
// Provider HTTP is served by an in-process node:http mock reached through the
// *_BASE_URL env overrides (the payment-gateways.test.ts pattern). DB suites
// need a MIGRATED, DISPOSABLE PostgreSQL via DATABASE_URL and skip themselves
// without it (docs/testing.md).
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

const PRICE = 50_000;
// Fixture secrets - the SECURITY suite asserts these literals never leak.
const ZP_SECRET_MERCHANT_ID = "zp-secret-mid-123";
const NP_SECRET_API_KEY = "np-secret-key-456";
const NP_SECRET_IPN = "np-ipn-789";
const SET_MARKER = "تنظیم شده";

const ONLINE_TYPES = [...SUPPORTED_ONLINE_PROVIDERS];

// Unique per run so reruns against the same database never collide.
const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
let seq = 0;
const ADMIN_ID = `admin-pm-${runTag}`;

function nextTelegramId(): bigint {
  return runTag + BigInt(++seq);
}

// --- provider mock server (NOWPayments /status + Zarinpal verify.json) ------------------

const mock = {
  npStatusCalls: 0,
  zpVerifyCalls: 0,
  zpVerifyBodies: [] as Array<Record<string, unknown>>,
  /** "error-envelope" = structured v4 error; "html" = non-JSON answer. */
  zpVerifyMode: "error-envelope" as "error-envelope" | "html",
};

function resetMockFlags(): void {
  mock.npStatusCalls = 0;
  mock.zpVerifyCalls = 0;
  mock.zpVerifyBodies = [];
  mock.zpVerifyMode = "error-envelope";
}

let server: http.Server;
let mockHost = "";
/** Nothing listens on port 1 - a guaranteed connection failure. */
const DEAD_HOST = "http://127.0.0.1:1";

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk: Buffer) => (data += chunk.toString()));
    req.on("end", () => resolve(data));
  });
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// --- env fixture handling ---------------------------------------------------------------

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

/** Blank provider env + a fresh gateway manager - each test sets its own. */
function clearProviderEnv(): void {
  for (const key of PROVIDER_ENV_KEYS) {
    delete process.env[key];
  }
  clearGatewayManagerCache();
}

/** Working (fixture) Zarinpal env pointed at the mock - fully configured. */
function setZarinpalEnv(): void {
  process.env.ZARINPAL_MERCHANT_ID = ZP_SECRET_MERCHANT_ID;
  process.env.ZARINPAL_CALLBACK_URL = "https://bot.example.com/payments/zarinpal/callback";
  process.env.ZARINPAL_BASE_URL = mockHost;
  clearGatewayManagerCache();
}

/** Working (fixture) NOWPayments env pointed at the mock - fully configured. */
function setNowPaymentsEnv(): void {
  process.env.NOWPAYMENTS_API_KEY = NP_SECRET_API_KEY;
  process.env.NOWPAYMENTS_IPN_SECRET = NP_SECRET_IPN;
  process.env.NOWPAYMENTS_CALLBACK_URL = "https://bot.example.com/payments/nowpayments/ipn";
  process.env.NOWPAYMENTS_TOMAN_PER_UNIT = "60000";
  process.env.NOWPAYMENTS_BASE_URL = mockHost;
  clearGatewayManagerCache();
}

// --- shared DB state (snapshot in beforeAll, restored in afterAll) ----------------------

let preexistingCardIds = new Set<string>();
let savedWalletSettingValue: string | null = null;

async function onlineGatewayRows() {
  return prisma.paymentGateway.findMany({
    where: { type: { in: ONLINE_TYPES } },
    orderBy: { createdAt: "asc" },
  });
}

async function gatewayRowByType(type: "ZARINPAL" | "NOWPAYMENTS" | "TELEGRAM_STARS" | "CARD_TO_CARD") {
  return prisma.paymentGateway.findFirst({ where: { type }, orderBy: { createdAt: "asc" } });
}

async function createUser(): Promise<User> {
  return prisma.user.create({ data: { telegramId: nextTelegramId() } });
}

async function createOrderCheckout(userId: string, price = PRICE): Promise<CheckoutSession> {
  return prisma.checkoutSession.create({
    data: {
      userId,
      purpose: "ORDER_PAYMENT",
      orderType: "SERVICE_PURCHASE",
      productSnapshot: {
        productName: `pm-product-${runTag}`,
        originalPriceToman: price,
        durationDays: 30,
        volumeGb: 10,
        panelName: `pm-panel-${runTag}`,
      },
      originalPriceToman: price,
      discountAmountToman: 0,
      finalPriceToman: price,
      status: "PENDING",
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  });
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    void (async () => {
      const urlPath = req.url ?? "";

      // Official NOWPayments API status endpoint.
      if (req.method === "GET" && urlPath === "/status") {
        mock.npStatusCalls += 1;
        json(res, 200, { message: "OK" });
        return;
      }

      // Zarinpal v4 verify - the dummy-verify connection probe lands here.
      if (req.method === "POST" && urlPath === "/pg/v4/payment/verify.json") {
        const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
        mock.zpVerifyCalls += 1;
        mock.zpVerifyBodies.push(body);
        if (mock.zpVerifyMode === "html") {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end("<html><body>gateway error page</body></html>");
          return;
        }
        // Structured v4 error envelope ("authority not found") - proves
        // connectivity + API shape without any server-side payment.
        json(res, 200, { data: [], errors: { code: -51, message: "Authority not found" } });
        return;
      }

      json(res, 404, { message: "not found" });
    })();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      mockHost = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      resolve();
    });
  });

  for (const key of PROVIDER_ENV_KEYS) {
    savedEnv[key] = process.env[key];
  }
  clearProviderEnv();

  if (!hasDb) {
    return;
  }
  // Start from a clean online-provider slate: previous suites/runs leave
  // uniquely-named ZARINPAL rows behind (payment-gateways.test.ts). Payments
  // referencing them SET NULL on delete; hidden-gateway rows go first
  // (RESTRICT). CARD_TO_CARD rows may carry card accounts - snapshot them
  // instead of deleting (admin-payment-method.test.ts owns that table).
  await prisma.userHiddenPaymentGateway.deleteMany({
    where: { paymentGateway: { type: { in: ONLINE_TYPES } } },
  });
  await prisma.paymentGateway.deleteMany({ where: { type: { in: ONLINE_TYPES } } });
  preexistingCardIds = new Set(
    (await prisma.paymentGateway.findMany({ where: { type: "CARD_TO_CARD" } })).map((g) => g.id),
  );
  savedWalletSettingValue =
    (await prisma.setting.findUnique({ where: { key: WALLET_PAYMENT_ENABLED_KEY } }))?.value ??
    null;
  clearSettingsCache();
});

afterAll(async () => {
  server?.close();
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
  // Remove the rows this suite bootstrapped and restore the WALLET Setting
  // to its pre-suite value, so later suites see the state they expect.
  await prisma.paymentGateway.deleteMany({ where: { type: { in: ONLINE_TYPES } } });
  await prisma.paymentGateway.deleteMany({
    where: { type: "CARD_TO_CARD", id: { notIn: [...preexistingCardIds] } },
  });
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
  resetMockFlags();
  clearProviderEnv();
});

// =============================================================================
// ADMIN ACCESS (source assertions - no DB, navigation-integrity style)
// =============================================================================

describe("ADMIN ACCESS: provider routes live behind the admin auth gate (1-2)", () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const appSrc = readFileSync(path.join(repoRoot, "apps/bot/src/app.ts"), "utf8");
  const handlerSrc = readFileSync(
    path.join(repoRoot, "apps/bot/src/handlers/admin-finance/admin-finance.handler.ts"),
    "utf8",
  );
  const viewsSrc = readFileSync(
    path.join(repoRoot, "apps/bot/src/handlers/admin-finance/admin-finance-views.ts"),
    "utf8",
  );

  it("1. the admin-finance composer is mounted behind adminAuthMiddleware", () => {
    // The finance composer joins the admin area AFTER the auth guard...
    expect(appSrc).toContain("adminArea.use(adminAuthMiddleware())");
    expect(appSrc).toContain("adminArea.use(adminFinanceHandler)");
    expect(appSrc.indexOf("adminArea.use(adminAuthMiddleware())")).toBeLessThan(
      appSrc.indexOf("adminArea.use(adminFinanceHandler)"),
    );
    // ...and every admin:* callback is routed through that gated area, so
    // admin:fin:pm:* can never execute for a non-admin.
    expect(appSrc).toMatch(/callbackQuery\(\/\^admin:\/, adminArea\.middleware\(\)\)/);
  });

  it("2. every emitted provider callback has a registered callbackQuery route", () => {
    // payprov:* callbacks run through the SAME gated admin area.
    expect(appSrc).toMatch(/callbackQuery\(\/\^payprov:\/, adminArea\.middleware\(\)\)/);

    // Registered provider routes (regex sources) in the finance handler:
    // the payprov navigation routes plus the pre-refactor admin:fin:pm
    // aliases (stale buttons on old messages keep answering).
    const registered: string[] = [];
    for (const match of handlerSrc.matchAll(
      /callbackQuery\(\s*\/\^((?:admin:fin:pm|payprov):[^/]+)\/,/g,
    )) {
      registered.push(match[1]);
    }
    expect(registered.sort()).toEqual([
      "admin:fin:pm:c:([A-Z_]+)$",
      "admin:fin:pm:s:([A-Z_]+)$",
      "admin:fin:pm:t:([A-Z_]+)$",
      "admin:fin:pm:t:([A-Z_]+):(on|off)$",
      "payprov:settings:([A-Z_]+)$",
      "payprov:test:([A-Z_]+)$",
      "payprov:toggle:([A-Z_]+)$",
      "payprov:toggle:([A-Z_]+):(on|off)$",
      "payprov:view:([A-Z_]+)$",
    ]);
    // Stable provider keys only: each route accepts the enum-key alphabet,
    // never free-form display names; the confirm route carries direction.
    for (const source of registered) {
      expect(source).toContain("([A-Z_]+)");
    }
    expect(registered).toContain("payprov:toggle:([A-Z_]+):(on|off)$");

    // Every provider callback the views can emit resolves to a registered
    // route - the legacy admin:fin:pm builders are gone from the views.
    const emitted = new Set<string>();
    for (const match of viewsSrc.matchAll(/`((?:admin:fin:pm|payprov):[a-z:]*)\$\{/g)) {
      emitted.add(match[1]);
    }
    expect([...emitted].sort()).toEqual([
      "payprov:settings:",
      "payprov:test:",
      "payprov:toggle:",
      "payprov:view:",
    ]);
    const prefixes = registered.map((source) => source.slice(0, source.search(/[([\\$?+*]/)));
    for (const prefix of emitted) {
      expect(
        prefixes.some((registeredPrefix) => registeredPrefix.startsWith(prefix)),
        `no route for emitted callback prefix ${prefix}`,
      ).toBe(true);
    }

    // Opening the list page bootstraps the gateway rows.
    expect(handlerSrc).toContain("await ensureProviderGateways()");
  });
});

// =============================================================================
// REGISTRY (pure shape - no DB)
// =============================================================================

describe("REGISTRY: the managed provider registry (3)", () => {
  it("3. five providers in display order; WALLET is virtual; only online gateways are testable", () => {
    expect(MANAGED_PROVIDERS.map((meta) => meta.key)).toEqual([
      "CARD_TO_CARD",
      "WALLET",
      "ZARINPAL",
      "NOWPAYMENTS",
      "TELEGRAM_STARS",
    ]);
    expect(MANAGED_PROVIDERS.filter((meta) => meta.virtual).map((meta) => meta.key)).toEqual([
      "WALLET",
    ]);
    expect(
      MANAGED_PROVIDERS.filter((meta) => meta.supportsConnectionTest).map((meta) => meta.key),
    ).toEqual(["ZARINPAL", "NOWPAYMENTS"]);
    // Lookup is by the stable key; unknown keys and display names miss.
    expect(managedProviderMeta("ZARINPAL")?.displayName).toBe("زرین‌پال");
    expect(managedProviderMeta("زرین‌پال")).toBeNull();
    expect(managedProviderMeta("PLISIO")).toBeNull();
    expect(managedProviderMeta("")).toBeNull();
  });
});

// =============================================================================
// BOOTSTRAP (real DB)
// =============================================================================

describe.runIf(hasDb)("BOOTSTRAP: ensureProviderGateways (4-6)", () => {
  it("4. creates exactly one DISABLED row per online provider (plus the card gateway)", async () => {
    expect(await onlineGatewayRows()).toHaveLength(0); // clean slate
    const cardCountBefore = await prisma.paymentGateway.count({
      where: { type: "CARD_TO_CARD" },
    });

    await ensureProviderGateways();

    for (const type of ONLINE_TYPES) {
      const rows = await prisma.paymentGateway.findMany({ where: { type } });
      expect(rows, `exactly one ${type} row`).toHaveLength(1);
      const meta = managedProviderMeta(type);
      expect(rows[0].isEnabled).toBe(false); // safe default: admin must opt in
      expect(rows[0].isHidden).toBe(false);
      expect(rows[0].name).toBe(meta?.displayName);
      expect(rows[0].lastCheckedAt).toBeNull();
      expect(rows[0].healthStatus).toBeNull();
      expect(rows[0].displayOrder).toBe(
        MANAGED_PROVIDERS.findIndex((candidate) => candidate.key === type),
      );
    }
    // CARD_TO_CARD goes through createCardGatewayIfMissing: created only
    // when absent (Phase 21 semantics - enabled by default).
    const cardCount = await prisma.paymentGateway.count({ where: { type: "CARD_TO_CARD" } });
    expect(cardCount).toBe(Math.max(cardCountBefore, 1));
    if (cardCountBefore === 0) {
      expect((await gatewayRowByType("CARD_TO_CARD"))?.isEnabled).toBe(true);
    }

    // WALLET is virtual: it appears on the managed list WITHOUT a gateway
    // row (no PaymentGatewayType exists for it) and reports the top-up
    // limits as its non-secret config.
    const wallet = (await listManagedProviders()).find((row) => row.providerKey === "WALLET");
    expect(wallet).toBeDefined();
    expect(wallet?.gatewayId).toBeUndefined();
    expect(wallet?.configured).toBe(true);
    expect(wallet?.configLines.join("\n")).toContain("حداقل/حداکثر شارژ");
  });

  it("5. a second call creates nothing and touches nothing (idempotent)", async () => {
    const before = await prisma.paymentGateway.findMany({ orderBy: { id: "asc" } });
    await ensureProviderGateways();
    const after = await prisma.paymentGateway.findMany({ orderBy: { id: "asc" } });
    expect(after).toHaveLength(before.length);
    expect(
      after.map((g) => ({ id: g.id, name: g.name, isEnabled: g.isEnabled, at: g.updatedAt.getTime() })),
    ).toEqual(
      before.map((g) => ({ id: g.id, name: g.name, isEnabled: g.isEnabled, at: g.updatedAt.getTime() })),
    );
  });

  it("6. existing rows are never overwritten: a customized name survives re-runs", async () => {
    const zarinpal = await gatewayRowByType("ZARINPAL");
    expect(zarinpal).not.toBeNull();
    const customName = `درگاه ریالی ${runTag}`;
    await prisma.paymentGateway.update({
      where: { id: zarinpal?.id ?? "" },
      data: { name: customName },
    });

    await ensureProviderGateways();

    const rows = await prisma.paymentGateway.findMany({ where: { type: "ZARINPAL" } });
    expect(rows).toHaveLength(1); // still no duplicate
    expect(rows[0].name).toBe(customName); // customization preserved
    // The managed list renders the stored name, keyed by the stable type.
    const listed = (await listManagedProviders()).find((row) => row.providerKey === "ZARINPAL");
    expect(listed?.displayName).toBe(customName);
    expect(listed?.gatewayId).toBe(rows[0].id);
  });
});

// =============================================================================
// ENABLE / DISABLE (real DB)
// =============================================================================

describe.runIf(hasDb)("ENABLE/DISABLE: setProviderEnabled with duplicate protection (7-9)", () => {
  it("7. ZARINPAL: enable flips the row once; the repeat is a protected duplicate", async () => {
    const row = await gatewayRowByType("ZARINPAL");
    expect(row?.isEnabled).toBe(false);

    // The enable guard re-checks env config at action time - enabling with
    // NO config is refused and flips nothing (spec: incomplete config).
    expect(await setProviderEnabled("ZARINPAL", true, ADMIN_ID)).toEqual({
      ok: false,
      changed: false,
      reason: "incomplete_config",
    });
    expect((await gatewayRowByType("ZARINPAL"))?.isEnabled).toBe(false);

    setZarinpalEnv();
    const enabled = await setProviderEnabled("ZARINPAL", true, ADMIN_ID);
    expect(enabled).toEqual({ ok: true, changed: true });
    expect((await gatewayRowByType("ZARINPAL"))?.isEnabled).toBe(true);

    // Double click / stale confirmation: same request again is a no-op.
    const duplicate = await setProviderEnabled("ZARINPAL", true, ADMIN_ID);
    expect(duplicate).toEqual({ ok: true, changed: false });
    expect((await gatewayRowByType("ZARINPAL"))?.isEnabled).toBe(true);

    // Disable is symmetric.
    const disabled = await setProviderEnabled("ZARINPAL", false, ADMIN_ID);
    expect(disabled).toEqual({ ok: true, changed: true });
    expect((await gatewayRowByType("ZARINPAL"))?.isEnabled).toBe(false);
    const duplicateDisable = await setProviderEnabled("ZARINPAL", false, ADMIN_ID);
    expect(duplicateDisable).toEqual({ ok: true, changed: false });
    expect((await gatewayRowByType("ZARINPAL"))?.isEnabled).toBe(false);
  });

  it("8. WALLET: flips the wallet_payment_enabled Setting, duplicates detected, no gateway row", async () => {
    // Known baseline for this test: enabled (the Setting default).
    await prisma.setting.deleteMany({ where: { key: WALLET_PAYMENT_ENABLED_KEY } });
    clearSettingsCache();
    expect(await isWalletPaymentEnabled()).toBe(true);
    const gatewayCountBefore = await prisma.paymentGateway.count();

    // Duplicate protection works even against the implicit default state.
    expect(await setProviderEnabled("WALLET", true, ADMIN_ID)).toEqual({
      ok: true,
      changed: false,
    });

    expect(await setProviderEnabled("WALLET", false, ADMIN_ID)).toEqual({
      ok: true,
      changed: true,
    });
    // Visible through the payment-settings service AND persisted as a row.
    expect(await isWalletPaymentEnabled()).toBe(false);
    expect(
      (await prisma.setting.findUnique({ where: { key: WALLET_PAYMENT_ENABLED_KEY } }))?.value,
    ).toBe("false");

    expect(await setProviderEnabled("WALLET", false, ADMIN_ID)).toEqual({
      ok: true,
      changed: false,
    });

    expect(await setProviderEnabled("WALLET", true, ADMIN_ID)).toEqual({
      ok: true,
      changed: true,
    });
    expect(await isWalletPaymentEnabled()).toBe(true);

    // Virtual means virtual: no PaymentGateway row was ever created.
    expect(await prisma.paymentGateway.count()).toBe(gatewayCountBefore);
  });

  it("9. unknown provider keys are rejected without touching anything", async () => {
    const before = await prisma.paymentGateway.findMany({ orderBy: { id: "asc" } });
    expect(await setProviderEnabled("PLISIO", true, ADMIN_ID)).toEqual({
      ok: false,
      changed: false,
    });
    expect(await setProviderEnabled("زرین‌پال", true, ADMIN_ID)).toEqual({
      ok: false,
      changed: false,
    });
    const after = await prisma.paymentGateway.findMany({ orderBy: { id: "asc" } });
    expect(after.map((g) => ({ id: g.id, isEnabled: g.isEnabled }))).toEqual(
      before.map((g) => ({ id: g.id, isEnabled: g.isEnabled })),
    );
  });
});

// =============================================================================
// USER VISIBILITY (real DB)
// =============================================================================

describe.runIf(hasDb)("USER VISIBILITY: only enabled+configured providers reach users (10-12)", () => {
  let user: User;
  let checkout: CheckoutSession;

  beforeAll(async () => {
    user = await createUser();
    checkout = await createOrderCheckout(user.id); // amount within (null) limits
  });

  it("10. ENABLED row + working env config -> offered to the paying user", async () => {
    setZarinpalEnv();
    expect(await setProviderEnabled("ZARINPAL", true, ADMIN_ID)).toEqual({
      ok: true,
      changed: true,
    });
    const zarinpal = await gatewayRowByType("ZARINPAL");
    const methods = await getAvailablePaymentMethods(user, checkout);
    expect(methods.some((g) => g.id === zarinpal?.id)).toBe(true);
  });

  it("11. DISABLED row -> excluded even though the env config still works", async () => {
    setZarinpalEnv();
    expect(await setProviderEnabled("ZARINPAL", false, ADMIN_ID)).toEqual({
      ok: true,
      changed: true,
    });
    const zarinpal = await gatewayRowByType("ZARINPAL");
    const methods = await getAvailablePaymentMethods(user, checkout);
    expect(methods.some((g) => g.id === zarinpal?.id)).toBe(false);
  });

  it("12. hasDormantOnlineGateways: true for admin-disabled AND enabled-but-unconfigured rows", async () => {
    // Disabled online rows exist (ZARINPAL was switched off in test 11,
    // NOWPAYMENTS/TELEGRAM_STARS bootstrapped disabled) -> the checkout
    // empty state must use payment_no_online_methods_text.
    expect(await hasDormantOnlineGateways()).toBe(true);

    // The adapter-unavailable branch: enabled rows whose env config has
    // been REMOVED are still dormant (nothing selectable). The enable
    // guard blocks reaching this state through setProviderEnabled, so the
    // rows are flipped directly - simulating config removed after enable.
    clearProviderEnv();
    await prisma.paymentGateway.updateMany({
      where: { type: { in: ONLINE_TYPES } },
      data: { isEnabled: true },
    });
    expect(await hasDormantOnlineGateways()).toBe(true);
    // And none of them reaches the user's method list either.
    const methods = await getAvailablePaymentMethods(user, checkout);
    expect(methods.some((g) => ONLINE_TYPES.includes(g.type as (typeof ONLINE_TYPES)[number]))).toBe(
      false,
    );

    // Leave every online provider disabled for the following suites -
    // disable is NEVER guarded by config, so the service switch works.
    for (const type of ONLINE_TYPES) {
      expect(await setProviderEnabled(type, false, ADMIN_ID)).toEqual({
        ok: true,
        changed: true,
      });
    }
  });
});

// =============================================================================
// SECURITY (real DB)
// =============================================================================

describe.runIf(hasDb)("SECURITY: presence-only markers and secret-free logs (13-14)", () => {
  function setSecretEnv(): void {
    process.env.ZARINPAL_MERCHANT_ID = ZP_SECRET_MERCHANT_ID;
    process.env.ZARINPAL_CALLBACK_URL = "https://bot.example.com/payments/zarinpal/callback";
    process.env.NOWPAYMENTS_API_KEY = NP_SECRET_API_KEY;
    process.env.NOWPAYMENTS_IPN_SECRET = NP_SECRET_IPN;
    clearGatewayManagerCache();
  }

  it("13. listManagedProviders reports تنظیم شده markers but never the secret values", async () => {
    setSecretEnv();
    const rows = await listManagedProviders();
    const serialized = JSON.stringify(rows);

    // Presence markers exist for the configured fields...
    expect(serialized).toContain(SET_MARKER);
    const zarinpal = rows.find((row) => row.providerKey === "ZARINPAL");
    expect(zarinpal?.configured).toBe(true);
    expect(zarinpal?.configLines.some((line) => line.includes(`Merchant ID: ${SET_MARKER}`))).toBe(
      true,
    );
    const nowpayments = rows.find((row) => row.providerKey === "NOWPAYMENTS");
    expect(nowpayments?.configLines.some((line) => line.includes(`API Key: ${SET_MARKER}`))).toBe(
      true,
    );
    expect(
      nowpayments?.configLines.some((line) => line.includes(`IPN Secret: ${SET_MARKER}`)),
    ).toBe(true);
    // ...missing fields show the unset marker instead of a value...
    expect(nowpayments?.configured).toBe(false); // callback + rate not set
    expect(serialized).toContain("تنظیم نشده");

    // ...and NONE of the secret literals appear anywhere in the output.
    expect(serialized).not.toContain(ZP_SECRET_MERCHANT_ID);
    expect(serialized).not.toContain(NP_SECRET_API_KEY);
    expect(serialized).not.toContain(NP_SECRET_IPN);
  });

  it("14. enable/disable + connection-test logs carry provider key and admin id only", async () => {
    setNowPaymentsEnv(); // full config (enable guard) pointed at the mock
    const savedLogLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "info";

    const written: string[] = [];
    const stdoutWrite = process.stdout.write;
    const stderrWrite = process.stderr.write;
    const capture = ((chunk: unknown): boolean => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stdout.write = capture;
    process.stderr.write = capture;
    try {
      expect(await setProviderEnabled("NOWPAYMENTS", true, ADMIN_ID)).toEqual({
        ok: true,
        changed: true,
      });
      expect((await testProviderConnection("NOWPAYMENTS")).status).toBe("OK");
      expect(await setProviderEnabled("NOWPAYMENTS", false, ADMIN_ID)).toEqual({
        ok: true,
        changed: true,
      });
    } finally {
      process.stdout.write = stdoutWrite;
      process.stderr.write = stderrWrite;
      if (savedLogLevel === undefined) {
        delete process.env.LOG_LEVEL;
      } else {
        process.env.LOG_LEVEL = savedLogLevel;
      }
    }

    const output = written.join("");
    // The audit trail exists: provider key + acting admin id...
    expect(output).toContain("payment provider enabled");
    expect(output).toContain("payment provider disabled");
    expect(output).toContain("payment provider connection test");
    expect(output).toContain("NOWPAYMENTS");
    expect(output).toContain(ADMIN_ID);
    // ...but never any credential.
    expect(output).not.toContain(ZP_SECRET_MERCHANT_ID);
    expect(output).not.toContain(NP_SECRET_API_KEY);
    expect(output).not.toContain(NP_SECRET_IPN);
  });
});

// =============================================================================
// CONNECTION TEST (real DB + mock provider server)
// =============================================================================

describe.runIf(hasDb)("CONNECTION TEST: probes + lastCheckedAt/healthStatus persistence (15-19)", () => {
  it("15. NOWPayments GET /status 200 {message: OK} -> OK, healthStatus OK, lastCheckedAt set", async () => {
    setNowPaymentsEnv();
    const before = Date.now();
    const result = await testProviderConnection("NOWPAYMENTS");
    expect(result).toEqual({ status: "OK" }); // never more than the status - no provider payloads
    expect(mock.npStatusCalls).toBe(1);

    const row = await gatewayRowByType("NOWPAYMENTS");
    expect(row?.healthStatus).toBe("OK");
    expect(row?.lastCheckedAt).not.toBeNull();
    expect(row?.lastCheckedAt?.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it("16. unreachable NOWPayments host -> FAILED persisted", async () => {
    setNowPaymentsEnv();
    process.env.NOWPAYMENTS_BASE_URL = DEAD_HOST;
    const previous = (await gatewayRowByType("NOWPAYMENTS"))?.lastCheckedAt;
    const result = await testProviderConnection("NOWPAYMENTS");
    expect(result).toEqual({ status: "FAILED" });

    const row = await gatewayRowByType("NOWPAYMENTS");
    expect(row?.healthStatus).toBe("FAILED"); // the outcome, never the raw error
    expect(row?.lastCheckedAt?.getTime()).toBeGreaterThanOrEqual(previous?.getTime() ?? 0);
  });

  it("17. Zarinpal structured error envelope on the dummy verify -> OK", async () => {
    setZarinpalEnv();
    mock.zpVerifyMode = "error-envelope";
    const result = await testProviderConnection("ZARINPAL");
    expect(result).toEqual({ status: "OK" });
    expect(mock.zpVerifyCalls).toBe(1);
    // The probe is a WELL-FORMED DUMMY verify: fixed authority shape, tiny
    // amount - verify.json never creates anything server-side, and the
    // structured error answer alone proves connectivity + API shape.
    expect(mock.zpVerifyBodies[0]).toMatchObject({
      amount: 1000,
      authority: "A" + "0".repeat(35),
    });
    expect(typeof mock.zpVerifyBodies[0].merchant_id).toBe("string");

    const row = await gatewayRowByType("ZARINPAL");
    expect(row?.healthStatus).toBe("OK");
    expect(row?.lastCheckedAt).not.toBeNull();
  });

  it("18. Zarinpal non-JSON/HTML answer -> FAILED persisted", async () => {
    setZarinpalEnv();
    mock.zpVerifyMode = "html";
    const result = await testProviderConnection("ZARINPAL");
    expect(result).toEqual({ status: "FAILED" });
    expect(mock.zpVerifyCalls).toBe(1);

    const row = await gatewayRowByType("ZARINPAL");
    expect(row?.healthStatus).toBe("FAILED");
  });

  it("19. unsupported/incomplete providers: no request, no persistence", async () => {
    // Guard against a regression ever reaching a real host.
    process.env.ZARINPAL_BASE_URL = DEAD_HOST;
    process.env.NOWPAYMENTS_BASE_URL = DEAD_HOST;
    const cardBefore = await gatewayRowByType("CARD_TO_CARD");
    const zarinpalBefore = await gatewayRowByType("ZARINPAL");

    // No meaningful test exists for these providers - UNSUPPORTED, and no
    // fake test is ever invented for the wallet/card/stars pages.
    expect(await testProviderConnection("CARD_TO_CARD")).toEqual({ status: "UNSUPPORTED" });
    expect(await testProviderConnection("WALLET")).toEqual({ status: "UNSUPPORTED" });
    expect(await testProviderConnection("TELEGRAM_STARS")).toEqual({ status: "UNSUPPORTED" });
    expect(await testProviderConnection("bogus")).toEqual({ status: "UNSUPPORTED" });

    // Supported provider with UNCONFIGURED env: INCOMPLETE - the probe is
    // skipped and no misleading FAILED is persisted.
    expect(await testProviderConnection("ZARINPAL")).toEqual({ status: "INCOMPLETE" });

    expect(mock.npStatusCalls).toBe(0);
    expect(mock.zpVerifyCalls).toBe(0);
    const cardAfter = await gatewayRowByType("CARD_TO_CARD");
    expect(cardAfter?.healthStatus ?? null).toBe(cardBefore?.healthStatus ?? null);
    expect(cardAfter?.lastCheckedAt?.getTime() ?? null).toBe(
      cardBefore?.lastCheckedAt?.getTime() ?? null,
    );
    const zarinpalAfter = await gatewayRowByType("ZARINPAL");
    expect(zarinpalAfter?.healthStatus).toBe(zarinpalBefore?.healthStatus);
    expect(zarinpalAfter?.lastCheckedAt?.getTime()).toBe(
      zarinpalBefore?.lastCheckedAt?.getTime(),
    );
  });
});

describe.skipIf(hasDb)("payment provider admin (skipped)", () => {
  it("provider-management E2E tests require DATABASE_URL - see docs/testing.md", () => {
    expect(hasDb).toBe(false);
  });
});
