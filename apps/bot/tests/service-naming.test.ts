import { readdirSync, readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  OrderStatus,
  OrderType,
  prisma,
  UsernamePatternType,
  type Panel,
  type User,
} from "@zedbot/database";
import { encryptSecret } from "@zedbot/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "service-naming-tests-secret-0001";
process.env.PANEL_HTTP_TIMEOUT_MS ??= "1500";

import { cb } from "../src/handlers/panels/panel-cb.js";
import { USERNAME_PATTERNS } from "../src/handlers/panels/panel-views.js";
import { provisionPaidOrder } from "../src/services/provisioning.service.js";
import {
  ensureOrderNamingSnapshot,
  NAMING_INCOMPLETE_TEXT,
  NAMING_SAVED_TEXT,
  NAMING_STRATEGY_VERSION,
  namingConfigFromPanel,
  normalizeRemoteUsername,
  parseNamingSnapshot,
  previewNamingStrategy,
  resolveVpnRemoteIdentity,
  USERNAME_STRATEGY_INFO,
  validateNamingConfig,
} from "../src/services/service-naming.service.js";

// =============================================================================
// Service naming tests (naming phase): the admin-selected strategy becomes
// AUTHORITATIVE for the remote identity.
//
//   DISCOVERY    - every selectable strategy registered + executable; no
//                  silent fallback to the default resolver
//   RESOLVERS    - documented output per strategy, missing-username fallback,
//                  normalization, length, truncation-uniqueness, determinism
//   CONFIG       - preview responds to the selection; persisted; paid-order
//                  snapshots immune to config/user/product changes
//   PROVISIONING - the mock panel receives EXACTLY the snapshotted username;
//                  concurrent retries create ONE account; local collisions
//                  never adopt; recovery reuses the stored identity
//                  (Marzban/XUI exact-name + retry + no-inbound-suffix are
//                  additionally locked by panel-provisioning-e2e.test.ts)
//   LEGACY       - services keep their usernames, migration renames nothing,
//                  lifecycle uses stored identity
//   NAVIGATION   - naming page + selector + preview callbacks, 64-byte budget
//   SECURITY     - no panel/app secret can reach a name or naming log
//
// E2E suites skip without DATABASE_URL/REDIS_URL (docs/testing.md).
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const hasRedis = (process.env.REDIS_URL ?? "") !== "" || (process.env.REDIS_HOST ?? "") !== "";
const hasDeps = hasDb && hasRedis;

const GIB = 1024n * 1024n * 1024n;
const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
let seq = 0;

const PANEL_SECRET_PASSWORD = "naming-panel-secret-pass-777";

const ALL_STRATEGIES = Object.values(UsernamePatternType);

// --- mock Marzban (token/create/read - the e2e mock pattern) ------------------------------

const mzUsers = new Map<string, { note: string; data_limit: number }>();
let mzCreateCount = 0;
let mzServer: http.Server;
let mzUrl = "";

