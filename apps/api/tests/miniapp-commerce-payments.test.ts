import { createHmac } from "node:crypto";

import { prisma } from "@zedbot/database";
import { commerceShortId, encryptSecret, MINIAPP_COMMERCE_SWITCH_KEYS } from "@zedbot/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// =============================================================================
// Mini App commerce surface, part B (P-1..P-12): wallet payment, top-up,
// card-to-card with browser receipt upload, Zarinpal initiation + callback +
// settle-on-poll — REAL plugin, REAL bot money services, REAL PostgreSQL,
// REAL HTTP fakes for the panel and the gateway.
//
// The invariants bought here (§11–§14, §20):
//   - one financial effect under replay AND under concurrency (asserted on
//     the LEDGER, not on status codes);
//   - no negative balance; a refused wallet payment writes nothing;
//   - the receipt pipeline is the bot's: PENDING_REVIEW payment +
//     ManualReceipt (+ stored upload), approved by the bot-side authority and
//     the approval visible to the Mini App status endpoint;
//   - spoofed MIME and oversized uploads are refused with stable codes;
//   - the browser's word is never evidence: a Zarinpal payment settles only
//     after the server-side verify, through the same CAS gate the bot uses.
//
// Without DATABASE_URL the suite skips itself (docs/testing.md).
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

process.env.APP_SECRET ??= "miniapp-payments-test-secret-0123456789";
const BOT_TOKEN = "454545:AA-miniapp-payments-test-token";
process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
process.env.MINIAPP_PUBLIC_URL = "https://miniapp.test.example/miniapp";
process.env.MINIAPP_AUTH_RATE_LIMIT = "1000";
process.env.MINIAPP_COMMERCE_RATE_LIMIT = "1000";
process.env.ZARINPAL_MERCHANT_ID = "test-merchant-miniapp-payments-suite";
process.env.ZARINPAL_CALLBACK_URL = "https://miniapp.test.example/payments/zarinpal/callback";
delete process.env.REDIS_URL;
delete process.env.REDIS_HOST; // queue enqueue degrades to the sweep path

const { miniAppRoutes } = await import("../src/miniapp/routes.js");
const { paymentRoutes } = await import("../src/payment-routes.js");
const { apiTrustedProxies } = await import("../src/miniapp/trusted-proxy.js");

const runTag = BigInt(Date.now() % 1_000_000_000) * 1000n;
const BUYER_TELEGRAM_ID = 9_500_000_000_000n + runTag;
const POOR_TELEGRAM_ID = BUYER_TELEGRAM_ID + 1n;
const ADMIN_TELEGRAM_ID = BUYER_TELEGRAM_ID + 2n;

const PRICE = 60_000;
const START_BALANCE = 500_000;
const CARD_NUMBER = "6037991234567890";

/** 1x1 transparent PNG — real magic bytes, real IHDR. */
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

let app: FastifyInstance;
let fakePanel: FastifyInstance;
let fakeZarinpal: FastifyInstance;
let buyerId = "";
let poorId = "";
let panelPublicId = "";
let productId = "";
let productPublicId = "";
let cardGatewayId = "";
let zarinpalGatewayId = "";
let buyerCookie = "";
let verifyCalls = 0;
/** Pre-suite values of GLOBAL settings this suite mutates, restored exactly:
 * these keys are NOT seeded, and other suites depend on their absence
 * (the reader falls back to enabled-by-default when the row is missing). */
const priorSettings = new Map<string, string | null>();

function signInitData(fields: Record<string, string>, token = BOT_TOKEN): string {
  const checkString = Object.keys(fields)
    .filter((k) => k !== "hash")
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const hash = createHmac("sha256", secret).update(checkString).digest("hex");
  return [...Object.entries(fields), ["hash", hash]]
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

async function signIn(telegramId: bigint): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/miniapp/auth",
    headers: { origin: "https://miniapp.test.example", "content-type": "application/json" },
    payload: {
      initData: signInitData({
        auth_date: String(Math.floor(Date.now() / 1000) - 5),
        query_id: "AAHpayments",
        user: `{"id":${telegramId.toString()},"first_name":"Payer"}`,
      }),
    },
  });
  if (response.statusCode !== 200) {
    throw new Error(`auth failed ${response.statusCode}: ${response.body}`);
  }
  const setCookie = response.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie[0] : String(setCookie);
  return raw.split(";")[0];
}

