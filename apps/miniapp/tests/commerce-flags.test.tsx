// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AddonsSection, BuyScreen, flagsFromResponse, type BuyView } from "../src/commerce";
import { COMMERCE_UI } from "../src/i18n";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("Mini App commerce capability visibility", () => {
  it("maps every rollout switch independently and defaults all capabilities off", () => {
    expect(flagsFromResponse(undefined)).toMatchObject({
      commerce: false, checkout: false, walletPurchase: false,
      serviceRenewal: false, extraVolume: false, extraTime: false,
    });
    expect(flagsFromResponse({ miniapp_commerce_browse_enabled: true })).toMatchObject({
      commerce: true, checkout: false, walletPurchase: false,
    });
    expect(flagsFromResponse({ miniapp_commerce_checkout_enabled: true })).toMatchObject({
      commerce: false, checkout: true, walletPurchase: false,
    });
    expect(flagsFromResponse({ miniapp_wallet_purchase_enabled: true })).toMatchObject({
      commerce: false, checkout: false, walletPurchase: true,
    });
    expect(flagsFromResponse({ miniapp_wallet_renewal_enabled: true })).toMatchObject({
      serviceRenewal: true, extraVolume: false, extraTime: false,
    });
    expect(flagsFromResponse({ miniapp_wallet_addons_enabled: true })).toMatchObject({
      serviceRenewal: false, extraVolume: true, extraTime: true,
    });
  });

  it("keeps catalog products non-actionable until checkout is enabled", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(new Response(JSON.stringify({
      ok: true,
      servicePanels: [{ publicId: "panel000", name: "Panel", fromPriceToman: 100, productCount: 1, categories: [{ publicId: "cat00000", name: "Category", products: [{ publicId: "prod0000", name: "Plan", description: "", priceToman: 100, volumeGb: 1, durationDays: 1, serviceLocation: null }] }] }],
      otherProductCategories: [],
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    const view: BuyView = { kind: "catalog", mode: "service" };
    await act(async () => {
      root.render(<BuyScreen flags={flagsFromResponse({ miniapp_commerce_browse_enabled: true })} view={view} onView={() => {}} onOrders={() => {}} />);
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    const plan = [...container.querySelectorAll("button")].find(button => button.textContent?.includes("Plan"));
    expect(plan).toBeInstanceOf(HTMLButtonElement);
    expect((plan as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps wallet payment disabled when checkout is enabled but wallet purchase is not", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(new Response(JSON.stringify({
      ok: true,
      quote: {
        kind: "SERVICE", productPublicId: "prod0000", productName: "Plan", panelName: "Panel",
        username: "test-user", note: null, originalPriceToman: 100, discountAmountToman: 0,
        finalPriceToman: 100, discountCode: null, discountStackingRejected: false,
        needsCustomerInputBeforePayment: false, walletPayEnabled: true, affordable: true,
        walletBalanceToman: 1_000, expectedBalanceAfterToman: 900,
        quoteExpiresAt: new Date(Date.now() + 60_000).toISOString(), draftToken: "sealed-quote",
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    const view: BuyView = {
      kind: "purchase",
      panel: { publicId: "panel000", name: "Panel", categories: [] },
      product: { publicId: "prod0000", name: "Plan", priceToman: 100, volumeGb: 1, durationDays: 1, serviceLocation: null },
    };
    await act(async () => {
      root.render(<BuyScreen flags={flagsFromResponse({ miniapp_commerce_browse_enabled: true, miniapp_commerce_checkout_enabled: true })} view={view} onView={() => {}} onOrders={() => {}} />);
    });
    const preInvoice = [...container.querySelectorAll("button")].find(button => button.textContent === COMMERCE_UI.preInvoice);
    expect(preInvoice).toBeInstanceOf(HTMLButtonElement);
    await act(async () => {
      (preInvoice as HTMLButtonElement).click();
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    const walletPay = [...container.querySelectorAll("button")].find(button => button.textContent === COMMERCE_UI.payWithWallet);
    expect(walletPay).toBeInstanceOf(HTMLButtonElement);
    expect((walletPay as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps add-on settlement disabled when its wallet capability is off", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true, walletPayEnabled: true,
        addons: { RENEWAL: { enabled: true, eligible: true, plans: [{ publicId: "plan0000", name: "Renew", priceToman: 100 }] } },
      }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        quote: {
          kind: "RENEWAL", servicePublicId: "svc00000", productPublicId: "plan0000", productName: "Renew",
          username: "test-user", originalPriceToman: 100, discountAmountToman: 0, finalPriceToman: 100,
          discountCode: null, walletPayEnabled: true, affordable: true, walletBalanceToman: 1_000,
          expectedBalanceAfterToman: 900, quoteExpiresAt: new Date(Date.now() + 60_000).toISOString(), draftToken: "sealed-addon-quote",
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } })));
    await act(async () => {
      root.render(<AddonsSection servicePublicId="svc00000" checkoutEnabled renewalEnabled={false} addonsEnabled={false} onPayment={() => {}} />);
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    const renewal = [...container.querySelectorAll("button")].find(button => button.textContent?.includes("Renew"));
    expect(renewal).toBeInstanceOf(HTMLButtonElement);
    await act(async () => {
      (renewal as HTMLButtonElement).click();
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    const walletPay = [...container.querySelectorAll("button")].find(button => button.textContent === COMMERCE_UI.payWithWallet);
    expect(walletPay).toBeInstanceOf(HTMLButtonElement);
    expect((walletPay as HTMLButtonElement).disabled).toBe(true);
  });
});