function startMarzbanMock(): Promise<void> {
  mzServer = http.createServer((req, res) => {
    void (async () => {
      const url = req.url ?? "";
      const send = (status: number, body: unknown): void => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.method === "POST" && url === "/api/admin/token") {
        send(200, { access_token: "naming-token" });
        return;
      }
      const match = /^\/api\/user\/([^/]+)$/.exec(url);
      if (req.method === "GET" && match !== null) {
        const username = decodeURIComponent(match[1]);
        if (username === "tpl") {
          send(200, {
            username: "tpl",
            status: "active",
            proxies: { vless: { id: "tpl-uuid" } },
            inbounds: { vless: ["VLESS"] },
          });
          return;
        }
        const user = mzUsers.get(username);
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
          expire: 0,
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
          const payload = JSON.parse(body) as {
            username: string;
            data_limit: number;
            note: string;
          };
          mzCreateCount += 1;
          if (mzUsers.has(payload.username)) {
            send(409, { detail: "User already exists" });
            return;
          }
          mzUsers.set(payload.username, { note: payload.note, data_limit: payload.data_limit });
          send(200, {
            username: payload.username,
            status: "active",
            proxies: { vless: {} },
            data_limit: payload.data_limit,
            expire: 0,
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
    mzServer.listen(0, "127.0.0.1", () => {
      mzUrl = `http://127.0.0.1:${(mzServer.address() as { port: number }).port}`;
      resolve();
    });
  });
}

// --- fixtures ------------------------------------------------------------------------------

let panel: Panel;
let categoryId = "";
let productId = "";

beforeAll(async () => {
  if (!hasDeps) {
    return;
  }
  await startMarzbanMock();
  panel = await prisma.panel.create({
    data: {
      type: "MARZBAN",
      name: `naming-mz-${runTag}`,
      baseUrl: mzUrl,
      username: "admin",
      passwordEncrypted: encryptSecret(PANEL_SECRET_PASSWORD),
      templateUsername: "tpl",
      status: "ACTIVE",
    },
  });
  const category = await prisma.productCategory.create({
    data: { type: "SERVICE_PRODUCT", name: `naming-cat-${runTag}`, isActive: true },
  });
  categoryId = category.id;
  const product = await prisma.product.create({
    data: {
      type: "SERVICE_PRODUCT",
      categoryId,
      panelId: panel.id,
      name: `naming-prod-${runTag}`,
      priceToman: 10_000,
      volumeGb: 20,
      durationDays: 30,
      isActive: true,
    },
  });
  productId = product.id;
});

afterAll(async () => {
  mzServer?.close();
  if (hasDeps) {
    await prisma.$disconnect();
  }
});

async function createUser(username: string | null = null): Promise<User> {
  seq += 1;
  return prisma.user.create({
    data: { telegramId: runTag + BigInt(seq), ...(username !== null ? { username } : {}) },
  });
}

async function createPaidOrder(user: User): Promise<string> {
  const order = await prisma.order.create({
    data: {
      userId: user.id,
      type: OrderType.SERVICE_PURCHASE,
      status: OrderStatus.PAID,
      productId,
      panelId: panel.id,
      originalPriceToman: 10_000,
      finalPriceToman: 10_000,
      productNameSnapshot: `naming-prod-${runTag}`,
      volumeGbSnapshot: 20,
      durationDaysSnapshot: 30,
      paidAt: new Date(),
    },
  });
  return order.id;
}

async function setStrategy(
  strategy: UsernamePatternType,
  fields: {
    customText?: string | null;
    randomLength?: number | null;
    representativePrefix?: string | null;
  } = {},
): Promise<Panel> {
  panel = await prisma.panel.update({
    where: { id: panel.id },
    data: {
      usernamePatternType: strategy,
      usernameCustomText: fields.customText ?? null,
      usernameRandomLength: fields.randomLength ?? null,
      representativeUsernamePrefix: fields.representativePrefix ?? null,
    },
  });
  return panel;
}

async function resolveFor(
  user: User,
  orderId: string,
): Promise<{ username: string; strategy: string }> {
  const result = await resolveVpnRemoteIdentity(
    { id: orderId },
    user,
    panel.id,
    namingConfigFromPanel(panel),
  );
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error("resolution failed");
  }
  return {
    username: result.identity.resolvedRemoteUsername,
    strategy: result.identity.strategy,
  };
}

// =============================================================================
// DISCOVERY (pure - no DB)
// =============================================================================

describe("DISCOVERY: every selectable strategy is registered and executable (1-3)", () => {
  it("1. the admin selector exposes EXACTLY the Prisma enum's strategies (eight, not five)", () => {
    // The task brief said five; the repository actually ships EIGHT. They
    // are preserved verbatim - none dropped, none invented.
    expect([...USERNAME_PATTERNS].sort()).toEqual([...ALL_STRATEGIES].sort());
    expect(USERNAME_PATTERNS).toHaveLength(8);
  });

  it("2. every strategy has a Persian label, description and an executable preview resolver", () => {
    const fullConfig = {
      usernameCustomText: "shop",
      usernameRandomLength: 4,
      representativeUsernamePrefix: "rep",
      usernameSequenceLastNumber: 41,
      representativeSequenceLastNumber: 7,
    };
    const labels = new Set<string>();
    for (const strategy of ALL_STRATEGIES) {
      const info = USERNAME_STRATEGY_INFO[strategy];
      expect(info.fa.length, strategy).toBeGreaterThan(3);
      expect(info.descriptionFa.length, strategy).toBeGreaterThan(5);
      labels.add(info.fa);
      const preview = previewNamingStrategy(fullConfig, strategy);
      expect(preview.ok, strategy).toBe(true);
      expect(preview.preview.length, strategy).toBeGreaterThan(0);
    }
    expect(labels.size).toBe(8); // distinct Persian labels - no duplicates
  });

  it("3. no strategy silently falls back to another resolver: previews are pairwise distinct", () => {
    const fullConfig = {
      usernameCustomText: "shop",
      usernameRandomLength: 6,
      representativeUsernamePrefix: "rep",
      usernameSequenceLastNumber: 41,
      representativeSequenceLastNumber: 7,
    };
    const previews = ALL_STRATEGIES.map(
      (strategy) => previewNamingStrategy(fullConfig, strategy).preview,
    );
    expect(new Set(previews).size).toBe(previews.length);
  });
});

// =============================================================================
// RESOLVERS (real DB - counters/collision checks live in PostgreSQL)
// =============================================================================

describe.runIf(hasDeps)("RESOLVERS: documented output per strategy (4-11)", () => {
  it("4. each strategy produces its documented shape and records ITS name in the snapshot", async () => {
    const user = await createUser("Some_Buyer");
    const tg = user.telegramId.toString();

    const cases: Array<{
      strategy: UsernamePatternType;
      fields?: Parameters<typeof setStrategy>[1];
      pattern: RegExp;
    }> = [
      {
        strategy: "TELEGRAM_USERNAME_SEQUENCE",
        pattern: /^some_buyer_\d+$/,
      },
      { strategy: "TELEGRAM_ID_RANDOM", pattern: new RegExp(`^${tg}_[a-z0-9]{4}$`) },
      {
        strategy: "CUSTOM",
        fields: { customText: "VipShop" },
        pattern: /^vipshop_[a-f0-9]{8}$/,
      },
      {
        strategy: "CUSTOM_RANDOM",
        fields: { randomLength: 10 },
        pattern: /^[a-z0-9]{10}$/,
      },
      {
        strategy: "CUSTOM_TEXT_RANDOM",
        fields: { customText: "VipShop", randomLength: 5 },
        pattern: /^vipshop_[a-z0-9]{5}$/,
      },
      {
        strategy: "CUSTOM_TEXT_SEQUENCE",
        fields: { customText: "VipShop" },
        pattern: /^vipshop_\d+$/,
      },
      { strategy: "TELEGRAM_ID_SEQUENCE", pattern: new RegExp(`^${tg}_\\d+$`) },
      {
        strategy: "REPRESENTATIVE_TEXT_SEQUENCE",
        fields: { representativePrefix: "AgentX" },
        pattern: /^agentx_\d+$/,
      },
    ];

    for (const testCase of cases) {
      await setStrategy(testCase.strategy, testCase.fields ?? {});
      const orderId = await createPaidOrder(user);
      const resolved = await resolveFor(user, orderId);
      expect(resolved.username, testCase.strategy).toMatch(testCase.pattern);
      // The snapshot names the SELECTED strategy - never a silent default.
      expect(resolved.strategy).toBe(testCase.strategy);
    }
  });

  it("5. a user WITHOUT a Telegram username gets the deterministic u<telegramId> fallback", async () => {
    const user = await createUser(null);
    await setStrategy("TELEGRAM_USERNAME_SEQUENCE");
    const orderId = await createPaidOrder(user);
    const resolved = await resolveFor(user, orderId);
    expect(resolved.username).toMatch(new RegExp(`^u${user.telegramId.toString()}_\\d+$`));
    for (const forbidden of ["undefined", "null", "@"]) {
      expect(resolved.username).not.toContain(forbidden);
    }
  });

  it("6. unsafe characters are normalized to the provider profile", () => {
    expect(normalizeRemoteUsername("My Panel!! نام--X", "a1b2c3d4")).toMatch(/^[a-z0-9_]+$/);
    expect(normalizeRemoteUsername("__lead_and_trail__", "a1b2c3d4")).toBe("lead_and_trail");
    expect(normalizeRemoteUsername("a  b   c", "a1b2c3d4")).toBe("a_b_c");
  });

  it("7. an all-unsafe input never yields an empty name", () => {
    const normalized = normalizeRemoteUsername("!!! ### نام", "a1b2c3d4");
    expect(normalized.length).toBeGreaterThanOrEqual(3);
    expect(normalized).toContain("a1b2c3d4");
  });

  it("8. the 32-char provider limit is enforced", () => {
    const long = normalizeRemoteUsername("x".repeat(80), "a1b2c3d4");
    expect(long.length).toBeLessThanOrEqual(32);
  });

  it("9. truncation preserves uniqueness via the order-derived tail", () => {
    const base = "very_long_custom_text_that_overflows_everything";
    const a = normalizeRemoteUsername(base, "aaaa1111");
    const b = normalizeRemoteUsername(base, "bbbb2222");
    expect(a).not.toBe(b);
    expect(a.endsWith("aaaa1111")).toBe(true);
    expect(b.endsWith("bbbb2222")).toBe(true);
  });

  it("10. the same order ALWAYS resolves to the same name - even for random strategies", async () => {
    const user = await createUser("stable_user");
    await setStrategy("TELEGRAM_ID_RANDOM", { randomLength: 6 });
    const orderId = await createPaidOrder(user);
    const order = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { user: true },
    });

    const first = await ensureOrderNamingSnapshot(order, panel, null);
    expect(first.ok).toBe(true);
    const again = await ensureOrderNamingSnapshot(
      await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { user: true } }),
      panel,
      null,
    );
    expect(again.ok).toBe(true);
    if (first.ok && again.ok) {
      // The random part was consumed ONCE and lives in the snapshot forever.
      expect(again.identity.resolvedRemoteUsername).toBe(first.identity.resolvedRemoteUsername);
      expect(again.identity.sources.random).toBe(first.identity.sources.random);
      expect(again.identity.version).toBe(NAMING_STRATEGY_VERSION);
    }
  });

  it("11. different orders never collide: sequences advance, CUSTOM gets order suffixes", async () => {
    const user = await createUser("collide_user");
    await setStrategy("TELEGRAM_ID_SEQUENCE");
    const firstOrder = await createPaidOrder(user);
    const secondOrder = await createPaidOrder(user);
    const first = await resolveFor(user, firstOrder);
    const second = await resolveFor(user, secondOrder);
    expect(first.username).not.toBe(second.username);

    await setStrategy("CUSTOM", { customText: "fixedtext" });
    const thirdOrder = await createPaidOrder(user);
    const fourthOrder = await createPaidOrder(user);
    const third = await resolveFor(user, thirdOrder);
    const fourth = await resolveFor(user, fourthOrder);
    expect(third.username).not.toBe(fourth.username); // order short id differs
  });
});

