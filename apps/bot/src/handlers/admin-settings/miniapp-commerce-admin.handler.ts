import {
  MINIAPP_COMMERCE_BROWSE_ENABLED_KEY,
  MINIAPP_COMMERCE_CHECKOUT_ENABLED_KEY,
  MINIAPP_COMMERCE_ROLLOUT_KEYS,
  MINIAPP_WALLET_ADDONS_ENABLED_KEY,
  MINIAPP_WALLET_PURCHASE_ENABLED_KEY,
  MINIAPP_WALLET_RENEWAL_ENABLED_KEY,
  readMiniAppRolloutState,
  type MiniAppCommerceRolloutKey,
} from "@zedbot/service-renewal";
import { Composer, InlineKeyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import type { BotContext } from "../../core/context.js";
import { buildBackToAdminMenuKeyboard } from "../../keyboards/common.keyboard.js";
import {
  clearSettingCacheKeys,
  compareAndSetBooleanSetting,
} from "../../services/settings.service.js";
import { safeAnswerCallback, safeEditOrReply } from "../../utils/safe-reply.js";

// =============================================================================
// Mini App commerce rollout — the OWNER's page. OWNER-only.
//
// WHY THIS PAGE HAD TO EXIST. The five switches default false and are not
// seeded, which is the right storage behaviour: a missing row reads as false,
// so merging enables nothing and the operator's first decision is an explicit
// one. But "correct default" is not the same as "manageable". Without a page,
// the only way to turn a payment surface on would be to write a row into the
// Setting table by hand — which means the person who owns the money has to use
// psql to open a till, has no way to see which surfaces are currently open, and
// no way to be sure they closed one. So the switches are here, all five, with
// their current state and their scope written out.
//
// IT REPLACES A PLACEHOLDER RATHER THAN ADDING A BUTTON. `admin:mini_app_settings`
// has been in `admin-placeholders.handler.ts` since the admin menu was built,
// answering «این بخش هنوز فعال نشده است.». It is now real, and its line in the
// placeholder list is a comment recording that — the same convention every
// other graduated capability follows.
//
// EACH TOGGLE IS A COMPARE-AND-SWAP against the state the page was rendered
// with, not a blind write. Two OWNERs on two devices looking at the same screen
// cannot both "turn it on" and have the second one silently turn it back off;
// the loser is told the value moved and sees the refreshed page.
//
// THE SWITCHES ARE NOT `isPublic`. The Mini App learns what it may do from
// owner-scoped, already-gated responses. A public setting would announce the
// rollout to every unauthenticated caller and make the switch itself a signal.
// =============================================================================

const OWNER_ONLY_TEXT = "این بخش فقط برای مالک ربات در دسترس است.";

/** Callback prefix for one toggle. Short, because callback data is bounded. */
const TOGGLE_PREFIX = "admin:mac:t:";
/** Callback for the "close everything" action. */
const DISABLE_ALL = "admin:mac:offall";

/**
 * A short, stable slug per switch.
 *
 * The Setting key itself is too long to put in callback data alongside the
 * prefix, and a numeric index would silently retarget if the list were ever
 * reordered — a click meant for "renewal" flipping "purchase" is exactly the
 * mistake this must not make. The slug is bound to the key here, once.
 */
const SWITCHES: ReadonlyArray<{
  slug: string;
  key: MiniAppCommerceRolloutKey;
  title: string;
  scope: string;
}> = [
  {
    slug: "browse",
    key: MINIAPP_COMMERCE_BROWSE_ENABLED_KEY,
    title: "مشاهده کاتالوگ",
    scope: "کاربر می‌تواند لوکیشن‌ها، دسته‌ها و محصولات را ببیند. هیچ پرداختی انجام نمی‌شود.",
  },
  {
    slug: "checkout",
    key: MINIAPP_COMMERCE_CHECKOUT_ENABLED_KEY,
    title: "ساخت پیش‌فاکتور و کد تخفیف",
    scope: "کاربر می‌تواند پیش‌فاکتور بسازد، کد تخفیف بزند و مبلغ نهایی را ببیند. پولی جابه‌جا نمی‌شود.",
  },
  {
    slug: "purchase",
    key: MINIAPP_WALLET_PURCHASE_ENABLED_KEY,
    title: "خرید اشتراک جدید با کیف پول",
    scope: "کسر از کیف پول و ساخت سرویس جدید روی پنل.",
  },
  {
    slug: "renewal",
    key: MINIAPP_WALLET_RENEWAL_ENABLED_KEY,
    title: "تمدید سرویس با کیف پول",
    scope: "کسر از کیف پول و تمدید سرویس موجود.",
  },
  {
    slug: "addons",
    key: MINIAPP_WALLET_ADDONS_ENABLED_KEY,
    title: "حجم اضافه و زمان اضافه با کیف پول",
    scope: "کسر از کیف پول و افزودن حجم یا زمان به سرویس موجود.",
  },
];

function isOwner(ctx: BotContext): boolean {
  return ctx.admin !== null && ctx.admin.role === "OWNER";
}

function switchBySlug(slug: string): (typeof SWITCHES)[number] | null {
  return SWITCHES.find((s) => s.slug === slug) ?? null;
}

function renderPage(state: Record<MiniAppCommerceRolloutKey, boolean>): {
  text: string;
  keyboard: InlineKeyboard;
} {
  const anyOn = SWITCHES.some((s) => state[s.key]);
  const lines: string[] = [
    "تنظیمات مینی اپ ⚙️",
    "",
    "کنترل مرحله‌ای فروش در مینی اپ. هر کلید جداگانه است و پیش‌فرض همه خاموش‌اند.",
    "",
  ];
  for (const item of SWITCHES) {
    lines.push(`${state[item.key] ? "🟢 روشن" : "⚪️ خاموش"} — ${item.title}`);
    lines.push(`      ${item.scope}`);
    lines.push("");
  }
  lines.push(
    anyOn
      ? "توجه: با خاموش کردن یک کلید، پرداخت‌های انجام‌شده و تاریخچه دست‌نخورده باقی می‌ماند و فقط عملیات جدید متوقف می‌شود."
      : "در حال حاضر هیچ بخشی از فروش مینی اپ فعال نیست.",
  );

  const keyboard = new InlineKeyboard();
  for (const item of SWITCHES) {
    keyboard
      .text(
        `${state[item.key] ? "خاموش کردن" : "روشن کردن"} — ${item.title}`,
        `${TOGGLE_PREFIX}${item.slug}`,
      )
      .row();
  }
  if (anyOn) {
    keyboard.text("خاموش کردن همه ⛔️", DISABLE_ALL).row();
  }
  keyboard.text("بازگشت", CB.ADMIN_MENU);
  return { text: lines.join("\n"), keyboard };
}

async function showPage(ctx: BotContext): Promise<void> {
  const state = await readMiniAppRolloutState();
  const { text, keyboard } = renderPage(state);
  await safeEditOrReply(ctx, text, keyboard);
  ctx.session.lastMenu = CB.ADMIN_MINI_APP_SETTINGS;
}

export const miniAppCommerceAdminHandler = new Composer<BotContext>();

miniAppCommerceAdminHandler.callbackQuery(CB.ADMIN_MINI_APP_SETTINGS, async (ctx) => {
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  await safeAnswerCallback(ctx);
  await showPage(ctx);
});

miniAppCommerceAdminHandler.callbackQuery(
  new RegExp(`^${TOGGLE_PREFIX}([a-z]+)$`),
  async (ctx) => {
    if (!isOwner(ctx)) {
      await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
      return;
    }
    const slug = ctx.match?.[1] ?? "";
    const item = switchBySlug(slug);
    if (item === null) {
      await safeAnswerCallback(ctx);
      await showPage(ctx);
      return;
    }
    // Read the CURRENT value and swap against it. A blind write would let two
    // OWNERs on two devices race, with the second click undoing the first.
    const state = await readMiniAppRolloutState();
    const current = state[item.key];
    const won = await compareAndSetBooleanSetting(item.key, current, !current);
    // The bot's cached settings reader must not keep serving the old value.
    // (The Mini App gate reads uncached, so it is already correct.)
    clearSettingCacheKeys([item.key]);
    await safeAnswerCallback(
      ctx,
      won
        ? !current
          ? "روشن شد."
          : "خاموش شد."
        : "مقدار این کلید هم‌زمان تغییر کرده بود. وضعیت به‌روزشده را ببینید.",
    );
    await showPage(ctx);
  },
);

miniAppCommerceAdminHandler.callbackQuery(DISABLE_ALL, async (ctx) => {
  if (!isOwner(ctx)) {
    await safeAnswerCallback(ctx, OWNER_ONLY_TEXT);
    return;
  }
  // The panic button. Each switch is closed independently and a lost race is
  // not an error here: another writer setting it to false reached the same
  // destination, and the only direction this action moves anything is off.
  const state = await readMiniAppRolloutState();
  for (const item of SWITCHES) {
    if (state[item.key]) {
      await compareAndSetBooleanSetting(item.key, true, false);
    }
  }
  clearSettingCacheKeys([...MINIAPP_COMMERCE_ROLLOUT_KEYS]);
  await safeAnswerCallback(ctx, "همه کلیدهای فروش مینی اپ خاموش شدند.");
  await showPage(ctx);
});

/** Exported for the admin-surface test: the page's switches and their scopes. */
export const MINIAPP_COMMERCE_SWITCHES = SWITCHES;
export const MINIAPP_COMMERCE_TOGGLE_PREFIX = TOGGLE_PREFIX;
export const MINIAPP_COMMERCE_DISABLE_ALL = DISABLE_ALL;

/** Re-exported so a test can assert the page covers exactly the shipped keys. */
export { buildBackToAdminMenuKeyboard };
