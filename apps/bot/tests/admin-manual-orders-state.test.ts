import { describe, expect, it } from "vitest";

import type { BotContext } from "../src/core/context.js";
import { initialSession } from "../src/core/session.js";
import { clearManualOrderState } from "../src/handlers/admin-manual-orders/manual-orders.handler.js";

// Pure session-state test (no DB): returning to the admin main menu must
// wipe the Phase 23 manual-delivery state - the deliver-text flow and the
// pending draft - while leaving unrelated session state untouched.

function fakeCtx(currentFlow: string | null): BotContext {
  const session = initialSession();
  session.currentFlow = currentFlow;
  session.temp.adminDeliveryDraft = { recordId: "record-1", deliveryText: "کد تحویل" };
  return { session } as unknown as BotContext;
}

describe("clearManualOrderState", () => {
  it("clears the deliver-text flow and the delivery draft", () => {
    const ctx = fakeCtx("admin_manual:deliver_text");
    clearManualOrderState(ctx);
    expect(ctx.session.currentFlow).toBeNull();
    expect(ctx.session.temp.adminDeliveryDraft).toBeUndefined();
  });

  it("leaves an unrelated flow untouched but still clears the draft", () => {
    const ctx = fakeCtx("payment:receipt");
    clearManualOrderState(ctx);
    expect(ctx.session.currentFlow).toBe("payment:receipt");
    expect(ctx.session.temp.adminDeliveryDraft).toBeUndefined();
  });
});
