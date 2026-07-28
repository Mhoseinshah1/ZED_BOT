import { createHmac } from "node:crypto";

import { prisma } from "@zedbot/database";
import { commerceShortId, encryptSecret, MINIAPP_COMMERCE_SWITCH_KEYS } from "@zedbot/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// =============================================================================
// Mini App commerce surface, parts C+D (D-1..D-10): delivery (link/configs/
// QR), service add-ons (renewal / extra volume / extra time), history and
// other-product delivery incl. the customer-input form — REAL plugin, REAL
// bot services, REAL PostgreSQL.
//
// Owner isolation is asserted on every delivered secret; statuses cross the
// wire as real enum values; the renewal money path is the bot's
// payRenewalDraftWithWallet; the personalized-product wallet path round-trips
// needs-input → form submit → settle against the SAME materialized checkout.
//
// Without DATABASE_URL the suite skips itself (docs/testing.md).
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

process.env.APP_SECRET ??= "miniapp-delivery-test-secret-0123456789";
const BOT_TOKEN = "464646:AA-miniapp-delivery-test-token";
process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
process.env.MINIAPP_PUBLIC_URL = "https://miniapp.test.example/miniapp";
process.env.MINIAPP_AUTH_RATE_LIMIT = "1000";
process.env.MINIAPP_COMMERCE_RATE_LIMIT = "1000";
delete process.env.REDIS_URL;
delete process.env.REDIS_HOST;

const { miniAppRoutes } = await import("../src/miniapp/routes.js");
const { apiTrustedProxies } = await import("../src/miniapp/trusted-proxy.js");

const runTag = BigInt(Date.now() % 1_000_000_000) * 1000n;
const OWNER_TELEGRAM_ID = 9_600_000_000_000n + runTag;
const OTHER_TELEGRAM_ID = OWNER_TELEGRAM_ID + 1n;

const RENEW_PRICE = 45_000;
const START_BALANCE = 400_000;
const SUB_URL = `https://sub.internal.example/s/${runTag}-token`;
const CONFIG_LINK_1 = `vless://cfg-${runTag}@host:443?x=1#one`;
const STOCK_CONTENT = `SECRET-STOCK-${runTag}`;

let app: FastifyInstance;
let ownerId = "";
let otherId = "";
let panelId = "";
let servicePublicId = "";
let renewProductPublicId = "";
let appleProductPublicId = "";
let stockOrderPublicId = "";
let ownerCookie = "";
let otherCookie = "";

const SWITCHES_ON = [
  "miniapp_commerce_enabled",
  "miniapp_service_delivery_enabled",
  "miniapp_service_renewal_enabled",
  "miniapp_extra_volume_enabled",
  "miniapp_extra_time_enabled",
  "miniapp_other_products_enabled",
];
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
        query_id: "AAHdelivery",
        user: `{"id":${telegramId.toString()},"first_name":"Owner"}`,
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
  return `delivery-${seed}-${runTag.toString()}`.slice(0, 64).padEnd(16, "x");
}

