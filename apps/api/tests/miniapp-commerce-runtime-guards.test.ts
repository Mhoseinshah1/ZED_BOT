import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rolloutEnabled = vi.fn<(key: string) => Promise<boolean>>();
const loadCatalog = vi.fn();
const createPurchaseCheckout = vi.fn();
const createOperationCheckout = vi.fn();
const issueQuoteForCheckout = vi.fn();
const openQuote = vi.fn();
const settleWalletOrder = vi.fn();
const checkoutFindFirst = vi.fn();
const userFindUnique = vi.fn();

vi.mock("@zedbot/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@zedbot/database")>();
  return {
    ...actual,
    prisma: {
      checkoutSession: { findFirst: checkoutFindFirst },
      user: { findUnique: userFindUnique },
      setting: { findUnique: vi.fn() },
    },
  };
});

vi.mock("@zedbot/service-renewal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@zedbot/service-renewal")>();
  return {
    ...actual,
    isMiniAppRolloutEnabled: rolloutEnabled,
    loadMiniAppCatalogForUser: loadCatalog,
    createPurchaseCheckout,
    createOperationCheckout,
    issueQuoteForCheckout,
    openQuote,
    settleWalletOrder,
  };
});

vi.mock("../src/miniapp/commerce/idempotency.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/miniapp/commerce/idempotency.js")>();
  return {
    ...actual,
    runIdempotentCommerce: vi.fn(async (_input, execute) => ({
      kind: "executed" as const,
      value: await execute(),
    })),
  };
});

vi.mock("../src/miniapp/commerce/queue.js", () => ({
  enqueueCommerceFollowUp: vi.fn(),
}));

const { registerCommerceRoutes } = await import("../src/miniapp/commerce/routes.js");

function allowingLimiter() {
  return { check: () => ({ allowed: true as const }) } as never;
}

async function appWithAuthenticatedUser() {
  const app = Fastify({ logger: false });
  app.addHook("preHandler", async (request) => {
    request.miniAppUser = {
      id: "runtime-guard-user",
      telegramId: 123n,
      group: "F",
      balanceToman: 500_000,
    } as never;
  });
  registerCommerceRoutes(app, {
    allowedOrigins: new Set(["https://miniapp.test.example"]),
    production: false,
    limiters: { perUser: allowingLimiter(), perClient: allowingLimiter() },
  });
  await app.ready();
  return app;
}

