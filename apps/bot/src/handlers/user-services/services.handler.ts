import type { Service } from "@zedbot/database";
import { Composer, InlineKeyboard, InputFile } from "grammy";

import { CB } from "../../core/callbacks.js";
import type { BotContext } from "../../core/context.js";
import {
  serviceSupportsGlobalLifecycle,
  XUI_LEGACY_OPERATION_TEXT,
} from "../../services/panel-readiness.service.js";
import {
  buildLinkRegenerationPreview,
  getLinkRegeneratableServiceByShortId,
  linkRegenerationEligibility,
  regenerateServiceSubscription,
  REGEN_SUCCESS_TEXT,
} from "../../services/service-link.service.js";
import {
  serviceListSyncEnabled,
  syncServiceForDisplay,
  syncServiceFromPanel,
} from "../../services/service-sync.service.js";
import {
  buildTogglePreview,
  getToggleableServiceByShortId,
  toggleEligibility,
  toggleServiceStatus,
  TOGGLE_ALREADY_DONE_TEXT,
  TOGGLE_DISABLED_OK_TEXT,
  TOGGLE_ENABLED_OK_TEXT,
  type ToggleAction,
} from "../../services/service-toggle.service.js";
import { getButtonText, getMessageTemplate } from "../../services/text.service.js";
import {
  getOwnedServiceByShortId,
  listUserServices,
  resolveServiceDetailActions,
  serviceShortId,
} from "../../services/user-services.service.js";
import { generateQrPng } from "../../services/qr-code.service.js";
import {
  CONFIG_QR_FILENAME,
  configFailureSummary,
  configOverflowSummary,
  configQrCaption,
  deliverConfigQrCodes,
  deliverSubscriptionQr,
  QR_GENERATION_FAILED_TEXT,
  QR_NO_CONFIGS_TEXT,
  QR_NO_SUBSCRIPTION_TEXT,
  QR_SEND_FAILED_TEXT,
} from "../../services/qr-delivery.service.js";
import {
  getActiveGuideAppBySlug,
  getActiveGuideAppsForPlatform,
  getAvailablePlatforms,
  isConnectionGuideEntryVisible,
  isConnectionGuidesEnabled,
  resolveGuideMethods,
  serviceHasConnectionPayload,
} from "../../services/connection-guide.service.js";
import { escapeHtml } from "../../utils/html.js";
import {
  safeAnswerCallback,
  safeEditOrReply,
  safeReply,
  safeReplyWithPhoto,
} from "../../utils/safe-reply.js";
import { GUIDE_PLATFORM_NEUTRAL_LABEL, guidePlatformFromCode } from "@zedbot/shared";
import {
  GUIDE_HTML,
  guideAppDetailPage,
  guideAppPage,
  guideEntryLabel,
  guidePlatformPage,
  platformLabel,
} from "./guide-views.js";
import {
  regenLinkConfirmKeyboard,
  serviceAccountLabel,
  serviceConfigLinks,
  serviceDetailKeyboard,
  serviceDetailText,
  serviceListKeyboard,
  svcCb,
  toggleConfirmKeyboard,
} from "./service-views.js";

// =============================================================================
// "سرویس‌های من 🛍" (Phase 10) - read-only over stored Service rows, plus the
// user-driven mutations later phases added behind explicit confirmations:
// the Phase 18 enable/disable toggle and the Phase 19 subscription link
// regeneration. Every route re-validates ownership; subscription links and
// configs are shown only to their owner and never logged.
// =============================================================================

const NOT_FOUND = "مورد یافت نشد.";
const MAX_CONFIGS_SHOWN = 10;
const HTML = { parseMode: "HTML" as const };

export const servicesHandler = new Composer<BotContext>();

/**
 * Detail view; toggle/extra-volume/extra-time buttons only when allowed.
 * Exported so the notification action handler (`ntf:*`) can land on the exact
 * same service detail page after re-loading the Service owner-scoped. Does NOT
 * answer the callback query - the caller does (some callers pass a toast).
 */
export async function renderServiceDetail(
  ctx: BotContext,
  service: Service,
  staleNotice: string | null = null,
): Promise<void> {
  const [actions, guide] = await Promise.all([
    resolveServiceDetailActions(service),
    buildServiceGuideEntry(service),
  ]);
  await safeEditOrReply(
    ctx,
    serviceDetailText(service, staleNotice),
    serviceDetailKeyboard(service, actions, guide),
    HTML,
  );
}