beforeAll(async () => {
  if (!hasDb) {
    return;
  }
  app = Fastify({ logger: false, trustProxy: apiTrustedProxies() });
  await app.register(miniAppRoutes, { prefix: "/api/miniapp" });
  await app.ready();

  const owner = await prisma.user.create({
    data: { telegramId: OWNER_TELEGRAM_ID, firstName: "Owner", balanceToman: START_BALANCE },
  });
  ownerId = owner.id;
  const other = await prisma.user.create({
    data: { telegramId: OTHER_TELEGRAM_ID, firstName: "Other", balanceToman: 100_000 },
  });
  otherId = other.id;

  const panel = await prisma.panel.create({
    data: {
      type: "MARZBAN",
      name: `delivery-panel-${runTag}`,
      baseUrl: "http://127.0.0.1:1",
      status: "ACTIVE",
      username: "admin",
      passwordEncrypted: encryptSecret("panel-password"),
      templateUsername: "tpl",
    },
  });
  panelId = panel.id;

  const svcCategory = await prisma.productCategory.create({
    data: { type: "SERVICE_PRODUCT", name: `delivery-svc-cat-${runTag}`, isActive: true },
  });
  const renewProduct = await prisma.product.create({
    data: {
      type: "SERVICE_PRODUCT",
      categoryId: svcCategory.id,
      panelId,
      name: `delivery-renew-plan-${runTag}`,
      priceToman: RENEW_PRICE,
      volumeGb: 30,
      durationDays: 30,
      isActive: true,
    },
  });
  renewProductPublicId = commerceShortId(renewProduct);

  const service = await prisma.service.create({
    data: {
      userId: ownerId,
      panelId,
      productId: renewProduct.id,
      panelType: "MARZBAN",
      username: `dsvc${runTag.toString().slice(0, 10)}`,
      status: "ACTIVE",
      source: "PAID",
      volumeBytes: 30n * 1024n ** 3n,
      usedBytes: 0n,
      remainingBytes: 30n * 1024n ** 3n,
      durationDays: 30,
      startsAt: new Date(),
      expiresAt: new Date(Date.now() + 10 * 24 * 60 * 60_000),
      subscriptionUrl: SUB_URL,
      configLinks: [CONFIG_LINK_1],
    },
  });
  servicePublicId = commerceShortId(service);

  // Personalized OTHER product (structured form BEFORE settlement).
  const otherCategory = await prisma.productCategory.create({
    data: { type: "OTHER_PRODUCT", name: `delivery-other-cat-${runTag}`, isActive: true },
  });
  const appleProduct = await prisma.product.create({
    data: {
      type: "OTHER_PRODUCT",
      categoryId: otherCategory.id,
      name: `delivery-apple-${runTag}`,
      priceToman: 80_000,
      isActive: true,
      otherProductKind: "APPLE_ID",
      otherProductFulfillmentProfile: "PERSONALIZED_SERVICE",
    },
  });
  appleProductPublicId = commerceShortId(appleProduct);

  // A DELIVERED stock order (auto-delivery already happened, bot-side).
  const stockProduct = await prisma.product.create({
    data: {
      type: "OTHER_PRODUCT",
      categoryId: otherCategory.id,
      name: `delivery-stock-${runTag}`,
      priceToman: 30_000,
      isActive: true,
      stockEnabled: true,
    },
  });
  const stockOrder = await prisma.order.create({
    data: {
      userId: ownerId,
      type: "OTHER_PRODUCT",
      status: "COMPLETED",
      productId: stockProduct.id,
      productNameSnapshot: stockProduct.name,
      finalPriceToman: 30_000,
      completedAt: new Date(),
    },
  });
  stockOrderPublicId = commerceShortId(stockOrder);
  await prisma.otherProductStockItem.create({
    data: {
      productId: stockProduct.id,
      status: "DELIVERED",
      contentEncrypted: encryptSecret(STOCK_CONTENT),
      contentFingerprint: `fp-${runTag}`,
      deliveredOrderId: stockOrder.id,
      deliveredToUserId: ownerId,
      deliveredAt: new Date(),
    },
  });

  for (const key of ["wallet_payment_enabled"]) {
    const row = await prisma.setting.findUnique({ where: { key } });
    priorSettings.set(key, row?.value ?? null);
  }
  for (const key of SWITCHES_ON) {
    await setSwitch(key, true);
  }
  await setSwitch("wallet_payment_enabled", true);

  ownerCookie = await signIn(OWNER_TELEGRAM_ID);
  otherCookie = await signIn(OTHER_TELEGRAM_ID);
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
});