describe("Mini App commerce runtime rollout guards", () => {
  beforeEach(() => {
    rolloutEnabled.mockReset();
    loadCatalog.mockReset();
    createPurchaseCheckout.mockReset();
    createOperationCheckout.mockReset();
    issueQuoteForCheckout.mockReset();
    openQuote.mockReset();
    settleWalletOrder.mockReset();
    checkoutFindFirst.mockReset();
    userFindUnique.mockReset();
  });

  it("rejects a direct catalog API call before domain work when browse is disabled", async () => {
    rolloutEnabled.mockResolvedValue(false);
    const app = await appWithAuthenticatedUser();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/commerce/catalog",
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ ok: false, code: "FEATURE_DISABLED" });
      expect(rolloutEnabled).toHaveBeenCalledWith("miniapp_commerce_browse_enabled");
      expect(loadCatalog).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("fails closed before domain work when the flag read fails", async () => {
    rolloutEnabled.mockRejectedValue(new Error("settings unavailable"));
    const app = await appWithAuthenticatedUser();
    try {
      const response = await app.inject({ method: "GET", url: "/commerce/catalog" });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ ok: false, code: "FEATURE_UNAVAILABLE" });
      expect(loadCatalog).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("rejects direct quote and final-checkout requests while checkout is disabled", async () => {
    rolloutEnabled.mockResolvedValue(false);
    const app = await appWithAuthenticatedUser();
    try {
      const headers = {
        origin: "https://miniapp.test.example",
        "content-type": "application/json",
      };
      const quote = await app.inject({
        method: "POST",
        url: "/commerce/quote",
        headers,
        payload: {
          kind: "SERVICE",
          productPublicId: "deadbeef",
          usernameMode: "RANDOM",
          clientRequestId: "runtime-quote-disabled-0001",
        },
      });
      const checkout = await app.inject({
        method: "POST",
        url: "/commerce/checkout",
        headers,
        payload: { draftToken: "must-not-be-opened" },
      });

      expect(quote.statusCode).toBe(403);
      expect(quote.json()).toEqual({ ok: false, code: "FEATURE_DISABLED" });
      expect(checkout.statusCode).toBe(403);
      expect(checkout.json()).toEqual({ ok: false, code: "FEATURE_DISABLED" });
      expect(createPurchaseCheckout).not.toHaveBeenCalled();
      expect(openQuote).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("rejects settlement when the purchase flag is disabled after quote creation", async () => {
    const flags = new Map<string, boolean>([
      ["miniapp_commerce_checkout_enabled", true],
      ["miniapp_wallet_purchase_enabled", true],
    ]);
    rolloutEnabled.mockImplementation(async (key) => flags.get(key) === true);
    const checkout = {
      id: "checkout-runtime-1",
      userId: "runtime-guard-user",
      status: "PENDING",
      orderType: "SERVICE_PURCHASE",
      productId: "product-runtime-1",
      serviceId: null,
      productSnapshot: { productId: "product-runtime-1", productName: "Runtime plan" },
      originalPriceToman: 100_000,
      discountAmountToman: 0,
      finalPriceToman: 100_000,
      discountCodeId: null,
    };
    createPurchaseCheckout.mockResolvedValue({ ok: true, checkout, draft: {} });
    checkoutFindFirst.mockResolvedValue(checkout);
    issueQuoteForCheckout.mockResolvedValue({
      ok: true,
      dto: {
        operation: "NEW_PURCHASE",
        optionLabel: "Runtime plan",
        serviceLabel: "runtime-user",
        originalPriceToman: 100_000,
        discountAmountToman: 0,
        finalPriceToman: 100_000,
        discountCode: null,
        affordable: true,
        walletBalanceToman: 500_000,
        expectedBalanceAfterToman: 400_000,
        quoteExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        quote: "runtime-valid-quote",
      },
    });
    openQuote.mockReturnValue({
      ok: true,
      payload: {
        userId: "runtime-guard-user",
        checkoutId: checkout.id,
        operation: "NEW_PURCHASE",
        finalPriceToman: 100_000,
        fingerprint: "runtime-fingerprint",
      },
    });

    const app = await appWithAuthenticatedUser();
    try {
      const headers = {
        origin: "https://miniapp.test.example",
        "content-type": "application/json",
      };
      const quote = await app.inject({
        method: "POST",
        url: "/commerce/quote",
        headers,
        payload: {
          kind: "SERVICE",
          productPublicId: "deadbeef",
          usernameMode: "RANDOM",
          clientRequestId: "runtime-quote-enabled-0001",
        },
      });
      expect(quote.statusCode).toBe(200);
      expect(quote.json().ok).toBe(true);

      flags.set("miniapp_wallet_purchase_enabled", false);
      const payment = await app.inject({
        method: "POST",
        url: "/commerce/pay/wallet",
        headers,
        payload: {
          draftToken: "runtime-valid-quote",
          clientRequestId: "123e4567-e89b-42d3-a456-426614174000",
        },
      });
      expect(payment.statusCode).toBe(403);
      expect(payment.json()).toEqual({ ok: false, code: "FEATURE_DISABLED" });
      expect(settleWalletOrder).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it.each([
    ["RENEWAL", "SERVICE_RENEWAL", "miniapp_wallet_renewal_enabled"],
    ["EXTRA_VOLUME", "EXTRA_VOLUME", "miniapp_wallet_addons_enabled"],
    ["EXTRA_TIME", "EXTRA_TIME", "miniapp_wallet_addons_enabled"],
  ] as const)(
    "rejects %s settlement when its capability is disabled after draft creation",
    async (operation, orderType, capabilityKey) => {
      const flags = new Map<string, boolean>([
        ["miniapp_commerce_checkout_enabled", true],
        [capabilityKey, true],
      ]);
      rolloutEnabled.mockImplementation(async (key) => flags.get(key) === true);
      const checkout = {
        id: `checkout-runtime-${operation.toLowerCase()}`,
        userId: "runtime-guard-user",
        status: "PENDING",
        orderType,
        productId: `product-runtime-${operation.toLowerCase()}`,
        serviceId: "service-runtime-1",
        productSnapshot: {
          productId: `product-runtime-${operation.toLowerCase()}`,
          productName: `Runtime ${operation}`,
        },
        originalPriceToman: 100_000,
        discountAmountToman: 0,
        finalPriceToman: 100_000,
        discountCodeId: null,
      };
      createOperationCheckout.mockResolvedValue({ ok: true, checkout, draft: {} });
      checkoutFindFirst.mockResolvedValue(checkout);
      issueQuoteForCheckout.mockResolvedValue({
        ok: true,
        dto: {
          operation,
          optionLabel: `Runtime ${operation}`,
          serviceLabel: "runtime-user",
          originalPriceToman: 100_000,
          discountAmountToman: 0,
          finalPriceToman: 100_000,
          discountCode: null,
          affordable: true,
          walletBalanceToman: 500_000,
          expectedBalanceAfterToman: 400_000,
          quoteExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          quote: `runtime-${operation.toLowerCase()}-quote`,
        },
      });
      openQuote.mockReturnValue({
        ok: true,
        payload: {
          userId: "runtime-guard-user",
          checkoutId: checkout.id,
          operation,
          finalPriceToman: 100_000,
          fingerprint: `runtime-${operation.toLowerCase()}-fingerprint`,
        },
      });

      const app = await appWithAuthenticatedUser();
      try {
        const headers = {
          origin: "https://miniapp.test.example",
          "content-type": "application/json",
        };
        const quote = await app.inject({
          method: "POST",
          url: "/commerce/services/service1/addon-quote",
          headers,
          payload: {
            kind: operation,
            productPublicId: "deadbeef",
            clientRequestId: `runtime-${operation.toLowerCase()}-quote-0001`,
          },
        });
        expect(quote.statusCode).toBe(200);
        expect(quote.json().ok).toBe(true);
        expect(createOperationCheckout).toHaveBeenCalledOnce();

        flags.set(capabilityKey, false);
        const payment = await app.inject({
          method: "POST",
          url: "/commerce/pay/wallet",
          headers,
          payload: {
            draftToken: `runtime-${operation.toLowerCase()}-quote`,
            clientRequestId: "123e4567-e89b-42d3-a456-426614174000",
          },
        });
        expect(payment.statusCode).toBe(403);
        expect(payment.json()).toEqual({ ok: false, code: "FEATURE_DISABLED" });
        expect(rolloutEnabled).toHaveBeenCalledWith(capabilityKey);
        expect(settleWalletOrder).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    },
  );
});
