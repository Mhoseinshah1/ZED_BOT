import http from "node:http";

import { OrderStatus, prisma, type Panel, type User } from "@zedbot/database";
import { encryptSecret } from "@zedbot/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "zedbot-panel-tests-shared-secret-00001";
// Short panel HTTP timeout so the unknown-outcome tests finish quickly.
// Must be set before the provisioning module (and its adapters) load.
process.env.PANEL_HTTP_TIMEOUT_MS = "800";

import {
  provisionPaidOrder,
  PROVISION_UNKNOWN_OUTCOME_TEXT,
  REFUND_PROVISIONING_REASON,
  generatePanelUsername,
} from "../src/services/provisioning.service.js";

// =============================================================================
// End-to-end provisioning: User -> Panel -> Product -> Checkout -> Payment ->
// PAID Order -> provisionPaidOrder, against real PostgreSQL + real Redis
// (the provisioning lock) + mock HTTP panels reproducing the real API
// contracts for BOTH panel families.
// =============================================================================

const hasDb =
  typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const hasRedis =
  (process.env.REDIS_URL ?? "") !== "" || (process.env.REDIS_HOST ?? "") !== "";
const hasDeps = hasDb && hasRedis;

const PRICE = 55_000;
const GIB = 1024n * 1024n * 1024n;
const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
let tgSeq = 0;

// --- mock Marzban -------------------------------------------------------------------
interface MarzbanMockUser {
  data_limit: number;
  expire: number;
  note: string;
}
const marzbanUsers = new Map<string, MarzbanMockUser>();
let marzbanCreateCount = 0;
let marzbanHangAll = false;
let marzbanServer: http.Server;
let marzbanUrl = "";
const hanging: http.ServerResponse[] = [];

function startMarzbanMock(): Promise<void> {
  marzbanServer = http.createServer((req, res) => {
    void (async () => {
      const url = req.url ?? "";
      const send = (status: number, body: unknown): void => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.method === "POST" && url === "/api/admin/token") {
        send(200, { access_token: "e2e-token" });
        return;
      }
      // hangAll affects the create call and service-user reads, but the
      // template stays readable so the pipeline reaches the create step.
      if (marzbanHangAll && req.method === "POST" && url === "/api/user") {
        hanging.push(res);
        return;
      }
      const match = /^\/api\/user\/([^/]+)$/.exec(url);
      if (req.method === "GET" && match !== null) {
        const username = decodeURIComponent(match[1]);
        if (marzbanHangAll && username !== "tpl") {
          hanging.push(res);
          return;
        }
        if (username === "tpl") {
          send(200, { username: "tpl", status: "active", proxies: { vless: { id: "tpl-uuid" } }, inbounds: { vless: ["VLESS"] } });
          return;
        }
        const user = marzbanUsers.get(username);
        if (user === undefined) {
          send(404, { detail: "User not found" });
          return;
        }
        send(200, {
          username,
          status: "active",
          proxies: { vless: {} },
          inbounds: { vless: ["VLESS"] },
          data_limit: user.data_limit,
          expire: user.expire,
          used_traffic: 0,
          note: user.note,
          subscription_url: `/sub/${username}`,
        });
        return;
      }
      if (req.method === "POST" && url === "/api/user") {
        let body = "";
        req.on("data", (c: Buffer) => (body += c.toString()));
        req.on("end", () => {
          const payload = JSON.parse(body) as { username: string; data_limit: number; expire: number; note: string };
          marzbanCreateCount += 1;
          if (marzbanUsers.has(payload.username)) {
            send(409, { detail: "User already exists" });
            return;
          }
          marzbanUsers.set(payload.username, {
            data_limit: payload.data_limit,
            expire: payload.expire,
            note: payload.note,
          });
          send(200, {
            username: payload.username,
            status: "active",
            proxies: { vless: {} },
            data_limit: payload.data_limit,
            expire: payload.expire,
            note: payload.note,
            subscription_url: `/sub/${payload.username}`,
          });
        });
        return;
      }
      res.writeHead(404);
      res.end();
    })();
  });
  return new Promise((resolve) => {
    marzbanServer.listen(0, "127.0.0.1", () => {
      marzbanUrl = `http://127.0.0.1:${(marzbanServer.address() as { port: number }).port}`;
      resolve();
    });
  });
}

