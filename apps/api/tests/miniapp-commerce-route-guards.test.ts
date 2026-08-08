import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const routes = readFileSync(path.resolve(here, "../src/miniapp/commerce/routes.ts"), "utf8");

function routeBody(method: "get" | "post", route: string): string {
  const routeAt = routes.indexOf(`"${route}"`);
  expect(routeAt, `${method.toUpperCase()} ${route} must be registered`).toBeGreaterThanOrEqual(0);
  const start = routes.lastIndexOf(`app.${method}`, routeAt);
  expect(start, `${method.toUpperCase()} ${route} must use the expected method`).toBeGreaterThanOrEqual(0);
  const next = routes.indexOf("\n  app.", routeAt);
  return routes.slice(start, next === -1 ? routes.length : next);
}

describe("Mini App commerce route rollout guards", () => {
  it.each([
    ["get", "/commerce/catalog"],
    ["get", "/commerce/products/:productId"],
    ["get", "/commerce/services/:serviceId/delivery"],
    ["get", "/commerce/services/:serviceId/qr"],
    ["get", "/commerce/services/:serviceId/addons"],
  ] as const)("rejects %s %s when browse is disabled", (method, route) => {
    expect(routeBody(method, route)).toContain('requireRollout(reply, ["miniapp_commerce_browse_enabled"])');
  });

  it.each([
    ["post", "/commerce/quote"],
    ["post", "/commerce/checkout"],
  ] as const)("rejects %s %s when checkout is disabled", (method, route) => {
    expect(routeBody(method, route)).toContain('requireRollout(reply, ["miniapp_commerce_checkout_enabled"])');
  });

  it("selects the wallet settlement gate from the quoted operation", () => {
    const body = routeBody("post", "/commerce/pay/wallet");
    expect(body).toContain("OPERATION_SETTLE_ROLLOUT_KEY[operation]");
    expect(body.indexOf("requireRollout")).toBeLessThan(body.indexOf("settleWalletOrder"));
  });

  it("uses only the checkout gate for operation drafts; operation flags are settlement-only", () => {
    const body = routeBody("post", "/commerce/services/:serviceId/addon-quote");
    expect(body).toContain('requireRollout(reply, ["miniapp_commerce_checkout_enabled"])');
    expect(body).not.toContain("OPERATION_SETTLE_ROLLOUT_KEY[operation]");
    expect(body.indexOf("requireRollout")).toBeLessThan(body.indexOf("createOperationCheckout"));
  });

  it("keeps settled-record reads owner-scoped without inventing a catalog gate", () => {
    expect(routeBody("get", "/commerce/checkouts/:checkoutId")).toContain("publicCheckoutWhere(owner.id");
    expect(routeBody("get", "/commerce/payments/:paymentId")).toContain("userId: owner.id");
    expect(routeBody("get", "/commerce/orders/:orderId")).toContain("userId: owner.id");
  });
});
