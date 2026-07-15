import { createHmac, randomUUID } from "node:crypto";
import http from "node:http";

import {
  CheckoutStatus,
  OrderStatus,
  PaymentGatewayType,
  PaymentStatus,
  prisma,
  type CheckoutSession,
  type PaymentGateway as PaymentGatewayRow,
  type User,
} from "@zedbot/database";
import {
  buildDefaultManager,
  NowPaymentsGateway,
  parseStarsPayload,
  PaymentGatewayManager,
  STARS_PAYLOAD_PREFIX,
  SUPPORTED_ONLINE_PROVIDERS,
  TelegramStarsGateway,
  verifyIpnSignature,
  ZarinpalGateway,
} from "@zedbot/payments";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "payment-gateway-tests-shared-secret-01";

import type { CheckoutDraft } from "../src/core/session.js";
import {
  validateStarsPreCheckout,
  type StarsPreCheckoutPayment,
} from "../src/handlers/stars-payment.handler.js";
import {
  clearGatewayManagerCache,
  getOrCreateGatewayPayment,
  recordProviderSuccessFromBot,
  runGatewaySettlementSweep,
  settleGatewayPayment,
} from "../src/services/gateway-payment.service.js";
import {
  getAvailablePaymentMethods,
  submitReceipt,
} from "../src/services/payment-method.service.js";
import {
  payPurchaseDraftWithWallet,
  WALLET_ORDER_PAYMENT_REASON,
} from "../src/services/wallet-payment.service.js";
import { WALLET_TOPUP_REASON } from "../src/services/wallet-topup.service.js";

// =============================================================================
// Payment gateway system tests (spec C):
//
//   ARCHITECTURE  - manager registry + admin-facing availability gating
//   ZARINPAL      - adapter contract against a stateful mock v4 REST server
//   NOWPAYMENTS   - invoice creation + IPN signature/status mapping
//   STARS         - XTR invoice spec + payload parsing
//   LIFECYCLE     - real-DB exactly-once settlement (creation reuse, CAS
//                   settle, wallet credit, sweep, wallet/card regressions)
//   SECURITY      - secret hygiene, pre-checkout validation, replay and
//                   tamper resistance
//
// Zarinpal/NOWPayments HTTP is served by an in-process node:http mock (the
// panel-mock pattern from xui-lifecycle.test.ts) that the adapters reach via
// the ZarinpalConfig/NowPaymentsConfig `baseUrl` override (env fallback
// ZARINPAL_BASE_URL / NOWPAYMENTS_BASE_URL). DB suites need a MIGRATED,
// DISPOSABLE PostgreSQL via DATABASE_URL and skip themselves without it
// (docs/testing.md).
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

const PRICE = 50_000;
const MERCHANT_ID = "zp-merchant-11111111-2222-3333-4444-555555555555";
const NP_API_KEY = "np-test-api-key-0001";
const NP_IPN_SECRET = "np-test-ipn-secret-0001";

// Unique per run so reruns against the same database never collide.
const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
let seq = 0;

function nextTelegramId(): bigint {
  return runTag + BigInt(++seq);
}

function uniqueAuthority(prefix: string): string {
  return `${prefix}-${runTag}-${++seq}`;
}

// --- stateful Zarinpal + NOWPayments mock server ---------------------------------------

const zpMock = {
  requestCalls: 0,
  verifyCalls: 0,
  requestBodies: [] as Array<Record<string, unknown>>,
  verifyBodies: [] as Array<Record<string, unknown>>,
  /** null = success (code 100 + fresh authority); a number = failure code. */
  requestFailCode: null as number | null,
  /** 100 = verified now, 101 = already verified, other = failure code. */
  verifyCode: 100,
  verifyRefId: 1234567,
  lastAuthority: "",
};

const npMock = {
  invoiceCalls: 0,
  invoiceBodies: [] as Array<Record<string, unknown>>,
  invoiceId: 4000001,
  /** null = success; a number = HTTP error status. */
  invoiceFailStatus: null as number | null,
};

function resetMockFlags(): void {
  zpMock.requestCalls = 0;
  zpMock.verifyCalls = 0;
  zpMock.requestBodies = [];
  zpMock.verifyBodies = [];
  zpMock.requestFailCode = null;
  zpMock.verifyCode = 100;
  zpMock.verifyRefId = 1234567;
  npMock.invoiceCalls = 0;
  npMock.invoiceBodies = [];
  npMock.invoiceFailStatus = null;
}

let server: http.Server;
let mockHost = "";

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