function post(url: string, cookie: string, payload: unknown) {
  return app.inject({
    method: "POST",
    url,
    headers: {
      cookie,
      origin: "https://miniapp.test.example",
      "content-type": "application/json",
    },
    payload: payload as Record<string, unknown>,
  });
}

function get(url: string, cookie: string) {
  return app.inject({ method: "GET", url, headers: { cookie } });
}

async function setSwitch(key: string, value: boolean): Promise<void> {
  await prisma.setting.upsert({
    where: { key },
    update: { value: value ? "true" : "false" },
    create: { key, value: value ? "true" : "false", type: "BOOLEAN" },
  });
}

function crid(seed: string): string {
  return `payments-${seed}-${runTag.toString()}`.slice(0, 64).padEnd(16, "x");
}

/** username → quote → returns the sealed draft token for a fresh purchase. */
async function freshQuote(
  cookie: string,
  options?: { discountCode?: string },
): Promise<{ draftToken: string; username: string }> {
  const reserve = await post("/api/miniapp/commerce/username", cookie, {
    panelPublicId,
    mode: "RANDOM",
  });
  expect(reserve.statusCode, reserve.body).toBe(200);
  const { draftNonce, username } = reserve.json() as { draftNonce: string; username: string };
  const quote = await post("/api/miniapp/commerce/quote", cookie, {
    kind: "SERVICE",
    productPublicId,
    draftNonce,
    ...(options?.discountCode !== undefined ? { discountCode: options.discountCode } : {}),
  });
  expect(quote.statusCode, quote.body).toBe(200);
  return {
    draftToken: (quote.json() as { quote: { draftToken: string } }).quote.draftToken,
    username,
  };
}

