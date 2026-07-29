import { prisma } from "@zedbot/database";
import {
  isMiniAppRolloutEnabled,
  MINIAPP_COMMERCE_ROLLOUT_KEYS,
  readMiniAppRolloutState,
  setMiniAppRolloutEnabled,
} from "@zedbot/service-renewal";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { MINIAPP_COMMERCE_SWITCHES } from "../src/handlers/admin-settings/miniapp-commerce-admin.handler.js";
import { clearSettingCacheKeys, getBooleanSetting } from "../src/services/settings.service.js";

// =============================================================================
// ROLL — the Mini App commerce rollout switches, and the OWNER's grip on them.
//
// A DEFAULT OF FALSE IS NOT THE SAME AS A MANAGEABLE SWITCH. The gate reads a
// missing row as false, which is the right storage behaviour and is asserted
// below. But if the only way to open a payment surface were to hand-write a row
// into the Setting table, the person who owns the money would need psql to open
// a till and would have no way to see which tills were open. So this suite also
// asserts that the OWNER page covers exactly the shipped keys — no key without a
// control, no control pointing at a key that does not exist.
//
// Real rows, real Prisma. Without DATABASE_URL the suite skips itself.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

async function clearAll(): Promise<void> {
  await prisma.setting.deleteMany({ where: { key: { in: [...MINIAPP_COMMERCE_ROLLOUT_KEYS] } } });
  clearSettingCacheKeys([...MINIAPP_COMMERCE_ROLLOUT_KEYS]);
}

afterEach(async () => {
  if (!hasDb) return;
  await clearAll();
});

afterAll(async () => {
  if (!hasDb) return;
  await clearAll();
});

describe.skipIf(!hasDb)("mini app commerce rollout switches", () => {
  // ROLL-1 --------------------------------------------------------------------
  it("ROLL-1: merging enables nothing — every key reads false with no row", async () => {
    await clearAll();
    // The state a fresh deploy of this branch is in: the migrations created no
    // row, the seed wrote no row, and every gate answers false.
    const rows = await prisma.setting.findMany({
      where: { key: { in: [...MINIAPP_COMMERCE_ROLLOUT_KEYS] } },
    });
    expect(rows).toHaveLength(0);

    const state = await readMiniAppRolloutState();
    for (const key of MINIAPP_COMMERCE_ROLLOUT_KEYS) {
      expect(state[key]).toBe(false);
      expect(await isMiniAppRolloutEnabled(key)).toBe(false);
    }
  });

  // ROLL-2 --------------------------------------------------------------------
  it("ROLL-2: the OWNER page covers exactly the shipped keys", async () => {
    // A key with no control cannot be turned off in an incident; a control for
    // a key that does not exist is a button that does nothing. Both are caught
    // by comparing the two lists rather than by reading the page.
    const covered = MINIAPP_COMMERCE_SWITCHES.map((s) => s.key).sort();
    expect(covered).toEqual([...MINIAPP_COMMERCE_ROLLOUT_KEYS].sort());

    // Every control also states its scope, because "what does this turn on" is
    // the question an operator has at the moment they are deciding.
    for (const item of MINIAPP_COMMERCE_SWITCHES) {
      expect(item.title.trim().length).toBeGreaterThan(0);
      expect(item.scope.trim().length).toBeGreaterThan(0);
      expect(item.slug).toMatch(/^[a-z]+$/);
    }
    // Slugs are unique: two controls sharing one would flip the wrong switch.
    const slugs = MINIAPP_COMMERCE_SWITCHES.map((s) => s.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  // ROLL-3 --------------------------------------------------------------------
  it("ROLL-3: enable, disable and restore-to-false all round-trip", async () => {
    for (const key of MINIAPP_COMMERCE_ROLLOUT_KEYS) {
      await setMiniAppRolloutEnabled(key, true);
      expect(await isMiniAppRolloutEnabled(key)).toBe(true);

      await setMiniAppRolloutEnabled(key, false);
      expect(await isMiniAppRolloutEnabled(key)).toBe(false);

      // The stored spelling is the canonical one an operator expects to read.
      const row = await prisma.setting.findUniqueOrThrow({ where: { key } });
      expect(row.value).toBe("false");
      expect(row.type).toBe("BOOLEAN");
      // Never public: a public setting would announce the rollout to every
      // unauthenticated caller and make the switch itself a signal.
      expect(row.isPublic).toBe(false);
    }
  });

  // ROLL-4 --------------------------------------------------------------------
  it("ROLL-4: switches are independent — one open till does not open another", async () => {
    await setMiniAppRolloutEnabled("miniapp_wallet_renewal_enabled", true);
    const state = await readMiniAppRolloutState();
    expect(state.miniapp_wallet_renewal_enabled).toBe(true);
    for (const key of MINIAPP_COMMERCE_ROLLOUT_KEYS) {
      if (key !== "miniapp_wallet_renewal_enabled") {
        expect(state[key]).toBe(false);
      }
    }
  });

  // ROLL-5 --------------------------------------------------------------------
  it("ROLL-5: a malformed or unexpected stored value fails closed", async () => {
    const key = "miniapp_wallet_purchase_enabled" as const;
    for (const value of ["", "  ", "maybe", "TRUE-ish", "0", "no", "null", "undefined", "2"]) {
      await prisma.setting.upsert({
        where: { key },
        update: { value },
        create: { key, value, type: "BOOLEAN", isPublic: false },
      });
      expect(await isMiniAppRolloutEnabled(key)).toBe(false);
    }
    // ...and the spellings that DO mean true are honoured, so the check above
    // is really about the malformed values and not about a gate stuck off.
    for (const value of ["true", "TRUE", " True ", "1", "yes", "YES"]) {
      await prisma.setting.upsert({
        where: { key },
        update: { value },
        create: { key, value, type: "BOOLEAN", isPublic: false },
      });
      expect(await isMiniAppRolloutEnabled(key)).toBe(true);
    }
  });

  // ROLL-6 --------------------------------------------------------------------
  it("ROLL-6: the gate and the bot's settings reader agree on every spelling", async () => {
    // The two readers must not disagree about whether a payment surface is
    // open. An earlier version of the domain gate also accepted "on", which the
    // bot's `isTruthySettingValue` does not — the admin page would have shown
    // OFF while the Mini App charged people.
    const key = "miniapp_wallet_addons_enabled" as const;
    for (const value of ["true", "1", "yes", "on", "false", "0", "no", "", "off", "enabled"]) {
      await prisma.setting.upsert({
        where: { key },
        update: { value },
        create: { key, value, type: "BOOLEAN", isPublic: false },
      });
      clearSettingCacheKeys([key]);
      const domainSaysEnabled = await isMiniAppRolloutEnabled(key);
      const botSaysEnabled = await getBooleanSetting(key, false);
      expect({ value, domainSaysEnabled }).toEqual({ value, domainSaysEnabled: botSaysEnabled });
    }
  });
});
