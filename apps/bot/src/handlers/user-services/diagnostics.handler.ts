import { Composer } from "grammy";

import type { BotContext } from "../../core/context.js";
import { isServiceDiagnosticsEnabled } from "../../services/service-diagnostics-settings.service.js";
import {
  checkDiagnosticsCooldown,
  logDiagnosticCooldownHit,
  logDiagnosticSupportHandoff,
  runServiceDiagnostics,
  snapshotForSupport,
} from "../../services/service-diagnostics.service.js";
import { getOwnedServiceByShortId } from "../../services/user-services.service.js";
import { safeAnswerCallback, safeEditOrReply } from "../../utils/safe-reply.js";
import {
  DIAG_HTML,
  diagnosticBackKeyboard,
  diagnosticRunningText,
  renderCooldownPage,
  renderDiagnosticNotice,
  renderDiagnosticReport,
  renderSupportArmedPrompt,
  renderSupportPreview,
} from "./diagnostics-views.js";

// =============================================================================
// Service self-diagnostics — user callbacks (feat/service-self-diagnostics).
//
// Routes (all emitting the single prefix `user:svc:diag:` for the nav scan):
//   user:svc:diag:<sid>          — run one diagnosis + render the report
//   user:svc:diag:<sid>:retry    — same, still bound by the cooldown
//   user:svc:diag:<sid>:support  — SAFE snapshot preview + confirm
//   user:svc:diag:<sid>:sup_yes  — arm the EXISTING support ticket flow
//
// Every route re-validates ctx.dbUser, resolves the Service OWNER-scoped, and
// re-checks the master switch (fail closed) — a stale/direct callback while the
// system is disabled does nothing. No route ever mutates a Service or panel.
// =============================================================================

export const diagnosticsHandler = new Composer<BotContext>();

const NOT_FOUND = "مورد یافت نشد.";
const DISABLED_TOAST = "بررسی مشکل سرویس در حال حاضر در دسترس نیست.";

/** Owner-scoped reload + master-switch recheck shared by every diagnostics route.
 * Returns the Service, or null after emitting the correct safe response. */
async function requireDiagnosableService(
  ctx: BotContext,
  sid: string,
): Promise<Awaited<ReturnType<typeof getOwnedServiceByShortId>>> {
  const user = ctx.dbUser;
  if (user === null) {
    return null;
  }
  if (!(await isServiceDiagnosticsEnabled())) {
    await safeAnswerCallback(ctx, DISABLED_TOAST);
    return null;
  }
  const service = await getOwnedServiceByShortId(sid, user.id);
  if (service === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return null;
  }
  return service;
}

/** Runs one diagnosis (respecting the cooldown) and renders the report. */
async function handleDiagRun(ctx: BotContext, sid: string): Promise<void> {
  const user = ctx.dbUser;
  const service = await requireDiagnosableService(ctx, sid);
  if (service === null || user === null) {
    return;
  }
  // Answer immediately (§7 step 4) so the client stops the loading spinner.
  await safeAnswerCallback(ctx);

  const cooldown = await checkDiagnosticsCooldown(user.id, service.id);
  if (cooldown.onCooldown) {
    await logDiagnosticCooldownHit(user.id, service.id);
    const page = await renderCooldownPage(sid, cooldown.remainingSeconds);
    await safeEditOrReply(ctx, page.text, page.keyboard, DIAG_HTML);
    return;
  }

  // Transient «در حال بررسی...» state while the one bounded panel read runs.
  await safeEditOrReply(
    ctx,
    await diagnosticRunningText(),
    await diagnosticBackKeyboard(sid),
    DIAG_HTML,
  );

  const run = await runServiceDiagnostics(service, user.id);
  // Keep the SAFE snapshot for the support preview/confirm WITHOUT a second read.
  ctx.session.temp.diagnosticSupportContext = {
    sid,
    serviceId: service.id,
    snapshot: snapshotForSupport(run.report, run.primary),
    primary: run.primary,
  };
  const page = await renderDiagnosticReport(run.service, run.report);
  await safeEditOrReply(ctx, page.text, page.keyboard, DIAG_HTML);
}

diagnosticsHandler.callbackQuery(/^user:svc:diag:([0-9a-f-]+)$/, async (ctx) => {
  await handleDiagRun(ctx, ctx.match[1]);
});

diagnosticsHandler.callbackQuery(/^user:svc:diag:([0-9a-f-]+):retry$/, async (ctx) => {
  await handleDiagRun(ctx, ctx.match[1]);
});

// Support preview: show the SAFE snapshot summary + a confirm button. Uses the
// snapshot stored at render time — no second panel read. A lost/mismatched
// snapshot routes the user to re-run (never attaches a stale/foreign report).
diagnosticsHandler.callbackQuery(/^user:svc:diag:([0-9a-f-]+):support$/, async (ctx) => {
  const sid = ctx.match[1];
  const service = await requireDiagnosableService(ctx, sid);
  if (service === null) {
    return;
  }
  await safeAnswerCallback(ctx);
  const pending = ctx.session.temp.diagnosticSupportContext;
  if (pending === undefined || pending.sid !== sid || pending.serviceId !== service.id) {
    const page = await renderDiagnosticNotice(sid, "service_diagnostics_stale");
    await safeEditOrReply(ctx, page.text, page.keyboard, DIAG_HTML);
    return;
  }
  const preview = await renderSupportPreview(service, pending.snapshot);
  await safeEditOrReply(ctx, preview.text, preview.keyboard, DIAG_HTML);
});

// Confirm: arm the EXISTING support MESSAGE flow (subject seeded; the snapshot
// context is already stored). The ticket + snapshot are created by the support
// text handler when the user writes their message — no second support engine.
diagnosticsHandler.callbackQuery(/^user:svc:diag:([0-9a-f-]+):sup_yes$/, async (ctx) => {
  const sid = ctx.match[1];
  const user = ctx.dbUser;
  const service = await requireDiagnosableService(ctx, sid);
  if (service === null || user === null) {
    return;
  }
  const pending = ctx.session.temp.diagnosticSupportContext;
  if (pending === undefined || pending.sid !== sid || pending.serviceId !== service.id) {
    await safeAnswerCallback(ctx);
    const page = await renderDiagnosticNotice(sid, "service_diagnostics_stale");
    await safeEditOrReply(ctx, page.text, page.keyboard, DIAG_HTML);
    return;
  }
  await safeAnswerCallback(ctx);
  // Arm the existing support MESSAGE step. The snapshot context (already set) is
  // consumed by supportTextHandler, which re-resolves ownership before attaching.
  ctx.session.temp.supportDraft = { subject: diagnosticSupportSubject(service.username) };
  ctx.session.currentFlow = "support:message";
  await logDiagnosticSupportHandoff(user.id, service.id);
  const prompt = await renderSupportArmedPrompt(sid);
  await safeEditOrReply(ctx, prompt.text, prompt.keyboard, DIAG_HTML);
});

/** Bounded, secret-free ticket subject for a diagnostics handoff (username is
 * already part of the approved service UI). */
function diagnosticSupportSubject(username: string): string {
  const subject = `بررسی مشکل سرویس — ${username}`;
  return subject.length <= 100 ? subject : subject.slice(0, 100);
}
