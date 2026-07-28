// =============================================================================
// Mini App commerce rollout switches (miniapp-commerce-parity, Phase 1).
//
// SW-1  the shared contract exposes exactly nine miniapp_* keys, unique, in
//       rollout order, and the truthiness rule matches the bot's.
// SW-2  fail-closed resolution: a failed read is OFF, never a fallback.
// SW-3  (DB) the seed created every switch row, so a fresh install has all
//       nine present and dormant.
// SW-4  (DB) toggles are atomic CAS: exactly one of N concurrent identical
//       toggles wins; the switch never double-flips.
// SW-5  (DB) the bot-side reader reads FRESH (a direct DB write is visible
//       immediately, no 30s cache window).
// =============================================================================
import { prisma } from "@zedbot/database";
import {
  isMiniAppSwitchValueTruthy,
  MINIAPP_COMMERCE_SWITCH_KEYS,
  resolveMiniAppSwitchState,
} from "@zedbot/shared";
import { describe, expect, it } from "vitest";

import {
  compareAndSetMiniAppSwitch,
  isMiniAppSwitchEnabled,
} from "../src/services/miniapp-commerce-settings.service.js";

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

describe("miniapp commerce switch contract (SW-1, SW-2)", () => {
  it("SW-1 exposes exactly nine unique miniapp_* keys in rollout order", () => {
    expect(MINIAPP_COMMERCE_SWITCH_KEYS).toHaveLength(9);
    expect(new Set(MINIAPP_COMMERCE_SWITCH_KEYS).size).toBe(9);
    for (const key of MINIAPP_COMMERCE_SWITCH_KEYS) {
      expect(key).toMatch(/^miniapp_[a-z_]+_enabled$/);
    }
    expect(MINIAPP_COMMERCE_SWITCH_KEYS[0]).toBe("miniapp_commerce_enabled");
  });

  it("SW-1 truthiness matches the bot's isTruthySettingValue rule", () => {
    for (const truthy of ["true", "TRUE", " True ", "1", "yes", "YES"]) {
      expect(isMiniAppSwitchValueTruthy(truthy)).toBe(true);
    }
    for (const falsy of ["false", "0", "no", "", "  ", "on", "enabled", null, undefined]) {
      expect(isMiniAppSwitchValueTruthy(falsy as string | null | undefined)).toBe(false);
    }
  });

  it("SW-2 a failed read resolves to fail-closed, not a fallback value", () => {
    expect(resolveMiniAppSwitchState({ ok: false })).toEqual({ ok: false });
    expect(resolveMiniAppSwitchState({ ok: true, value: null })).toEqual({
      ok: true,
      enabled: false,
    });
    expect(resolveMiniAppSwitchState({ ok: true, value: "true" })).toEqual({
      ok: true,
      enabled: true,
    });
  });
});

describe.runIf(hasDb)("miniapp commerce switches against the database (SW-3..SW-5)", () => {
  it("SW-3 the seed created all nine switch rows", async () => {
    const rows = await prisma.setting.findMany({
      where: { key: { in: [...MINIAPP_COMMERCE_SWITCH_KEYS] } },
      select: { key: true },
    });
    expect(rows.map((r) => r.key).sort()).toEqual([...MINIAPP_COMMERCE_SWITCH_KEYS].sort());
  });

  it("SW-4 concurrent identical toggles: exactly one wins", async () => {
    const key = "miniapp_extra_time_enabled";
    const before = await isMiniAppSwitchEnabled(key);
    try {
      const results = await Promise.all(
        Array.from({ length: 6 }, () => compareAndSetMiniAppSwitch(key, before)),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await isMiniAppSwitchEnabled(key)).toBe(!before);
    } finally {
      await prisma.setting.update({
        where: { key },
        data: { value: before ? "true" : "false" },
      });
    }
  });

  it("SW-5 the reader is fresh: a direct DB write is visible immediately", async () => {
    const key = "miniapp_extra_volume_enabled";
    const before = await prisma.setting.findUnique({ where: { key } });
    try {
      await prisma.setting.update({ where: { key }, data: { value: "true" } });
      expect(await isMiniAppSwitchEnabled(key)).toBe(true);
      await prisma.setting.update({ where: { key }, data: { value: "false" } });
      expect(await isMiniAppSwitchEnabled(key)).toBe(false);
    } finally {
      await prisma.setting.update({
        where: { key },
        data: { value: before?.value ?? "false" },
      });
    }
  });
});

describe.skipIf(hasDb)("miniapp commerce switches (skipped)", () => {
  it("requires DATABASE_URL for the DB-backed suite", () => {
    expect(hasDb).toBe(false);
  });
});