beforeAll(async () => {
  if (!hasDb) {
    return;
  }
  // --- fake Marzban (username availability probes) ---------------------------
  fakePanel = Fastify({ logger: false });
  fakePanel.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_request, body, done) => done(null, body),
  );
  fakePanel.post("/api/admin/token", async () => ({ access_token: "fake-token" }));
  fakePanel.get("/api/user/:username", async (_request, reply) =>
    reply.code(404).send({ detail: "User not found" }),
  );
  await fakePanel.listen({ port: 0, host: "127.0.0.1" });
  const panelAddress = fakePanel.server.address();
  const fakePanelUrl = `http://127.0.0.1:${typeof panelAddress === "object" && panelAddress !== null ? panelAddress.port : 0}`;

  // --- fake Zarinpal ----------------------------------------------------------
  fakeZarinpal = Fastify({ logger: false });
  fakeZarinpal.post("/pg/v4/payment/request.json", async () => ({
    data: { code: 100, authority: `A-${runTag.toString()}-${Math.floor(Math.random() * 1e6)}` },
    errors: [],
  }));
  fakeZarinpal.post("/pg/v4/payment/verify.json", async () => {
    verifyCalls += 1;
    // ref_id must be UNIQUE per settlement: @@unique([provider,
    // externalTransactionId]) treats a reused charge id as forged evidence
    // and refuses the event entirely — which is exactly what a constant here
    // triggered across suite reruns.
    return {
      data: { code: 100, ref_id: Number(runTag % 1_000_000n) * 1_000 + verifyCalls },
      errors: [],
    };
  });
  await fakeZarinpal.listen({ port: 0, host: "127.0.0.1" });
  const zpAddress = fakeZarinpal.server.address();
  process.env.ZARINPAL_BASE_URL = `http://127.0.0.1:${typeof zpAddress === "object" && zpAddress !== null ? zpAddress.port : 0}`;

  app = Fastify({ logger: false, trustProxy: apiTrustedProxies() });
  await app.register(paymentRoutes);
  await app.register(miniAppRoutes, { prefix: "/api/miniapp" });
  await app.ready();

  const buyer = await prisma.user.create({
    data: { telegramId: BUYER_TELEGRAM_ID, firstName: "Payer", balanceToman: START_BALANCE },
  });
  buyerId = buyer.id;
  const poor = await prisma.user.create({
    data: { telegramId: POOR_TELEGRAM_ID, firstName: "Poor", balanceToman: 1_000 },
  });
  poorId = poor.id;

  const panel = await prisma.panel.create({
    data: {
      type: "MARZBAN",
      name: `payments-panel-${runTag}`,
      baseUrl: fakePanelUrl,
      status: "ACTIVE",
      username: "admin",
      passwordEncrypted: encryptSecret("panel-password"),
      templateUsername: "tpl",
    },
  });
  panelPublicId = commerceShortId(panel);
  const category = await prisma.productCategory.create({
    data: { type: "SERVICE_PRODUCT", name: `payments-cat-${runTag}`, isActive: true },
  });
  const product = await prisma.product.create({
    data: {
      type: "SERVICE_PRODUCT",
      categoryId: category.id,
      panelId: panel.id,
      name: `payments-product-${runTag}`,
      priceToman: PRICE,
      volumeGb: 10,
      durationDays: 30,
      isActive: true,
    },
  });
  productId = product.id;
  productPublicId = commerceShortId(product);

  const cardGateway = await prisma.paymentGateway.create({
    data: { type: "CARD_TO_CARD", name: `کارت‌به‌کارت-${runTag}`, isEnabled: true },
  });
  cardGatewayId = cardGateway.id;
  await prisma.cardToCardAccount.create({
    data: {
      gatewayId: cardGateway.id,
      cardNumberEncrypted: encryptSecret(CARD_NUMBER),
      ownerName: "Test Owner",
      isActive: true,
    },
  });
  const zarinpalGateway = await prisma.paymentGateway.create({
    data: { type: "ZARINPAL", name: `زرین‌پال-${runTag}`, isEnabled: true },
  });
  zarinpalGatewayId = zarinpalGateway.id;

  for (const key of ["wallet_payment_enabled", "wallet_topup_enabled"]) {
    const row = await prisma.setting.findUnique({ where: { key } });
    priorSettings.set(key, row?.value ?? null);
  }
  await setSwitch("miniapp_commerce_enabled", true);
  await setSwitch("wallet_payment_enabled", true);
  await setSwitch("wallet_topup_enabled", true);

  buyerCookie = await signIn(BUYER_TELEGRAM_ID);
});

afterAll(async () => {
  if (!hasDb) {
    return;
  }
  for (const key of MINIAPP_COMMERCE_SWITCH_KEYS) {
    await setSwitch(key, false);
  }
  for (const [key, prior] of priorSettings) {
    if (prior === null) {
      await prisma.setting.deleteMany({ where: { key } });
    } else {
      await setSwitch(key, prior === "true");
    }
  }
  await app.close();
  await fakePanel.close();
  await fakeZarinpal.close();
});

