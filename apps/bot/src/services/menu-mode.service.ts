import { getSetting, setSetting } from "./settings.service.js";

// =============================================================================
// Main-menu keyboard modes (menu-keyboard-mode phases): two INDEPENDENT,
// admin-configurable Settings that select HOW the approved main menus are
// rendered - inline glass buttons inside the message (the historical
// behavior and the default for BOTH) or a persistent Telegram reply keyboard
// below the input field. The user menu and the admin menu each have their
// own Setting, so every combination (INLINE/INLINE, REPLY/INLINE,
// INLINE/REPLY, REPLY/REPLY) is supported. Only the keyboard TYPE switches;
// the approved menu structures, labels, ordering and visibility rules are
// shared by both renderings (keyboards/user-menu-definition.ts and
// keyboards/admin-menu-definition.ts).
// =============================================================================

export const USER_MENU_MODE_KEY = "user_main_menu_keyboard_mode";
export const ADMIN_MENU_MODE_KEY = "admin_main_menu_keyboard_mode";

export type UserMenuMode = "INLINE" | "REPLY";
/** Same value set for both scopes - kept as one alias to avoid drift. */
export type MenuMode = UserMenuMode;

/** Persian display label for each mode (admin settings page). */
export const MENU_MODE_LABELS: Record<UserMenuMode, string> = {
  INLINE: "دکمه شیشه‌ای داخل پیام",
  REPLY: "دکمه معمولی پایین صفحه",
};

/**
 * The current user-menu mode. Unset/unknown values resolve to INLINE, so
 * existing installations keep their exact current behavior with no
 * migration.
 */
export async function getUserMenuMode(): Promise<UserMenuMode> {
  const raw = await getSetting(USER_MENU_MODE_KEY, "INLINE");
  return raw === "REPLY" ? "REPLY" : "INLINE";
}

export async function setUserMenuMode(mode: UserMenuMode): Promise<void> {
  await setSetting(USER_MENU_MODE_KEY, mode, "STRING");
}

/**
 * The current admin-menu mode - independent of the user setting and equally
 * fail-closed: unset/unknown resolves to INLINE, so production admin menus
 * never switch to a reply keyboard without an explicit operator choice.
 */
export async function getAdminMenuMode(): Promise<MenuMode> {
  const raw = await getSetting(ADMIN_MENU_MODE_KEY, "INLINE");
  return raw === "REPLY" ? "REPLY" : "INLINE";
}

export async function setAdminMenuMode(mode: MenuMode): Promise<void> {
  await setSetting(ADMIN_MENU_MODE_KEY, mode, "STRING");
}