// =============================================================================
// CONFIGURATION (real DB)
// =============================================================================

describe.runIf(hasDeps)("CONFIGURATION: selection is persisted and paid orders are immune (12-15)", () => {
  it("12. changing the saved strategy changes the preview output", async () => {
    await setStrategy("TELEGRAM_ID_SEQUENCE");
    const sequencePreview = previewNamingStrategy(panel, panel.usernamePatternType).preview;
    await setStrategy("CUSTOM", { customText: "previewshop" });
    const customPreview = previewNamingStrategy(panel, panel.usernamePatternType).preview;
    expect(sequencePreview).not.toBe(customPreview);
    expect(customPreview).toContain("previewshop");
  });

  it("13. the selected strategy is persisted on the panel row", async () => {
    await setStrategy("CUSTOM_TEXT_SEQUENCE", { customText: "persisted" });
    const fresh = await prisma.panel.findUniqueOrThrow({ where: { id: panel.id } });
    expect(fresh.usernamePatternType).toBe("CUSTOM_TEXT_SEQUENCE");
    expect(fresh.usernameCustomText).toBe("persisted");
  });

  it("14. precedence is PANEL-scoped (checkout capture beats later panel edits)", async () => {
    // The audited admin UX stores naming ONLY on the Panel (no product
    // override exists by design). The checkout CAPTURE of that panel config
    // is what a paid order resolves from - a later panel edit loses.
    const user = await createUser("precedence_u");
    await setStrategy("CUSTOM", { customText: "capturedtext" });
    const captured = namingConfigFromPanel(panel);
    const orderId = await createPaidOrder(user);
    await setStrategy("TELEGRAM_ID_SEQUENCE"); // admin changes AFTER checkout
    const order = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { user: true },
    });
    const ensured = await ensureOrderNamingSnapshot(order, panel, captured);
    expect(ensured.ok).toBe(true);
    if (ensured.ok) {
      expect(ensured.identity.strategy).toBe("CUSTOM");
      expect(ensured.identity.resolvedRemoteUsername).toContain("capturedtext");
    }
  });

  it("15. config/user/product changes NEVER alter an existing paid snapshot", async () => {
    const user = await createUser("mutable_user");
    await setStrategy("TELEGRAM_USERNAME_SEQUENCE");
    const orderId = await createPaidOrder(user);
    const order = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { user: true },
    });
    const first = await ensureOrderNamingSnapshot(order, panel, null);
    expect(first.ok).toBe(true);

    // Every mutable source changes...
    await prisma.user.update({ where: { id: user.id }, data: { username: "renamed_user" } });
    await prisma.product.update({ where: { id: productId }, data: { name: "renamed product" } });
    await setStrategy("CUSTOM_RANDOM", { randomLength: 9 });

    // ...and the paid order's identity does not.
    const reloaded = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { user: true },
    });
    const second = await ensureOrderNamingSnapshot(reloaded, panel, null);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.identity.resolvedRemoteUsername).toBe(first.identity.resolvedRemoteUsername);
      expect(second.identity.strategy).toBe("TELEGRAM_USERNAME_SEQUENCE");
    }
    await prisma.product.update({
      where: { id: productId },
      data: { name: `naming-prod-${runTag}` },
    });
  });

  it("15b. validation gates: strategies with missing required config are incomplete", () => {
    const incomplete = validateNamingConfig({
      strategy: "CUSTOM",
      customText: null,
      randomLength: null,
      representativePrefix: null,
    });
    expect(incomplete.ok).toBe(false);
    expect(incomplete.missingFa).toContain("متن دلخواه username");
    expect(NAMING_INCOMPLETE_TEXT).toBe("اطلاعات لازم برای این روش نام‌گذاری کامل نیست.");
    expect(NAMING_SAVED_TEXT).toBe("روش نام‌گذاری با موفقیت ذخیره شد ✅");
  });
});