beforeAll(async () => {
  server = http.createServer((req, res) => {
    void (async () => {
      const path = req.url ?? "";

      if (req.method === "POST" && path === "/pg/v4/payment/request.json") {
        const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
        zpMock.requestCalls += 1;
        zpMock.requestBodies.push(body);
        if (zpMock.requestFailCode !== null) {
          json(res, 200, { data: [], errors: { code: zpMock.requestFailCode, message: "failed" } });
          return;
        }
        // Authorities are minted unique per call: Payment.authority is a
        // UNIQUE column, so reruns against the same DB must never collide.
        zpMock.lastAuthority = uniqueAuthority("A0000zp");
        json(res, 200, {
          data: { code: 100, message: "Success", authority: zpMock.lastAuthority, fee: 0 },
          errors: [],
        });
        return;
      }

      if (req.method === "POST" && path === "/pg/v4/payment/verify.json") {
        const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
        zpMock.verifyCalls += 1;
        zpMock.verifyBodies.push(body);
        if (zpMock.verifyCode === 100 || zpMock.verifyCode === 101) {
          json(res, 200, {
            data: {
              code: zpMock.verifyCode,
              message: zpMock.verifyCode === 100 ? "Verified" : "Already verified",
              ref_id: zpMock.verifyRefId,
              card_pan: "502229******1234",
            },
            errors: [],
          });
          return;
        }
        json(res, 200, { data: [], errors: { code: zpMock.verifyCode, message: "failed" } });
        return;
      }

      if (req.method === "POST" && path === "/invoice") {
        const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
        npMock.invoiceCalls += 1;
        npMock.invoiceBodies.push(body);
        if (npMock.invoiceFailStatus !== null) {
          json(res, npMock.invoiceFailStatus, { message: "invoice failed" });
          return;
        }
        json(res, 200, {
          id: npMock.invoiceId,
          invoice_url: `${mockHost}/inv/${npMock.invoiceId}`,
          order_id: body.order_id,
          price_amount: body.price_amount,
        });
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
});

afterAll(() => {
  server?.close();
});

afterEach(() => {
  resetMockFlags();
});

function zpGateway(overrides: Partial<ConstructorParameters<typeof ZarinpalGateway>[0]> = {}) {
  return new ZarinpalGateway({
    merchantId: MERCHANT_ID,
    sandbox: false,
    callbackUrl: "https://bot.example.com/payments/zarinpal/callback",
    baseUrl: mockHost,
    ...overrides,
  });
}

function npGateway(overrides: Partial<ConstructorParameters<typeof NowPaymentsGateway>[0]> = {}) {
  return new NowPaymentsGateway({
    apiKey: NP_API_KEY,
    ipnSecret: NP_IPN_SECRET,
    callbackUrl: "https://bot.example.com/payments/nowpayments/ipn",
    sandbox: false,
    priceCurrency: "usd",
    tomanPerUnit: 70_000,
    baseUrl: mockHost,
    ...overrides,
  });
}

/** Recursively sorts object keys, mirroring NOWPayments' documented rule. */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (typeof value === "object" && value !== null) {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = sortKeysDeep(source[key]);
    }
    return sorted;
  }
  return value;
}

function signIpn(body: Record<string, unknown>, secret: string): string {
  return createHmac("sha512", secret)
    .update(JSON.stringify(sortKeysDeep(body)))
    .digest("hex");
}

// =============================================================================
// ARCHITECTURE
// =============================================================================

describe("ARCHITECTURE: gateway manager registry (1)", () => {
  it("1. buildDefaultManager returns adapters; unsupported providers resolve to null", () => {
    const manager = buildDefaultManager({ starsTomanPerStar: 1500 });
    expect(manager).toBeInstanceOf(PaymentGatewayManager);
    expect(manager.get("ZARINPAL")).toBeInstanceOf(ZarinpalGateway);
    expect(manager.get("NOWPAYMENTS")).toBeInstanceOf(NowPaymentsGateway);
    expect(manager.get("TELEGRAM_STARS")).toBeInstanceOf(TelegramStarsGateway);
    // Unsupported / unknown providers are rejected with null, never a throw.
    expect(manager.get("PLISIO")).toBeNull();
    expect(manager.get("bogus")).toBeNull();
    expect(manager.get("CARD_TO_CARD")).toBeNull();
    expect(SUPPORTED_ONLINE_PROVIDERS).toEqual(["ZARINPAL", "NOWPAYMENTS", "TELEGRAM_STARS"]);
    // available() only reports adapters whose isAvailable() is true.
    const none = new PaymentGatewayManager({
      ZARINPAL: new ZarinpalGateway({ sandbox: false }),
    });
    expect(none.available()).toEqual([]);
    const wired = new PaymentGatewayManager({ ZARINPAL: zpGateway() });
    expect(wired.available()).toEqual(["ZARINPAL"]);
  });
});

// =============================================================================
// ZARINPAL (adapter vs mock)
// =============================================================================

describe("ZARINPAL adapter against the v4 mock (3-6)", () => {
  it("3. createPayment success returns the authority and a StartPay redirect", async () => {
    const result = await zpGateway().createPayment({
      paymentId: "pay-zp-1",
      amountToman: PRICE,
      description: "ZED_BOT order pay-zp-1",
    });
    expect(result.ok).toBe(true);
    expect(result.authority).toBe(zpMock.lastAuthority);
    expect(result.redirectUrl).toBe(`${mockHost}/pg/StartPay/${zpMock.lastAuthority}`);
    expect(zpMock.requestCalls).toBe(1);
    expect(zpMock.requestBodies[0]).toMatchObject({
      merchant_id: MERCHANT_ID,
      amount: PRICE,
      currency: "IRT",
    });
  });

  it("4. verifyPayment success (code 100) is SUCCESS with the ref_id", async () => {
    zpMock.verifyRefId = 987654321;
    const result = await zpGateway().verifyPayment({ authority: "A-verify-1", amountToman: PRICE });
    expect(result.ok).toBe(true);
    expect(result.status).toBe("SUCCESS");
    expect(result.transactionId).toBe("987654321");
    expect(result.uncertain).toBeUndefined();
    expect(zpMock.verifyBodies[0]).toMatchObject({
      merchant_id: MERCHANT_ID,
      amount: PRICE,
      authority: "A-verify-1",
    });
  });

  it("5. verifyPayment failure (non-100/101 code) is a DEFINITE FAILED, never uncertain", async () => {
    zpMock.verifyCode = -51;
    const result = await zpGateway().verifyPayment({ authority: "A-verify-2", amountToman: PRICE });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("FAILED");
    expect(result.uncertain).toBeUndefined();
    expect(result.errorMessage).toContain("-51");
  });

  it("6. duplicate verification: code 101 is SUCCESS again (verify called twice)", async () => {
    const gateway = zpGateway();
    const first = await gateway.verifyPayment({ authority: "A-verify-3", amountToman: PRICE });
    expect(first.ok).toBe(true);
    expect(first.status).toBe("SUCCESS");
    zpMock.verifyCode = 101; // Zarinpal's own duplicate-verification answer
    const second = await gateway.verifyPayment({ authority: "A-verify-3", amountToman: PRICE });
    expect(second.ok).toBe(true);
    expect(second.status).toBe("SUCCESS");
    expect(second.transactionId).toBe(String(zpMock.verifyRefId));
    expect(zpMock.verifyCalls).toBe(2);
    // Settlement staying exactly-once despite repeated verifications is
    // proven against the real DB in LIFECYCLE test 13.
  });
});

// =============================================================================
// NOWPAYMENTS
// =============================================================================

describe("NOWPAYMENTS adapter, IPN signature and status mapping (7-9)", () => {
  it("7. invoice creation returns authority/externalReference/redirectUrl", async () => {
    const result = await npGateway().createPayment({
      paymentId: "pay-np-1",
      amountToman: 700_000,
      description: "ZED_BOT order pay-np-1",
    });
    expect(result.ok).toBe(true);
    expect(result.authority).toBe("4000001");
    expect(result.externalReference).toBe("4000001");
    expect(result.redirectUrl).toBe(`${mockHost}/inv/4000001`);
    expect(npMock.invoiceCalls).toBe(1);
    expect(npMock.invoiceBodies[0]).toMatchObject({
      order_id: "pay-np-1",
      price_amount: 10, // 700,000 toman / 70,000 toman-per-usd
      price_currency: "usd",
    });
  });

  it("8. verifyIpnSignature: sorted-keys HMAC-SHA512 passes; tampering and wrong secrets fail", () => {
    // Keys deliberately out of order to prove the sorted-canonical rule.
    const body = {
      payment_status: "finished",
      order_id: "pay-np-2",
      invoice_id: 4000001,
      payment_id: 5001,
      outcome: { amount: 10.0, currency: "usd" },
    };
    const rawBody = JSON.stringify(body);
    const signature = signIpn(body, NP_IPN_SECRET);
    expect(verifyIpnSignature(rawBody, signature, NP_IPN_SECRET)).toBe(true);
    // Tampered body: same signature no longer matches.
    const tampered = rawBody.replace('"finished"', '"failed"');
    expect(verifyIpnSignature(tampered, signature, NP_IPN_SECRET)).toBe(false);
    // Wrong secret fails, as do empty inputs and non-JSON bodies.
    expect(verifyIpnSignature(rawBody, signature, "some-other-secret")).toBe(false);
    expect(verifyIpnSignature("", signature, NP_IPN_SECRET)).toBe(false);
    expect(verifyIpnSignature(rawBody, "", NP_IPN_SECRET)).toBe(false);
    expect(verifyIpnSignature("not json", signature, NP_IPN_SECRET)).toBe(false);
  });

  it("9. handleCallback maps provider statuses and sanitizes the payload", () => {
    const gateway = npGateway();
    const cases: Array<[string, string]> = [
      ["finished", "SUCCESS"],
      ["confirming", "PROCESSING"],
      ["expired", "EXPIRED"],
      ["failed", "FAILED"],
      ["weird", "UNKNOWN"],
    ];
    for (const [providerStatus, expected] of cases) {
      const body = {
        payment_status: providerStatus,
        order_id: "pay-np-3",
        invoice_id: 4000001,
        payment_id: 5001,
        price_amount: 10,
        pay_currency: "trx",
        actually_paid: 120,
      };
      const signature = signIpn(body, NP_IPN_SECRET);
      const parsed = gateway.handleCallback({
        rawBody: JSON.stringify(body),
        headers: { "x-nowpayments-ipn-signature": signature },
      });
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) {
        continue;
      }
      expect(parsed.event.status).toBe(expected);
      expect(parsed.event.paymentId).toBe("pay-np-3");
      expect(parsed.event.externalReference).toBe("4000001");
      expect(parsed.event.transactionId).toBe("5001");
      // Sanitized payload: whitelisted business fields only - never the
      // signature or any header key/value.
      expect(Object.keys(parsed.event.sanitizedPayload).sort()).toEqual([
        "actually_paid",
        "invoice_id",
        "order_id",
        "pay_currency",
        "payment_id",
        "payment_status",
        "price_amount",
      ]);
      const serialized = JSON.stringify(parsed.event);
      expect(serialized).not.toContain(signature);
      expect(serialized.toLowerCase()).not.toContain("signature");
    }
  });
});

// =============================================================================
// STARS
// =============================================================================

describe("STARS gateway invoice spec and payload parsing (10-11)", () => {
  it("10. createPayment builds the XTR invoice spec (ceil rate, zedbot:pay payload); missing rate fails", async () => {
    const gateway = new TelegramStarsGateway({ enabled: true, tomanPerStar: 1000 });
    const result = await gateway.createPayment({
      paymentId: "pay-stars-1",
      amountToman: 24_001,
      description: "ZED_BOT order pay-stars-1",
    });
    expect(result.ok).toBe(true);
    expect(result.authority).toBe("zedbot:pay:pay-stars-1");
    expect(result.telegramInvoice).toMatchObject({
      currency: "XTR",
      payload: "zedbot:pay:pay-stars-1",
      stars: 25, // ceil(24001 / 1000)
    });
    expect(result.telegramInvoice?.title.length).toBeLessThanOrEqual(32);
    // Exact division stays exact; tiny amounts still charge at least 1 star.
    const exact = await gateway.createPayment({
      paymentId: "p2",
      amountToman: 25_000,
      description: "d",
    });
    expect(exact.telegramInvoice?.stars).toBe(25);
    const tiny = await gateway.createPayment({ paymentId: "p3", amountToman: 1, description: "d" });
    expect(tiny.telegramInvoice?.stars).toBe(1);
    // Rate missing -> not ok (never a zero/NaN invoice).
    const noRate = await new TelegramStarsGateway({ enabled: true }).createPayment({
      paymentId: "p4",
      amountToman: 10_000,
      description: "d",
    });
    expect(noRate.ok).toBe(false);
    expect(noRate.telegramInvoice).toBeUndefined();
  });

  it("11. parseStarsPayload round-trips its own payloads and rejects garbage", () => {
    const paymentId = randomUUID();
    expect(parseStarsPayload(`${STARS_PAYLOAD_PREFIX}${paymentId}`)).toBe(paymentId);
    expect(parseStarsPayload("")).toBeNull();
    expect(parseStarsPayload("zedbot:pay:")).toBeNull(); // empty id
    expect(parseStarsPayload("zedbot:pay")).toBeNull();
    expect(parseStarsPayload(`other:pay:${paymentId}`)).toBeNull();
    expect(parseStarsPayload(paymentId)).toBeNull();
  });
});

// =============================================================================
// SECURITY (provider-pure)
// =============================================================================

describe("SECURITY: secret hygiene and Stars pre-checkout validation (20-21)", () => {
  it("20. merchant id never appears in adapter results, errors or log output", async () => {
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
      const gateway = zpGateway();
      const created = await gateway.createPayment({
        paymentId: "pay-sec-1",
        amountToman: PRICE,
        description: "ZED_BOT order pay-sec-1",
      });
      const verified = await gateway.verifyPayment({
        authority: created.authority ?? "",
        amountToman: PRICE,
      });
      zpMock.verifyCode = -53;
      const failed = await gateway.verifyPayment({ authority: "A-sec-2", amountToman: PRICE });
      zpMock.requestFailCode = -9;
      const createFailed = await gateway.createPayment({
        paymentId: "pay-sec-2",
        amountToman: PRICE,
        description: "d",
      });
      for (const result of [created, verified, failed, createFailed]) {
        expect(JSON.stringify(result)).not.toContain(MERCHANT_ID);
      }
      expect(failed.errorMessage).not.toContain(MERCHANT_ID);
      expect(createFailed.errorMessage).not.toContain(MERCHANT_ID);
      expect(written.join("")).not.toContain(MERCHANT_ID);
    } finally {
      process.stdout.write = stdoutWrite;
      process.stderr.write = stderrWrite;
    }
  });

  it("21. validateStarsPreCheckout enforces owner, live status, expiry, currency and exact amount", () => {
    const owner = 777_001n;
    const base: StarsPreCheckoutPayment = {
      status: PaymentStatus.PENDING,
      expiresAt: new Date(Date.now() + 3_600_000),
      callbackPayload: { method: "TELEGRAM_STARS", stars: 25 },
      user: { telegramId: owner },
    };
    const query = { from: { id: 777_001 }, currency: "XTR", total_amount: 25 };

    expect(validateStarsPreCheckout(base, query)).toBe(true);
    expect(validateStarsPreCheckout({ ...base, status: PaymentStatus.PROCESSING }, query)).toBe(true);
    expect(validateStarsPreCheckout({ ...base, expiresAt: null }, query)).toBe(true);

    // No payment row at all.
    expect(validateStarsPreCheckout(null, query)).toBe(false);
    // Someone else's payment.
    expect(validateStarsPreCheckout(base, { ...query, from: { id: 777_002 } })).toBe(false);
    // Terminal / already-settled statuses are dead.
    expect(validateStarsPreCheckout({ ...base, status: PaymentStatus.APPROVED }, query)).toBe(false);
    expect(validateStarsPreCheckout({ ...base, status: PaymentStatus.FAILED }, query)).toBe(false);
    expect(
      validateStarsPreCheckout({ ...base, status: PaymentStatus.PENDING_REVIEW }, query),
    ).toBe(false);
    // Expired invoice.
    expect(
      validateStarsPreCheckout({ ...base, expiresAt: new Date(Date.now() - 1000) }, query),
    ).toBe(false);
    // Wrong currency.
    expect(validateStarsPreCheckout(base, { ...query, currency: "USD" })).toBe(false);
    // Amount mismatch in either direction.
    expect(validateStarsPreCheckout(base, { ...query, total_amount: 24 })).toBe(false);
    expect(validateStarsPreCheckout(base, { ...query, total_amount: 26 })).toBe(false);
    // Stored stars amount missing or invalid -> reject, never charge.
    expect(validateStarsPreCheckout({ ...base, callbackPayload: { method: "X" } }, query)).toBe(false);
    expect(
      validateStarsPreCheckout({ ...base, callbackPayload: { stars: 25.5 } }, query),
    ).toBe(false);
    expect(validateStarsPreCheckout({ ...base, callbackPayload: null }, query)).toBe(false);
  });
});

// =============================================================================
// E2E fixtures (real DB)
// =============================================================================

const GATEWAY_ENV_KEYS = [
  "ZARINPAL_MERCHANT_ID",
  "ZARINPAL_CALLBACK_URL",
  "ZARINPAL_BASE_URL",
  "ZARINPAL_SANDBOX",
] as const;
const savedEnv: Partial<Record<(typeof GATEWAY_ENV_KEYS)[number], string | undefined>> = {};

function setZarinpalEnv(): void {
  process.env.ZARINPAL_MERCHANT_ID = MERCHANT_ID;
  process.env.ZARINPAL_CALLBACK_URL = "https://bot.example.com/payments/zarinpal/callback";
  process.env.ZARINPAL_BASE_URL = mockHost;
  delete process.env.ZARINPAL_SANDBOX;
  clearGatewayManagerCache();
}

let panelId: string;
let categoryId: string;
let productId: string;
let zarinpalGatewayRow: PaymentGatewayRow;
let cardGatewayRow: PaymentGatewayRow;

async function createUser(balanceToman = 0): Promise<User> {
  return prisma.user.create({ data: { telegramId: nextTelegramId(), balanceToman } });
}

async function createOrderCheckout(userId: string, price = PRICE): Promise<CheckoutSession> {
  return prisma.checkoutSession.create({
    data: {
      userId,
      purpose: "ORDER_PAYMENT",
      productId,
      orderType: "SERVICE_PURCHASE",
      productSnapshot: {
        productName: `gw-product-${runTag}`,
        originalPriceToman: price,
        durationDays: 30,
        volumeGb: 10,
        panelName: `gw-panel-${runTag}`,
      },
      originalPriceToman: price,
      discountAmountToman: 0,
      finalPriceToman: price,
      status: "PENDING",
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  });
}

async function createWalletCheckout(userId: string, amount: number): Promise<CheckoutSession> {
  return prisma.checkoutSession.create({
    data: {
      userId,
      purpose: "WALLET_CHARGE",
      productSnapshot: { flowType: "WALLET_TOPUP", walletTopupAmountToman: amount },
      originalPriceToman: amount,
      discountAmountToman: 0,
      finalPriceToman: amount,
      status: "PENDING",
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  });
}

interface DirectPaymentOptions {
  provider: PaymentGatewayType;
  purpose?: "ORDER_PAYMENT" | "WALLET_CHARGE";
  status?: PaymentStatus;
  providerStatus?: string | null;
  amountToman?: number;
  payableAmountToman?: number;
  authority?: string;
  expiresAt?: Date | null;
  callbackPayload?: Record<string, unknown>;
}

/** A gateway Payment row created directly (simulating a prior creation). */
async function createGatewayPaymentRow(
  user: User,
  checkout: CheckoutSession,
  options: DirectPaymentOptions,
) {
  const amount = options.amountToman ?? checkout.finalPriceToman;
  return prisma.payment.create({
    data: {
      userId: user.id,
      checkoutSessionId: checkout.id,
      provider: options.provider,
      purpose: options.purpose ?? "ORDER_PAYMENT",
      status: options.status ?? PaymentStatus.PENDING,
      providerStatus: options.providerStatus ?? null,
      amountToman: amount,
      payableAmountToman: options.payableAmountToman ?? amount,
      authority: options.authority ?? uniqueAuthority(`auth-${options.provider}`),
      expiresAt: options.expiresAt === undefined ? checkout.expiresAt : options.expiresAt,
      callbackPayload: options.callbackPayload ?? { method: options.provider },
    },
  });
}

describe.runIf(hasDb)("ARCHITECTURE: availability gating hides unconfigured providers (2, E2E)", () => {
  beforeAll(async () => {
    zarinpalGatewayRow ??= await prisma.paymentGateway.create({
      data: { type: "ZARINPAL", name: `gw-zarinpal-${runTag}`, isEnabled: true },
    });
  });

  afterAll(async () => {
    for (const key of GATEWAY_ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    clearGatewayManagerCache();
  });

  it("2. getAvailablePaymentMethods drops a DB ZARINPAL gateway without env config and keeps it with config", async () => {
    for (const key of GATEWAY_ENV_KEYS) {
      savedEnv[key] = process.env[key];
    }
    const user = await createUser();
    const checkout = await createOrderCheckout(user.id);

    // Env unavailable -> the adapter reports isAvailable()=false and the
    // ENABLED DB row is hidden (no dead-end payment screens).
    delete process.env.ZARINPAL_MERCHANT_ID;
    delete process.env.ZARINPAL_CALLBACK_URL;
    delete process.env.ZARINPAL_BASE_URL;
    clearGatewayManagerCache();
    const without = await getAvailablePaymentMethods(user, checkout);
    expect(without.some((g) => g.id === zarinpalGatewayRow.id)).toBe(false);

    // Config present -> the same row is offered.
    setZarinpalEnv();
    const withEnv = await getAvailablePaymentMethods(user, checkout);
    expect(withEnv.some((g) => g.id === zarinpalGatewayRow.id)).toBe(true);
  });
});

describe.runIf(hasDb)("LIFECYCLE: exactly-once gateway settlement (12-19, E2E)", () => {
  beforeAll(async () => {
    setZarinpalEnv();
    // Neutralize stale PENDING/PROCESSING gateway payments left by previous
    // runs against this disposable DB so the sweep test only sees this run's
    // rows (the sweep batch is global and createdAt-ordered).
    await prisma.payment.updateMany({
      where: {
        provider: { in: ["ZARINPAL", "NOWPAYMENTS", "TELEGRAM_STARS"] },
        status: { in: [PaymentStatus.PENDING, PaymentStatus.PROCESSING] },
      },
      data: { status: PaymentStatus.DELETED },
    });
    const panel = await prisma.panel.create({
      data: {
        type: "MARZBAN",
        name: `gw-panel-${runTag}`,
        baseUrl: "http://127.0.0.1:1",
        status: "ACTIVE",
        username: "admin",
        passwordEncrypted: "enc",
        templateUsername: "tpl",
      },
    });
    panelId = panel.id;
    const category = await prisma.productCategory.create({
      data: { type: "SERVICE_PRODUCT", name: `gw-category-${runTag}`, isActive: true },
    });
    categoryId = category.id;
    const product = await prisma.product.create({
      data: {
        type: "SERVICE_PRODUCT",
        categoryId,
        panelId,
        name: `gw-product-${runTag}`,
        priceToman: PRICE,
        volumeGb: 10,
        durationDays: 30,
        isActive: true,
      },
    });
    productId = product.id;
    zarinpalGatewayRow ??= await prisma.paymentGateway.create({
      data: { type: "ZARINPAL", name: `gw-zarinpal-${runTag}`, isEnabled: true },
    });
    cardGatewayRow = await prisma.paymentGateway.create({
      data: { type: "CARD_TO_CARD", name: `gw-card-${runTag}`, isEnabled: true },
    });
  });

  afterAll(async () => {
    for (const key of GATEWAY_ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    clearGatewayManagerCache();
    await prisma.$disconnect();
  });

  it("12. getOrCreateGatewayPayment creates ONE PENDING payment and reuses it on re-entry", async () => {
    setZarinpalEnv();
    const user = await createUser();
    const checkout = await createOrderCheckout(user.id);

    const first = await getOrCreateGatewayPayment(user, checkout, zarinpalGatewayRow);
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    expect(first.payment.status).toBe(PaymentStatus.PENDING);
    expect(first.payment.provider).toBe("ZARINPAL");
    expect(first.payment.authority).toBe(zpMock.lastAuthority);
    expect(first.create.redirectUrl).toBe(`${mockHost}/pg/StartPay/${zpMock.lastAuthority}`);
    expect(zpMock.requestCalls).toBe(1);

    // Re-entry: same row, same redirect, NO second provider payment.
    const second = await getOrCreateGatewayPayment(user, checkout, zarinpalGatewayRow);
    expect(second.ok).toBe(true);
    if (!second.ok) {
      return;
    }
    expect(second.payment.id).toBe(first.payment.id);
    expect(second.create.redirectUrl).toBe(first.create.redirectUrl);
    expect(zpMock.requestCalls).toBe(1);
    expect(
      await prisma.payment.count({ where: { checkoutSessionId: checkout.id } }),
    ).toBe(1);
  });

  it("13. settleGatewayPayment settles EXACTLY once - sequentially and concurrently", async () => {
    const user = await createUser();
    const checkout = await createOrderCheckout(user.id);
    const payment = await createGatewayPaymentRow(user, checkout, {
      provider: "ZARINPAL",
      providerStatus: "SUCCESS", // set directly, simulating the API recorder
    });

    const first = await settleGatewayPayment(payment.id);
    expect(first.kind).toBe("settled");
    const settledPayment = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(settledPayment.status).toBe(PaymentStatus.APPROVED);
    const paidCheckout = await prisma.checkoutSession.findUniqueOrThrow({
      where: { id: checkout.id },
    });
    expect(paidCheckout.status).toBe(CheckoutStatus.PAID);
    const orders = await prisma.order.findMany({ where: { checkoutSessionId: checkout.id } });
    expect(orders).toHaveLength(1);
    expect(orders[0].status).toBe(OrderStatus.PAID);
    expect(orders[0].finalPriceToman).toBe(PRICE);
    expect(settledPayment.orderId).toBe(orders[0].id);
    const statsAfter = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(statsAfter.ordersCount).toBe(1);
    expect(statsAfter.paidOrdersCount).toBe(1);
    expect(statsAfter.totalPurchaseAmountToman).toBe(PRICE);

    // Duplicate callback replay: "already", still exactly one order, stats stable.
    const replay = await settleGatewayPayment(payment.id);
    expect(replay.kind).toBe("already");
    if (replay.kind === "already") {
      expect(replay.order?.id).toBe(orders[0].id);
    }
    expect(await prisma.order.count({ where: { checkoutSessionId: checkout.id } })).toBe(1);
    const statsReplay = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(statsReplay.ordersCount).toBe(1);
    expect(statsReplay.paidOrdersCount).toBe(1);
    // Settle outcomes never leak provider credentials.
    expect(JSON.stringify(first)).not.toContain(MERCHANT_ID);
    expect(JSON.stringify(replay)).not.toContain(MERCHANT_ID);

    // CONCURRENT settles on a fresh payment: the CAS admits exactly one winner.
    const user2 = await createUser();
    const checkout2 = await createOrderCheckout(user2.id);
    const payment2 = await createGatewayPaymentRow(user2, checkout2, {
      provider: "ZARINPAL",
      providerStatus: "SUCCESS",
    });
    const [a, b] = await Promise.all([
      settleGatewayPayment(payment2.id),
      settleGatewayPayment(payment2.id),
    ]);
    const kinds = [a.kind, b.kind].sort();
    expect(kinds).toEqual(["already", "settled"]);
    expect(await prisma.order.count({ where: { checkoutSessionId: checkout2.id } })).toBe(1);
    const stats2 = await prisma.user.findUniqueOrThrow({ where: { id: user2.id } });
    expect(stats2.paidOrdersCount).toBe(1);
  });

  it("14. a failed payment never provisions: settle reports failed, no Order/Service rows", async () => {
    const user = await createUser();
    const checkout = await createOrderCheckout(user.id);
    // The state the API recorder leaves after a definite provider failure:
    // providerStatus FAILED + Payment.status FAILED (CAS from PENDING).
    const payment = await createGatewayPaymentRow(user, checkout, {
      provider: "NOWPAYMENTS",
      providerStatus: "FAILED",
      status: PaymentStatus.FAILED,
    });

    const outcome = await settleGatewayPayment(payment.id);
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.status).toBe(PaymentStatus.FAILED);
    }
    expect(await prisma.order.count({ where: { checkoutSessionId: checkout.id } })).toBe(0);
    expect(await prisma.service.count({ where: { userId: user.id } })).toBe(0);
    const untouched = await prisma.checkoutSession.findUniqueOrThrow({ where: { id: checkout.id } });
    expect(untouched.status).toBe(CheckoutStatus.PENDING);
  });

  it("15. a pending payment never provisions: providerStatus null stays pending, no Order", async () => {
    const user = await createUser();
    const checkout = await createOrderCheckout(user.id);
    const payment = await createGatewayPaymentRow(user, checkout, {
      provider: "NOWPAYMENTS",
      providerStatus: null,
    });

    const outcome = await settleGatewayPayment(payment.id);
    expect(outcome.kind).toBe("pending");
    expect(await prisma.order.count({ where: { checkoutSessionId: checkout.id } })).toBe(0);
    const row = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(row.status).toBe(PaymentStatus.PENDING);
  });

  it("16. WALLET_CHARGE settlement credits the wallet exactly once and is replay-safe", async () => {
    const amount = 120_000;
    const user = await createUser(0);
    const checkout = await createWalletCheckout(user.id, amount);
    const payment = await createGatewayPaymentRow(user, checkout, {
      provider: "NOWPAYMENTS",
      purpose: "WALLET_CHARGE",
      providerStatus: "SUCCESS",
      amountToman: amount,
    });

    const first = await settleGatewayPayment(payment.id);
    expect(first.kind).toBe("settled");
    if (first.kind === "settled") {
      expect(first.purpose).toBe("WALLET_CHARGE");
      expect(first.order).toBeNull();
    }
    const credited = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(credited.balanceToman).toBe(amount);
    expect(credited.totalChargedToman).toBe(amount);
    const txs = await prisma.walletTransaction.findMany({
      where: { userId: user.id, relatedPaymentId: payment.id },
    });
    expect(txs).toHaveLength(1);
    expect(txs[0].reason).toBe(WALLET_TOPUP_REASON);
    expect(txs[0].amountToman).toBe(amount);
    expect(txs[0].balanceBeforeToman).toBe(0);
    expect(txs[0].balanceAfterToman).toBe(amount);
    // No Order for wallet charges - ever.
    expect(await prisma.order.count({ where: { checkoutSessionId: checkout.id } })).toBe(0);

    // Replay: "already", the balance and the ledger move ZERO.
    const replay = await settleGatewayPayment(payment.id);
    expect(replay.kind).toBe("already");
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.balanceToman).toBe(amount);
    expect(
      await prisma.walletTransaction.count({
        where: { userId: user.id, relatedPaymentId: payment.id },
      }),
    ).toBe(1);
  });

  it("17. the sweep expires stale PENDING payments and settles recorded successes", async () => {
    const user = await createUser(0);
    // Stale: PENDING, no provider event, expired 40 minutes ago (past the
    // 30-minute grace) -> the sweep flips it to EXPIRED.
    const staleCheckout = await createOrderCheckout(user.id);
    const stalePayment = await createGatewayPaymentRow(user, staleCheckout, {
      provider: "ZARINPAL",
      providerStatus: null,
      expiresAt: new Date(Date.now() - 40 * 60_000),
    });
    // Recorded success the user never claimed: the sweep settles it instead.
    const amount = 90_000;
    const successCheckout = await createWalletCheckout(user.id, amount);
    const successPayment = await createGatewayPaymentRow(user, successCheckout, {
      provider: "NOWPAYMENTS",
      purpose: "WALLET_CHARGE",
      providerStatus: "SUCCESS",
      amountToman: amount,
    });

    const sent: Array<{ chatId: string; text: string }> = [];
    await runGatewaySettlementSweep({
      sendMessage: async (chatId: string, text: string) => {
        sent.push({ chatId, text });
        return null;
      },
    });

    const expired = await prisma.payment.findUniqueOrThrow({ where: { id: stalePayment.id } });
    expect(expired.status).toBe(PaymentStatus.EXPIRED);
    expect(await prisma.order.count({ where: { checkoutSessionId: staleCheckout.id } })).toBe(0);

    const settled = await prisma.payment.findUniqueOrThrow({ where: { id: successPayment.id } });
    expect(settled.status).toBe(PaymentStatus.APPROVED);
    const credited = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(credited.balanceToman).toBe(amount);
    // Fulfillment notified the user about the top-up exactly once.
    expect(sent.filter((m) => m.chatId === user.telegramId.toString())).toHaveLength(1);

    // A second sweep changes nothing (idempotent replay).
    await runGatewaySettlementSweep({ sendMessage: async () => null });
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.balanceToman).toBe(amount);
    expect(
      await prisma.walletTransaction.count({
        where: { userId: user.id, relatedPaymentId: successPayment.id },
      }),
    ).toBe(1);
  });

  it("18. wallet payment still works: purchase draft settles with a PAID order (smoke)", async () => {
    const user = await createUser(PRICE * 2);
    const draft: CheckoutDraft = {
      productId,
      categoryId,
      panelId,
      flowType: "SERVICE_PRODUCT",
      originalPriceToman: PRICE,
      discountAmountToman: 0,
      finalPriceToman: PRICE,
      draftNonce: randomUUID(),
    };
    const result = await payPurchaseDraftWithWallet(user, draft);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.order.status).toBe(OrderStatus.PAID);
    expect(result.payment.status).toBe(PaymentStatus.APPROVED);
    expect(result.newBalanceToman).toBe(PRICE);
    expect(
      await prisma.walletTransaction.count({
        where: { userId: user.id, type: "SPEND", reason: WALLET_ORDER_PAYMENT_REASON },
      }),
    ).toBe(1);
  });

  it("19. card-to-card still works: submitReceipt creates a PENDING_REVIEW payment + receipt (smoke)", async () => {
    const user = await createUser();
    const checkout = await createOrderCheckout(user.id);
    const result = await submitReceipt(user, checkout, cardGatewayRow.id, undefined, {
      text: "card receipt text",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.payment.status).toBe(PaymentStatus.PENDING_REVIEW);
    expect(result.payment.provider).toBeNull();
    const receipts = await prisma.manualReceipt.findMany({
      where: { paymentId: result.payment.id },
    });
    expect(receipts).toHaveLength(1);
    expect(receipts[0].status).toBe(PaymentStatus.PENDING_REVIEW);
    // Nothing settled: no order, checkout stays PENDING.
    expect(await prisma.order.count({ where: { checkoutSessionId: checkout.id } })).toBe(0);
  });
});

describe.runIf(hasDb)("SECURITY: replay and tamper resistance (22-23, E2E)", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("22. duplicate Stars successful_payment records once and settles once", async () => {
    const stars = 50;
    const user = await createUser();
    const checkout = await createOrderCheckout(user.id);
    const payment = await createGatewayPaymentRow(user, checkout, {
      provider: "TELEGRAM_STARS",
      providerStatus: null,
      callbackPayload: { method: "TELEGRAM_STARS", stars },
    });
    await prisma.payment.update({
      where: { id: payment.id },
      data: { authority: `${STARS_PAYLOAD_PREFIX}${payment.id}` },
    });

    // Telegram redelivers successful_payment updates: record twice...
    // (charge ids land in the per-provider-unique externalTransactionId, so
    // they must be run-unique or reruns would be refused as replays)
    const chargeId = `stars-charge-${runTag}`;
    await recordProviderSuccessFromBot(payment.id, {
      transactionId: chargeId,
      sanitizedPayload: { currency: "XTR", total_amount: stars },
    });
    const afterFirst = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(afterFirst.providerStatus).toBe("SUCCESS");
    expect(afterFirst.verifiedAt).not.toBeNull();
    expect(afterFirst.externalTransactionId).toBe(chargeId);
    await recordProviderSuccessFromBot(payment.id, {
      transactionId: chargeId,
      sanitizedPayload: { currency: "XTR", total_amount: stars },
    });
    const afterSecond = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    // verifiedAt is set exactly once and stays stable across replays.
    expect(afterSecond.verifiedAt?.getTime()).toBe(afterFirst.verifiedAt?.getTime());

    // ...and settle twice: one Order, verifiedAt still stable.
    const first = await settleGatewayPayment(payment.id);
    const second = await settleGatewayPayment(payment.id);
    expect(first.kind).toBe("settled");
    expect(second.kind).toBe("already");
    expect(await prisma.order.count({ where: { checkoutSessionId: checkout.id } })).toBe(1);
    const final = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(final.verifiedAt?.getTime()).toBe(afterFirst.verifiedAt?.getTime());
    expect(final.status).toBe(PaymentStatus.APPROVED);
  });

  it("23. tampered amounts never settle: amount/checkout mismatch is an error, nothing moves", async () => {
    const user = await createUser();
    const checkout = await createOrderCheckout(user.id); // finalPriceToman = PRICE
    const payment = await createGatewayPaymentRow(user, checkout, {
      provider: "ZARINPAL",
      providerStatus: "SUCCESS",
      amountToman: PRICE - 49_000, // tampered: 1,000 instead of 50,000
    });

    const outcome = await settleGatewayPayment(payment.id);
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.error).toBe("payment/checkout amount mismatch");
    }
    const row = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(row.status).toBe(PaymentStatus.PENDING); // never APPROVED
    const untouched = await prisma.checkoutSession.findUniqueOrThrow({ where: { id: checkout.id } });
    expect(untouched.status).toBe(CheckoutStatus.PENDING);
    expect(await prisma.order.count({ where: { checkoutSessionId: checkout.id } })).toBe(0);
    const stats = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(stats.paidOrdersCount).toBe(0);
  });
});

describe.skipIf(hasDb)("payment gateways (skipped)", () => {
  it("payment gateway E2E tests require DATABASE_URL - see docs/testing.md", () => {
    expect(hasDb).toBe(false);
  });
});