export async function renderServicesList(ctx: BotContext, page: number): Promise<void> {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const pageData = await listUserServices(user.id, page);
  await safeAnswerCallback(ctx);
  if (pageData.total === 0) {
    const buy = await getButtonText("buy_subscription");
    const kb = new InlineKeyboard().text(buy, CB.USER_BUY).row().text("بازگشت به منوی اصلی", CB.USER_MENU);
    await safeEditOrReply(ctx, await getMessageTemplate("no_services_text"), kb);
    return;
  }
  if (serviceListSyncEnabled()) {
    // Opt-in list sync (service-live-sync phase): refresh the CURRENT page's
    // rows concurrently, bounded by the same per-service display budget.
    // Failures silently keep the stored row - the list never breaks.
    pageData.services = await Promise.all(
      pageData.services.map((service) =>
        syncServiceForDisplay(service, user.id).then((display) => display.service),
      ),
    );
  }
  await safeEditOrReply(ctx, "سرویس‌های من 🛍", serviceListKeyboard(pageData));
}

servicesHandler.callbackQuery(CB.USER_SERVICES, async (ctx) => {
  await renderServicesList(ctx, 1);
  ctx.session.lastMenu = CB.USER_SERVICES;
});

servicesHandler.callbackQuery(/^user:svc:list:(\d+)$/, async (ctx) => {
  await renderServicesList(ctx, Number.parseInt(ctx.match[1], 10));
});

// Service-live-sync phase: OPENING the detail page synchronizes from the
// panel first (Load -> adapter -> normalize -> update row -> render). Fresh
// rows (within the TTL) skip the panel; slow/unreachable panels fall back to
// the stored values plus a safe Persian notice - the page always renders.
servicesHandler.callbackQuery(/^user:svc:view:([0-9a-f-]+)$/, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const service = await getOwnedServiceByShortId(ctx.match[1], user.id);
  if (service === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  // Returning to the service detail cancels any pending guide→support handoff, so
  // the "بازگشت به سرویس" button on the support prompt (and any other path back
  // here) can't leave the user stuck in support:message — their next plain
  // message would otherwise be consumed into a ticket. No-op when none pending.
  clearGuideHandoff(ctx);
  await safeAnswerCallback(ctx);
  const display = await syncServiceForDisplay(service, user.id);
  await renderServiceDetail(ctx, display.service, display.notice);
});