// =============================================================================
// PROVISIONING (real DB + Redis lock + mock Marzban)
// =============================================================================

describe.runIf(hasDeps)("PROVISIONING: the snapshot reaches the panel exactly (16-22)", () => {
  it("16. the mock panel receives EXACTLY the snapshotted username; retries reuse it", async () => {
    const user = await createUser("prov_user_a");
    const provText = `prov${runTag % 100000n}`;
    await setStrategy("CUSTOM_TEXT_SEQUENCE", { customText: provText });
    const orderId = await createPaidOrder(user);

    const outcome = await provisionPaidOrder(orderId);
    expect(outcome.ok).toBe(true);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    const snapshot = parseNamingSnapshot(order.namingSnapshot);
    expect(snapshot).not.toBeNull();
    const username = snapshot?.resolvedRemoteUsername ?? "";
    expect(username).toMatch(new RegExp(`^${provText}_\\d+$`)); // the strategy's shape
    expect(mzUsers.has(username)).toBe(true); // the panel got THAT name

    // Retry: same identity, no second remote account.
    const createsBefore = mzCreateCount;
    const retry = await provisionPaidOrder(orderId);
    expect(retry.ok).toBe(true);
    expect(mzCreateCount).toBe(createsBefore);

    // The Service row persisted the applied identity + strategy snapshot.
    const service = await prisma.service.findFirstOrThrow({ where: { orderId } });
    expect(service.username).toBe(username);
    const serviceSnapshot = service.namingStrategySnapshot as {
      strategy?: string;
      version?: number;
    } | null;
    expect(serviceSnapshot?.strategy).toBe("CUSTOM_TEXT_SEQUENCE");
    expect(serviceSnapshot?.version).toBe(NAMING_STRATEGY_VERSION);
  });

  it("17. concurrent provisioning creates exactly ONE remote account and ONE service", async () => {
    const user = await createUser("prov_user_b");
    await setStrategy("TELEGRAM_ID_RANDOM", { randomLength: 5 });
    const orderId = await createPaidOrder(user);

    const [first, second] = await Promise.all([
      provisionPaidOrder(orderId),
      provisionPaidOrder(orderId),
    ]);
    // One side wins; the other is refused by the lock/claim (still no error
    // that moves money) - and afterwards exactly one of everything exists.
    expect(first.ok || second.ok).toBe(true);
    const services = await prisma.service.findMany({ where: { orderId } });
    expect(services).toHaveLength(1);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    const username = parseNamingSnapshot(order.namingSnapshot)?.resolvedRemoteUsername ?? "";
    expect([...mzUsers.keys()].filter((name) => name === username)).toHaveLength(1);
  });

  it("18. a local name owned by ANOTHER user is never adopted - the resolver adds the order suffix", async () => {
    const owner = await createUser("owner_user");
    const buyer = await createUser("buyer_user");
    await setStrategy("CUSTOM", { customText: `shared${runTag % 100000n}` });
    const buyerOrderId = await createPaidOrder(buyer);
    const orderShort = buyerOrderId.replace(/-/g, "").slice(0, 8).toLowerCase();

    // Another user already owns the EXACT name this order would produce.
    const ownerOrderId = await createPaidOrder(owner);
    await prisma.service.create({
      data: {
        userId: owner.id,
        orderId: ownerOrderId,
        panelId: panel.id,
        panelType: "MARZBAN",
        username: `shared${runTag % 100000n}_${orderShort}`,
        status: "ACTIVE",
        volumeBytes: 1n * GIB,
        usedBytes: 0n,
        remainingBytes: 1n * GIB,
        startsAt: new Date(),
      },
    });

    const buyerUser = await prisma.user.findUniqueOrThrow({ where: { id: buyer.id } });
    const resolved = await resolveVpnRemoteIdentity(
      { id: buyerOrderId },
      buyerUser,
      panel.id,
      namingConfigFromPanel(panel),
    );
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      // Deterministic suffix, never the other user's name, never adoption.
      expect(resolved.identity.resolvedRemoteUsername).not.toBe(`shared${runTag % 100000n}_${orderShort}`);
      expect(resolved.identity.resolvedRemoteUsername).toContain(orderShort);
    }
  });

  it("19. after a DB loss the stored identity is reused - the panel account is recovered, not recreated", async () => {
    const user = await createUser("prov_user_c");
    await setStrategy("CUSTOM_TEXT_SEQUENCE", { customText: `recov${runTag % 100000n}` });
    const orderId = await createPaidOrder(user);

    const outcome = await provisionPaidOrder(orderId);
    expect(outcome.ok).toBe(true);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    const username = parseNamingSnapshot(order.namingSnapshot)?.resolvedRemoteUsername ?? "";

    // Simulate "panel success + local Service lost": delete the row and
    // re-run. The stored snapshot names the identity; the adapter recovers
    // the EXISTING remote account (ownership marker note) - no rename, no
    // duplicate remote account.
    await prisma.service.deleteMany({ where: { orderId } });
    await prisma.order.update({ where: { id: orderId }, data: { status: OrderStatus.PAID } });
    const createsBefore = mzCreateCount;
    const retry = await provisionPaidOrder(orderId);
    expect(retry.ok).toBe(true);
    const service = await prisma.service.findFirstOrThrow({ where: { orderId } });
    expect(service.username).toBe(username);
    expect([...mzUsers.keys()].filter((name) => name === username)).toHaveLength(1);
    // The one extra POST hit the 409 path (recovery), never a second account.
    expect(mzCreateCount - createsBefore).toBeLessThanOrEqual(1);
  });
});

