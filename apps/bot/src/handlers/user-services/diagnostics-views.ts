import type { Service } from "@zedbot/database";
import {
  clampButtonLabel,
  clampEscapedText,
  type DiagnosticSnapshot,
  GUIDE_PAGE_TEXT_MAX,
  type ServiceDiagnosticAction,
  type ServiceDiagnosticCheckStatus,
  type ServiceDiagnosticOverall,
  type ServiceDiagnosticReport,
} from "@zedbot/shared";
import { InlineKeyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import { diagnosticCheckMessage } from "../../services/service-diagnostics.service.js";
import { isServiceDiagnosticsEnabled } from "../../services/service-diagnostics-settings.service.js";
import { getButtonText, getMessageTemplate } from "../../services/text.service.js";
import { serviceShortId } from "../../services/user-services.service.js";
import { escapeHtml } from "../../utils/html.js";
import { evcb } from "../user-extra-volume/extra-volume-views.js";
import { rncb } from "../user-renewal/renewal-views.js";
import { serviceAccountLabel, svcCb } from "./service-views.js";

// =============================================================================
// Service self-diagnostics — user view layer (feat/service-self-diagnostics).
//
// Assembles the report page + safe action keyboard. ALL text is rendered as
// escaped plain text and the assembled message is clamped under Telegram's
// limit (reusing the hardened PR #116 guide patterns), so operator-edited
// wrapper templates can never break parse_mode: HTML or overflow. Per-check
// lines carry code-constant Persian (behaviour never depends on a label);
// every action button reuses an EXISTING callback.
// =============================================================================

export const DIAG_HTML = { parseMode: "HTML" as const };

/** «بررسی مشکل سرویس 🛠» entry label (editable). */
export async function diagnosticsEntryLabel(): Promise<string> {
  return getButtonText("service_diagnostics");
}

/** Detail-page entry spec, or null when the diagnostics master switch is off. */
export async function buildServiceDiagnosticsEntry(): Promise<{ label: string } | null> {
  if (!(await isServiceDiagnosticsEnabled())) {
    return null;
  }
  return { label: await diagnosticsEntryLabel() };
}

const STATUS_ICON: Record<ServiceDiagnosticCheckStatus, string> = {
  PASS: "✅",
  INFO: "ℹ️",
  WARNING: "⚠️",
  FAIL: "❌",
  UNKNOWN: "❔",
};

const OVERALL_TEMPLATE_KEY: Record<ServiceDiagnosticOverall, string> = {
  HEALTHY: "service_diagnostics_healthy",
  ACTION_REQUIRED: "service_diagnostics_action_required",
  DEGRADED: "service_diagnostics_degraded",
  UNAVAILABLE: "service_diagnostics_unavailable",
  NEEDS_SUPPORT: "service_diagnostics_needs_support",
};

/** Renders an operator-editable diagnostics template as SAFE bounded plain text. */
async function diagTemplateText(
  key: string,
  vars?: Record<string, string>,
): Promise<string> {
  return clampEscapedText(escapeHtml(await getMessageTemplate(key, undefined, vars)));
}

/** Short, tz-neutral timestamp for the evidence line (never a locale surprise). */
function formatCheckedAt(checkedAt: Date): string {
  return `${checkedAt.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** The action → (label source, callback) map. Labels come from ButtonText where
 * a dedicated key exists, else a literal matching the detail keyboard. */
async function actionButton(
  action: ServiceDiagnosticAction,
  sid: string,
): Promise<{ label: string; cb: string } | null> {
  switch (action) {
    case "RETRY_DIAGNOSTIC":
      return { label: await getButtonText("diagnostics_retry"), cb: svcCb.diagRetry(sid) };
    case "REFRESH_SERVICE":
      return { label: await getButtonText("diagnostics_refresh"), cb: svcCb.refresh(sid) };
    case "OPEN_CONNECTION_GUIDE":
      return { label: await getButtonText("diagnostics_open_guide"), cb: svcCb.guide(sid) };
    case "SHOW_SUBSCRIPTION_LINK":
      return { label: "لینک اشتراک 🔗", cb: svcCb.link(sid) };
    case "SHOW_SUBSCRIPTION_QR":
      return { label: "QR اشتراک 📷", cb: svcCb.qrSub(sid) };
    case "SHOW_CONFIGS":
      return { label: "کانفیگ‌ها 📄", cb: svcCb.configs(sid) };
    case "SHOW_CONFIG_QRS":
      return { label: "QR کانفیگ‌ها 📷", cb: svcCb.qrConfigs(sid) };
    case "ENABLE_SERVICE":
      return { label: "روشن کردن سرویس ▶️", cb: svcCb.enable(sid) };
    case "RENEW_SERVICE":
      return { label: "تمدید سرویس ♻️", cb: rncb.service(sid) };
    case "BUY_EXTRA_VOLUME":
      return { label: "خرید حجم اضافه ➕", cb: evcb.service(sid) };
    case "REGENERATE_LINK":
      return { label: "تغییر لینک 🔄", cb: svcCb.regenLink(sid) };
    case "OPEN_SUPPORT":
      return { label: await getButtonText("diagnostics_send_support"), cb: svcCb.diagSupport(sid) };
    default:
      return null;
  }
}

export interface DiagnosticPage {
  text: string;
  keyboard: InlineKeyboard;
}

/** Builds the full report page (message + safe action keyboard). */
export async function renderDiagnosticReport(
  service: Service,
  report: ServiceDiagnosticReport,
): Promise<DiagnosticPage> {
  const sid = serviceShortId(service);
  const intro = await diagTemplateText("service_diagnostics_report_intro", {
    service_name: serviceAccountLabel(service),
  });
  const headline = await diagTemplateText(OVERALL_TEMPLATE_KEY[report.overall]);

  const checkLines = report.checks
    .map((check) => `${STATUS_ICON[check.status]} ${escapeHtml(check.userMessage)}`)
    .join("\n");

  const evidenceKey =
    report.evidenceSource === "LIVE_PANEL"
      ? "service_diagnostics_live_evidence"
      : "service_diagnostics_stored_evidence";
  const evidence = await diagTemplateText(evidenceKey, {
    checked_at: formatCheckedAt(report.checkedAt),
  });

  const text = clampEscapedText(
    [intro, "", headline, "", "بررسی‌ها:", checkLines, "", evidence].join("\n"),
    GUIDE_PAGE_TEXT_MAX,
  );

  const kb = new InlineKeyboard();
  for (const action of report.recommendedActions) {
    const button = await actionButton(action, sid);
    if (button !== null) {
      kb.text(clampButtonLabel(button.label), button.cb).row();
    }
  }
  kb.text(await getButtonText("diagnostics_back_service"), svcCb.view(sid)).text(
    "بازگشت به منوی اصلی",
    CB.USER_MENU,
  );
  return { text, keyboard: kb };
}

/** The running («در حال بررسی...») transient page. */
export async function diagnosticRunningText(): Promise<string> {
  return diagTemplateText("service_diagnostics_running");
}

/** A single back button so the transient running/cooldown pages are never a
 * dead end (nav-integrity: every safeEditOrReply passes a keyboard). */
export async function diagnosticBackKeyboard(sid: string): Promise<InlineKeyboard> {
  return new InlineKeyboard().text(
    await getButtonText("diagnostics_back_service"),
    svcCb.view(sid),
  );
}

/** Cooldown page: shows the remaining seconds + retry/back (never a lockout). */
export async function renderCooldownPage(
  sid: string,
  remainingSeconds: number,
): Promise<DiagnosticPage> {
  const text = await diagTemplateText("service_diagnostics_cooldown", {
    seconds: String(remainingSeconds),
  });
  const kb = new InlineKeyboard()
    .text(await getButtonText("diagnostics_retry"), svcCb.diagRetry(sid))
    .row()
    .text(await getButtonText("diagnostics_back_service"), svcCb.view(sid));
  return { text, keyboard: kb };
}

/** The disabled / stale-report page (master switch off, or a lost snapshot). */
export async function renderDiagnosticNotice(
  sid: string,
  templateKey: string,
): Promise<DiagnosticPage> {
  const text = await diagTemplateText(templateKey);
  const kb = new InlineKeyboard()
    .text(await getButtonText("service_diagnostics"), svcCb.diag(sid))
    .row()
    .text(await getButtonText("diagnostics_back_service"), svcCb.view(sid));
  return { text, keyboard: kb };
}

/** The armed «write your message» prompt after the user confirms the handoff. */
export async function renderSupportArmedPrompt(sid: string): Promise<DiagnosticPage> {
  const text = await diagTemplateText("service_diagnostics_support_prompt");
  const kb = new InlineKeyboard().text(
    await getButtonText("diagnostics_back_service"),
    svcCb.view(sid),
  );
  return { text, keyboard: kb };
}

/**
 * The support-handoff preview: the SAFE snapshot summary (overall + per-check
 * code lines, all code-constant Persian — no secret, no payload) plus the prompt
 * to write a message. Confirm arms the EXISTING support ticket flow; cancel
 * returns to the service (which clears the handoff via the guard middleware).
 */
export async function renderSupportPreview(
  service: Service,
  snapshot: DiagnosticSnapshot,
): Promise<DiagnosticPage> {
  const sid = serviceShortId(service);
  const previewIntro = await diagTemplateText("service_diagnostics_support_preview");
  const headline = await diagTemplateText(OVERALL_TEMPLATE_KEY[snapshot.overall]);
  const checkLines = snapshot.checks
    .map((check) => `${STATUS_ICON[check.status]} ${escapeHtml(diagnosticCheckMessage(check.code))}`)
    .join("\n");
  const prompt = await diagTemplateText("service_diagnostics_support_prompt");

  const text = clampEscapedText(
    [
      previewIntro,
      "",
      escapeHtml(serviceAccountLabel(service)),
      "",
      headline,
      "",
      "بررسی‌ها:",
      checkLines,
      "",
      prompt,
    ].join("\n"),
    GUIDE_PAGE_TEXT_MAX,
  );
  const kb = new InlineKeyboard()
    .text(clampButtonLabel(await getButtonText("diagnostics_send_support")), svcCb.diagSupportYes(sid))
    .row()
    .text(await getButtonText("diagnostics_back_service"), svcCb.view(sid));
  return { text, keyboard: kb };
}