// --- mock XUI (Sanaei 3X-UI) ----------------------------------------------------------
interface XuiMockClient {
  id?: string;
  password?: string;
  email: string;
  totalGB: number;
  expiryTime: number;
  enable: boolean;
  subId?: string;
}
const xuiClients: XuiMockClient[] = []; // single inbound id=1
let xuiAddCount = 0;
let xuiHangAddClient = false;
let xuiDelFail = false;
let xuiServer: http.Server;
let xuiUrl = "";
const XUI_SESSION = "e2e-session";
const XUI_API_TOKEN = "e2e-xui-api-token-secret";

function startXuiMock(): Promise<void> {
  xuiServer = http.createServer((req, res) => {
    void (async () => {
      const url = req.url ?? "";
      const send = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
        res.writeHead(status, { "Content-Type": "application/json", ...headers });
        res.end(JSON.stringify(body));
      };
      if (req.method === "POST" && url === "/login") {
        send(200, { success: true, msg: "Login Successfully" }, { "Set-Cookie": `3x-ui=${XUI_SESSION}; Path=/` });
        return;
      }
      const cookieOk = (req.headers.cookie ?? "") === `3x-ui=${XUI_SESSION}`;
      const bearerOk = req.headers.authorization === `Bearer ${XUI_API_TOKEN}`;
      if (!cookieOk && !bearerOk) {
        res.writeHead(302, { Location: "/" });
        res.end();
        return;
      }
      if (req.method === "GET" && url === "/panel/api/inbounds/list") {
        send(200, {
          success: true,
          obj: [
            {
              id: 1,
              enable: true,
              protocol: "vless",
              remark: "e2e",
              port: 443,
              settings: JSON.stringify({ clients: xuiClients }),
              clientStats: xuiClients.map((c, i) => ({
                id: i + 1,
                inboundId: 1,
                email: c.email,
                up: 0,
                down: 0,
                total: c.totalGB,
                expiryTime: c.expiryTime,
                enable: true,
              })),
            },
          ],
        });
        return;
      }
      if (req.method === "POST" && url === "/panel/api/inbounds/addClient") {
        if (xuiHangAddClient) {
          hanging.push(res);
          return;
        }
        let body = "";
        req.on("data", (c: Buffer) => (body += c.toString()));
        req.on("end", () => {
          const payload = JSON.parse(body) as { id: number; settings: string };
          const client = (JSON.parse(payload.settings) as { clients: XuiMockClient[] }).clients[0];
          if (xuiClients.some((c) => c.email === client.email)) {
            send(200, { success: false, msg: "Duplicate email" });
            return;
          }
          xuiClients.push(client);
          xuiAddCount += 1;
          send(200, { success: true, msg: "Client added" });
        });
        return;
      }
      const delMatch = /^\/panel\/api\/inbounds\/1\/delClient\/([^/]+)$/.exec(url);
      if (req.method === "POST" && delMatch !== null) {
        if (xuiDelFail) {
          send(200, { success: false, msg: "Error" });
          return;
        }
        const clientId = decodeURIComponent(delMatch[1]);
        const index = xuiClients.findIndex((c) => c.id === clientId || c.password === clientId);
        if (index >= 0) {
          xuiClients.splice(index, 1);
        }
        send(200, { success: index >= 0, msg: "" });
        return;
      }
      res.writeHead(404);
      res.end();
    })();
  });
  return new Promise((resolve) => {
    xuiServer.listen(0, "127.0.0.1", () => {
      xuiUrl = `http://127.0.0.1:${(xuiServer.address() as { port: number }).port}`;
      resolve();
    });
  });
}