// =============================================================================
// LEGACY RECORDS (real DB)
// =============================================================================

describe.runIf(hasDeps)("LEGACY: existing services and orders keep their identity (20-22)", () => {
  it("20. a legacy service (null naming snapshot) keeps its username through idempotent retries", async () => {
    const user = await createUser("legacy_user");
    const orderId = await createPaidOrder(user);
    const legacyUsername = `zed_${user.telegramId.toString()}_${orderId.replace(/-/g, "").slice(0, 8)}`;
    await prisma.service.create({
      data: {
        userId: user.id,
        orderId,
        panelId: panel.id,
        panelType: "MARZBAN",
        username: legacyUsername,
        status: "ACTIVE",
        volumeBytes: 1n * GIB,
        usedBytes: 0n,
        remainingBytes: 1n * GIB,
        startsAt: new Date(),
        // namingStrategySnapshot stays NULL = LEGACY
      },
    });

    const retry = await provisionPaidOrder(orderId); // idempotency path
    expect(retry.ok).toBe(true);
    const service = await prisma.service.findFirstOrThrow({ where: { orderId } });
    expect(service.username).toBe(legacyUsername); // never renamed
    expect(service.namingStrategySnapshot).toBeNull();
  });

  it("21. the migration adds nullable columns only - it renames and rewrites NOTHING", () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
    const migrationsDir = path.join(repoRoot, "packages/database/prisma/migrations");
    const namingMigration = readdirSync(migrationsDir).find((dir) =>
      dir.includes("naming_snapshots_and_policies"),
    );
    expect(namingMigration).toBeDefined();
    const sql = readFileSync(path.join(migrationsDir, namingMigration ?? "", "migration.sql"), "utf8");
    expect(sql).not.toMatch(/UPDATE\s/i);
    expect(sql).not.toMatch(/DELETE\s/i);
    expect(sql).toContain('ADD COLUMN     "namingSnapshot" JSONB');
    expect(sql).toContain('ADD COLUMN     "deliveryReference" TEXT');
  });

  it("22. lifecycle services use the STORED username - none imports the naming resolver", () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
    for (const file of [
      "apps/bot/src/services/service-toggle.service.ts",
      "apps/bot/src/services/service-link.service.ts",
      "apps/bot/src/services/service-renewal.service.ts",
      "apps/bot/src/services/service-sync.service.ts",
    ]) {
      const src = readFileSync(path.join(repoRoot, file), "utf8");
      expect(src, file).not.toContain("service-naming.service");
      expect(src, file).toContain("username");
    }
  });
});

