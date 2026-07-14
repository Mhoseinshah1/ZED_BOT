import { randomUUID } from "node:crypto";
import http from "node:http";

import { OrderStatus, prisma, type Panel, type User } from "@zedbot/database";
import { encryptSecret } from "@zedbot/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "zedbot-panel-tests-shared-secret-00001";
// Short panel HTTP timeout so the unknown-outcome tests finish quickly.
// Must be set before the provisioning module (and its adapters) load.
process.env.PANEL_HTTP_TIMEOUT_MS = "800";

import { isProductVisible } from "../src/services/catalog.service.js";
import { payPurchaseDraftWithWallet } from "../src/services/wallet-payment.service.js";
import {
  provisionPaidOrder,
  PROVISION_UNKNOWN_OUTCOME_TEXT,
  REFUND_PROVISIONING_REASON,
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

// --- mock XUI (Sanaei 3X-UI, GLOBAL client API - pinned 4e928a1c) ---------------------
interface XuiMockClient {
  uuid?: string;
  password?: string;
  email: string;
  totalGB: number;
  expiryTime: number;
  enable: boolean;
  subId?: string;
  inboundIds: number[];
}
const xuiClients: XuiMockClient[] = []; // single vless inbound id=1
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
            { id: 1, enable: true, protocol: "vless", remark: "e2e", port: 443 },
            { id: 2, enable: true, protocol: "vless", remark: "e2e-2", port: 444 },
          ],
        });
        return;
      }
      if (req.method === "GET" && url === "/panel/api/clients/list") {
        send(200, {
          success: true,
          obj: xuiClients.map((c) => ({
            email: c.email,
            subId: c.subId ?? "",
            uuid: c.uuid ?? "",
            password: c.password ?? "",
            totalGB: c.totalGB,
            expiryTime: c.expiryTime,
            enable: c.enable,
            inboundIds: c.inboundIds,
            traffic: { email: c.email, up: 0, down: 0, total: c.totalGB, expiryTime: c.expiryTime, enable: true },
          })),
        });
        return;
      }
      const getMatch = /^\/panel\/api\/clients\/get\/([^/]+)$/.exec(url);
      if (req.method === "GET" && getMatch !== null) {
        const email = decodeURIComponent(getMatch[1]);
        const row = xuiClients.find((c) => c.email === email);
        if (row === undefined) {
          send(200, { success: false, msg: "record not found" });
          return;
        }
        send(200, {
          success: true,
          obj: {
            client: { email: row.email, subId: row.subId ?? "", uuid: row.uuid ?? "", password: row.password ?? "" },
            inboundIds: row.inboundIds,
            usedTraffic: 0,
          },
        });
        return;
      }
      if (req.method === "POST" && url === "/panel/api/clients/add") {
        if (xuiHangAddClient) {
          hanging.push(res);
          return;
        }
        let body = "";
        req.on("data", (c: Buffer) => (body += c.toString()));
        req.on("end", () => {
          const payload = JSON.parse(body) as { client: { email: string; subId: string; totalGB?: number; expiryTime?: number }; inboundIds: number[] };
          let row = xuiClients.find((c) => c.email === payload.client.email);
          if (row !== undefined && row.subId !== payload.client.subId) {
            send(200, { success: false, msg: `email already in use: ${payload.client.email}` });
            return;
          }
          if (row === undefined) {
            row = {
              email: payload.client.email,
              subId: payload.client.subId,
              uuid: randomUUID(),
              totalGB: payload.client.totalGB ?? 0,
              expiryTime: payload.client.expiryTime ?? 0,
              enable: true,
              inboundIds: [],
            };
            xuiClients.push(row);
            xuiAddCount += 1;
          }
          for (const id of payload.inboundIds) {
            if (!row.inboundIds.includes(id)) {
              row.inboundIds.push(id);
            }
          }
          send(200, { success: true, msg: "Client added" });
        });
        return;
      }
      const delMatch = /^\/panel\/api\/clients\/del\/([^/]+)$/.exec(url);
      if (req.method === "POST" && delMatch !== null) {
        if (xuiDelFail) {
          send(200, { success: false, msg: "Error" });
          return;
        }
        const email = decodeURIComponent(delMatch[1]);
        const index = xuiClients.findIndex((c) => c.email === email);
        if (index >= 0) {
          xuiClients.splice(index, 1);
        }
        send(200, { success: index >= 0, msg: "" });
        return;
      }
      const linksMatch = /^\/panel\/api\/clients\/links\/([^/]+)$/.exec(url);
      if (req.method === "GET" && linksMatch !== null) {
        const email = decodeURIComponent(linksMatch[1]);
        const row = xuiClients.find((c) => c.email === email);
        send(200, {
          success: true,
          obj: row === undefined ? [] : [`vless://${row.uuid}@e2e.example:443#${email}`],
        });
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
let xuiMultiPanel: Panel;
let marzbanProductId = "";
let xuiProductId = "";
let xuiTokenProductId = "";
let xuiSubsetProductId = "";
let xuiInheritProductId = "";
let xuiViolatingProductId = "";

beforeAll(async () => {
  if (!hasDeps) return;
  await Promise.all([startMarzbanMock(), startXuiMock()]);
  const category = await prisma.productCategory.create({
    data: { type: "SERVICE_PRODUCT", name: `e2e-prov-cat-${runTag}`, isActive: true },
  });
  [marzbanPanel, xuiPanel, xuiTokenPanel, xuiMultiPanel] = await Promise.all([
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
    prisma.panel.create({
      data: {
        type: "XUI",
        name: `e2e-prov-xui-multi-${runTag}`,
        baseUrl: xuiUrl,
        username: "admin",
        passwordEncrypted: encryptSecret("xui-pass"),
        inboundIds: [1, 2], // the panel-level ALLOWLIST
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
  // Product-level inbound selection fixtures on the [1, 2] allowlist panel.
  const makeSelectionProduct = (name: string, inboundIds: number[] | null) =>
    prisma.product.create({
      data: {
        type: "SERVICE_PRODUCT",
        categoryId: category.id,
        panelId: xuiMultiPanel.id,
        name,
        priceToman: PRICE,
        volumeGb: 20,
        durationDays: 30,
        isActive: true,
        ...(inboundIds !== null ? { inboundIds } : {}),
      },
    });
  const [ps, pi, pv] = await Promise.all([
    makeSelectionProduct(`e2e-prov-xui-subset-${runTag}`, [2]),
    makeSelectionProduct(`e2e-prov-xui-inherit-${runTag}`, null),
    makeSelectionProduct(`e2e-prov-xui-violating-${runTag}`, [3]),
  ]);
  xuiSubsetProductId = ps.id;
  xuiInheritProductId = pi.id;
  xuiViolatingProductId = pv.id;
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
async function createPaidChain(
  user: User,
  productId: string,
  opts: { inboundIdsSnapshot?: number[] } = {},
): Promise<string> {
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
      ...(opts.inboundIdsSnapshot !== undefined
        ? { inboundIdsSnapshot: opts.inboundIdsSnapshot }
        : {}),
      paidAt: new Date(),
    },
  });
  return order.id;
}


/**
 * The order's ACTUAL resolved identity (naming phase): provisioning persists
 * it on Order.namingSnapshot before the first remote call, so tests read it
 * back instead of predicting a name from user/order data.
 */
async function resolvedUsername(orderId: string): Promise<string> {
  const order = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    select: { namingSnapshot: true },
  });
  const snapshot = order.namingSnapshot as { resolvedRemoteUsername?: string } | null;
  if (snapshot?.resolvedRemoteUsername === undefined) {
    throw new Error("order has no naming snapshot");
  }
  return snapshot.resolvedRemoteUsername;
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
    const outcome = await provisionPaidOrder(orderId);
    const username = await resolvedUsername(orderId);
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
    const outcome = await provisionPaidOrder(orderId);
    const username = await resolvedUsername(orderId);
    expect(outcome.ok).toBe(true);

    // ONE global client with the sold values (bytes + ms), email = username
    // exactly - no per-inbound suffix.
    const remote = xuiClients.find((c) => c.email === username);
    expect(remote).toBeDefined();
    expect(remote?.totalGB).toBe(Number(20n * GIB));
    expect(remote?.subId).toBe(username);
    expect(remote?.enable).toBe(true);
    expect(remote?.inboundIds).toEqual([1]);

    // Exactly one local Service with remote identifiers persisted.
    const services = await prisma.service.findMany({ where: { orderId } });
    expect(services).toHaveLength(1);
    expect(services[0].username).toBe(username);
    expect(services[0].remoteClientId).toBe(remote?.uuid);
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
    expect(xuiClients.filter((c) => c.email === username).length).toBe(1);
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
    const outcome = await provisionPaidOrder(orderId);
    const username = await resolvedUsername(orderId);
    expect(outcome.ok).toBe(true);

    const remote = xuiClients.find((c) => c.email === username);
    expect(remote).toBeDefined();
    const services = await prisma.service.findMany({ where: { orderId } });
    expect(services).toHaveLength(1);
    expect(services[0].remoteClientId).toBe(remote?.uuid);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe(OrderStatus.COMPLETED);
    expect(await refundCount(orderId)).toBe(0);

    const addsBefore = xuiAddCount;
    const retry = await provisionPaidOrder(orderId);
    expect(retry.ok).toBe(true);
    expect(xuiAddCount).toBe(addsBefore);
    expect(await prisma.service.count({ where: { orderId } })).toBe(1);
  });

  it("attaches the global client ONLY to the product-selected inbound subset", async () => {
    const user = await createUser();
    const orderId = await createPaidChain(user, xuiSubsetProductId);
    const outcome = await provisionPaidOrder(orderId);
    const username = await resolvedUsername(orderId);
    expect(outcome.ok).toBe(true);

    // Panel allowlist is [1, 2]; the product selected [2] - and ONLY [2]
    // may be attached.
    const remote = xuiClients.find((c) => c.email === username);
    expect(remote?.inboundIds).toEqual([2]);
    const services = await prisma.service.findMany({ where: { orderId } });
    expect(services).toHaveLength(1);
    expect(services[0].remoteInboundIds).toEqual([2]);
  });

  it("inherits the panel's full allowlist when the product selects nothing", async () => {
    const user = await createUser();
    const orderId = await createPaidChain(user, xuiInheritProductId);
    const outcome = await provisionPaidOrder(orderId);
    const username = await resolvedUsername(orderId);
    expect(outcome.ok).toBe(true);
    const remote = xuiClients.find((c) => c.email === username);
    expect(remote?.inboundIds?.slice().sort()).toEqual([1, 2]);
    const services = await prisma.service.findMany({ where: { orderId } });
    expect(services[0].remoteInboundIds).toEqual([1, 2]);
  });

  it("provisions the EXACT inbound set sold at checkout, surviving product edits", async () => {
    const user = await createUser();
    // Sold entitlement snapshotted at checkout: inbound [2].
    const orderId = await createPaidChain(user, xuiSubsetProductId, { inboundIdsSnapshot: [2] });

    // The admin edits the product AFTER payment: selection becomes [1].
    await prisma.product.update({ where: { id: xuiSubsetProductId }, data: { inboundIds: [1] } });
    try {
      const outcome = await provisionPaidOrder(orderId);
      expect(outcome.ok).toBe(true);
      const username = await resolvedUsername(orderId);
      // The paid order's entitlement is unchanged: attached to [2], not [1].
      const remote = xuiClients.find((c) => c.email === username);
      expect(remote?.inboundIds).toEqual([2]);
      const services = await prisma.service.findMany({ where: { orderId } });
      expect(services[0].remoteInboundIds).toEqual([2]);
    } finally {
      await prisma.product.update({ where: { id: xuiSubsetProductId }, data: { inboundIds: [2] } });
    }
  });

  it("wallet payment snapshots the sold inbound set on the order", async () => {
    const user = await prisma.user.create({
      data: { telegramId: runTag + BigInt(9000 + ++tgSeq), balanceToman: PRICE },
    });
    const product = await prisma.product.findUniqueOrThrow({
      where: { id: xuiSubsetProductId },
      include: { category: true, panel: true },
    });
    const result = await payPurchaseDraftWithWallet(user, {
      productId: product.id,
      categoryId: product.categoryId,
      panelId: product.panelId ?? undefined,
      flowType: "SERVICE_PRODUCT",
      originalPriceToman: PRICE,
      discountAmountToman: 0,
      finalPriceToman: PRICE,
      draftNonce: `inb-snap-${runTag}-${tgSeq}`,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const order = await prisma.order.findUniqueOrThrow({ where: { id: result.order.id } });
      // The sold set ([2] - the product's selection) is snapshotted on the
      // order AND recorded in the checkout's product snapshot.
      expect(order.inboundIdsSnapshot).toEqual([2]);
      const checkout = await prisma.checkoutSession.findUniqueOrThrow({
        where: { id: order.checkoutSessionId ?? "" },
      });
      const snapshot = checkout.productSnapshot as { inboundIds?: unknown };
      expect(snapshot.inboundIds).toEqual([2]);
    }
  });

  it("blocks an out-of-allowlist product selection before payment and refunds after", async () => {
    // Pre-payment: the product is not even visible/sellable.
    const violating = await prisma.product.findUniqueOrThrow({
      where: { id: xuiViolatingProductId },
      include: { category: true, panel: true },
    });
    expect(isProductVisible(violating, "F")).toBe(false);

    // Post-payment defense in depth: a definite config failure -> refund,
    // and the panel is never touched.
    const user = await createUser();
    const orderId = await createPaidChain(user, xuiViolatingProductId);
    const outcome = await provisionPaidOrder(orderId);
    const username = await resolvedUsername(orderId);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.refunded).toBe(true);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe(OrderStatus.FAILED);
    expect(order.failureReason).toContain("product inbound selection invalid");
    expect(await refundCount(orderId)).toBe(1);
    expect(xuiClients.some((c) => c.email === username)).toBe(false);
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
