import { createHmac } from "node:crypto";
import http from "node:http";

import {
  PaymentStatus,
  prisma,
  type CheckoutSession,
  type Payment,
  type User,
} from "@zedbot/database";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

// =============================================================================
// Payment provider callback/webhook route tests (spec C, 24-31), driven with
// fastify.inject() against the real paymentRoutes plugin and a REAL
// PostgreSQL (the routes RECORD verified provider events on Payment rows;
// they never settle - Payment.status must stay PENDING on SUCCESS).
//
// Zarinpal verification calls are served by an in-process node:http mock via
// the ZARINPAL_BASE_URL override; NOWPayments IPN signatures are computed
// in-test with the provider's documented sorted-keys HMAC-SHA512 rule.
// Without DATABASE_URL the suite skips itself (docs/testing.md).
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

const NP_IPN_SECRET = "np-api-test-ipn-secret-0001";
const MERCHANT_ID = "zp-api-merchant-11111111-2222-3333-4444-555555555555";

// Unique per run so reruns against the same database never collide.
const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
let seq = 0;

// Invoice ids must survive a JSON number round-trip (Number precision), so
// they are derived from the run tag but kept well below 2^53.
const invoiceBase = Number(runTag % 100_000_000_000n);

function nextInvoiceId(): number {
  return invoiceBase * 10_000 + ++seq;
}

// --- stateful Zarinpal verify mock -----------------------------------------------------

const zpMock = {
  verifyCalls: 0,
  verifyBodies: [] as Array<Record<string, unknown>>,
  /** 100 = verified now, 101 = already verified, other = failure code. */
  verifyCode: 100,
  verifyRefId: 424242,
};

function resetMockFlags(): void {
  zpMock.verifyCalls = 0;
  zpMock.verifyBodies = [];
  zpMock.verifyCode = 100;
  zpMock.verifyRefId = 424242;
}

let server: http.Server;
let mockHost = "";
let app: FastifyInstance;

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk: Buffer) => (data += chunk.toString()));
    req.on("end", () => resolve(data));
  });
}

// --- IPN signing (the provider's documented sorted-keys rule) ---------------------------

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

function signIpn(body: Record<string, unknown>, secret: string = NP_IPN_SECRET): string {
  return createHmac("sha512", secret)
    .update(JSON.stringify(sortKeysDeep(body)))
    .digest("hex");
}

async function postIpn(
  body: Record<string, unknown>,
  options: { signature?: string } = {},
): Promise<{ statusCode: number }> {
  return app.inject({
    method: "POST",
    url: "/payments/nowpayments/ipn",
    payload: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      "x-nowpayments-ipn-signature": options.signature ?? signIpn(body),
    },
  });
}

// --- DB fixtures ------------------------------------------------------------------------

const PRICE = 60_000;

async function createUser(): Promise<User> {
  return prisma.user.create({ data: { telegramId: runTag + BigInt(++seq) } });
}

