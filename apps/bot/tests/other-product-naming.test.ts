import {
  OrderStatus,
  OrderType,
  OtherProductNamingPolicy,
  prisma,
  type Product,
  type User,
} from "@zedbot/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "other-naming-tests-secret-0001";

import {
  DELIVERY_REFERENCE_LABEL,
  ensureOrderDeliveryReference,
  normalizeDeliveryReference,
  OTHER_NAMING_POLICIES,
  OTHER_POLICY_INFO,
  OTHER_TEMPLATE_ALLOWED_VARS,
  resolveOtherProductDeliveryIdentity,
  validateOtherNamingTemplate,
} from "../src/services/other-product-naming.service.js";
import { searchManualOrders } from "../src/services/other-product-delivery.service.js";

// =============================================================================
// Other-product naming tests (naming phase): deterministic, safe delivery
// references for OTHER_PRODUCT orders.
//
//   POLICIES  - all five registered with Persian labels; documented shapes;
//               uniqueness by order-short construction
//   TEMPLATE  - strict variable registry; unknown variables rejected; secrets
//               unrepresentable
//   PERSISTENCE - exactly-once CAS; retries never regenerate; no Service row
//   SEARCH    - admin search finds an order by its reference
//   SECURITY  - stock/manual secrets never reach a reference
//
// DB suites need DATABASE_URL (docs/testing.md).
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
let seq = 0;

const STOCK_SECRET_MARKER = "stock-secret-account-passw0rd";
const MANUAL_SECRET_MARKER = "manual-delivery-secret-text";

let product: Product;
let categoryId = "";

beforeAll(async () => {
  if (!hasDb) {
    return;
  }
  const category = await prisma.productCategory.create({
    data: { type: "OTHER_PRODUCT", name: `onaming-cat-${runTag}`, isActive: true },
  });
  categoryId = category.id;
  product = await prisma.product.create({
    data: {
      type: "OTHER_PRODUCT",
      categoryId,
      name: `Gift Card ${runTag}`,
      priceToman: 50_000,
      isActive: true,
      deliveryType: "MANUAL_ADMIN",
    },
  });
});

afterAll(async () => {
  if (hasDb) {
    await prisma.$disconnect();
  }
});

async function createUser(username: string | null = null): Promise<User> {
  seq += 1;
  return prisma.user.create({
    data: { telegramId: runTag + BigInt(seq), ...(username !== null ? { username } : {}) },
  });
}

async function createOtherOrder(user: User): Promise<string> {
  const order = await prisma.order.create({
    data: {
      userId: user.id,
      type: OrderType.OTHER_PRODUCT,
      status: OrderStatus.PAID,
      productId: product.id,
      originalPriceToman: 50_000,
      finalPriceToman: 50_000,
      productNameSnapshot: product.name,
      paidAt: new Date(),
    },
  });
  return order.id;
}

function contextFor(
  user: User,
  orderId: string,
  policy: OtherProductNamingPolicy | null,
  template: string | null = null,
) {
  return {
    orderId,
    orderCreatedAt: new Date("2026-07-14T12:00:00Z"),
    user,
    productName: product?.name ?? "Gift Card X",
    policy,
    template,
  };
}

// =============================================================================
// POLICIES (pure + DB fixtures for user rows)
// =============================================================================

describe("POLICIES: registry and labels (1-2)", () => {
  it("1. all five policies are registered with distinct Persian labels", () => {
    expect(OTHER_NAMING_POLICIES).toHaveLength(5);
    const labels = OTHER_NAMING_POLICIES.map((policy) => OTHER_POLICY_INFO[policy].fa);
    expect(new Set(labels).size).toBe(5);
    expect(OTHER_POLICY_INFO.ORDER_SHORT_ID.fa).toBe("شناسه کوتاه سفارش");
    expect(OTHER_POLICY_INFO.TELEGRAM_ID.fa).toBe("آیدی عددی تلگرام");
    expect(OTHER_POLICY_INFO.TELEGRAM_USERNAME_WITH_FALLBACK.fa).toBe(
      "نام کاربری تلگرام با جایگزین",
    );
    expect(OTHER_POLICY_INFO.PRODUCT_CODE_AND_ORDER.fa).toBe("کد محصول و شناسه سفارش");
    expect(OTHER_POLICY_INFO.CUSTOM_TEMPLATE.fa).toBe("قالب سفارشی");
    expect(DELIVERY_REFERENCE_LABEL).toBe("شناسه تحویل:");
  });

  it("2. normalization: provider-safe charset, 40-char cap, order tail preserved, never empty", () => {
    expect(normalizeDeliveryReference("My REF!! نام", "a1b2c3d4")).toMatch(/^[a-z0-9-]+$/);
    expect(normalizeDeliveryReference("", "a1b2c3d4")).toBe("ord-a1b2c3d4");
    const long = normalizeDeliveryReference("x".repeat(90), "a1b2c3d4");
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long.endsWith("a1b2c3d4")).toBe(true);
  });
});