// --- fixtures ----------------------------------------------------------------------
let marzbanPanel: Panel;
let xuiPanel: Panel;
let xuiTokenPanel: Panel;
let marzbanProductId = "";
let xuiProductId = "";
let xuiTokenProductId = "";

beforeAll(async () => {
  if (!hasDeps) return;
  await Promise.all([startMarzbanMock(), startXuiMock()]);
  const category = await prisma.productCategory.create({
    data: { type: "SERVICE_PRODUCT", name: `e2e-prov-cat-${runTag}`, isActive: true },
  });
  [marzbanPanel, xuiPanel, xuiTokenPanel] = await Promise.all([
    prisma.panel.create({
      data: {
        type: "MARZBAN",
        name: `e2e-prov-marzban-${runTag}`,
        baseUrl: marzbanUrl,
        username: "admin",
        passwordEncrypted: encryptSecret("marzban-pass"),
        templateUsername: "tpl",
        status: "ACTIVE",
      },
    }),
    prisma.panel.create({
      data: {
        type: "XUI",
        name: `e2e-prov-xui-${runTag}`,
        baseUrl: xuiUrl,
        username: "admin",
        passwordEncrypted: encryptSecret("xui-pass"),
        inboundIds: [1],
        status: "ACTIVE",
      },
    }),
    prisma.panel.create({
      data: {
        type: "XUI",
        name: `e2e-prov-xui-token-${runTag}`,
        baseUrl: xuiUrl,
        authMode: "API_TOKEN",
        tokenEncrypted: encryptSecret(XUI_API_TOKEN),
        inboundIds: [1],
        status: "ACTIVE",
      },
    }),
  ]);
  const makeProduct = (name: string, panelId: string) =>
    prisma.product.create({
      data: {
        type: "SERVICE_PRODUCT",
        categoryId: category.id,
        panelId,
        name,
        priceToman: PRICE,
        volumeGb: 20,
        durationDays: 30,
        isActive: true,
      },
    });
  const [p1, p2, p3] = await Promise.all([
    makeProduct(`e2e-prov-marzban-prod-${runTag}`, marzbanPanel.id),
    makeProduct(`e2e-prov-xui-prod-${runTag}`, xuiPanel.id),
    makeProduct(`e2e-prov-xui-token-prod-${runTag}`, xuiTokenPanel.id),
  ]);
  marzbanProductId = p1.id;
  xuiProductId = p2.id;
  xuiTokenProductId = p3.id;
});

afterAll(() => {
  for (const res of hanging) {
    res.destroy();
  }
  marzbanServer?.close();
  xuiServer?.close();
});

async function createUser(): Promise<User> {
  tgSeq += 1;
  return prisma.user.create({ data: { telegramId: runTag + BigInt(tgSeq), balanceToman: 0 } });
}

/** Full chain: CheckoutSession (PAID) -> Payment (APPROVED) -> Order (PAID). */
async function createPaidChain(user: User, productId: string): Promise<string> {
  const checkout = await prisma.checkoutSession.create({
    data: {
      userId: user.id,
      purpose: "ORDER_PAYMENT",
      productId,
      orderType: "SERVICE_PURCHASE",
      originalPriceToman: PRICE,
      finalPriceToman: PRICE,
      status: "PAID",
      expiresAt: new Date(Date.now() + 3_600_000),
      paidAt: new Date(),
    },
  });
  const payment = await prisma.payment.create({
    data: {
      userId: user.id,
      checkoutSessionId: checkout.id,
      purpose: "ORDER_PAYMENT",
      status: "APPROVED",
      amountToman: PRICE,
      payableAmountToman: PRICE,
      paidAt: new Date(),
    },
  });
  const order = await prisma.order.create({
    data: {
      userId: user.id,
      type: "SERVICE_PURCHASE",
      status: OrderStatus.PAID,
      productId,
      checkoutSessionId: checkout.id,
      paymentId: payment.id,
      originalPriceToman: PRICE,
      discountAmountToman: 0,
      finalPriceToman: PRICE,
      volumeGbSnapshot: 20,
      durationDaysSnapshot: 30,
      paidAt: new Date(),
    },
  });
  return order.id;
}