async function createCheckout(userId: string): Promise<CheckoutSession> {
  return prisma.checkoutSession.create({
    data: {
      userId,
      purpose: "ORDER_PAYMENT",
      orderType: "SERVICE_PURCHASE",
      originalPriceToman: PRICE,
      finalPriceToman: PRICE,
      status: "PENDING",
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  });
}

async function createNowPayment(options: { externalReference?: string } = {}): Promise<Payment> {
  const user = await createUser();
  const checkout = await createCheckout(user.id);
  const invoiceId = String(nextInvoiceId());
  return prisma.payment.create({
    data: {
      userId: user.id,
      checkoutSessionId: checkout.id,
      provider: "NOWPAYMENTS",
      purpose: "ORDER_PAYMENT",
      status: PaymentStatus.PENDING,
      amountToman: PRICE,
      payableAmountToman: PRICE,
      authority: invoiceId,
      externalReference: options.externalReference ?? invoiceId,
      expiresAt: new Date(Date.now() + 3_600_000),
      callbackPayload: { method: "NOWPAYMENTS" },
    },
  });
}

async function createZarinpalPayment(): Promise<Payment> {
  const user = await createUser();
  const checkout = await createCheckout(user.id);
  return prisma.payment.create({
    data: {
      userId: user.id,
      checkoutSessionId: checkout.id,
      provider: "ZARINPAL",
      purpose: "ORDER_PAYMENT",
      status: PaymentStatus.PENDING,
      amountToman: PRICE,
      payableAmountToman: PRICE,
      authority: `A0api${runTag}${++seq}`,
      expiresAt: new Date(Date.now() + 3_600_000),
      callbackPayload: { method: "ZARINPAL" },
    },
  });
}

function reload(id: string): Promise<Payment> {
  return prisma.payment.findUniqueOrThrow({ where: { id } });
}

/** A signed "finished" IPN body for a payment (invoice matches the row). */
function finishedBody(payment: Payment, overrides: Record<string, unknown> = {}) {
  return {
    payment_status: "finished",
    order_id: payment.id,
    invoice_id: Number(payment.externalReference),
    payment_id: 500_000 + ++seq,
    price_amount: 12.5,
    pay_currency: "trx",
    actually_paid: 300,
    ...overrides,
  };
}

describe.runIf(hasDb)("payment routes: NOWPayments IPN + Zarinpal callback (24-31)", () => {
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      void (async () => {
        if (req.method === "POST" && req.url === "/pg/v4/payment/verify.json") {
          const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
          zpMock.verifyCalls += 1;
          zpMock.verifyBodies.push(body);
          res.writeHead(200, { "Content-Type": "application/json" });
          if (zpMock.verifyCode === 100 || zpMock.verifyCode === 101) {
            res.end(
              JSON.stringify({
                data: { code: zpMock.verifyCode, ref_id: zpMock.verifyRefId, message: "ok" },
                errors: [],
              }),
            );
            return;
          }
          res.end(
            JSON.stringify({ data: [], errors: { code: zpMock.verifyCode, message: "failed" } }),
          );
          return;
        }
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: "not found" }));
      })();
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        mockHost = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        resolve();
      });
    });

    // Gateways are constructed from env at plugin registration - configure
    // BEFORE registering (missing values would answer 401/pending safely).
    process.env.NOWPAYMENTS_IPN_SECRET = NP_IPN_SECRET;
    process.env.ZARINPAL_MERCHANT_ID = MERCHANT_ID;
    process.env.ZARINPAL_CALLBACK_URL = "https://bot.example.com/payments/zarinpal/callback";
    process.env.ZARINPAL_BASE_URL = mockHost;
    const { paymentRoutes } = await import("../src/payment-routes.js");
    app = Fastify({ logger: false });
    await app.register(paymentRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    server?.close();
    delete process.env.NOWPAYMENTS_IPN_SECRET;
    delete process.env.ZARINPAL_MERCHANT_ID;
    delete process.env.ZARINPAL_CALLBACK_URL;
    delete process.env.ZARINPAL_BASE_URL;
    await prisma.$disconnect();
  });

  afterEach(() => {
    resetMockFlags();
  });

  it("24. a valid finished IPN records SUCCESS without touching Payment.status", async () => {
    const payment = await createNowPayment();
    const body = finishedBody(payment);
    const response = await postIpn(body);
    expect(response.statusCode).toBe(200);

    const row = await reload(payment.id);
    expect(row.providerStatus).toBe("SUCCESS");
    expect(row.verifiedAt).not.toBeNull();
    expect(row.externalTransactionId).toBe(String(body.payment_id));
    // Recording NEVER settles: the bot's settlement transaction owns APPROVED.
    expect(row.status).toBe(PaymentStatus.PENDING);
    // The stored payload is the sanitized business subset - no signature.
    const payload = row.callbackPayload as Record<string, unknown>;
    expect(payload.payment_status).toBe("finished");
    expect(JSON.stringify(payload)).not.toContain(signIpn(body));
  });

  it("25. an invalid signature is rejected with 401 and writes nothing", async () => {
    const payment = await createNowPayment();
    const body = finishedBody(payment);
    const wrongSecret = await postIpn(body, { signature: signIpn(body, "wrong-secret") });
    expect(wrongSecret.statusCode).toBe(401);
    const missing = await app.inject({
      method: "POST",
      url: "/payments/nowpayments/ipn",
      payload: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
    expect(missing.statusCode).toBe(401);

    const row = await reload(payment.id);
    expect(row.providerStatus).toBeNull();
    expect(row.verifiedAt).toBeNull();
    expect(row.externalTransactionId).toBeNull();
    expect(row.status).toBe(PaymentStatus.PENDING);
  });

  it("26. a duplicate webhook is idempotent: 200 both times, verifiedAt unchanged", async () => {
    const payment = await createNowPayment();
    const body = finishedBody(payment);
    expect((await postIpn(body)).statusCode).toBe(200);
    const afterFirst = await reload(payment.id);
    expect((await postIpn(body)).statusCode).toBe(200);
    const afterSecond = await reload(payment.id);

    expect(afterSecond.verifiedAt?.getTime()).toBe(afterFirst.verifiedAt?.getTime());
    expect(afterSecond.providerStatus).toBe("SUCCESS");
    expect(afterSecond.externalTransactionId).toBe(afterFirst.externalTransactionId);
    expect(afterSecond.status).toBe(PaymentStatus.PENDING);
    expect(afterSecond.callbackPayload).toEqual(afterFirst.callbackPayload);
  });

  it("27. failed moves PENDING to FAILED; a FAILED replay AFTER SUCCESS is ignored", async () => {
    // CAS from PENDING: a definite provider failure fails the payment.
    const failing = await createNowPayment();
    const failedBody = finishedBody(failing, { payment_status: "failed" });
    expect((await postIpn(failedBody)).statusCode).toBe(200);
    const failedRow = await reload(failing.id);
    expect(failedRow.providerStatus).toBe("FAILED");
    expect(failedRow.status).toBe(PaymentStatus.FAILED);
    expect(failedRow.verifiedAt).toBeNull();

    // Downgrade protection: once SUCCESS is recorded, non-SUCCESS replays
    // are ignored entirely.
    const succeeded = await createNowPayment();
    expect((await postIpn(finishedBody(succeeded))).statusCode).toBe(200);
    const beforeReplay = await reload(succeeded.id);
    const downgrade = finishedBody(succeeded, { payment_status: "failed" });
    expect((await postIpn(downgrade)).statusCode).toBe(200);
    const afterReplay = await reload(succeeded.id);
    expect(afterReplay.providerStatus).toBe("SUCCESS");
    expect(afterReplay.status).toBe(PaymentStatus.PENDING);
    expect(afterReplay.verifiedAt?.getTime()).toBe(beforeReplay.verifiedAt?.getTime());
    expect(afterReplay.callbackPayload).toEqual(beforeReplay.callbackPayload);
  });

  it("28. an expired event records EXPIRED", async () => {
    const payment = await createNowPayment();
    const body = finishedBody(payment, { payment_status: "expired" });
    expect((await postIpn(body)).statusCode).toBe(200);
    const row = await reload(payment.id);
    expect(row.providerStatus).toBe("EXPIRED");
    expect(row.status).toBe(PaymentStatus.EXPIRED);
    expect(row.verifiedAt).toBeNull();
  });

  it("29. an unknown provider status answers 200, stores the payload, changes no status", async () => {
    const payment = await createNowPayment();
    const body = finishedBody(payment, { payment_status: "weird_new_status" });
    expect((await postIpn(body)).statusCode).toBe(200);
    const row = await reload(payment.id);
    // Needs-review path: payload recorded for a human, statuses untouched.
    expect((row.callbackPayload as Record<string, unknown>).payment_status).toBe(
      "weird_new_status",
    );
    expect(row.providerStatus).toBeNull();
    expect(row.status).toBe(PaymentStatus.PENDING);
    expect(row.verifiedAt).toBeNull();
  });

  it("30. Zarinpal callback: NOK cancels, OK verifies via the API, unknown is 404, replays stay stable", async () => {
    // NOK: the user cancelled at the gateway - no verification call at all.
    const cancelled = await createZarinpalPayment();
    const nok = await app.inject({
      method: "GET",
      url: `/payments/zarinpal/callback?Authority=${cancelled.authority}&Status=NOK`,
    });
    expect(nok.statusCode).toBe(200);
    expect(nok.body).toContain("پرداخت لغو شد");
    const cancelledRow = await reload(cancelled.id);
    expect(cancelledRow.providerStatus).toBe("CANCELLED");
    expect(cancelledRow.status).toBe(PaymentStatus.CANCELLED);
    expect(zpMock.verifyCalls).toBe(0);

    // OK: the redirect alone proves nothing - the route verifies against the
    // (mock) Zarinpal API and records SUCCESS + ref_id.
    const paying = await createZarinpalPayment();
    const ok = await app.inject({
      method: "GET",
      url: `/payments/zarinpal/callback?Authority=${paying.authority}&Status=OK`,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain("موفقیت");
    expect(zpMock.verifyCalls).toBe(1);
    expect(zpMock.verifyBodies[0]).toMatchObject({
      authority: paying.authority,
      amount: PRICE,
      merchant_id: MERCHANT_ID,
    });
    const verified = await reload(paying.id);
    expect(verified.providerStatus).toBe("SUCCESS");
    expect(verified.externalTransactionId).toBe(String(zpMock.verifyRefId));
    expect(verified.verifiedAt).not.toBeNull();
    expect(verified.status).toBe(PaymentStatus.PENDING); // recording never settles

    // Unknown Authority: 404 page, no verification attempted.
    const unknown = await app.inject({
      method: "GET",
      url: `/payments/zarinpal/callback?Authority=A0missing${runTag}&Status=OK`,
    });
    expect(unknown.statusCode).toBe(404);
    expect(zpMock.verifyCalls).toBe(1);

    // Duplicate OK callback: Zarinpal answers 101 (already verified) - the
    // row stays exactly as recorded, verifiedAt unchanged.
    zpMock.verifyCode = 101;
    const replay = await app.inject({
      method: "GET",
      url: `/payments/zarinpal/callback?Authority=${paying.authority}&Status=OK`,
    });
    expect(replay.statusCode).toBe(200);
    expect(zpMock.verifyCalls).toBe(2);
    const afterReplay = await reload(paying.id);
    expect(afterReplay.providerStatus).toBe("SUCCESS");
    expect(afterReplay.verifiedAt?.getTime()).toBe(verified.verifiedAt?.getTime());
    expect(afterReplay.externalTransactionId).toBe(verified.externalTransactionId);
    expect(afterReplay.status).toBe(PaymentStatus.PENDING);

    // Malformed callback (missing parameters) is a 400, never a crash.
    const malformed = await app.inject({ method: "GET", url: "/payments/zarinpal/callback" });
    expect(malformed.statusCode).toBe(400);
  });

  it("31. ownership: unmatched order ids and reference mismatches write nothing (still 200)", async () => {
    const control = await createNowPayment();

    // A signed IPN whose order_id matches NO payment: 200 (no id oracle),
    // nothing written anywhere.
    const ghostBody = finishedBody(control, {
      order_id: "00000000-0000-4000-8000-000000000000",
    });
    expect((await postIpn(ghostBody)).statusCode).toBe(200);
    let row = await reload(control.id);
    expect(row.providerStatus).toBeNull();
    expect(row.verifiedAt).toBeNull();

    // A signed IPN naming OUR payment but a FOREIGN invoice reference:
    // ignored (an attacker cannot re-point another invoice's outcome).
    const mismatched = finishedBody(control, { invoice_id: 999_999_999 });
    expect((await postIpn(mismatched)).statusCode).toBe(200);
    row = await reload(control.id);
    expect(row.providerStatus).toBeNull();
    expect(row.verifiedAt).toBeNull();
    expect(row.externalTransactionId).toBeNull();
    expect(row.status).toBe(PaymentStatus.PENDING);
    expect((row.callbackPayload as Record<string, unknown>).method).toBe("NOWPAYMENTS");
  });
});

describe.skipIf(hasDb)("payment routes (skipped)", () => {
  it("payment route integration tests require DATABASE_URL - see docs/testing.md", () => {
    expect(hasDb).toBe(false);
  });
});
