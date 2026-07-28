import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.APP_SECRET ??= "support-notification-loop-secret";

import { runShutdownSequence, SHUTDOWN_STEPS } from "../src/core/shutdown.js";
import {
  resetSupportNotificationLoopForTests,
  startSupportNotificationLoop,
  type SupportSweepRunner,
} from "../src/services/support-notification.service.js";

// =============================================================================
// S8 — the loop's timer contract, and the drain that shutdown depends on.
//
// These are about the TIMER and the LIFECYCLE, not about delivery — the sweep
// is injected and counted, so no database and no Telegram stand-in are
// involved. What matters here is exactly what stop() and drain() mean: no tick
// begins after stop, a duplicate start arms nothing, two sweeps never overlap,
// and drain does not resolve while a sweep is still running.
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

/** A sweep the test resolves by hand, so "still running" is a real state. */
function heldSweep() {
  const events: string[] = [];
  let release: (() => void) | null = null;
  let started = 0;
  const sweep: SupportSweepRunner = () =>
    new Promise((resolve) => {
      started += 1;
      events.push("sweep-started");
      release = () => {
        events.push("sweep-resolved");
        resolve({ recovered: 0, delivered: 0 });
      };
    });
  return {
    sweep,
    events,
    get started(): number {
      return started;
    },
    release(): void {
      if (release === null) throw new Error("no sweep in flight");
      release();
      release = null;
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api = { sendMessage: async () => ({ message_id: 1 }) } as any;

describe("support notification loop controller", () => {
  beforeEach(async () => {
    await resetSupportNotificationLoopForTests();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await resetSupportNotificationLoopForTests();
  });

  it("S8-1: one immediate tick, before any time passes", async () => {
    const { calls, sweep } = countingSweep();
    const controller = startSupportNotificationLoop(api, sweep);
    expect(calls.length, "the backlog is not left waiting for an interval").toBe(1);
    await controller.stopAndDrain();
  });

  it("S8-2: periodic ticks at the sweep interval", async () => {
    const { calls, sweep } = countingSweep();
    const controller = startSupportNotificationLoop(api, sweep);
    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS * 3);
    expect(calls.length, "immediate + three periodic").toBe(4);
    await controller.stopAndDrain();
  });

  it("S8-3: a duplicate start does not duplicate timers", async () => {
    const { calls, sweep } = countingSweep();
    const other = countingSweep();

    const first = startSupportNotificationLoop(api, sweep);
    const second = startSupportNotificationLoop(api, other.sweep);
    expect(second, "the existing controller comes back").toBe(first);
    expect(other.calls.length, "the second sweep was never armed").toBe(0);

    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS * 2);
    expect(calls.length, "one timer's worth of ticks, not two").toBe(3);
    await first.stopAndDrain();
  });

  it("S8-4: after stop, no tick ever begins again", async () => {
    const { calls, sweep } = countingSweep();
    const controller = startSupportNotificationLoop(api, sweep);
    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);
    expect(calls.length).toBe(2);

    controller.stop();
    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS * 10);
    expect(calls.length, "stopped means stopped").toBe(2);
  });

  it("S8-5: stop is idempotent, and a fresh start after stop is a fresh loop", async () => {
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
    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);
    expect(next.calls.length, "the old controller cannot stop the new loop").toBe(2);
    await second.stopAndDrain();
  });

  it("S8-6: a tick in flight when stop runs finishes; the next one never starts", async () => {
    const held = heldSweep();
    const controller = startSupportNotificationLoop(api, held.sweep);
    expect(held.started, "immediate tick is in flight").toBe(1);

    controller.stop();
    held.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(held.events).toEqual(["sweep-started", "sweep-resolved"]);
    // ...and no further tick begins.
    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS * 5);
    expect(held.started).toBe(1);
  });

  it("S8-7: a rejecting sweep does not stop future ticks", async () => {
    let calls = 0;
    const sweep: SupportSweepRunner = async () => {
      calls += 1;
      throw new Error("500 internal");
    };
    const controller = startSupportNotificationLoop(api, sweep);
    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS * 2);
    expect(calls, "failures are contained, the schedule survives").toBe(3);
    await controller.stopAndDrain();
  });

  it("S8-8: drain does not resolve while a tick is still running", async () => {
    const held = heldSweep();
    const controller = startSupportNotificationLoop(api, held.sweep);
    controller.stop();

    let drained = false;
    const draining = controller.drain().then(() => {
      drained = true;
    });

    // Every microtask and timer the runtime has to offer, and it must still
    // be waiting — the sweep has not resolved.
    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS * 10);
    expect(drained, "drain is honest about work in flight").toBe(false);

    held.release();
    await draining;
    expect(drained).toBe(true);
    expect(held.events).toEqual(["sweep-started", "sweep-resolved"]);
  });

  it("S8-9: drain resolves immediately when nothing is running", async () => {
    const { sweep } = countingSweep();
    const controller = startSupportNotificationLoop(api, sweep);
    // The immediate tick resolves on its own microtask.
    await vi.advanceTimersByTimeAsync(0);
    controller.stop();
    await expect(controller.drain()).resolves.toBeUndefined();
    // And draining twice is as harmless as stopping twice.
    await expect(controller.drain()).resolves.toBeUndefined();
  });

  it("S8-10: a slow tick suppresses the next firing rather than overlapping", async () => {
    const held = heldSweep();
    const controller = startSupportNotificationLoop(api, held.sweep);
    expect(held.started).toBe(1);

    // Several intervals pass while the first sweep is still working.
    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS * 4);
    expect(held.started, "one process, one sweep at a time").toBe(1);

    // Once it finishes, the schedule resumes normally.
    held.release();
    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);
    expect(held.started).toBe(2);
    controller.stop();
    held.release();
    await controller.drain();
  });

  it("S8-11: a drained tick's failure never escapes as a rejection", async () => {
    const sweep: SupportSweepRunner = async () => {
      throw new Error("chat not found");
    };
    const controller = startSupportNotificationLoop(api, sweep);
    // drain() is a shutdown step: if it rejected, the steps after it — the
    // database disconnect — would be skipped.
    await expect(controller.stopAndDrain()).resolves.toBeUndefined();
  });
});

