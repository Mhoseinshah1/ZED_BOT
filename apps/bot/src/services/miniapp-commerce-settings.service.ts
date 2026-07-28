// =============================================================================
// Mini App commerce rollout switches — bot-side read/toggle service
// (miniapp-commerce-parity, Phase 1).
//
// Thin wrappers over the Setting store for the nine `miniapp_*` switches
// defined in @zedbot/shared (miniapp-commerce.ts). The bot only needs them for
// the OWNER admin screen (display + atomic toggle); the API process performs
// its own FRESH fail-closed reads at every mutation boundary
// (apps/api/src/miniapp/feature-switches.ts) and never trusts this cache.
// =============================================================================
import type { MiniAppCommerceSwitchKey } from "@zedbot/shared";
import { MINIAPP_COMMERCE_SWITCH_KEYS } from "@zedbot/shared";

import {
  compareAndSetBooleanSetting,
  getBooleanSettingFresh,
} from "./settings.service.js";

/** Current value of one switch, read fresh (the admin screen must never show
 * a stale cache after a toggle, and other processes may have flipped it). */
export async function isMiniAppSwitchEnabled(
  key: MiniAppCommerceSwitchKey,
): Promise<boolean> {
  return getBooleanSettingFresh(key, false);
}

/** Fresh values of every switch, in rollout order. */
export async function readAllMiniAppSwitches(): Promise<
  ReadonlyArray<{ key: MiniAppCommerceSwitchKey; enabled: boolean }>
> {
  return Promise.all(
    MINIAPP_COMMERCE_SWITCH_KEYS.map(async (key) => ({
      key,
      enabled: await getBooleanSettingFresh(key, false),
    })),
  );
}

/** Atomic toggle: flips `key` from `expected` to `!expected` with no
 * read-check-write window (CAS — a concurrent double-tap loses cleanly). */
export async function compareAndSetMiniAppSwitch(
  key: MiniAppCommerceSwitchKey,
  expected: boolean,
): Promise<boolean> {
  return compareAndSetBooleanSetting(key, expected, !expected);
}
