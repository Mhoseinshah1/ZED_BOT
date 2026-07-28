import { describe, expect, it } from "vitest";

import { supportNotificationErrorCode } from "../src/services/support-notification-errors.js";

// =============================================================================
// The classifier is the ONLY thing standing between a raw Telegram error and
// the log line an operator reads, so its output must depend on what went wrong
// — never on which digits happen to appear inside an echoed chat id. The
// regression here is real: Date.now()-derived chat ids routinely contain "429"
// or "403" as substrings, and a naive includes() check classified
// "chat not found" as rate-limited whenever the id cooperated.
// =============================================================================

describe("supportNotificationErrorCode", () => {
  it("classifies chat-not-found even when the echoed chat id contains 429", () => {
    expect(
      supportNotificationErrorCode(new Error("Bad Request: chat not found: chat_id=1429178524033")),
    ).toBe("chat-missing");
  });

  it("classifies chat-not-found even when the echoed chat id contains 403", () => {
    expect(
      supportNotificationErrorCode(new Error("Bad Request: chat not found: chat_id=8403991245067")),
    ).toBe("chat-missing");
  });

  it("still classifies a real 429 status", () => {
    expect(supportNotificationErrorCode(new Error("429: Too Many Requests: retry after 5"))).toBe(
      "rate-limited",
    );
    expect(supportNotificationErrorCode(new Error("too many requests"))).toBe("rate-limited");
  });

  it("still classifies a real 403 status", () => {
    expect(
      supportNotificationErrorCode(new Error("403: Forbidden: bot was blocked by the user")),
    ).toBe("blocked-by-admin");
    expect(supportNotificationErrorCode(new Error("bot was blocked by the user"))).toBe(
      "blocked-by-admin",
    );
  });

  it("does not treat digits embedded in larger numbers as status codes", () => {
    expect(supportNotificationErrorCode(new Error("send failed for peer 14293_4035"))).toBe(
      "send-failed",
    );
  });

  it("classifies timeouts", () => {
    expect(supportNotificationErrorCode(new Error("connect ETIMEDOUT 10.0.0.1:443"))).toBe(
      "timeout",
    );
  });

  it("falls back to send-failed", () => {
    expect(supportNotificationErrorCode(new Error("something else entirely"))).toBe("send-failed");
  });
});