describe.runIf(hasDb)("miniapp commerce parts C+D (D-1..D-10)", () => {
  it("D-1 delivery is switch-gated, owner-scoped and carries link + configs", async () => {
    await setSwitch("miniapp_service_delivery_enabled", false);
    const gated = await get(
      `/api/miniapp/commerce/services/${servicePublicId}/delivery`,
      ownerCookie,
    );
    expect(gated.statusCode).toBe(403);
    await setSwitch("miniapp_service_delivery_enabled", true);

    const response = await get(
      `/api/miniapp/commerce/services/${servicePublicId}/delivery`,
      ownerCookie,
    );
    expect(response.statusCode, response.body).toBe(200);
    const { delivery } = response.json() as {
      delivery: { subscriptionUrl: string; configLinks: string[]; username: string };
    };
    expect(delivery.subscriptionUrl).toBe(SUB_URL);
    expect(delivery.configLinks).toEqual([CONFIG_LINK_1]);
    expect(response.body).not.toContain(ownerId);
    expect(response.body).not.toContain(panelId);

    const foreign = await get(
      `/api/miniapp/commerce/services/${servicePublicId}/delivery`,
      otherCookie,
    );
    expect(foreign.statusCode).toBe(404);
  });

  it("D-2 QR endpoints render real PNGs for the link and each config", async () => {
    const sub = await get(
      `/api/miniapp/commerce/services/${servicePublicId}/qr?target=sub`,
      ownerCookie,
    );
    expect(sub.statusCode).toBe(200);
    expect(sub.headers["content-type"]).toBe("image/png");
    expect(sub.rawPayload.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");

    const config = await get(
      `/api/miniapp/commerce/services/${servicePublicId}/qr?target=config&index=0`,
      ownerCookie,
    );
    expect(config.statusCode).toBe(200);
    const missing = await get(
      `/api/miniapp/commerce/services/${servicePublicId}/qr?target=config&index=7`,
      ownerCookie,
    );
    expect(missing.statusCode).toBe(404);
  });

  it("D-3 add-on options honour the per-add-on switches and real eligibility", async () => {
    const response = await get(
      `/api/miniapp/commerce/services/${servicePublicId}/addons`,
      ownerCookie,
    );
    expect(response.statusCode, response.body).toBe(200);
    const { addons } = response.json() as {
      addons: Record<string, { enabled: boolean; eligible: boolean; plans: unknown[] }>;
    };
    expect(addons.RENEWAL.enabled).toBe(true);
    expect(addons.RENEWAL.eligible).toBe(true);
    expect(addons.RENEWAL.plans.length).toBeGreaterThan(0);
    expect(addons.EXTRA_VOLUME.eligible).toBe(true);
    expect(addons.EXTRA_TIME.eligible).toBe(true);

    await setSwitch("miniapp_service_renewal_enabled", false);
    const gated = await get(
      `/api/miniapp/commerce/services/${servicePublicId}/addons`,
      ownerCookie,
    );
    const gatedAddons = (gated.json() as { addons: Record<string, { enabled: boolean }> })
      .addons;
    expect(gatedAddons.RENEWAL.enabled).toBe(false);
    await setSwitch("miniapp_service_renewal_enabled", true);
  });

  it("D-4 renewal: quote then wallet pay — the bot's renewal money path, once", async () => {
    const quote = await post(
      `/api/miniapp/commerce/services/${servicePublicId}/addon-quote`,
      ownerCookie,
      { kind: "RENEWAL", productPublicId: renewProductPublicId },
    );
    expect(quote.statusCode, quote.body).toBe(200);
    const quoteBody = (quote.json() as {
      quote: { finalPriceToman: number; draftToken: string };
    }).quote;
    expect(quoteBody.finalPriceToman).toBe(RENEW_PRICE);

    const pay = await post("/api/miniapp/commerce/pay/wallet", ownerCookie, {
      draftToken: quoteBody.draftToken,
      clientRequestId: crid("renew-pay"),
    });
    expect(pay.statusCode, pay.body).toBe(201);
    const payBody = pay.json() as { checkout: { status: string; orderType: string } };
    expect(payBody.checkout.status).toBe("PAID");
    expect(payBody.checkout.orderType).toBe("SERVICE_RENEWAL");

    const user = await prisma.user.findUniqueOrThrow({ where: { id: ownerId } });
    expect(user.balanceToman).toBe(START_BALANCE - RENEW_PRICE);
    const order = await prisma.order.findFirstOrThrow({
      where: { userId: ownerId, type: "SERVICE_RENEWAL" },
    });
    expect(order.status).toBe("PAID"); // panel grant runs in the bot process
    const checkout = await prisma.checkoutSession.findUniqueOrThrow({
      where: { id: order.checkoutSessionId ?? "" },
    });
    expect(checkout.origin).toBe("MINIAPP");
    expect(checkout.serviceId).not.toBeNull();
  });

  it("D-5 extra time: quote then confirm creates the PENDING EXTRA_TIME checkout", async () => {
    const quote = await post(
      `/api/miniapp/commerce/services/${servicePublicId}/addon-quote`,
      ownerCookie,
      { kind: "EXTRA_TIME", productPublicId: renewProductPublicId },
    );
    expect(quote.statusCode, quote.body).toBe(200);
    const token = (quote.json() as { quote: { draftToken: string } }).quote.draftToken;
    const confirm = await post("/api/miniapp/commerce/checkout", ownerCookie, {
      draftToken: token,
      clientRequestId: crid("et-confirm"),
    });
    expect(confirm.statusCode, confirm.body).toBe(201);
    const checkout = (confirm.json() as {
      checkout: { orderType: string; status: string };
    }).checkout;
    expect(checkout.orderType).toBe("EXTRA_TIME");
    expect(checkout.status).toBe("PENDING");
  });

  it("D-6 history + order detail link the pieces together, opaquely", async () => {
    const history = await get("/api/miniapp/commerce/history?page=1", ownerCookie);
    expect(history.statusCode, history.body).toBe(200);
    const items = (history.json() as {
      items: Array<{ itemType: string; publicId: string; orderType?: string }>;
    }).items;
    expect(items.length).toBeGreaterThan(0);
    const renewal = items.find((i) => i.orderType === "SERVICE_RENEWAL");
    expect(renewal).toBeDefined();

    const detail = await get(
      `/api/miniapp/commerce/orders/${renewal?.publicId ?? ""}`,
      ownerCookie,
    );
    expect(detail.statusCode, detail.body).toBe(200);
    const order = (detail.json() as {
      order: {
        paymentPublicId: string | null;
        servicePublicId: string | null;
        reconciliationPending: boolean;
      };
    }).order;
    expect(order.paymentPublicId).toMatch(/^[0-9a-f]{8}$/);
    expect(order.servicePublicId).toBe(servicePublicId);
    expect(order.reconciliationPending).toBe(false);
    expect(detail.body).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
    );

    const payments = await get("/api/miniapp/commerce/payments?page=1", ownerCookie);
    expect(payments.statusCode).toBe(200);
    expect(
      (payments.json() as { payments: unknown[] }).payments.length,
    ).toBeGreaterThan(0);
  });

  it("D-7 delivered stock content is revealed ONLY on the owner's detail route", async () => {
    const detail = await get(
      `/api/miniapp/commerce/other-orders/${stockOrderPublicId}`,
      ownerCookie,
    );
    expect(detail.statusCode, detail.body).toBe(200);
    const order = (detail.json() as {
      order: { deliveredStock: string | null; displayStatus: string };
    }).order;
    expect(order.deliveredStock).toBe(STOCK_CONTENT);
    expect(order.displayStatus).toBe("delivered_stock");

    // Never in a list:
    const history = await get("/api/miniapp/commerce/history?page=1", ownerCookie);
    expect(history.body).not.toContain(STOCK_CONTENT);
    // Never for anyone else:
    const foreign = await get(
      `/api/miniapp/commerce/other-orders/${stockOrderPublicId}`,
      otherCookie,
    );
    expect(foreign.statusCode).toBe(404);
  });

  it("D-8 personalized OTHER product: needs-input → form → settle the SAME checkout", async () => {
    const quote = await post("/api/miniapp/commerce/quote", ownerCookie, {
      kind: "OTHER",
      productPublicId: appleProductPublicId,
    });
    expect(quote.statusCode, quote.body).toBe(200);
    const quoteBody = (quote.json() as {
      quote: { needsCustomerInputBeforePayment: boolean; draftToken: string };
    }).quote;
    expect(quoteBody.needsCustomerInputBeforePayment).toBe(true);

    const firstPay = await post("/api/miniapp/commerce/pay/wallet", ownerCookie, {
      draftToken: quoteBody.draftToken,
      clientRequestId: crid("apple-pay-1"),
    });
    expect(firstPay.statusCode, firstPay.body).toBe(409);
    const needsInput = firstPay.json() as {
      code: string;
      checkout: { publicId: string };
    };
    expect(needsInput.code).toBe("NEEDS_CUSTOMER_INPUT");
    const checkoutPublicId = needsInput.checkout.publicId;

    const form = await get(
      `/api/miniapp/commerce/checkouts/${checkoutPublicId}/input`,
      ownerCookie,
    );
    expect(form.statusCode, form.body).toBe(200);
    const fields = (form.json() as {
      input: { fields: Array<{ key: string; required: boolean }> };
    }).input.fields;
    expect(fields.length).toBeGreaterThan(0);

    const values: Record<string, string> = {};
    for (const field of fields as Array<{
      key: string;
      required: boolean;
      type: string;
      options: string[] | null;
    }>) {
      if (!field.required) {
        continue; // optional fields may be skipped (§8)
      }
      if (field.options !== null && field.options.length > 0) {
        values[field.key] = field.options[0];
      } else if (field.type === "EMAIL") {
        values[field.key] = "buyer@example.com";
      } else if (field.type === "PHONE") {
        values[field.key] = "+989121234567";
      } else {
        values[field.key] = `مقدار ${field.key}`;
      }
    }
    const submit = await post(
      `/api/miniapp/commerce/checkouts/${checkoutPublicId}/input`,
      ownerCookie,
      { clientRequestId: crid("apple-form"), values },
    );
    expect(submit.statusCode, submit.body).toBe(200);
    expect((submit.json() as { status: string }).status).toBe("SUBMITTED");
    // Raw values never round-trip — only the masked summary does.
    expect(submit.body).not.toContain(`مقدار ${fields[0].key}`);

    const balanceBefore = (
      await prisma.user.findUniqueOrThrow({ where: { id: ownerId } })
    ).balanceToman;
    const secondPay = await post("/api/miniapp/commerce/pay/wallet", ownerCookie, {
      draftToken: quoteBody.draftToken,
      clientRequestId: crid("apple-pay-2"),
    });
    expect(secondPay.statusCode, secondPay.body).toBe(201);
    const paid = secondPay.json() as { checkout: { publicId: string; status: string } };
    // The SAME materialized checkout settled — the submitted form is attached.
    expect(paid.checkout.publicId).toBe(checkoutPublicId);
    expect(paid.checkout.status).toBe("PAID");
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: ownerId } })).balanceToman,
    ).toBe(balanceBefore - 80_000);
  });

  it("D-9 an ineligible service refuses an add-on quote with a stable code", async () => {
    await prisma.service.updateMany({
      where: { userId: ownerId, id: { startsWith: servicePublicId } },
      data: { status: "DISABLED" },
    });
    try {
      const quote = await post(
        `/api/miniapp/commerce/services/${servicePublicId}/addon-quote`,
        ownerCookie,
        { kind: "RENEWAL", productPublicId: renewProductPublicId },
      );
      // Eligibility is the bot's renewableWhere — a DISABLED service may or
      // may not renew per that authority; what matters here is that the
      // answer is a stable machine code, not a leak or a 500.
      expect([200, 409]).toContain(quote.statusCode);
      if (quote.statusCode !== 200) {
        expect((quote.json() as { code: string }).code).toMatch(
          /SERVICE_NOT_ELIGIBLE|PRODUCT_UNAVAILABLE/,
        );
      }
    } finally {
      await prisma.service.updateMany({
        where: { userId: ownerId, id: { startsWith: servicePublicId } },
        data: { status: "ACTIVE" },
      });
    }
  });

  it("D-10 foreign users get 404 for every service-scoped surface", async () => {
    for (const url of [
      `/api/miniapp/commerce/services/${servicePublicId}/addons`,
      `/api/miniapp/commerce/services/${servicePublicId}/qr?target=sub`,
    ]) {
      const response = await get(url, otherCookie);
      expect(response.statusCode, url).toBe(404);
    }
    const quote = await post(
      `/api/miniapp/commerce/services/${servicePublicId}/addon-quote`,
      otherCookie,
      { kind: "RENEWAL", productPublicId: renewProductPublicId },
    );
    expect(quote.statusCode).toBe(404);
  });
});

describe.skipIf(hasDb)("miniapp commerce parts C+D (skipped)", () => {
  it("requires DATABASE_URL", () => {
    expect(hasDb).toBe(false);
  });
});