async function refundCount(orderId: string): Promise<number> {
  return prisma.walletTransaction.count({
    where: { relatedOrderId: orderId, reason: REFUND_PROVISIONING_REASON },
  });
}

describe.runIf(hasDeps)("E2E provisioning (Marzban)", () => {
  it("provisions a PAID order end to end, idempotent on retry", async () => {
    const user = await createUser();
    const orderId = await createPaidChain(user, marzbanProductId);
    const username = generatePanelUsername(user.telegramId, orderId);

    const outcome = await provisionPaidOrder(orderId);
    expect(outcome.ok).toBe(true);

    // Remote mock account exists with the sold values.
    const remote = marzbanUsers.get(username);
    expect(remote).toBeDefined();
    expect(remote?.data_limit).toBe(Number(20n * GIB));

    // Exactly one local Service; order COMPLETED; no refund.
    const services = await prisma.service.findMany({ where: { orderId } });
    expect(services).toHaveLength(1);
    expect(services[0].username).toBe(username);
    expect(services[0].volumeBytes).toBe(20n * GIB);
    expect(services[0].subscriptionUrl).toContain(`/sub/${username}`);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe(OrderStatus.COMPLETED);
    expect(await refundCount(orderId)).toBe(0);

    // Retry: no duplicate remote account, no duplicate Service.
    const createsBefore = marzbanCreateCount;
    const retry = await provisionPaidOrder(orderId);
    expect(retry.ok).toBe(true);
    expect(retry.ok && retry.alreadyExisted).toBe(true);
    expect(marzbanCreateCount).toBe(createsBefore);
    expect(await prisma.service.count({ where: { orderId } })).toBe(1);
    expect(await refundCount(orderId)).toBe(0);
  });

  it("keeps the order PROVISIONING (no refund) on an unknown remote outcome", async () => {
    const user = await createUser();
    const orderId = await createPaidChain(user, marzbanProductId);

    marzbanHangAll = true; // create hangs AND the read-back probe hangs
    try {
      const outcome = await provisionPaidOrder(orderId);
      expect(outcome.ok).toBe(false);
      expect(outcome.ok === false && outcome.refunded).toBe(false);
      expect(outcome.ok === false && outcome.error).toBe(PROVISION_UNKNOWN_OUTCOME_TEXT);
    } finally {
      marzbanHangAll = false;
    }

    // UNKNOWN never moves money: still PROVISIONING, zero refunds, no Service.
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe(OrderStatus.PROVISIONING);
    expect(await refundCount(orderId)).toBe(0);
    expect(await prisma.service.count({ where: { orderId } })).toBe(0);
  });
});

