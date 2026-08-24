import { describe, expect, it, vi } from "vitest";

import { connectDatabaseWithRetry } from "../src/core/database-startup.js";

// Regression: a single failed database connection attempt at bot startup
// used to be treated as final - the bot proceeded to start polling anyway,
// and completeBotStartupReadiness's hard throw (once polling actually
// began) rejected bot.start(), which index.ts's outer catch treats as
// non-retryable and exits the whole process after a 30s cooldown. Since
// docker-compose already gates the bot container on postgres's own
// healthcheck, a failed first attempt is normally a brief startup race
// (connection-pool warmup, other services connecting at the same moment),
// not a genuinely broken database - it deserves a bounded retry, not an
// immediate full container restart cycle.
describe("connectDatabaseWithRetry", () => {
  it("returns true on the first successful attempt without retrying", async () => {
    const connect = vi.fn().mockResolvedValue(undefined);
    const result = await connectDatabaseWithRetry(5, 0, connect);
    expect(result).toBe(true);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("retries after transient failures and succeeds once the database becomes reachable", async () => {
    const connect = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce(undefined);
    const result = await connectDatabaseWithRetry(5, 0, connect);
    expect(result).toBe(true);
    expect(connect).toHaveBeenCalledTimes(3);
  });

  it("gives up and returns false after exhausting the bounded attempt count", async () => {
    const connect = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await connectDatabaseWithRetry(4, 0, connect);
    expect(result).toBe(false);
    expect(connect).toHaveBeenCalledTimes(4);
  });

  it("does not sleep after the final failed attempt", async () => {
    const connect = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const start = Date.now();
    await connectDatabaseWithRetry(3, 50, connect);
    // 2 inter-attempt delays (between attempts 1-2 and 2-3), none after the
    // 3rd (final) failure - comfortably under 3 delays' worth of time.
    expect(Date.now() - start).toBeLessThan(50 * 2.5);
  });
});