describe.runIf(hasDb)("miniapp commerce part B (P-1..P-12)", () => {
  it("P-1 wallet payment: one transaction, one ledger row, frozen amounts, MINIAPP origin", async () => {
    const { draftToken, username } = await freshQuote(buyerCookie);
    const response = await post("/api/miniapp/commerce/pay/wallet", buyerCookie, {
      draftToken,
      clientRequestId: crid("wallet-1"),
    });
    expect(response.statusCode, response.body).toBe(201);
    const body = response.json() as {
      checkout: { status: string; finalPriceToman: number; username: string };
      paymentPublicId: string;
      orderPublicId: string;
    };
    expect(body.checkout.status).toBe("PAID");
    expect(body.checkout.finalPriceToman).toBe(PRICE);
    expect(body.checkout.username).toBe(username);
    expect(body.paymentPublicId).toMatch(/^[0-9a-f]{8}$/);
    expect(body.orderPublicId).toMatch(/^[0-9a-f]{8}$/);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: buyerId } });
    expect(user.balanceToman).toBe(START_BALANCE - PRICE);
    const spends = await prisma.walletTransaction.findMany({
      where: { userId: buyerId, type: "SPEND" },
    });
    expect(spends).toHaveLength(1);
    expect(spends[0].amountToman).toBe(PRICE); // stored magnitude, ledger-consistent
    expect(spends[0].balanceAfterToman).toBe(START_BALANCE - PRICE);
    const checkout = await prisma.checkoutSession.findFirstOrThrow({
      where: { userId: buyerId, productId, status: "PAID" },
    });
    expect(checkout.origin).toBe("MINIAPP");
    expect(checkout.settledByPaymentId).not.toBeNull();
    const order = await prisma.order.findFirstOrThrow({
      where: { checkoutSessionId: checkout.id },
    });
    expect(order.status).toBe("PAID"); // fulfilment belongs to the bot process
  });

  it("P-2 replay returns the ORIGINAL result; changed payload conflicts; no second effect", async () => {
    const { draftToken } = await freshQuote(buyerCookie);
    const key = crid("wallet-replay");
    const first = await post("/api/miniapp/commerce/pay/wallet", buyerCookie, {
      draftToken,
      clientRequestId: key,
    });
    expect(first.statusCode, first.body).toBe(201);
    const balanceAfterFirst = (
      await prisma.user.findUniqueOrThrow({ where: { id: buyerId } })
    ).balanceToman;

    const replay = await post("/api/miniapp/commerce/pay/wallet", buyerCookie, {
      draftToken,
      clientRequestId: key,
    });
    expect(replay.statusCode, replay.body).toBe(200);
    expect((replay.json() as { paymentPublicId: string }).paymentPublicId).toBe(
      (first.json() as { paymentPublicId: string }).paymentPublicId,
    );
    const conflict = await post("/api/miniapp/commerce/pay/wallet", buyerCookie, {
      draftToken: `${draftToken}x`,
      clientRequestId: key,
    });
    expect([409, 410]).toContain(conflict.statusCode);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: buyerId } })).balanceToman,
    ).toBe(balanceAfterFirst);
  });

  it("P-3 concurrent identical confirmations produce exactly ONE financial effect", async () => {
    const { draftToken } = await freshQuote(buyerCookie);
    const key = crid("wallet-race");
    const before = (
      await prisma.user.findUniqueOrThrow({ where: { id: buyerId } })
    ).balanceToman;
    const responses = await Promise.all(
      Array.from({ length: 4 }, () =>
        post("/api/miniapp/commerce/pay/wallet", buyerCookie, {
          draftToken,
          clientRequestId: key,
        }),
      ),
    );
    const succeeded = responses.filter((r) => r.statusCode === 200 || r.statusCode === 201);
    expect(succeeded.length).toBeGreaterThanOrEqual(1);
    const after = (
      await prisma.user.findUniqueOrThrow({ where: { id: buyerId } })
    ).balanceToman;
    expect(after).toBe(before - PRICE); // exactly once, whatever the racing shapes
    const paymentIds = new Set(
      succeeded.map((r) => (r.json() as { paymentPublicId: string }).paymentPublicId),
    );
    expect(paymentIds.size).toBe(1);
  });

  it("P-4 insufficient balance: refused, and NOTHING is written", async () => {
    const poorCookie = await signIn(POOR_TELEGRAM_ID);
    const { draftToken } = await freshQuote(poorCookie);
    const response = await post("/api/miniapp/commerce/pay/wallet", poorCookie, {
      draftToken,
      clientRequestId: crid("wallet-poor"),
    });
    expect(response.statusCode, response.body).toBe(402);
    expect(response.json()).toMatchObject({ code: "INSUFFICIENT_BALANCE" });
    const poor = await prisma.user.findUniqueOrThrow({ where: { id: poorId } });
    expect(poor.balanceToman).toBe(1_000); // never negative, never touched
    expect(
      await prisma.walletTransaction.count({ where: { userId: poorId } }),
    ).toBe(0);
    expect(await prisma.order.count({ where: { userId: poorId } })).toBe(0);
  });

  it("P-5 the methods list is provider-gating AND miniapp switches, composed", async () => {
    const { draftToken } = await freshQuote(buyerCookie);
    const confirm = await post("/api/miniapp/commerce/checkout", buyerCookie, {
      draftToken,
      clientRequestId: crid("methods-confirm"),
    });
    expect(confirm.statusCode, confirm.body).toBe(201);
    const checkoutPublicId = (confirm.json() as { checkout: { publicId: string } }).checkout
      .publicId;

    // Both miniapp method switches are still OFF → nothing is offered even
    // though the gateway rows are enabled.
    const closed = await get(
      `/api/miniapp/commerce/checkouts/${checkoutPublicId}/methods`,
      buyerCookie,
    );
    expect(closed.statusCode).toBe(200);
    expect((closed.json() as { methods: unknown[] }).methods).toEqual([]);

    await setSwitch("miniapp_card_to_card_enabled", true);
    await setSwitch("miniapp_online_payments_enabled", true);
    const open = await get(
      `/api/miniapp/commerce/checkouts/${checkoutPublicId}/methods`,
      buyerCookie,
    );
    // Other suites may have seeded their own enabled gateways into the shared
    // test database — assert on THIS suite's rows, not on global emptiness.
    const methods = (open.json() as { methods: Array<{ type: string; publicId: string }> })
      .methods;
    const mine = methods.filter((m) =>
      [cardGatewayId.slice(0, 8), zarinpalGatewayId.slice(0, 8)].includes(m.publicId),
    );
    expect(mine.map((m) => m.type).sort()).toEqual(["CARD_TO_CARD", "ZARINPAL"]);
  });

  let cardCheckoutPublicId = "";
  let cardReceiptPaymentPublicId = "";

  it("P-6 card-to-card: card details, PNG receipt upload, PENDING_REVIEW pipeline", async () => {
    const { draftToken } = await freshQuote(buyerCookie);
    const confirm = await post("/api/miniapp/commerce/checkout", buyerCookie, {
      draftToken,
      clientRequestId: crid("card-confirm"),
    });
    expect(confirm.statusCode, confirm.body).toBe(201);
    cardCheckoutPublicId = (confirm.json() as { checkout: { publicId: string } }).checkout
      .publicId;

    const card = await post(
      `/api/miniapp/commerce/checkouts/${cardCheckoutPublicId}/pay/card`,
      buyerCookie,
      { clientRequestId: crid("card-info") },
    );
    expect(card.statusCode, card.body).toBe(200);
    const cardBody = card.json() as {
      gatewayPublicId: string;
      cardRef: string;
      cardNumber: string;
      amountToman: number;
    };
    expect(cardBody.cardNumber).toBe(CARD_NUMBER);
    expect(cardBody.amountToman).toBe(PRICE);

    const submit = await post(
      `/api/miniapp/commerce/checkouts/${cardCheckoutPublicId}/receipt`,
      buyerCookie,
      {
        clientRequestId: crid("receipt-1"),
        gatewayPublicId: cardBody.gatewayPublicId,
        cardRef: cardBody.cardRef,
        fileBase64: TINY_PNG_BASE64,
      },
    );
    expect(submit.statusCode, submit.body).toBe(201);
    const submitBody = submit.json() as { paymentPublicId: string; status: string };
    expect(submitBody.status).toBe("PENDING_REVIEW");
    cardReceiptPaymentPublicId = submitBody.paymentPublicId;

    const payment = await prisma.payment.findFirstOrThrow({
      where: { userId: buyerId, id: { startsWith: submitBody.paymentPublicId } },
      include: { receipts: true },
    });
    expect(payment.status).toBe("PENDING_REVIEW");
    expect(payment.receipts).toHaveLength(1);
    expect(payment.receipts[0].uploadId).not.toBeNull();
    expect(payment.receipts[0].fileId).toBeNull();
    const upload = await prisma.miniAppReceiptUpload.findUniqueOrThrow({
      where: { id: payment.receipts[0].uploadId ?? "" },
    });
    expect(upload.mimeType).toBe("image/png");
    expect(upload.consumedAt).not.toBeNull();
    expect(upload.sizeBytes).toBeGreaterThan(0);

    // Duplicate submission under a NEW key: the domain's own guard refuses.
    const duplicate = await post(
      `/api/miniapp/commerce/checkouts/${cardCheckoutPublicId}/receipt`,
      buyerCookie,
      {
        clientRequestId: crid("receipt-2"),
        gatewayPublicId: cardBody.gatewayPublicId,
        fileBase64: TINY_PNG_BASE64,
      },
    );
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ code: "RECEIPT_ALREADY_SUBMITTED" });
  });

  it("P-7 spoofed MIME and oversized uploads are refused with stable codes", async () => {
    const spoofed = await post(
      `/api/miniapp/commerce/checkouts/${cardCheckoutPublicId}/receipt`,
      buyerCookie,
      {
        clientRequestId: crid("receipt-spoof"),
        gatewayPublicId: "00000000",
        fileBase64: Buffer.from("plain text pretending to be an image").toString("base64"),
      },
    );
    // File verification runs BEFORE gateway resolution — the bytes are the
    // first thing that must be right.
    expect(spoofed.statusCode).toBe(400);
    expect(spoofed.json()).toMatchObject({ code: "RECEIPT_FILE_INVALID" });

    const oversized = await post(
      `/api/miniapp/commerce/checkouts/${cardCheckoutPublicId}/receipt`,
      buyerCookie,
      {
        clientRequestId: crid("receipt-big"),
        gatewayPublicId: "00000000",
        fileBase64: "A".repeat(7_100_000), // > base64 ceiling, < body limit
      },
    );
    expect(oversized.statusCode).toBe(400);
    expect(oversized.json()).toMatchObject({ code: "RECEIPT_FILE_INVALID" });
  });

  it("P-8 a bot-side approval settles the SAME rows the Mini App polls", async () => {
    const admin = await prisma.admin.create({
      data: { telegramId: ADMIN_TELEGRAM_ID, role: "OWNER", isActive: true },
    });
    const payment = await prisma.payment.findFirstOrThrow({
      where: { userId: buyerId, id: { startsWith: cardReceiptPaymentPublicId } },
    });
    const { approveReceiptPayment } = await import(
      "@zedbot/bot/services/receipt-review.service"
    );
    const approval = await approveReceiptPayment(payment.id, admin);
    expect(approval.ok, "error" in approval ? String(approval.error) : "").toBe(true);

    const status = await get(
      `/api/miniapp/commerce/payments/${cardReceiptPaymentPublicId}`,
      buyerCookie,
    );
    expect(status.statusCode, status.body).toBe(200);
    const body = status.json() as {
      payment: { status: string; settlementStatus: string };
      checkout: { status: string } | null;
      orderPublicId: string | null;
    };
    expect(body.payment.status).toBe("APPROVED");
    expect(body.payment.settlementStatus).toBe("SETTLED");
    expect(body.checkout?.status).toBe("PAID");
    expect(body.orderPublicId).not.toBeNull();
  });

  it("P-9 top-up enforces the bot's min/max and never offers the wallet to itself", async () => {
    await setSwitch("miniapp_wallet_topup_enabled", true);
    const tooSmall = await post("/api/miniapp/commerce/topup", buyerCookie, {
      amountToman: 100,
      clientRequestId: crid("topup-small"),
    });
    expect(tooSmall.statusCode).toBe(400);
    expect(tooSmall.json()).toMatchObject({ code: "AMOUNT_OUT_OF_RANGE" });

    const ok = await post("/api/miniapp/commerce/topup", buyerCookie, {
      amountToman: 20_000,
      clientRequestId: crid("topup-ok"),
    });
    expect(ok.statusCode, ok.body).toBe(201);
    const checkout = (ok.json() as { checkout: { publicId: string; purpose: string } }).checkout;
    expect(checkout.purpose).toBe("WALLET_CHARGE");

    const methods = await get(
      `/api/miniapp/commerce/checkouts/${checkout.publicId}/methods`,
      buyerCookie,
    );
    const types = (methods.json() as { methods: Array<{ type: string }> }).methods.map(
      (m) => m.type,
    );
    expect(types).not.toContain("WALLET"); // structurally impossible, asserted anyway
    expect(types).toContain("CARD_TO_CARD");
  });

  it("P-10 Zarinpal: initiation returns a redirect; the callback + poll settle EXACTLY once", async () => {
    const { draftToken } = await freshQuote(buyerCookie);
    const confirm = await post("/api/miniapp/commerce/checkout", buyerCookie, {
      draftToken,
      clientRequestId: crid("zp-confirm"),
    });
    const checkoutPublicId = (confirm.json() as { checkout: { publicId: string } }).checkout
      .publicId;
    const zpGateway = await prisma.paymentGateway.findUniqueOrThrow({
      where: { id: zarinpalGatewayId },
    });

    const init = await post(
      `/api/miniapp/commerce/checkouts/${checkoutPublicId}/pay/gateway`,
      buyerCookie,
      {
        gatewayPublicId: commerceShortId(zpGateway),
        clientRequestId: crid("zp-init"),
      },
    );
    expect(init.statusCode, init.body).toBe(200);
    const initBody = init.json() as { paymentPublicId: string; redirectUrl: string | null };
    expect(initBody.redirectUrl).toContain("/pg/StartPay/");

    const payment = await prisma.payment.findFirstOrThrow({
      where: { userId: buyerId, id: { startsWith: initBody.paymentPublicId } },
    });
    expect(payment.authority).not.toBeNull();

    // Browser returns via Zarinpal → the SERVER verifies before recording.
    const callback = await app.inject({
      method: "GET",
      url: `/payments/zarinpal/callback?Authority=${payment.authority}&Status=OK`,
    });
    expect(callback.statusCode).toBe(200);
    const recorded = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(recorded.providerStatus, callback.body.slice(0, 300)).toBe("SUCCESS");
    expect(recorded.status).not.toBe("APPROVED"); // recording NEVER settles

    // The Mini App polls → settle-on-poll (same CAS the bot button runs).
    const status = await get(
      `/api/miniapp/commerce/payments/${initBody.paymentPublicId}`,
      buyerCookie,
    );
    expect(status.statusCode, status.body).toBe(200);
    const settled = status.json() as {
      payment: { status: string; settlementStatus: string };
      orderPublicId: string | null;
    };
    expect(settled.payment.status).toBe("APPROVED");
    expect(settled.payment.settlementStatus).toBe("SETTLED");
    expect(settled.orderPublicId).not.toBeNull();

    // Poll again + replay the callback: still exactly one order, one payment.
    await get(`/api/miniapp/commerce/payments/${initBody.paymentPublicId}`, buyerCookie);
    await app.inject({
      method: "GET",
      url: `/payments/zarinpal/callback?Authority=${payment.authority}&Status=OK`,
    });
    const checkout = await prisma.checkoutSession.findFirstOrThrow({
      where: { userId: buyerId, id: { startsWith: checkoutPublicId } },
    });
    expect(
      await prisma.order.count({ where: { checkoutSessionId: checkout.id } }),
    ).toBe(1);
    expect(verifyCalls).toBeGreaterThanOrEqual(1);
  });

  it("P-11 a foreign user's payment status is 404; malformed ids are 404", async () => {
    const poorCookie = await signIn(POOR_TELEGRAM_ID);
    const foreign = await get(
      `/api/miniapp/commerce/payments/${cardReceiptPaymentPublicId}`,
      poorCookie,
    );
    expect(foreign.statusCode).toBe(404);
    const malformed = await get(`/api/miniapp/commerce/payments/${buyerId}`, buyerCookie);
    expect(malformed.statusCode).toBe(404);
  });

  it("P-12 no response in this suite ever carried a database uuid", async () => {
    // Spot-check the highest-risk payload: payment status with relations.
    const status = await get(
      `/api/miniapp/commerce/payments/${cardReceiptPaymentPublicId}`,
      buyerCookie,
    );
    const body = status.body;
    expect(body).not.toContain(buyerId);
    expect(body).not.toContain(productId);
    expect(body).not.toContain(cardGatewayId);
    expect(body).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });
});

describe.skipIf(hasDb)("miniapp commerce part B (skipped)", () => {
  it("requires DATABASE_URL", () => {
    expect(hasDb).toBe(false);
  });
});