describe.runIf(hasDeps)("E2E provisioning (XUI / Sanaei)", () => {
  it("provisions a PAID order end to end, idempotent on retry", async () => {
    const user = await createUser();
    const orderId = await createPaidChain(user, xuiProductId);
    const username = generatePanelUsername(user.telegramId, orderId);

    const outcome = await provisionPaidOrder(orderId);
    expect(outcome.ok).toBe(true);

    // Remote mock client exists with the sold values (bytes + ms).
    const remote = xuiClients.find((c) => c.email === `${username}-1`);
    expect(remote).toBeDefined();
    expect(remote?.totalGB).toBe(Number(20n * GIB));
    expect(remote?.subId).toBe(username);
    expect(remote?.enable).toBe(true);

    // Exactly one local Service with remote identifiers persisted.
    const services = await prisma.service.findMany({ where: { orderId } });
    expect(services).toHaveLength(1);
    expect(services[0].username).toBe(username);
    expect(services[0].remoteClientId).toBe(remote?.id);
    expect(services[0].remoteInboundIds).toEqual([1]);
    expect(services[0].subscriptionToken).toBe(username);
    // No subscription base configured -> no fabricated subscription URL.
    expect(services[0].subscriptionUrl).toBeNull();
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe(OrderStatus.COMPLETED);
    expect(await refundCount(orderId)).toBe(0);

    // Retry: no duplicate remote client, no duplicate Service.
    const addsBefore = xuiAddCount;
    const retry = await provisionPaidOrder(orderId);
    expect(retry.ok).toBe(true);
    expect(xuiAddCount).toBe(addsBefore);
    expect(xuiClients.filter((c) => c.email.startsWith(username)).length).toBe(1);
    expect(await prisma.service.count({ where: { orderId } })).toBe(1);
  });

  it("keeps the order PROVISIONING (no refund) on an unconfirmable partial outcome", async () => {
    const user = await createUser();
    const orderId = await createPaidChain(user, xuiProductId);

    // addClient times out (may have landed) and cleanup cannot be confirmed.
    xuiHangAddClient = true;
    xuiDelFail = true;
    try {
      const outcome = await provisionPaidOrder(orderId);
      expect(outcome.ok).toBe(false);
      expect(outcome.ok === false && outcome.refunded).toBe(false);
      expect(outcome.ok === false && outcome.error).toBe(PROVISION_UNKNOWN_OUTCOME_TEXT);
    } finally {
      xuiHangAddClient = false;
      xuiDelFail = false;
    }

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe(OrderStatus.PROVISIONING);
    expect(await refundCount(orderId)).toBe(0);
    expect(await prisma.service.count({ where: { orderId } })).toBe(0);
  });

  it("provisions end to end in API_TOKEN mode, idempotent on retry", async () => {
    const user = await createUser();
    const orderId = await createPaidChain(user, xuiTokenProductId);
    const username = generatePanelUsername(user.telegramId, orderId);

    const outcome = await provisionPaidOrder(orderId);
    expect(outcome.ok).toBe(true);

    const remote = xuiClients.find((c) => c.email === `${username}-1`);
    expect(remote).toBeDefined();
    const services = await prisma.service.findMany({ where: { orderId } });
    expect(services).toHaveLength(1);
    expect(services[0].remoteClientId).toBe(remote?.id);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe(OrderStatus.COMPLETED);
    expect(await refundCount(orderId)).toBe(0);

    const addsBefore = xuiAddCount;
    const retry = await provisionPaidOrder(orderId);
    expect(retry.ok).toBe(true);
    expect(xuiAddCount).toBe(addsBefore);
    expect(await prisma.service.count({ where: { orderId } })).toBe(1);
  });

  it("refunds on a definite configuration failure (missing inbound ids)", async () => {
    const user = await createUser();
    const brokenPanel = await prisma.panel.create({
      data: {
        type: "XUI",
        name: `e2e-prov-xui-broken-${runTag}`,
        baseUrl: xuiUrl,
        username: "admin",
        passwordEncrypted: encryptSecret("xui-pass"),
        // no inboundIds -> local preflight catches it as a definite failure
        status: "ACTIVE",
      },
    });
    const category = await prisma.product.findUniqueOrThrow({
      where: { id: xuiProductId },
      select: { categoryId: true },
    });
    const brokenProduct = await prisma.product.create({
      data: {
        type: "SERVICE_PRODUCT",
        categoryId: category.categoryId,
        panelId: brokenPanel.id,
        name: `e2e-prov-xui-broken-prod-${runTag}`,
        priceToman: PRICE,
        volumeGb: 20,
        durationDays: 30,
        isActive: true,
      },
    });
    const orderId = await createPaidChain(user, brokenProduct.id);

    const outcome = await provisionPaidOrder(orderId);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.refunded).toBe(true);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe(OrderStatus.FAILED);
    expect(await refundCount(orderId)).toBe(1);
    const refreshed = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(refreshed.balanceToman).toBe(PRICE);
  });
});
