import { getSetting, setSetting } from "./settings.service.js";

// =============================================================================
// User main-menu keyboard mode (menu-keyboard-mode phase): one global,
// admin-configurable Setting that selects HOW the approved user main menu is
// rendered - inline glass buttons inside the message (the historical
// behavior and the default) or a persistent Telegram reply keyboard below
// the input field. Only the keyboard TYPE switches; the approved menu
// structure, labels, ordering and visibility rules are shared by both modes
// (keyboards/user-menu-definition.ts). Admin menus are NEVER affected.
// =============================================================================

export const USER_MENU_MODE_KEY = "user_main_menu_keyboard_mode";

export type UserMenuMode = "INLINE" | "REPLY";

/** Persian display label for each mode (admin settings page). */
export const MENU_MODE_LABELS: Record<UserMenuMode, string> = {
  INLINE: "دکمه شیشه‌ای داخل پیام",
  REPLY: "دکمه معمولی پایین صفحه",
};

/**
 * The current mode. Unset/unknown values resolve to INLINE, so existing
 * installations keep their exact current behavior with no migration.
 */
export async function getUserMenuMode(): Promise<UserMenuMode> {
  const raw = await getSetting(USER_MENU_MODE_KEY, "INLINE");
  return raw === "REPLY" ? "REPLY" : "INLINE";
}

export async function setUserMenuMode(mode: UserMenuMode): Promise<void> {
  await setSetting(USER_MENU_MODE_KEY, mode, "STRING");
}
