import { InlineKeyboard } from "grammy";

import { CB } from "../core/callbacks.js";
import { getButtonText } from "../services/text.service.js";

/** "back" + "main menu" row used under placeholder pages. */
export async function buildBackToMenuKeyboard(): Promise<InlineKeyboard> {
  const [back, mainMenu] = await Promise.all([
    getButtonText("back"),
    getButtonText("main_menu"),
  ]);
  return new InlineKeyboard().text(back, CB.COMMON_BACK).text(mainMenu, CB.USER_MENU);
}

/** "back" row for admin placeholder pages (returns to the admin menu). */
export function buildBackToAdminMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("بازگشت", CB.ADMIN_MENU);
}
