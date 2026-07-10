import { describe, expect, it } from "vitest";

import type { BotContext } from "../src/core/context.js";
import { initialSession } from "../src/core/session.js";
import { clearAdminUsersState } from "../src/handlers/admin-users/admin-users.handler.js";

// Pure session-state test (no DB): returning to the admin main menu must
// wipe the Phase 20 admin-users state - the wallet-adjustment flow, the
// pending draft and the stored search query - while leaving unrelated
// session state untouched.

function fakeCtx(currentFlow: string | null): BotContext {
  const session = initialSession();
  session.currentFlow = currentFlow;
  session.temp.adminUserWalletDraft = {
    targetUserId: "user-1",
    action: "DECREASE",
    amountToman: 1000,
    reason: "test",
    draftNonce: "nonce",
  };
  session.temp.adminUserSearchQuery = "someone";
  return { session } as unknown as BotContext;
}

describe("clearAdminUsersState", () => {
  it.each(["admin_users:search", "admin_wallet:amount", "admin_wallet:reason"])(
    "clears flow %s, the wallet draft and the search query",
    (flow) => {
      const ctx = fakeCtx(flow);
      clearAdminUsersState(ctx);
      expect(ctx.session.currentFlow).toBeNull();
      expect(ctx.session.temp.adminUserWalletDraft).toBeUndefined();
      expect(ctx.session.temp.adminUserSearchQuery).toBeUndefined();
    },
  );

  it("leaves an unrelated flow untouched but still clears draft/query", () => {
    const ctx = fakeCtx("payment:receipt");
    clearAdminUsersState(ctx);
    expect(ctx.session.currentFlow).toBe("payment:receipt");
    expect(ctx.session.temp.adminUserWalletDraft).toBeUndefined();
    expect(ctx.session.temp.adminUserSearchQuery).toBeUndefined();
  });
});