describe.runIf(hasDb)("POLICIES: documented per-policy shapes (3-5)", () => {
  it("3. each policy produces its documented shape (order short id always embedded)", async () => {
    const user = await createUser("Other_Buyer");
    const orderId = await createOtherOrder(user);
    const short = orderId.replace(/-/g, "").slice(0, 8).toLowerCase();
    const tg = user.telegramId.toString();

    expect(resolveOtherProductDeliveryIdentity(contextFor(user, orderId, null))).toBe(
      `ord-${short}`,
    );
    expect(
      resolveOtherProductDeliveryIdentity(contextFor(user, orderId, "TELEGRAM_ID")),
    ).toBe(`tg${tg}-${short}`);
    expect(
      resolveOtherProductDeliveryIdentity(
        contextFor(user, orderId, "TELEGRAM_USERNAME_WITH_FALLBACK"),
      ),
    ).toBe(`other-buyer-${short}`);
    expect(
      resolveOtherProductDeliveryIdentity(contextFor(user, orderId, "PRODUCT_CODE_AND_ORDER")),
    ).toMatch(new RegExp(`^gift-card-\\d*-${short}$`));
    expect(
      resolveOtherProductDeliveryIdentity(
        contextFor(user, orderId, "CUSTOM_TEMPLATE", "lic-{telegram_id}-{date}"),
      ),
    ).toBe(`lic-${tg}-20260714-${short}`);
  });

  it("4. a user without a Telegram username gets the deterministic fallback", async () => {
    const user = await createUser(null);
    const orderId = await createOtherOrder(user);
    const reference = resolveOtherProductDeliveryIdentity(
      contextFor(user, orderId, "TELEGRAM_USERNAME_WITH_FALLBACK"),
    );
    expect(reference).toContain(`u${user.telegramId.toString()}`);
    for (const forbidden of ["undefined", "null", "@"]) {
      expect(reference).not.toContain(forbidden);
    }
  });

  it("5. two different orders never share a reference under any policy", async () => {
    const user = await createUser("dup_buyer");
    const firstOrder = await createOtherOrder(user);
    const secondOrder = await createOtherOrder(user);
    for (const policy of OTHER_NAMING_POLICIES) {
      const template = policy === "CUSTOM_TEMPLATE" ? "fixed-{product_name}" : null;
      const first = resolveOtherProductDeliveryIdentity(
        contextFor(user, firstOrder, policy, template),
      );
      const second = resolveOtherProductDeliveryIdentity(
        contextFor(user, secondOrder, policy, template),
      );
      expect(first, policy).not.toBe(second);
    }
  });
});

// =============================================================================
// TEMPLATE SAFETY
// =============================================================================

describe("TEMPLATE: strict variable registry (6-7)", () => {
  it("6. unknown variables are rejected; the registry is exactly the safe six", () => {
    expect([...OTHER_TEMPLATE_ALLOWED_VARS]).toEqual([
      "order_short_id",
      "telegram_id",
      "telegram_username",
      "user_short_id",
      "product_name",
      "date",
    ]);
    expect(validateOtherNamingTemplate("ok-{order_short_id}-{date}").ok).toBe(true);
    for (const bad of [
      "x-{stock_content}",
      "x-{password}",
      "x-{panel_token}",
      "x-{payment_secret}",
      "x-{DATABASE_URL}",
      "x-{delivery_text}",
      "x-{phone_number}",
      "x-{unknown}",
    ]) {
      const result = validateOtherNamingTemplate(bad);
      expect(result.ok, bad).toBe(false);
      expect(result.unknownVars.length, bad).toBeGreaterThan(0);
    }
    expect(validateOtherNamingTemplate("   ").ok).toBe(false);
  });

  it("7. an invalid STORED template falls back to the default shape instead of blocking delivery", () => {
    const fakeUser = { id: "u-1", telegramId: 42n, username: "x" } as User;
    const reference = resolveOtherProductDeliveryIdentity({
      orderId: "12345678-0000-0000-0000-000000000000",
      orderCreatedAt: new Date(),
      user: fakeUser,
      productName: "p",
      policy: "CUSTOM_TEMPLATE",
      template: "broken-{password}",
    });
    expect(reference).toBe("ord-12345678");
    expect(reference).not.toContain("password");
  });
});

