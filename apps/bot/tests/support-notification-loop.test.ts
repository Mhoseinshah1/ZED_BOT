import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.APP_SECRET ??= "support-notification-loop-secret";

import {
  resetSupportNotificationLoopForTests,
  startSupportNotificationLoop,
  type SupportSweepRunner,
} from "../src/services/support-notification.service.js";

// =============================================================================
// S8 — the loop's timer contract, under fake timers.
//
// These are about the TIMER, not about delivery — the sweep is injected and
// counted, so no database and no Telegram stand-in are involved. What matters
// here is exactly what a stop() promise means: no tick begins afterwards, a
// duplicate start arms nothing, and shutdown can rely on both.
// =============================================================================

const SWEEP_INTERVAL_MS = 60_000;

function countingSweep() {
  const calls: number[] = [];
  const sweep: SupportSweepRunner = async () => {
    calls.push(Date.now());
    return { recovered: 0, delivered: 0 };
  };
  return { calls, sweep };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api = { sendMessage: async () => ({ message_id: 1 }) } as any;

describe("support notification loop controller", () => {
  beforeEach(() => {
    resetSupportNotificationLoopForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    resetSupportNotificationLoopForTests();
    vi.useRealTimers();
  });

  it("S8-1: one immediate tick, before any time passes", () => {
    const { calls, sweep } = countingSweep();
    const controller = startSupportNotificationLoop(api, sweep);
    expect(calls.length, "the backlog is not left waiting for an interval").toBe(1);
    controller.stop();
  });

  it("S8-2: periodic ticks at the sweep interval", () => {
    const { calls, sweep } = countingSweep();
    const controller = startSupportNotificationLoop(api, sweep);
    vi.advanceTimersByTime(SWEEP_INTERVAL_MS * 3);
    expect(calls.length, "immediate + three periodic").toBe(4);
    controller.stop();
  });

  it("S8-3: a duplicate start does not duplicate timers", () => {
    const { calls, sweep } = countingSweep();
    const other = countingSweep();

    const first = startSupportNotificationLoop(api, sweep);
    const second = startSupportNotificationLoop(api, other.sweep);
    expect(second, "the existing controller comes back").toBe(first);
    expect(other.calls.length, "the second sweep was never armed").toBe(0);

    vi.advanceTimersByTime(SWEEP_INTERVAL_MS * 2);
    expect(calls.length, "one timer's worth of ticks, not two").toBe(3);
    first.stop();
  });

  it("S8-4: after stop, no tick ever begins again", () => {
    const { calls, sweep } = countingSweep();
    const controller = startSupportNotificationLoop(api, sweep);
    vi.advanceTimersByTime(SWEEP_INTERVAL_MS);
    expect(calls.length).toBe(2);

    controller.stop();
    vi.advanceTimersByTime(SWEEP_INTERVAL_MS * 10);
    expect(calls.length, "stopped means stopped").toBe(2);
  });

  it("S8-5: stop is idempotent, and a fresh start after stop is a fresh loop", () => {
    const { sweep } = countingSweep();
    const controller = startSupportNotificationLoop(api, sweep);
    controller.stop();
    expect(() => {
      controller.stop();
      controller.stop();
    }, "double stop is harmless").not.toThrow();

    // A NEW loop after stop is permitted — that is what lets a test reset —
    // and the old controller's stop must not reach into the new loop.
    const next = countingSweep();
    const second = startSupportNotificationLoop(api, next.sweep);
    expect(second).not.toBe(controller);
    controller.stop();
    vi.advanceTimersByTime(SWEEP_INTERVAL_MS);
    expect(next.calls.length, "the old controller cannot stop the new loop").toBe(2);
    second.stop();
  });

  it("S8-6: a tick in flight when stop runs finishes; the next one never starts", async () => {
    let resolveInFlight: (() => void) | null = null;
    let finished = 0;
    const sweep: SupportSweepRunner = () =>
      new Promise((resolve) => {
        resolveInFlight = () => {
          finished += 1;
          resolve({ recovered: 0, delivered: 0 });
        };
      });

    const controller = startSupportNotificationLoop(api, sweep);
    expect(resolveInFlight, "immediate tick is in flight").not.toBeNull();

    controller.stop();
    // The in-flight sweep completes safely after stop...
    resolveInFlight?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(finished).toBe(1);
    // ...and no further tick begins.
    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS * 5);
    expect(finished).toBe(1);
  });

  it("S8-7: a rejecting sweep does not stop future ticks", () => {
    let calls = 0;
    const sweep: SupportSweepRunner = async () => {
      calls += 1;
      throw new Error("500 internal");
    };
    const controller = startSupportNotificationLoop(api, sweep);
    vi.advanceTimersByTime(SWEEP_INTERVAL_MS * 2);
    expect(calls, "failures are swallowed, the schedule survives").toBe(3);
    controller.stop();
  });
});

// =============================================================================
// The shutdown ordering contract, asserted in the file that runs in production.
// Comment-stripped, for the same reason the startup wiring scan is: a test a
// comment can satisfy certifies an outage.
// =============================================================================

describe("shutdown stops the loop before the database disconnects", () => {
  const raw = readFileSync(path.join(import.meta.dirname, "..", "src", "index.ts"), "utf8");
  const entry = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|\s)\/\/.*$/, "$1"))
    .join("\n");

  it("S8-8: shutdown order is loop → bot and consumers → database", () => {
    const shutdownStart = entry.indexOf("const shutdown = async");
    expect(shutdownStart, "shutdown handler present").toBeGreaterThan(-1);
    const at = (needle: string): number => {
      const i = entry.indexOf(needle, shutdownStart);
      expect(i, `${needle} inside shutdown`).toBeGreaterThan(-1);
      return i;
    };
    const stopLoop = at("supportNotificationLoop?.stop()");
    const stopBot = at("await bot.stop()");
    const disconnect = at("await disconnectDatabase()");
    expect(stopLoop, "loop first — no new sweep may race the teardown").toBeLessThan(stopBot);
    expect(stopBot, "bot and consumers before the database").toBeLessThan(disconnect);
  });
});
