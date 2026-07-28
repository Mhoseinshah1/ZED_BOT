// =============================================================================
// Mini App commerce rollout switches — API-side FRESH, FAIL-CLOSED reads
// (miniapp-commerce-parity, Phase 1).
//
// Every authoritative commerce mutation boundary (and every commerce read
// surface) re-reads its gating switch straight from the database on the
// request path: no process cache, no TTL, no assumed default. A read failure
// is indistinguishable from "disabled" for the caller — the request is
// refused — so a broken database can never fail a gate OPEN. This mirrors the
// access-policy discipline (`readBooleanSetting` returning {ok:false}) and the
// bot's `tryGetBooleanSettingFresh`.
//
// The switch value only gates NEW work. Settled payments, paid orders and
// delivered content are never re-gated: status/read endpoints for an entity
// the user already owns stay readable so an operator flipping a switch off
// mid-flight cannot strand a paid user without their receipt or delivery.
// Where that carve-out applies is decided per-route, not here.
// =============================================================================
import { prisma } from "@zedbot/database";
import type { MiniAppCommerceSwitchKey, MiniAppSwitchState } from "@zedbot/shared";
import { resolveMiniAppSwitchState } from "@zedbot/shared";

/** One fresh read. `{ok:false}` = the read itself failed → treat as OFF. */
export async function readMiniAppSwitchFresh(
  key: MiniAppCommerceSwitchKey,
): Promise<MiniAppSwitchState> {
  try {
    const row = await prisma.setting.findUnique({
      where: { key },
      select: { value: true },
    });
    return resolveMiniAppSwitchState({ ok: true, value: row?.value ?? null });
  } catch {
    return resolveMiniAppSwitchState({ ok: false });
  }
}

/** Convenience conjunction: every listed switch must be ON, and every read
 * must succeed. The master switch is the caller's responsibility to include
 * (routes always pass it first so "master off" wins over sub-switch state). */
export async function allMiniAppSwitchesEnabled(
  keys: readonly MiniAppCommerceSwitchKey[],
): Promise<{ ok: true } | { ok: false; unavailable: boolean }> {
  for (const key of keys) {
    const state = await readMiniAppSwitchFresh(key);
    if (!state.ok) return { ok: false, unavailable: true };
    if (!state.enabled) return { ok: false, unavailable: false };
  }
  return { ok: true };
}
