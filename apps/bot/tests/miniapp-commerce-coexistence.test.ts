import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function source(relative: string): string {
  return readFileSync(path.join(root, relative), "utf8");
}

describe("Telegram bot and Mini App commerce coexistence", () => {
  const botCommerce = [
    "apps/bot/src/handlers/user-checkout/checkout.handler.ts",
    "apps/bot/src/handlers/user-renewal/renewal.handler.ts",
    "apps/bot/src/handlers/user-extra-volume/extra-volume.handler.ts",
    "apps/bot/src/handlers/user-extra-time/extra-time.handler.ts",
  ];

  it("keeps every Telegram commerce handler independent of Mini App rollout settings", () => {
    for (const file of botCommerce) {
      const body = source(file);
      expect(body, file).not.toMatch(/miniapp_(?:commerce|wallet)_/i);
      expect(body, file).not.toContain("web_app");
    }
  });

  it("retains the native Telegram purchase and renewal callback flows", () => {
    expect(source(botCommerce[0])).toContain("user:buy:panel:");
    expect(source(botCommerce[0])).toContain("user:buy:prod:");
    const renewalFlow = source(botCommerce[1]) + source("apps/bot/src/handlers/user-renewal/renewal-views.ts");
    expect(renewalFlow).toContain("user:renew:svc:");
    expect(renewalFlow).toContain("user:renew:plan:");
    expect(renewalFlow).toContain("user:renew:wallet:yes");
  });

  it("isolates the Telegram web_app button to the dedicated Mini App entry", () => {
    expect(source("apps/bot/src/handlers/miniapp.handler.ts")).toContain("webApp");
  });

  it("uses the same wallet settlement authority and financial record shapes from both interfaces", () => {
    const botWallet = source("apps/bot/src/services/wallet-payment.service.ts");
    const miniAppRoutes = source("apps/api/src/miniapp/commerce/routes.ts");
    for (const body of [botWallet, miniAppRoutes]) {
      expect(body).toContain('from "@zedbot/service-renewal"');
      expect(body).toContain("settleWalletOrder");
    }
  });
});