// =============================================================================
// NAVIGATION + SECURITY (pure/source)
// =============================================================================

describe("NAVIGATION: naming settings page, selector, preview (23-25)", () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const handlerSrc = readFileSync(
    path.join(repoRoot, "apps/bot/src/handlers/panels/panel.handler.ts"),
    "utf8",
  );
  const viewsSrc = readFileSync(
    path.join(repoRoot, "apps/bot/src/handlers/panels/panel-views.ts"),
    "utf8",
  );

  it("23. the naming page renders the required Persian chrome and both actions", () => {
    expect(viewsSrc).toContain("روش نام‌گذاری سرویس");
    expect(viewsSrc).toContain("روش فعلی:");
    expect(viewsSrc).toContain("نمونه نام ساخته‌شده:");
    expect(viewsSrc).toContain("پیش‌نمایش نام‌گذاری");
    // Selector buttons use the Persian labels + stable index callbacks.
    expect(viewsSrc).toContain("USERNAME_STRATEGY_INFO[pattern].fa");
  });

  it("24. selector, save and preview callbacks all have registered handlers; back works", () => {
    expect(handlerSrc).toMatch(/callbackQuery\(\/\^admin:panel:us:/);
    expect(handlerSrc).toMatch(/callbackQuery\(\/\^admin:panel:up:/);
    expect(handlerSrc).toMatch(/callbackQuery\(\/\^admin:panel:unp:/);
    // The selector keyboard's back returns to the naming settings page.
    expect(viewsSrc).toContain('kb.text("بازگشت", cb.usernameSettings(sid))');
  });

  it("25. every naming callback stays under Telegram's 64-byte limit", () => {
    const sid = "a1b2c3d4";
    for (const data of [
      cb.usernameSettings(sid),
      cb.usernamePreview(sid),
      ...USERNAME_PATTERNS.map((_, index) => cb.usernamePattern(sid, index)),
    ]) {
      expect(Buffer.byteLength(data, "utf8"), data).toBeLessThanOrEqual(64);
    }
  });
});

describe.runIf(hasDeps)("SECURITY: secrets can never enter names or naming logs (26)", () => {
  it("26. resolved identities and naming snapshots contain no panel/app secret", async () => {
    const user = await createUser("security_user");
    await setStrategy("TELEGRAM_USERNAME_SEQUENCE");
    const orderId = await createPaidOrder(user);
    const order = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { user: true },
    });
    const ensured = await ensureOrderNamingSnapshot(order, panel, null);
    expect(ensured.ok).toBe(true);
    if (ensured.ok) {
      const serialized = JSON.stringify(ensured.identity);
      expect(serialized).not.toContain(PANEL_SECRET_PASSWORD);
      expect(serialized).not.toContain(process.env.APP_SECRET ?? "app-secret-never");
      expect(serialized).not.toContain(panel.passwordEncrypted);
      // The name itself is provider-charset only - no room for injected data.
      expect(ensured.identity.resolvedRemoteUsername).toMatch(/^[a-z0-9_]{3,32}$/);
    }
  });
});

describe.skipIf(hasDeps)("service naming (skipped)", () => {
  it("naming E2E tests require DATABASE_URL and REDIS_URL - see docs/testing.md", () => {
    expect(hasDeps).toBe(false);
  });
});
