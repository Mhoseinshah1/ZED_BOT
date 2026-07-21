import type { Service, ServiceStatus } from "@zedbot/database";
import {
  clampEscapedText,
  clampHtmlMessage,
  GUIDE_PAGE_TEXT_MAX,
  GUIDE_PLATFORM_CODE,
  validateHttpsDownloadUrl,
  type GuidePlatform,
} from "@zedbot/shared";
import { InlineKeyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import type { ConnectionGuideApp, GuideMethodAvailability } from "../../services/connection-guide.service.js";
import { getButtonText, getMessageTemplate } from "../../services/text.service.js";
import type { ServiceDetailActions } from "../../services/user-services.service.js";
import { escapeHtml } from "../../utils/html.js";
import { evcb } from "../user-extra-volume/extra-volume-views.js";
import { rncb } from "../user-renewal/renewal-views.js";
import { serviceAccountLabel, svcCb } from "./service-views.js";

// =============================================================================
// Device connection guides — user view layer (feat/device-connection-guides).
// Pure-ish async builders: they read editable copy (MessageTemplate/ButtonText)
// and assemble the platform / app / guide pages + keyboards. They NEVER embed a
// Service secret in text, a caption, a URL button or a callback: connection
// payloads stay behind the existing owner-scoped link/config/QR callbacks, and
// download buttons carry ONLY the operator's validated HTTPS URL. Operator copy
// (app name, instructions, troubleshooting) is HTML-escaped.
// =============================================================================

const HTML = { parseMode: "HTML" as const };

/** Editable button-text key per platform (labels never drive routing). */
const PLATFORM_BUTTON_KEY: Record<GuidePlatform, string> = {
  IOS: "guide_platform_ios",
  ANDROID: "guide_platform_android",
  WINDOWS: "guide_platform_windows",
  MACOS: "guide_platform_macos",
  LINUX: "guide_platform_linux",
  ANDROID_TV: "guide_platform_android_tv",
};

/** Per-status built-in decision copy (§13). */
const STATUS_TEMPLATE_KEY: Partial<Record<ServiceStatus, string>> = {
  ACTIVE: "connection_guides_service_active",
  DISABLED: "connection_guides_service_disabled",
  EXPIRED: "connection_guides_service_expired",
  LIMITED: "connection_guides_service_limited",
};

/** Statuses for which the full guide (methods/instructions/downloads) is shown.
 * FAILED / CREATING / DELETED get the safe "unavailable" variant instead. */
const CONNECTABLE_STATUSES: ReadonlySet<ServiceStatus> = new Set([
  "ACTIVE",
  "DISABLED",
  "EXPIRED",
  "LIMITED",
]);

export function guideStatusShowsFullGuide(status: ServiceStatus): boolean {
  return CONNECTABLE_STATUSES.has(status);
}

export async function platformLabel(platform: GuidePlatform): Promise<string> {
  return getButtonText(PLATFORM_BUTTON_KEY[platform]);
}

/** The «آموزش اتصال 📱» entry label (editable). */
export async function guideEntryLabel(): Promise<string> {
  return getButtonText("service_connection_guide");
}

interface Page {
  text: string;
  keyboard: InlineKeyboard;
}

function backToServiceRow(kb: InlineKeyboard, sid: string): InlineKeyboard {
  return kb.text("بازگشت به سرویس", svcCb.view(sid)).text("بازگشت به منوی اصلی", CB.USER_MENU);
}


/** Platform-selection page — only platforms with >=1 active app are shown. */
export async function guidePlatformPage(
  service: Service,
  platforms: GuidePlatform[],
): Promise<Page> {
  const sid = service.id.slice(0, 8);
  const label = serviceAccountLabel(service);
  if (platforms.length === 0) {
    const kb = backToServiceRow(new InlineKeyboard(), sid);
    return { text: await getMessageTemplate("connection_guides_no_apps"), keyboard: kb };
  }
  const text = await getMessageTemplate("connection_guides_choose_platform", undefined, {
    service_name: escapeHtml(label),
  });
  const kb = new InlineKeyboard();
  for (const p of platforms) {
    kb.text(await platformLabel(p), svcCb.guidePlatform(sid, GUIDE_PLATFORM_CODE[p])).row();
  }
  backToServiceRow(kb, sid);
  return { text, keyboard: kb };
}

/** Application-selection page for a platform. */
export async function guideAppPage(
  service: Service,
  platform: GuidePlatform,
  apps: ConnectionGuideApp[],
): Promise<Page> {
  const sid = service.id.slice(0, 8);
  const pcode = GUIDE_PLATFORM_CODE[platform];
  const device = await platformLabel(platform);
  if (apps.length === 0) {
    const kb = new InlineKeyboard()
      .text(await getButtonText("guide_back_platforms"), svcCb.guide(sid))
      .row();
    backToServiceRow(kb, sid);
    return { text: await getMessageTemplate("connection_guides_stale_app"), keyboard: kb };
  }
  const text = await getMessageTemplate("connection_guides_choose_app", undefined, {
    service_name: escapeHtml(serviceAccountLabel(service)),
    device: escapeHtml(device),
  });
  const kb = new InlineKeyboard();
  for (const app of apps) {
    kb.text(`${app.iconEmoji} ${app.displayName}`, svcCb.guideApp(sid, pcode, app.slug)).row();
  }
  kb.text(await getButtonText("guide_back_platforms"), svcCb.guide(sid)).row();
  backToServiceRow(kb, sid);
  return { text, keyboard: kb };
}

/** Builds the app guide page (§10-§14). */
export async function guideAppDetailPage(
  service: Service,
  platform: GuidePlatform,
  app: ConnectionGuideApp,
  methods: GuideMethodAvailability,
  actions: ServiceDetailActions,
): Promise<Page> {
  const sid = service.id.slice(0, 8);
  const pcode = GUIDE_PLATFORM_CODE[platform];
  const accountLabel = serviceAccountLabel(service);
  const showFull = guideStatusShowsFullGuide(service.status);

  const intro = await getMessageTemplate("connection_guides_app_page_intro", undefined, {
    app: escapeHtml(app.displayName),
    service_name: escapeHtml(accountLabel),
  });
  const lines: string[] = [intro];

  const kb = new InlineKeyboard();

  if (showFull) {
    // Built-in status decision line (§13) — always kept (short, important).
    const statusKey = STATUS_TEMPLATE_KEY[service.status];
    const statusLine = statusKey !== undefined ? await getMessageTemplate(statusKey) : null;

    // Operator instructions — escaped, rendered verbatim (no placeholder/secret
    // substitution). Troubleshooting appended when present. The whole message
    // must fit Telegram's 4096-char limit or BOTH the edit and the reply fallback
    // fail silently, so the operator body is clamped to the budget left after the
    // intro/status/separators.
    let body = escapeHtml(app.instructions.trim());
    if (app.troubleshooting.trim() !== "") {
      body += `\n\n${escapeHtml(app.troubleshooting.trim())}`;
    }
    const reserved = intro.length + (statusLine?.length ?? 0) + 8; // separators/newlines
    body = clampEscapedText(body, Math.max(0, GUIDE_PAGE_TEXT_MAX - reserved));
    lines.push("", body);
    if (statusLine !== null) {
      lines.push("", statusLine);
    }

    // Method buttons reuse the EXISTING owner-scoped callbacks (no second path).
    // The QR button is keyed to the payload, not to the text-link flag, so a
    // QR-only app still renders a standalone QR action.
    if (methods.subscription || methods.qrSubscription) {
      if (methods.subscription) {
        kb.text("لینک اشتراک 🔗", svcCb.link(sid));
      }
      if (methods.qrSubscription) {
        kb.text("QR اشتراک 📷", svcCb.qrSub(sid));
      }
      kb.row();
    }
    if (methods.configs || methods.qrConfigs) {
      if (methods.configs) {
        kb.text("کانفیگ‌ها 📄", svcCb.configs(sid));
      }
      if (methods.qrConfigs) {
        kb.text("QR کانفیگ‌ها 📷", svcCb.qrConfigs(sid));
      }
      kb.row();
    }

    // Download buttons — validated HTTPS URL buttons only (re-validated here so a
    // legacy/corrupt record can never render an unsafe URL button).
    const primary = validateHttpsDownloadUrl(app.primaryDownloadUrl);
    if (primary.ok) {
      kb.url(await getButtonText("guide_download_primary"), primary.url).row();
    }
    if (app.alternateDownloadUrl !== null) {
      const alt = validateHttpsDownloadUrl(app.alternateDownloadUrl);
      if (alt.ok) {
        kb.url(await getButtonText("guide_download_alternate"), alt.url).row();
      }
    }

    // Status-eligible actions reuse the existing detail-page routes (§13).
    if (service.status === "DISABLED" && actions.toggleAction === "ENABLE") {
      kb.text("روشن کردن سرویس ▶️", svcCb.enable(sid)).row();
    }
    if (service.status === "EXPIRED" && actions.canRenew) {
      kb.text("تمدید سرویس ♻️", rncb.service(sid)).row();
    }
    if (service.status === "LIMITED") {
      if (actions.canBuyExtraVolume) {
        kb.text("خرید حجم اضافه ➕", evcb.service(sid));
      }
      if (actions.canRenew) {
        kb.text("تمدید سرویس ♻️", rncb.service(sid));
      }
      if (actions.canBuyExtraVolume || actions.canRenew) {
        kb.row();
      }
    }
  } else {
    // FAILED / CREATING / DELETED — never present a usable-looking guide.
    lines.push("", await getMessageTemplate("connection_guides_service_unavailable"));
  }

  // Support handoff (§14) + navigation.
  kb.text(await getButtonText("guide_support"), svcCb.guideSupport(sid, pcode, app.slug)).row();
  kb.text(await getButtonText("guide_back_apps"), svcCb.guidePlatform(sid, pcode)).row();
  backToServiceRow(kb, sid);

  // Final guard: even after the per-body budget, an operator who edited the intro
  // or a status template to extreme lengths could still push the whole message
  // past Telegram's limit. The intro/status templates are LIVE HTML (rendered with
  // `parse_mode: HTML`), so this uses the tag-balancing clamp — it never cuts
  // inside a tag and re-closes any tag the cut left open, so the send can never
  // fail (whether from over-length or malformed HTML).
  return { text: clampHtmlMessage(lines.join("\n"), GUIDE_PAGE_TEXT_MAX), keyboard: kb };
}

export { HTML as GUIDE_HTML };