// =============================================================================
// The shutdown sequence, EXECUTED.
//
// The previous version of this file asserted the order by reading `index.ts`
// as text: `stop()` appears before `disconnectDatabase()`. That proves the two
// calls are written in that order — not that the first one finished before the
// second one started, which is the only property that matters. A stopped loop
// with a sweep still running is a sweep racing the disconnect, and the string
// scan is blind to it.
//
// So these drive the real sequence with a sweep that has not resolved, and
// assert on what does NOT happen.
// =============================================================================

describe("shutdown drains notification work before disconnecting", () => {
  beforeEach(async () => {
    await resetSupportNotificationLoopForTests();
  });

  afterEach(async () => {
    await resetSupportNotificationLoopForTests();
  });

  /** Steps that record themselves, so the order is data. */
  function recordingSteps(order: string[]) {
    return {
      writeStoppingLog: async (): Promise<void> => {
        order.push("log");
      },
      stopBot: async (): Promise<void> => {
        order.push("bot");
      },
      stopConsumers: async (): Promise<void> => {
        order.push("consumers");
      },
      disconnectDatabase: async (): Promise<void> => {
        order.push("disconnect");
      },
    };
  }

  it("S8-12: the database is not disconnected until the in-flight sweep resolves", async () => {
    const order: string[] = [];
    const held = heldSweep();
    const controller = startSupportNotificationLoop(api, held.sweep);
    expect(held.started, "(1) an immediate sweep begins and holds a promise").toBe(1);

    // (2) Shutdown starts.
    const shutdown = runShutdownSequence({
      stopSupportNotificationTicks: () => {
        order.push("stop-ticks");
        controller.stop();
      },
      drainSupportNotifications: () => controller.drain(),
      ...recordingSteps(order),
    });

    // (3) Give the sequence every chance to run ahead. It must be parked in
    // the drain step: nothing after it may have happened.
    for (let i = 0; i < 10; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(order, "shutdown is blocked in drain").toEqual(["stop-ticks"]);
    expect(order, "the database must NOT be disconnected yet").not.toContain("disconnect");

    // (4) The sweep resolves.
    held.release();

    // (5) Only now may the rest of the teardown run.
    const report = await shutdown;
    expect(order).toEqual(["stop-ticks", "log", "bot", "consumers", "disconnect"]);
    expect(report.failed, "every step succeeded").toEqual([]);
    expect(report.completed).toEqual([...SHUTDOWN_STEPS]);
    expect(held.events).toEqual(["sweep-started", "sweep-resolved"]);
  });

  it("S8-13: shutdown stops new ticks before it waits for the running one", async () => {
    const order: string[] = [];
    const held = heldSweep();
    const controller = startSupportNotificationLoop(api, held.sweep);

    const shutdown = runShutdownSequence({
      stopSupportNotificationTicks: () => {
        order.push("stop-ticks");
        controller.stop();
      },
      drainSupportNotifications: async () => {
        order.push("drain-begin");
        await controller.drain();
        order.push("drain-end");
      },
      ...recordingSteps(order),
    });
    await new Promise((resolve) => setImmediate(resolve));
    // Draining a loop that was not stopped first would never terminate: the
    // interval keeps feeding it new ticks. Order is not cosmetic here.
    expect(order.indexOf("stop-ticks")).toBeLessThan(order.indexOf("drain-begin"));

    held.release();
    await shutdown;
    expect(order.indexOf("drain-end")).toBeLessThan(order.indexOf("disconnect"));
  });

  it("S8-14: a failing step does not prevent the database from being disconnected", async () => {
    const order: string[] = [];
    const seen: string[] = [];
    const report = await runShutdownSequence(
      {
        stopSupportNotificationTicks: () => {
          order.push("stop-ticks");
        },
        drainSupportNotifications: async () => {
          order.push("drain");
        },
        writeStoppingLog: async () => {
          order.push("log");
        },
        stopBot: async () => {
          throw new Error("grammY refused to stop");
        },
        stopConsumers: async () => {
          order.push("consumers");
        },
        disconnectDatabase: async () => {
          order.push("disconnect");
        },
      },
      (step) => {
        seen.push(step);
      },
    );

    // The old single try/catch skipped everything after the throw, including
    // the disconnect — the one step most worth reaching.
    expect(order, "teardown continued past the failure").toContain("disconnect");
    expect(report.failed).toEqual(["stop-bot"]);
    expect(seen).toEqual(["stop-bot"]);
  });

  it("S8-15: a rejecting drain is contained and the sequence still completes", async () => {
    const report = await runShutdownSequence({
      stopSupportNotificationTicks: () => {},
      drainSupportNotifications: async () => {
        throw new Error("drain exploded");
      },
      writeStoppingLog: async () => {},
      stopBot: async () => {},
      stopConsumers: async () => {},
      disconnectDatabase: async () => {},
    });
    expect(report.failed).toEqual(["drain-support-notifications"]);
    expect(report.completed).toContain("disconnect-database");
  });

  it("S8-16: the production entrypoint runs this exact sequence", () => {
    // The executable tests above prove the sequence is correct. This proves
    // production uses it rather than a hand-rolled copy that could drift.
    const raw = readFileSync(path.join(import.meta.dirname, "..", "src", "index.ts"), "utf8");
    const entry = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((line) => line.replace(/(^|\s)\/\/.*$/, "$1"))
      .join("\n");

    expect(entry, "imported").toMatch(
      /import\s*\{[^}]*runShutdownSequence[^}]*\}\s*from\s*"\.\/core\/shutdown\.js"/s,
    );
    const shutdownStart = entry.indexOf("const shutdown = async");
    expect(shutdownStart, "shutdown handler present").toBeGreaterThan(-1);
    const body = entry.slice(shutdownStart);
    expect(body, "the sequence is what shutdown runs").toContain("await runShutdownSequence(");
    // Both halves are wired: stopping alone was the defect.
    expect(body).toContain("supportNotificationLoop?.stop()");
    expect(body).toContain("supportNotificationLoop?.drain()");
    expect(body).toContain("disconnectDatabase()");
  });
});