// =============================================================================
// PERSISTENCE + SEARCH + SECURITY (real DB)
// =============================================================================

describe.runIf(hasDb)("PERSISTENCE: exactly-once reference, no Service rows (8-10)", () => {
  it("8. ensureOrderDeliveryReference persists once; retries return the SAME value", async () => {
    const user = await createUser("persist_buyer");
    const orderId = await createOtherOrder(user);
    await prisma.product.update({
      where: { id: product.id },
      data: { otherNamingPolicy: "TELEGRAM_ID" },
    });
    try {
      const first = await ensureOrderDeliveryReference(orderId);
      expect(first).not.toBeNull();
      // The policy changes afterwards - the stored reference does not.
      await prisma.product.update({
        where: { id: product.id },
        data: { otherNamingPolicy: "PRODUCT_CODE_AND_ORDER" },
      });
      const second = await ensureOrderDeliveryReference(orderId);
      expect(second).toBe(first);
      const row = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(row.deliveryReference).toBe(first);
    } finally {
      await prisma.product.update({
        where: { id: product.id },
        data: { otherNamingPolicy: null },
      });
    }
  });

  it("9. concurrent resolution converges on ONE reference", async () => {
    const user = await createUser("race_buyer");
    const orderId = await createOtherOrder(user);
    const [a, b] = await Promise.all([
      ensureOrderDeliveryReference(orderId),
      ensureOrderDeliveryReference(orderId),
    ]);
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });

  it("10. naming never creates VPN Service rows and ignores non-OTHER_PRODUCT orders", async () => {
    const user = await createUser("no_service_buyer");
    const orderId = await createOtherOrder(user);
    const servicesBefore = await prisma.service.count();
    await ensureOrderDeliveryReference(orderId);
    expect(await prisma.service.count()).toBe(servicesBefore);
    expect(await prisma.service.count({ where: { orderId } })).toBe(0);

    // A SERVICE_PURCHASE order is out of scope for delivery references.
    const vpnOrder = await prisma.order.create({
      data: {
        userId: user.id,
        type: OrderType.SERVICE_PURCHASE,
        status: OrderStatus.PAID,
        originalPriceToman: 1,
        finalPriceToman: 1,
      },
    });
    expect(await ensureOrderDeliveryReference(vpnOrder.id)).toBeNull();
  });
});

describe.runIf(hasDb)("SEARCH + SECURITY (11-12)", () => {
  it("11. admin search finds the manual order by its delivery reference", async () => {
    const user = await createUser("search_buyer");
    const orderId = await createOtherOrder(user);
    const reference = await ensureOrderDeliveryReference(orderId);
    expect(reference).not.toBeNull();
    await prisma.otherProductOrder.create({
      data: { orderId, userId: user.id, productId: product.id, status: "WAITING_ADMIN_DELIVERY" },
    });
    const results = await searchManualOrders(reference ?? "");
    expect(results.some((row) => row.orderId === orderId)).toBe(true);
  });

  it("12. stock/manual secrets can never reach a reference", async () => {
    const user = await createUser("secure_buyer");
    const orderId = await createOtherOrder(user);
    // Even a hostile template cannot reference secret material - the
    // registry has no such variable, and the fallback kicks in.
    const reference = resolveOtherProductDeliveryIdentity(
      contextFor(user, orderId, "CUSTOM_TEMPLATE", `{stock_content}-${STOCK_SECRET_MARKER}`),
    );
    expect(reference).not.toContain(STOCK_SECRET_MARKER);
    expect(reference).not.toContain(MANUAL_SECRET_MARKER);
    // And every produced reference is charset-bound - no free text survives.
    expect(reference).toMatch(/^[a-z0-9-]{3,40}$/);
  });
});

describe.skipIf(hasDb)("other-product naming (skipped)", () => {
  it("DB-backed naming tests require DATABASE_URL - see docs/testing.md", () => {
    expect(hasDb).toBe(false);
  });
});
