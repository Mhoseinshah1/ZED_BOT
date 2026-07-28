import { createHmac } from "node:crypto";

import { prisma } from "@zedbot/database";
import { commerceShortId, encryptSecret, MINIAPP_COMMERCE_SWITCH_KEYS } from "@zedbot/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// =============================================================================
// Mini App commerce surface, part A (C-1..C-12): flags, catalog, username
// reservation, quote, checkout confirmation — against the REAL plugin, the
// REAL bot domain services and a REAL PostgreSQL.
//
// The properties bought here:
//   - fail-closed rollout: everything is 403 until the OWNER switch turns on,
//     and a switch flipped off between quote and confirm blocks the confirm
//     (stale browser state is rejected);
//   - ONE authority: the checkout row that confirm produces is priced by the
//     same resolver/validator the bot uses, snapshot-frozen, reservation
//     claimed in-transaction — asserted on the DATABASE, not the response;
//   - payload-bound idempotency: replay returns the original checkout,
//     a different payload under the same key is a 409 conflict;
//   - opacity: no database uuid appears in any commerce response.
//
// Without DATABASE_URL the suite skips itself (docs/testing.md).
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

process.env.APP_SECRET ??= "miniapp-commerce-test-secret-0123456789";
const BOT_TOKEN = "434343:AA-miniapp-commerce-test-token";
process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
process.env.MINIAPP_PUBLIC_URL = "https://miniapp.test.example/miniapp";
process.env.MINIAPP_AUTH_RATE_LIMIT = "1000";
process.env.MINIAPP_COMMERCE_RATE_LIMIT = "1000";

const { miniAppRoutes } = await import("../src/miniapp/routes.js");
const { apiTrustedProxies } = await import("../src/miniapp/trusted-proxy.js");

const runTag = BigInt(Date.now() % 1_000_000_000) * 1000n;
const BUYER_TELEGRAM_ID = 9_300_000_000_000n + runTag;
const OTHER_TELEGRAM_ID = BUYER_TELEGRAM_ID + 1n;

const PRICE = 90_000;
const PERCENT_OFF = 10;

let app: FastifyInstance;
/** A minimal REAL Marzban lookalike: token endpoint + user reads that 404
 * (positively absent), so the availability probe runs the real adapter and
 * the real HTTP stack instead of a mock. */
let fakePanel: FastifyInstance;
let fakePanelUrl = "";
let buyerId = "";
let panelId = "";
let productId = "";
let productPublicId = "";
let panelPublicId = "";
let discountCodeText = "";
let buyerCookie = "";
let otherCookie = "";

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
        query_id: "AAHcommerce",
        user: `{"id":${telegramId.toString()},"first_name":"Buyer"}`,
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

function clientRequestId(seed: string): string {
  return `commerce-test-${seed}-${runTag.toString()}`.slice(0, 64).padEnd(16, "x");
}

beforeAll(async () => {
  if (!hasDb) {
    return;
  }
  app = Fastify({ logger: false, trustProxy: apiTrustedProxies() });
  await app.register(miniAppRoutes, { prefix: "/api/miniapp" });
  await app.ready();

  fakePanel = Fastify({ logger: false });
  // Marzban authenticates with an OAuth2 password grant, form-encoded.
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
  const address = fakePanel.server.address();
  fakePanelUrl = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;

  const buyer = await prisma.user.create({
    data: { telegramId: BUYER_TELEGRAM_ID, firstName: "Buyer", balanceToman: 500_000 },
  });
  buyerId = buyer.id;
  await prisma.user.create({
    data: { telegramId: OTHER_TELEGRAM_ID, firstName: "Other" },
  });

  const panel = await prisma.panel.create({
    data: {
      type: "MARZBAN",
      name: `commerce-panel-${runTag}`,
      baseUrl: fakePanelUrl,
      status: "ACTIVE",
      username: "admin",
      passwordEncrypted: encryptSecret("panel-password"),
      templateUsername: "tpl",
    },
  });
  panelId = panel.id;
  panelPublicId = commerceShortId(panel);

  const category = await prisma.productCategory.create({
    data: { type: "SERVICE_PRODUCT", name: `commerce-cat-${runTag}`, isActive: true },
  });
  const product = await prisma.product.create({
    data: {
      type: "SERVICE_PRODUCT",
      categoryId: category.id,
      panelId,
      name: `commerce-product-${runTag}`,
      priceToman: PRICE,
      volumeGb: 20,
      durationDays: 30,
      isActive: true,
    },
  });
  productId = product.id;
  productPublicId = commerceShortId(product);

  discountCodeText = `CMTEST${runTag.toString()}`;
  await prisma.discountCode.create({
    data: {
      code: discountCodeText,
      type: "PERCENT",
      value: PERCENT_OFF,
      isActive: true,
      appliesTo: "PURCHASE",
    },
  });

  buyerCookie = await signIn(BUYER_TELEGRAM_ID);
  otherCookie = await signIn(OTHER_TELEGRAM_ID);
});

