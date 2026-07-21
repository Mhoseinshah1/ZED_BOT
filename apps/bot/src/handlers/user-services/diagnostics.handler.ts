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

// -----------------------------------------------------------------------------
// §1 handoff-cleanup contract. A diagnostic support handoff is TWO pieces of
// session state: the ARMED message flow (`currentFlow === "support:message"` +
// the seeded `supportDraft`), and the stored SNAPSHOT context
// (`diagnosticSupportContext`) the preview/confirm reuse without a second read.
//
//   disarmDiagnosticSupportMessage — cancels ONLY the armed flow (+ draft). Safe
//     to call unconditionally: a no-op when nothing is armed. Never touches the
//     snapshot, so a valid preview/confirm can still reuse it.
//   clearDiagnosticSupportContext — drops ONLY the stored snapshot context.
//   clearDiagnosticHandoff — both, for every early-return / fail-closed path.
//
// The invariant every diagnostic route enforces: cancel the armed flow FIRST,
// before any master-switch / ownership / Service check, so a stale keyboard can
// never turn the user's next ordinary message into a ticket for a
// previously-armed service. ONLY a fully-validated `:sup_yes` re-arms.
// -----------------------------------------------------------------------------

/** Cancels an armed support-message handoff (flow + seeded draft) WITHOUT
 * touching the stored snapshot. Idempotent: a no-op when nothing is armed. */
function disarmDiagnosticSupportMessage(ctx: BotContext): void {
  if (ctx.session.currentFlow === "support:message") {
    ctx.session.currentFlow = null;
  }
  delete ctx.session.temp.supportDraft;
}

/** Drops the stored diagnostic snapshot context (the preview/confirm payload). */
function clearDiagnosticSupportContext(ctx: BotContext): void {
  delete ctx.session.temp.diagnosticSupportContext;
}

/** Fully clears a diagnostic support handoff: the armed flow AND the snapshot.
 * Used on every early-return / fail-closed path so nothing survives to capture
 * the user's next message or be re-armed against a stale snapshot. */
function clearDiagnosticHandoff(ctx: BotContext): void {
  disarmDiagnosticSupportMessage(ctx);
  clearDiagnosticSupportContext(ctx);
}

/** Owner-scoped reload + master-switch recheck shared by every diagnostics route.
 * Returns the Service, or null after emitting the correct safe response. Any
 * thrown master-switch / ownership / DB error fails CLOSED (returns null with the
 * not-found toast) so the caller drops the whole handoff. */
async function requireDiagnosableService(
  ctx: BotContext,
  sid: string,
): Promise<Awaited<ReturnType<typeof getOwnedServiceByShortId>>> {
  const user = ctx.dbUser;
  if (user === null) {
    return null;
  }
  try {
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
  } catch {
    // Master-switch read or ownership/DB lookup failure: never surface details,
    // never leave a handoff armed. The caller (enterDiagnosticRoute) clears it.
    await safeAnswerCallback(ctx, NOT_FOUND);
    return null;
  }
}

/**
 * The shared entry gate for EVERY diagnostic callback. §1 order of operations:
 *   1. cancel any armed support-message handoff FIRST (before every check), and
 *   2. owner-reload the Service under the master switch, then
 *   3. on ANY early return (disabled, unknown/foreign/ambiguous id, dbUser
 *      absent, DB failure) ALSO drop the stale snapshot context.
 * Returns the Service on success — the caller decides whether to keep (preview),
 * replace (a fresh run) or re-arm (confirm) the snapshot — or null after the
 * correct safe response has been emitted.
 */
async function enterDiagnosticRoute(
  ctx: BotContext,
  sid: string,
): Promise<Awaited<ReturnType<typeof getOwnedServiceByShortId>>> {
  disarmDiagnosticSupportMessage(ctx);
  const service = await requireDiagnosableService(ctx, sid);
  if (service === null) {
    // Every early return leaves NOTHING behind — flow AND snapshot both cleared.
    clearDiagnosticHandoff(ctx);
    return null;
  }
  return service;
}

/** Runs one diagnosis (respecting the cooldown) and renders the report. */
async function handleDiagRun(ctx: BotContext, sid: string): Promise<void> {
  const user = ctx.dbUser;
  // §1: cancel any armed handoff FIRST; an early return also drops the snapshot.
  // A successful run REPLACES the snapshot below, so the armed flow never
  // survives a fresh run/retry (only a validated `:sup_yes` re-arms).
  const service = await enterDiagnosticRoute(ctx, sid);
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
  // §1: enterDiagnosticRoute DISARMS any armed handoff first (a stale keyboard
  // from an older message can never leave the user's next message captured), and
  // drops the snapshot on an early return. A VALID preview keeps the latest
  // unarmed snapshot; only `:sup_yes` re-arms.
  const service = await enterDiagnosticRoute(ctx, sid);
  if (service === null) {
    return;
  }
  await safeAnswerCallback(ctx);
  const pending = ctx.session.temp.diagnosticSupportContext;
  if (pending === undefined || pending.sid !== sid || pending.serviceId !== service.id) {
    clearDiagnosticSupportContext(ctx);
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
  // §1: enterDiagnosticRoute disarms first + drops the snapshot on any early
  // return. This route is the ONLY one that may re-arm — and only after every
  // check AND the snapshot match below succeed.
  const service = await enterDiagnosticRoute(ctx, sid);
  if (service === null || user === null) {
    return;
  }
  const pending = ctx.session.temp.diagnosticSupportContext;
  if (pending === undefined || pending.sid !== sid || pending.serviceId !== service.id) {
    // A stale/mismatched confirm must never re-arm: the handoff is already
    // disarmed above; drop the snapshot too before showing the stale page.
    clearDiagnosticSupportContext(ctx);
    await safeAnswerCallback(ctx);
    const page = await renderDiagnosticNotice(sid, "service_diagnostics_stale");
    await safeEditOrReply(ctx, page.text, page.keyboard, DIAG_HTML);
    return;
  }
  await safeAnswerCallback(ctx);
  // Arm the existing support MESSAGE step. The snapshot context (already set) is
  // consumed by supportTextHandler, which re-resolves ownership before attaching.
  // Support Tickets V2: the diagnostics handoff opens a normal ticket through the
  // SAME engine, pre-classified CONNECTION / SERVICE_DIAGNOSTICS and linked to the
  // exact owner-scoped Service. The strict snapshot stays in diagnosticSupportContext.
  ctx.session.temp.supportDraft = {
    subject: diagnosticSupportSubject(service.username),
    category: "CONNECTION",
    origin: "SERVICE_DIAGNOSTICS",
    serviceId: service.id,
  };
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