// Phase 11: refresh now syncs from the PANEL (read-only). A failed sync
// keeps the stored values on screen; adapter errors never reach the user.
servicesHandler.callbackQuery(/^user:svc:refresh:([0-9a-f-]+)$/, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const owned = await getOwnedServiceByShortId(ctx.match[1], user.id);
  if (owned === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  const sync = await syncServiceFromPanel(owned.id, user.id);
  if (sync.ok) {
    await safeAnswerCallback(ctx, sync.message);
    await renderServiceDetail(ctx, sync.service);
    return;
  }
  if (sync.service === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  await safeAnswerCallback(ctx, sync.safeUserMessage);
  await renderServiceDetail(ctx, sync.service);
});

// --- Phase 18: enable/disable toggle ----------------------------------------
// Ask -> explicit confirmation -> panel update -> DB update. The panel is
// NEVER called before the «yes» step, and every step re-validates ownership
// and eligibility (stale buttons answer with a safe toast, nothing changes).

async function askToggle(ctx: BotContext, shortId: string, action: ToggleAction): Promise<void> {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const service = await getToggleableServiceByShortId(shortId, user.id);
  if (service === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  // Stale-button guard: legacy per-inbound XUI services never reach the
  // toggle confirmation (the detail keyboard already hides the button).
  if (!serviceSupportsGlobalLifecycle(service)) {
    await safeAnswerCallback(ctx, XUI_LEGACY_OPERATION_TEXT);
    await renderServiceDetail(ctx, service);
    return;
  }
  const eligibility = toggleEligibility(service, service.panel.status, action);
  if (!eligibility.eligible) {
    await safeAnswerCallback(ctx, eligibility.safeUserMessage);
    await renderServiceDetail(ctx, service);
    return;
  }
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    buildTogglePreview(service, action),
    toggleConfirmKeyboard(shortId, action),
    HTML,
  );
}

async function confirmToggle(
  ctx: BotContext,
  shortId: string,
  action: ToggleAction,
): Promise<void> {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const service = await getToggleableServiceByShortId(shortId, user.id);
  if (service === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  const outcome = await toggleServiceStatus(user.id, service.id, action);
  if (!outcome.ok) {
    await safeAnswerCallback(ctx, outcome.safeUserMessage);
    const current = await getOwnedServiceByShortId(shortId, user.id);
    if (current !== null) {
      await renderServiceDetail(ctx, current);
    }
    return;
  }
  const notice = outcome.alreadyDone
    ? TOGGLE_ALREADY_DONE_TEXT
    : action === "DISABLE"
      ? TOGGLE_DISABLED_OK_TEXT
      : TOGGLE_ENABLED_OK_TEXT;
  await safeAnswerCallback(ctx, notice);
  await renderServiceDetail(ctx, outcome.service);
}

servicesHandler.callbackQuery(/^user:svc:disable:([0-9a-f-]+)$/, async (ctx) => {
  await askToggle(ctx, ctx.match[1], "DISABLE");
});

servicesHandler.callbackQuery(/^user:svc:disable:([0-9a-f-]+):yes$/, async (ctx) => {
  await confirmToggle(ctx, ctx.match[1], "DISABLE");
});

servicesHandler.callbackQuery(/^user:svc:enable:([0-9a-f-]+)$/, async (ctx) => {
  await askToggle(ctx, ctx.match[1], "ENABLE");
});

servicesHandler.callbackQuery(/^user:svc:enable:([0-9a-f-]+):yes$/, async (ctx) => {
  await confirmToggle(ctx, ctx.match[1], "ENABLE");
});

// --- Phase 19: subscription link regeneration --------------------------------
// Ask -> explicit confirmation -> panel revoke -> DB update. The panel is
// NEVER called before «yes»; each confirmed click is an explicit user
// request, so a repeated confirmation simply regenerates again (the success
// screen replaces the confirm button, and the DB always holds the last
// successful link - never a half-written state).

servicesHandler.callbackQuery(/^user:svc:regen_link:([0-9a-f-]+)$/, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const service = await getLinkRegeneratableServiceByShortId(ctx.match[1], user.id);
  if (service === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  // Stale-button guard: legacy per-inbound XUI services never reach the
  // regeneration confirmation (the detail keyboard already hides the button).
  if (!serviceSupportsGlobalLifecycle(service)) {
    await safeAnswerCallback(ctx, XUI_LEGACY_OPERATION_TEXT);
    await renderServiceDetail(ctx, service);
    return;
  }
  const eligibility = linkRegenerationEligibility(service, service.panel.status);
  if (!eligibility.eligible) {
    await safeAnswerCallback(ctx, eligibility.safeUserMessage);
    await renderServiceDetail(ctx, service);
    return;
  }
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    buildLinkRegenerationPreview(service),
    regenLinkConfirmKeyboard(ctx.match[1]),
    HTML,
  );
});

servicesHandler.callbackQuery(/^user:svc:regen_link:([0-9a-f-]+):yes$/, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const service = await getLinkRegeneratableServiceByShortId(ctx.match[1], user.id);
  if (service === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  const outcome = await regenerateServiceSubscription(user.id, service.id);
  if (!outcome.ok) {
    await safeAnswerCallback(ctx, outcome.safeUserMessage);
    const current = await getOwnedServiceByShortId(ctx.match[1], user.id);
    if (current !== null) {
      await renderServiceDetail(ctx, current);
    }
    return;
  }
  await safeAnswerCallback(ctx, REGEN_SUCCESS_TEXT);
  const sid = serviceShortId(outcome.service);
  const lines = [REGEN_SUCCESS_TEXT];
  const hasNewLink =
    outcome.service.subscriptionUrl !== null && outcome.service.subscriptionUrl !== "";
  if (hasNewLink) {
    // <code> is tap-to-copy in official Telegram clients.
    lines.push("", "لینک اشتراک جدید 🔗", `<code>${escapeHtml(outcome.service.subscriptionUrl ?? "")}</code>`);
  }
  const kb = new InlineKeyboard();
  if (hasNewLink) {
    // §7: the QR reuses the owner-scoped qr_sub route, which re-loads the Service
    // and reads the NEWLY stored subscriptionUrl - never stale pre-regen data.
    kb.text("QR لینک جدید 📷", svcCb.qrSub(sid)).row();
  }
  // §16: the guide route always re-loads the current Service, so it uses the
  // NEW link/config state - never the stale pre-regen data.
  const regenGuide = await guideNextButton(outcome.service);
  if (regenGuide !== null) {
    kb.text(regenGuide.label, regenGuide.cb).row();
  }
  kb.text("بازگشت به سرویس", svcCb.view(sid)).row().text("بازگشت به منو", CB.USER_MENU);
  await safeEditOrReply(ctx, lines.join("\n"), kb, HTML);
});

servicesHandler.callbackQuery(/^user:svc:link:([0-9a-f-]+)$/, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const service = await getOwnedServiceByShortId(ctx.match[1], user.id);
  if (service === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  if (service.subscriptionUrl === null || service.subscriptionUrl === "") {
    await safeAnswerCallback(ctx, "لینک اشتراک برای این سرویس ثبت نشده است.");
    return;
  }
  await safeAnswerCallback(ctx);
  // §16: additive «آموزش اتصال 📱» next-action + back nav (existing text link kept).
  const linkSid = serviceShortId(service);
  const linkKb = new InlineKeyboard();
  const linkGuide = await guideNextButton(service);
  if (linkGuide !== null) {
    linkKb.text(linkGuide.label, linkGuide.cb).row();
  }
  linkKb.text("بازگشت به سرویس", svcCb.view(linkSid)).text("بازگشت به منوی اصلی", CB.USER_MENU);
  // <code> is tap-to-copy in official Telegram clients.
  await safeReply(
    ctx,
    `لینک اشتراک شما:\n<code>${escapeHtml(service.subscriptionUrl)}</code>`,
    linkKb,
    HTML,
  );
});

servicesHandler.callbackQuery(/^user:svc:configs:([0-9a-f-]+)$/, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const service = await getOwnedServiceByShortId(ctx.match[1], user.id);
  if (service === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  const links = serviceConfigLinks(service);
  if (links.length === 0) {
    await safeAnswerCallback(ctx, "کانفیگی برای این سرویس ثبت نشده است.");
    return;
  }
  await safeAnswerCallback(ctx);
  const lines = ["کانفیگ‌های سرویس شما:", ""];
  for (const link of links.slice(0, MAX_CONFIGS_SHOWN)) {
    lines.push(`<code>${escapeHtml(link)}</code>`, "");
  }
  if (links.length > MAX_CONFIGS_SHOWN) {
    lines.push(`+${links.length - MAX_CONFIGS_SHOWN} کانفیگ دیگر نمایش داده نشد.`);
  }
  // §16: additive «آموزش اتصال 📱» next-action + back nav (existing configs kept).
  const cfgSid = serviceShortId(service);
  const cfgKb = new InlineKeyboard();
  const cfgGuide = await guideNextButton(service);
  if (cfgGuide !== null) {
    cfgKb.text(cfgGuide.label, cfgGuide.cb).row();
  }
  cfgKb.text("بازگشت به سرویس", svcCb.view(cfgSid)).text("بازگشت به منوی اصلی", CB.USER_MENU);
  await safeReply(ctx, lines.join("\n").trimEnd(), cfgKb, HTML);
});

// --- QR codes (service-config-qrcode phase) ----------------------------------
// ADDITIVE presentation over the SAME stored payloads - the copyable text link /
// config handlers above are unchanged. Every route re-loads the Service
// owner-scoped (never trusts the callback), answers the callback query BEFORE the
// (relatively expensive) QR generation, and is fail-soft: a generation / Telegram
// send failure falls back to the text link and never crashes the bot. Nothing is
// persisted; the QR is regenerated on demand from Service.subscriptionUrl /
// Service.configLinks. The raw payloads never appear in a caption, filename or log.

servicesHandler.callbackQuery(/^user:svc:qr_sub:([0-9a-f-]+)$/, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const service = await getOwnedServiceByShortId(ctx.match[1], user.id);
  if (service === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  if (service.subscriptionUrl === null || service.subscriptionUrl === "") {
    await safeAnswerCallback(ctx, QR_NO_SUBSCRIPTION_TEXT);
    return;
  }
  await safeAnswerCallback(ctx);
  const sid = serviceShortId(service);
  // Additive keyboard: the copyable text link stays one tap away, plus the §16
  // «آموزش اتصال 📱» next-action when the guide entry gate is satisfied.
  const keyboard = new InlineKeyboard().text("لینک متنی 🔗", svcCb.link(sid)).row();
  const subGuide = await guideNextButton(service);
  if (subGuide !== null) {
    keyboard.text(subGuide.label, subGuide.cb).row();
  }
  keyboard.text("بازگشت به سرویس", svcCb.view(sid));
  const outcome = await deliverSubscriptionQr(
    service.subscriptionUrl,
    serviceAccountLabel(service),
    ({ png, caption, filename }) =>
      safeReplyWithPhoto(ctx, new InputFile(png, filename), { caption, keyboard }),
  );
  if (outcome === "GEN_FAILED") {
    await safeReply(ctx, QR_GENERATION_FAILED_TEXT, keyboard);
  } else if (outcome === "SEND_FAILED") {
    await safeReply(ctx, QR_SEND_FAILED_TEXT, keyboard);
  }
});

servicesHandler.callbackQuery(/^user:svc:qr_configs:([0-9a-f-]+)$/, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const service = await getOwnedServiceByShortId(ctx.match[1], user.id);
  if (service === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  const links = serviceConfigLinks(service);
  if (links.length === 0) {
    await safeAnswerCallback(ctx, QR_NO_CONFIGS_TEXT);
    return;
  }
  await safeAnswerCallback(ctx);
  const sid = serviceShortId(service);
  const label = serviceAccountLabel(service);
  // Additive: keep the copyable text configs one tap away (mirrors the
  // subscription QR keyboard's «لینک متنی» button), the §16 «آموزش اتصال 📱»
  // next-action when eligible, then the back navigation.
  const backKb = new InlineKeyboard().text("لینک متنی 📄", svcCb.configs(sid)).row();
  const cfgQrGuide = await guideNextButton(service);
  if (cfgQrGuide !== null) {
    backKb.text(cfgQrGuide.label, cfgQrGuide.cb).row();
  }
  backKb.text("بازگشت به سرویس", svcCb.view(sid));

  // One config -> one photo carrying the back keyboard (§5).
  if (links.length === 1) {
    const qr = await generateQrPng(links[0]);
    if (!qr.ok) {
      await safeReply(ctx, QR_GENERATION_FAILED_TEXT, backKb);
      return;
    }
    const sent = await safeReplyWithPhoto(ctx, new InputFile(qr.png, CONFIG_QR_FILENAME), {
      caption: configQrCaption(1, 1, label),
      keyboard: backKb,
    });
    if (!sent) {
      await safeReply(ctx, QR_SEND_FAILED_TEXT, backKb);
    }
    return;
  }

  // Multiple configs -> bounded, ordered, sequential photos (one QR each, never
  // several joined), then ONE trailing summary + back keyboard.
  const result = await deliverConfigQrCodes(links, label, ({ png, caption, filename }) =>
    safeReplyWithPhoto(ctx, new InputFile(png, filename), { caption }),
  );
  const summary: string[] = [];
  if (result.skipped > 0) {
    summary.push(configOverflowSummary(result.skipped));
  }
  const failedCount = result.genFailed + result.sendFailed;
  if (failedCount > 0) {
    summary.push(configFailureSummary(failedCount));
  }
  if (summary.length === 0) {
    summary.push("کیوآرکد کانفیگ‌ها ارسال شد.");
  }
  await safeReply(ctx, summary.join("\n\n"), backKb);
});

// --- Device connection guides (feat/device-connection-guides) -----------------
// «آموزش اتصال 📱» — operator-managed, per-platform "how to connect" pages under
// an eligible Service. Every route re-loads the Service OWNER-scoped, rechecks
// the master switch (fail-closed), reloads the active guide app, answers the
// callback BEFORE rendering, and never trusts the callback/session as data. No
// Service secret ever enters the guide text, a URL button, a caption or a
// callback — connection payloads stay behind the existing owner-scoped
// link/config/QR callbacks reused here.

/** Detail-page entry gate: null unless the master switch is on, an active app
 * exists AND this Service has a usable connection payload. */
async function buildServiceGuideEntry(service: Service): Promise<{ label: string } | null> {
  if (!(await isConnectionGuideEntryVisible(service))) {
    return null;
  }
  return { label: await guideEntryLabel() };
}

/** «آموزش اتصال 📱» next-action button spec for the link/QR/regen responses (§16),
 * or null when the guide entry gate is not satisfied. Function declaration →
 * hoisted, so the earlier link/config/QR handlers can call it. */
async function guideNextButton(
  service: Service,
): Promise<{ label: string; cb: string } | null> {
  if (!(await isConnectionGuideEntryVisible(service))) {
    return null;
  }
  return { label: await guideEntryLabel(), cb: svcCb.guide(serviceShortId(service)) };
}

/** Clears a pending guide→support handoff (only when one is actually pending),
 * so returning to any guide page cleanly cancels it. */
function clearGuideHandoff(ctx: BotContext): void {
  if (ctx.session.temp.guideSupportContext === undefined) {
    return;
  }
  if (ctx.session.currentFlow === "support:message") {
    ctx.session.currentFlow = null;
  }
  delete ctx.session.temp.supportDraft;
  delete ctx.session.temp.guideSupportContext;
}

/** Owner-scoped reload + master-switch recheck shared by every guide route.
 * Returns the Service, or null after emitting the correct safe response. */
async function requireGuideService(ctx: BotContext, sid: string): Promise<Service | null> {
  const user = ctx.dbUser;
  if (user === null) {
    return null;
  }
  const service = await getOwnedServiceByShortId(sid, user.id);
  if (service === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return null;
  }
  if (!(await isConnectionGuidesEnabled())) {
    // Fail closed: a stale/direct callback while the system is disabled shows a
    // safe notice and never renders any guide content.
    await safeAnswerCallback(ctx);
    const kb = new InlineKeyboard()
      .text("بازگشت به سرویس", svcCb.view(sid))
      .text("بازگشت به منوی اصلی", CB.USER_MENU);
    await safeEditOrReply(ctx, await getMessageTemplate("connection_guides_disabled"), kb);
    return null;
  }
  if (!serviceHasConnectionPayload(service)) {
    // The Service lost its connection payload (subscription/config) after the
    // entry button or a guide page was sent. The entry is normally hidden for
    // this state, so a stale/direct callback must not lead into a dead-end guide
    // with no working action — show the safe no-payload notice instead.
    await safeAnswerCallback(ctx);
    const kb = new InlineKeyboard()
      .text("بازگشت به سرویس", svcCb.view(sid))
      .text("بازگشت به منوی اصلی", CB.USER_MENU);
    await safeEditOrReply(ctx, await getMessageTemplate("connection_guides_no_payload"), kb);
    return null;
  }
  return service;
}

async function renderGuidePlatformSelection(ctx: BotContext, service: Service): Promise<void> {
  const platforms = await getAvailablePlatforms();
  const page = await guidePlatformPage(service, platforms);
  await safeEditOrReply(ctx, page.text, page.keyboard, GUIDE_HTML);
}

async function renderGuideAppSelection(
  ctx: BotContext,
  service: Service,
  platform: Parameters<typeof guideAppPage>[1],
): Promise<void> {
  const apps = await getActiveGuideAppsForPlatform(platform);
  const page = await guideAppPage(service, platform, apps);
  await safeEditOrReply(ctx, page.text, page.keyboard, GUIDE_HTML);
}

// Platform-selection page.
servicesHandler.callbackQuery(/^user:svc:guide:([0-9a-f-]+)$/, async (ctx) => {
  const sid = ctx.match[1];
  const service = await requireGuideService(ctx, sid);
  if (service === null) {
    return;
  }
  clearGuideHandoff(ctx);
  await safeAnswerCallback(ctx);
  await renderGuidePlatformSelection(ctx, service);
});

// Application-selection page for a platform.
servicesHandler.callbackQuery(/^user:svc:guide:([0-9a-f-]+):([a-z0-9]+)$/, async (ctx) => {
  const sid = ctx.match[1];
  const platform = guidePlatformFromCode(ctx.match[2]);
  const service = await requireGuideService(ctx, sid);
  if (service === null) {
    return;
  }
  clearGuideHandoff(ctx);
  await safeAnswerCallback(ctx);
  if (platform === null) {
    await renderGuidePlatformSelection(ctx, service);
    return;
  }
  await renderGuideAppSelection(ctx, service, platform);
});

// Application guide page.
servicesHandler.callbackQuery(/^user:svc:guide:([0-9a-f-]+):([a-z0-9]+):([a-z0-9-]+)$/, async (ctx) => {
  const sid = ctx.match[1];
  const platform = guidePlatformFromCode(ctx.match[2]);
  const slug = ctx.match[3];
  const service = await requireGuideService(ctx, sid);
  if (service === null) {
    return;
  }
  clearGuideHandoff(ctx);
  if (platform === null) {
    await safeAnswerCallback(ctx);
    await renderGuidePlatformSelection(ctx, service);
    return;
  }
  const app = await getActiveGuideAppBySlug(slug);
  if (app === null || app.platform !== platform) {
    // Inactive/removed after the keyboard rendered — safe notice + app list.
    await safeAnswerCallback(ctx, await getMessageTemplate("connection_guides_stale_app"));
    await renderGuideAppSelection(ctx, service, platform);
    return;
  }
  await safeAnswerCallback(ctx);
  const actions = await resolveServiceDetailActions(service);
  const methods = resolveGuideMethods(app, service);
  const page = await guideAppDetailPage(service, platform, app, methods, actions);
  await safeEditOrReply(ctx, page.text, page.keyboard, GUIDE_HTML);
});

/** Safe support handoff subject: device + app only, bounded, never a secret. */
function buildGuideSupportSubject(platformNeutral: string, appName: string): string {
  const subject = `راهنمای اتصال — ${platformNeutral} / ${appName}`;
  return subject.length <= 100 ? subject : subject.slice(0, 100);
}

// Support handoff — seeds a SAFE context and routes into the EXISTING ticket flow.
servicesHandler.callbackQuery(/^user:svc:gsup:([0-9a-f-]+):([a-z0-9]+):([a-z0-9-]+)$/, async (ctx) => {
  const sid = ctx.match[1];
  const pcode = ctx.match[2];
  const platform = guidePlatformFromCode(pcode);
  const slug = ctx.match[3];
  const service = await requireGuideService(ctx, sid);
  if (service === null) {
    return;
  }
  if (platform === null) {
    await safeAnswerCallback(ctx);
    await renderGuidePlatformSelection(ctx, service);
    return;
  }
  const app = await getActiveGuideAppBySlug(slug);
  if (app === null || app.platform !== platform) {
    await safeAnswerCallback(ctx, await getMessageTemplate("connection_guides_stale_app"));
    await renderGuideAppSelection(ctx, service, platform);
    return;
  }
  await safeAnswerCallback(ctx);
  // Seed the existing support MESSAGE flow: the subject encodes the device + app
  // (no secret), and the short-lived, ids-only context lets the prompt show the
  // selection and lets the cancel button return to the exact guide page. The
  // ticket itself is created by the existing support text handler when the user
  // writes their message — no second support engine.
  ctx.session.temp.supportDraft = {
    subject: buildGuideSupportSubject(GUIDE_PLATFORM_NEUTRAL_LABEL[platform], app.displayName),
  };
  ctx.session.temp.guideSupportContext = { sid, pcode, slug };
  ctx.session.currentFlow = "support:message";
  const text = await getMessageTemplate("connection_guides_support_handoff", undefined, {
    service_name: escapeHtml(serviceAccountLabel(service)),
    device: escapeHtml(await platformLabel(platform)),
    app: escapeHtml(app.displayName),
  });
  const kb = new InlineKeyboard()
    .text("انصراف و بازگشت به راهنما", svcCb.guideApp(sid, pcode, slug))
    .row()
    .text("بازگشت به سرویس", svcCb.view(sid));
  await safeEditOrReply(ctx, text, kb, GUIDE_HTML);
});