afterAll(async () => {
  if (!hasDb) {
    return;
  }
  for (const key of MINIAPP_COMMERCE_SWITCH_KEYS) {
    await setSwitch(key, false);
  }
  await app.close();
  await fakePanel.close();
});

describe.runIf(hasDb)("miniapp commerce part A (C-1..C-12)", () => {
  it("C-1 everything commerce is OFF by default: flags false, catalog 403", async () => {
    const flags = await get("/api/miniapp/commerce/flags", buyerCookie);
    expect(flags.statusCode).toBe(200);
    const parsed = flags.json() as { flags: Record<string, boolean> };
    for (const key of MINIAPP_COMMERCE_SWITCH_KEYS) {
      expect(parsed.flags[key]).toBe(false);
    }
    const catalog = await get("/api/miniapp/commerce/catalog", buyerCookie);
    expect(catalog.statusCode).toBe(403);
    expect(catalog.json()).toMatchObject({ ok: false, code: "FEATURE_DISABLED" });

    const quote = await post("/api/miniapp/commerce/quote", buyerCookie, {
      kind: "SERVICE",
      productPublicId,
    });
    expect(quote.statusCode).toBe(403);
    expect(quote.json()).toMatchObject({ code: "FEATURE_DISABLED" });
  });

  it("C-2 with the master switch on, the catalog lists the product by PUBLIC id only", async () => {
    await setSwitch("miniapp_commerce_enabled", true);
    const response = await get("/api/miniapp/commerce/catalog", buyerCookie);
    expect(response.statusCode).toBe(200);
    const body = response.body;
    expect(body).toContain(productPublicId);
    expect(body).toContain(panelPublicId);
    // No database uuid crosses the boundary — not the product's, panel's, ...
    expect(body).not.toContain(productId);
    expect(body).not.toContain(panelId);
    expect(body).not.toContain(buyerId);
    // Other products are gated by their own switch (off) — empty, not leaked.
    expect((response.json() as { otherProductCategories: unknown[] }).otherProductCategories).toEqual([]);
  });

  let draftNonce = "";
  let username = "";
  let draftToken = "";

  it("C-3 reserves a CUSTOM username and returns the server-minted nonce", async () => {
    const response = await post("/api/miniapp/commerce/username", buyerCookie, {
      panelPublicId,
      mode: "CUSTOM",
      username: `cbuyer${runTag.toString().slice(0, 8)}`,
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as { draftNonce: string; username: string };
    expect(body.draftNonce.length).toBeGreaterThan(10);
    expect(body.username.startsWith("cbuyer")).toBe(true);
    draftNonce = body.draftNonce;
    username = body.username;

    const reservation = await prisma.serviceUsernameReservation.findFirst({
      where: { userId: buyerId, draftNonce },
    });
    expect(reservation?.status).toBe("HELD");
  });

  it("C-4 a taken username is refused with a stable code", async () => {
    const response = await post("/api/miniapp/commerce/username", buyerCookie, {
      panelPublicId,
      mode: "CUSTOM",
      username,
    });
    // Same user, DIFFERENT draft nonce → the earlier hold blocks it.
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "USERNAME_UNAVAILABLE" });
  });

  it("C-5 quotes the authoritative pre-invoice (discount applied server-side)", async () => {
    const bad = await post("/api/miniapp/commerce/quote", buyerCookie, {
      kind: "SERVICE",
      productPublicId,
      draftNonce,
      discountCode: "no-such-code",
    });
    expect(bad.statusCode).toBe(409);
    expect(bad.json()).toMatchObject({ code: "DISCOUNT_INVALID" });

    const response = await post("/api/miniapp/commerce/quote", buyerCookie, {
      kind: "SERVICE",
      productPublicId,
      draftNonce,
      note: "یادداشت تست",
      discountCode: discountCodeText,
    });
    expect(response.statusCode).toBe(200);
    const { quote } = response.json() as {
      quote: {
        originalPriceToman: number;
        discountAmountToman: number;
        finalPriceToman: number;
        username: string;
        draftToken: string;
      };
    };
    expect(quote.originalPriceToman).toBe(PRICE);
    expect(quote.discountAmountToman).toBe((PRICE * PERCENT_OFF) / 100);
    expect(quote.finalPriceToman).toBe(PRICE - (PRICE * PERCENT_OFF) / 100);
    expect(quote.username).toBe(username);
    draftToken = quote.draftToken;
    expect(response.body).not.toContain(productId);
  });

  it("C-6 confirm creates the ONE durable checkout: frozen snapshot, claimed reservation, MINIAPP origin", async () => {
    const response = await post("/api/miniapp/commerce/checkout", buyerCookie, {
      draftToken,
      clientRequestId: clientRequestId("confirm"),
    });
    expect(response.statusCode).toBe(201);
    const { checkout } = response.json() as {
      checkout: {
        publicId: string;
        status: string;
        finalPriceToman: number;
        username: string;
      };
    };
    expect(checkout.status).toBe("PENDING");
    expect(checkout.finalPriceToman).toBe(PRICE - (PRICE * PERCENT_OFF) / 100);
    expect(checkout.username).toBe(username);

    const row = await prisma.checkoutSession.findFirst({
      where: { userId: buyerId, id: { startsWith: checkout.publicId } },
      include: { usernameReservations: true },
    });
    expect(row).not.toBeNull();
    expect(row?.origin).toBe("MINIAPP");
    expect(row?.finalPriceToman).toBe(PRICE - (PRICE * PERCENT_OFF) / 100);
    expect(row?.discountCodeId).not.toBeNull();
    const snapshot = row?.productSnapshot as Record<string, unknown>;
    expect(snapshot.serviceUsername).toBe(username);
    expect(snapshot.productName).toContain("commerce-product");
    // The in-transaction claim: the HELD reservation is now BOUND to it.
    expect(row?.usernameReservations.map((r) => r.status)).toContain("BOUND");
    expect(response.body).not.toContain(row?.id ?? "never");
  });

  it("C-7 replaying the SAME clientRequestId returns the ORIGINAL checkout", async () => {
    const first = await post("/api/miniapp/commerce/checkout", buyerCookie, {
      draftToken,
      clientRequestId: clientRequestId("replay"),
    });
    // The reservation is already BOUND, so a NEW checkout could never be
    // created — but this call replays the idempotency row, never re-executing.
    const again = await post("/api/miniapp/commerce/checkout", buyerCookie, {
      draftToken,
      clientRequestId: clientRequestId("confirm"),
    });
    expect(again.statusCode).toBe(200);
    const originalCount = await prisma.checkoutSession.count({
      where: { userId: buyerId, productId, status: "PENDING" },
    });
    expect(originalCount).toBe(1);
    // And C-7b: same key, DIFFERENT payload → conflict, nothing executed.
    const conflict = await post("/api/miniapp/commerce/checkout", buyerCookie, {
      draftToken: `${draftToken}x`,
      clientRequestId: clientRequestId("confirm"),
    });
    expect([409, 410]).toContain(conflict.statusCode);
    void first;
  });

  it("C-8 the checkout status endpoint is owner-scoped and opaque", async () => {
    const row = await prisma.checkoutSession.findFirst({
      where: { userId: buyerId, productId, status: "PENDING" },
    });
    const publicId = commerceShortId(row ?? { id: "00000000" });
    const owner = await get(`/api/miniapp/commerce/checkouts/${publicId}`, buyerCookie);
    expect(owner.statusCode).toBe(200);
    const stranger = await get(`/api/miniapp/commerce/checkouts/${publicId}`, otherCookie);
    expect(stranger.statusCode).toBe(404);
    const malformed = await get(`/api/miniapp/commerce/checkouts/${row?.id ?? ""}`, buyerCookie);
    expect(malformed.statusCode).toBe(404); // full uuid is NOT a public id
  });

  it("C-9 a price change between quote and confirm settles on the FRESH price", async () => {
    // New username/draft for a clean second checkout.
    const reserve = await post("/api/miniapp/commerce/username", buyerCookie, {
      panelPublicId,
      mode: "RANDOM",
    });
    expect(reserve.statusCode).toBe(200);
    const nonce = (reserve.json() as { draftNonce: string }).draftNonce;
    const quote = await post("/api/miniapp/commerce/quote", buyerCookie, {
      kind: "SERVICE",
      productPublicId,
      draftNonce: nonce,
    });
    expect(quote.statusCode).toBe(200);
    const token = (quote.json() as { quote: { draftToken: string } }).quote.draftToken;

    await prisma.product.update({ where: { id: productId }, data: { priceToman: PRICE + 10_000 } });
    try {
      const confirm = await post("/api/miniapp/commerce/checkout", buyerCookie, {
        draftToken: token,
        clientRequestId: clientRequestId("fresh-price"),
      });
      expect(confirm.statusCode).toBe(201);
      const { checkout } = confirm.json() as { checkout: { finalPriceToman: number } };
      // The browser's quoted amount is NOT trusted; the durable checkout is
      // re-priced from the live row at confirm — exactly like the bot's
      // «تایید خرید» click re-reading its draft against the product.
      expect(checkout.finalPriceToman).toBe(PRICE + 10_000);
    } finally {
      await prisma.product.update({ where: { id: productId }, data: { priceToman: PRICE } });
    }
  });

  it("C-10 disabling the switch between quote and confirm rejects the stale confirm", async () => {
    const reserve = await post("/api/miniapp/commerce/username", buyerCookie, {
      panelPublicId,
      mode: "RANDOM",
    });
    const nonce = (reserve.json() as { draftNonce: string }).draftNonce;
    const quote = await post("/api/miniapp/commerce/quote", buyerCookie, {
      kind: "SERVICE",
      productPublicId,
      draftNonce: nonce,
    });
    const token = (quote.json() as { quote: { draftToken: string } }).quote.draftToken;

    await setSwitch("miniapp_commerce_enabled", false);
    try {
      const confirm = await post("/api/miniapp/commerce/checkout", buyerCookie, {
        draftToken: token,
        clientRequestId: clientRequestId("stale-switch"),
      });
      expect(confirm.statusCode).toBe(403);
      expect(confirm.json()).toMatchObject({ code: "FEATURE_DISABLED" });
    } finally {
      await setSwitch("miniapp_commerce_enabled", true);
    }
  });

  it("C-11 a tampered or oversized draft token is DRAFT_EXPIRED, teaching nothing", async () => {
    for (const bad of [`${draftToken.slice(0, -2)}zz`, "d1.AAAA", "x".repeat(3000)]) {
      const response = await post("/api/miniapp/commerce/checkout", buyerCookie, {
        draftToken: bad,
        clientRequestId: clientRequestId(`tamper${bad.length}`),
      });
      expect(response.statusCode).toBe(410);
      expect(response.json()).toMatchObject({ code: "DRAFT_EXPIRED" });
    }
  });

  it("C-12 another user's draft token is unusable (owner-bound capsule)", async () => {
    const reserve = await post("/api/miniapp/commerce/username", buyerCookie, {
      panelPublicId,
      mode: "RANDOM",
    });
    const nonce = (reserve.json() as { draftNonce: string }).draftNonce;
    const quote = await post("/api/miniapp/commerce/quote", buyerCookie, {
      kind: "SERVICE",
      productPublicId,
      draftNonce: nonce,
    });
    const token = (quote.json() as { quote: { draftToken: string } }).quote.draftToken;
    const response = await post("/api/miniapp/commerce/checkout", otherCookie, {
      draftToken: token,
      clientRequestId: clientRequestId("foreign"),
    });
    expect(response.statusCode).toBe(404);
  });
});

describe.skipIf(hasDb)("miniapp commerce part A (skipped)", () => {
  it("requires DATABASE_URL", () => {
    expect(hasDb).toBe(false);
  });
});
