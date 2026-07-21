import { prisma, type Panel, type Service, type User } from "@zedbot/database";
import {
  encryptSecret,
  SERVICE_DIAGNOSTICS_ENABLED_KEY,
  validateDiagnosticSnapshot,
} from "@zedbot/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// encryptSecret (used to seed the test panel's credentials) reads APP_SECRET at
// call time; CI does not export it for the bot test process, so set a local
// fallback here (same pattern as service-live-sync.test.ts) — never overriding a
// real one.
process.env.APP_SECRET ??= "service-diagnostics-tests-secret-1";

// One controllable panel read: the mocked adapter records every call so tests can
// assert AT MOST ONE authenticated read per diagnosis and control its outcome.
const panelState = vi.hoisted(() => ({ account: { ok: false } as Record<string, unknown>, reads: 0 }));
vi.mock("../src/services/panel-adapter-factory.js", () => ({
  buildAdapterForPanel: () => ({
    getServiceAccount: async () => {
      panelState.reads += 1;
      return panelState.account;
    },
  }),
  normalizeSubscriptionBase: () => null,
}));

import { initialSession, type SessionData } from "../src/core/session.js";
import { diagnosticsHandler } from "../src/handlers/user-services/diagnostics.handler.js";
import { supportTextHandler } from "../src/handlers/user-support/support.handler.js";
import {
  buildServiceDiagnosticsEntry,
  renderDiagnosticReport,
} from "../src/handlers/user-services/diagnostics-views.js";
import {
  checkDiagnosticsCooldown,
  runServiceDiagnostics,
  snapshotForSupport,
} from "../src/services/service-diagnostics.service.js";
import { clearCooldown, serviceDiagnosticsCooldownKey } from "../src/services/service-lock.service.js";
import { createSupportTicket, getAdminTicketDetail } from "../src/services/support-ticket.service.js";
import { clearSettingsCache, setSetting } from "../src/services/settings.service.js";
import { getOwnedServiceById } from "../src/services/user-services.service.js";

// =============================================================================
// Service self-diagnostics — DB + Redis integration. Covers the master switch,
// owner scoping, the ONE-read guarantee, update-only-on-success, cooldown, the
// safe support snapshot round-trip through a real ticket, and Telegram safety.
// Skips without DATABASE_URL / REDIS.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const hasRedis = (process.env.REDIS_URL ?? "") !== "" || (process.env.REDIS_HOST ?? "") !== "";
const d = hasDb && hasRedis ? describe : describe.skip;

const GIB = 1024n * 1024n * 1024n;
const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
const SUB_SECRET = "https://sub.example.com/SUBSCRIPTIONSECRET?token=DEADBEEF";

let panel: Panel;
let owner: User;
let foreigner: User;
let service: Service;
let seq = 0;

async function makeUser(): Promise<User> {
  seq += 1;
  return prisma.user.create({ data: { telegramId: runTag + BigInt(seq) } });
}

beforeAll(async () => {
  if (!hasDb || !hasRedis) {
    return;
  }
  panel = await prisma.panel.create({
    data: {
      type: "MARZBAN",
      name: `diag-mz-${runTag}`,
      baseUrl: "http://127.0.0.1:1/api",
      username: "u",
      passwordEncrypted: encryptSecret("p"),
      status: "ACTIVE",
      provisioningReady: true,
    },
  });
  owner = await makeUser();
  foreigner = await makeUser();
  service = await prisma.service.create({
    data: {
      userId: owner.id,
      panelId: panel.id,
      panelType: "MARZBAN",
      username: `diag-svc-${runTag}`,
      status: "ACTIVE",
      volumeBytes: 10n * GIB,
      usedBytes: 0n,
      remainingBytes: 10n * GIB,
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
      subscriptionUrl: SUB_SECRET,
      lastSubscriptionUpdateAt: new Date(Date.now() - 3_600_000),
    },
  });
  await setSetting(SERVICE_DIAGNOSTICS_ENABLED_KEY, "true", "BOOLEAN");
  clearSettingsCache();
});

afterAll(async () => {
  if (!hasDb || !hasRedis) {
    return;
  }
  // Restore the DB-wide master switch to its default (off) so this file never
  // leaks an enabled diagnostics flag into other test files sharing the DB.
  await setSetting(SERVICE_DIAGNOSTICS_ENABLED_KEY, "false", "BOOLEAN").catch(() => undefined);
  clearSettingsCache();
  await clearCooldown(serviceDiagnosticsCooldownKey(owner.id, service.id)).catch(() => undefined);
});

interface Btn {
  text: string;
  data?: string;
  url?: string;
}
function flatButtons(markup: unknown): Btn[] {
  const kb = (markup as { inline_keyboard?: Array<Array<Record<string, string>>> })?.inline_keyboard;
  if (!Array.isArray(kb)) return [];
  return kb.flat().map((b) => ({ text: b.text, data: b.callback_data, url: b.url }));
}
function fakeCtx(data: string, user: User | null, session = initialSession()) {
  const cap = { edits: [] as Array<{ text: string; buttons: Btn[] }>, toasts: [] as Array<string | undefined> };
  const callbackQuery = { id: "c", data, message: { message_id: 5, chat: { id: 1, type: "private" } } };
  const ctx = {
    session,
    dbUser: user,
    from: { id: 1, first_name: "T" },
    callbackQuery,
    update: { update_id: 1, callback_query: callbackQuery },
    match: undefined as unknown,
    reply: async () => ({}),
    editMessageText: async (text: string, other?: { reply_markup?: unknown }) => {
      cap.edits.push({ text, buttons: flatButtons(other?.reply_markup) });
      return {};
    },
    answerCallbackQuery: async (p?: { text?: string }) => {
      cap.toasts.push(p?.text);
      return true;
    },
  };
  return { ctx: ctx as never, cap, session };
}
async function runHandler(
  data: string,
  user: User | null,
  session = initialSession(),
): Promise<{ edits: Array<{ text: string; buttons: Btn[] }>; toasts: Array<string | undefined> }> {
  const { ctx, cap } = fakeCtx(data, user, session);
  await diagnosticsHandler.middleware()(ctx, async () => undefined);
  return cap;
}

const sid = (): string => service.id.slice(0, 8);

d("service-diagnostics: master switch + entry gate", () => {
  it("entry is hidden while disabled and shown while enabled", async () => {
    await setSetting(SERVICE_DIAGNOSTICS_ENABLED_KEY, "false", "BOOLEAN");
    clearSettingsCache();
    expect(await buildServiceDiagnosticsEntry()).toBeNull();
    await setSetting(SERVICE_DIAGNOSTICS_ENABLED_KEY, "true", "BOOLEAN");
    clearSettingsCache();
    expect(await buildServiceDiagnosticsEntry()).not.toBeNull();
  });

  it("a direct callback fails closed while disabled", async () => {
    await setSetting(SERVICE_DIAGNOSTICS_ENABLED_KEY, "false", "BOOLEAN");
    clearSettingsCache();
    const cap = await runHandler(`user:svc:diag:${sid()}`, owner);
    expect(cap.edits).toHaveLength(0);
    expect(cap.toasts.some((t) => (t ?? "").includes("در دسترس نیست"))).toBe(true);
    await setSetting(SERVICE_DIAGNOSTICS_ENABLED_KEY, "true", "BOOLEAN");
    clearSettingsCache();
  });

  it("a foreign user cannot diagnose (owner-scoped)", async () => {
    await clearCooldown(serviceDiagnosticsCooldownKey(foreigner.id, service.id));
    const cap = await runHandler(`user:svc:diag:${sid()}`, foreigner);
    expect(cap.toasts.some((t) => (t ?? "").includes("یافت نشد"))).toBe(true);
    expect(cap.edits).toHaveLength(0);
  });
});

d("service-diagnostics: one panel read + evidence policy", () => {
  it("a successful read performs exactly ONE read, updates only reported fields, and is LIVE_PANEL", async () => {
    panelState.account = { ok: true, status: "active", usedBytes: 5n * GIB, totalBytes: 10n * GIB, remainingBytes: 5n * GIB };
    panelState.reads = 0;
    const run = await runServiceDiagnostics(service, owner.id);
    expect(panelState.reads).toBe(1);
    expect(run.report.evidenceSource).toBe("LIVE_PANEL");
    const row = await prisma.service.findUniqueOrThrow({ where: { id: service.id } });
    expect(row.usedBytes).toBe(5n * GIB);
    expect(row.username).toBe(service.username); // identity never rewritten
  });

  it("a failed read leaves the Service row unchanged and reports UNAVAILABLE", async () => {
    const before = await prisma.service.findUniqueOrThrow({ where: { id: service.id } });
    panelState.account = { ok: false, diagnostic: { code: "unreachable" } };
    panelState.reads = 0;
    const run = await runServiceDiagnostics(service, owner.id);
    expect(panelState.reads).toBe(1);
    expect(run.report.overall).toBe("UNAVAILABLE");
    const after = await prisma.service.findUniqueOrThrow({ where: { id: service.id } });
    expect(after.usedBytes).toBe(before.usedBytes);
  });

  it("a positive notFound routes to NEEDS_SUPPORT and never mutates the row", async () => {
    const before = await prisma.service.findUniqueOrThrow({ where: { id: service.id } });
    panelState.account = { ok: false, notFound: true };
    const run = await runServiceDiagnostics(service, owner.id);
    expect(run.report.overall).toBe("NEEDS_SUPPORT");
    const after = await prisma.service.findUniqueOrThrow({ where: { id: service.id } });
    expect(after.usedBytes).toBe(before.usedBytes);
  });

  it("the OWNER read-only preview (persist:false) reasons over LIVE state but NEVER writes the row", async () => {
    const before = await prisma.service.findUniqueOrThrow({ where: { id: service.id } });
    // A DIFFERENT usage than the stored row, so a persisted write would be visible.
    panelState.account = { ok: true, status: "active", usedBytes: 7n * GIB, totalBytes: 10n * GIB, remainingBytes: 3n * GIB };
    const run = await runServiceDiagnostics(service, owner.id, { persist: false });
    expect(run.report.evidenceSource).toBe("LIVE_PANEL"); // still a live read
    // The report reasons over the LIVE projection, not the stale stored row...
    expect(run.service.usedBytes).toBe(7n * GIB);
    // ...yet the DB row is never written.
    const after = await prisma.service.findUniqueOrThrow({ where: { id: service.id } });
    expect(after.usedBytes).toBe(before.usedBytes);
    expect(after.lastSubscriptionUpdateAt?.getTime() ?? 0).toBe(
      before.lastSubscriptionUpdateAt?.getTime() ?? 0,
    );
  });
});

d("service-diagnostics: cooldown", () => {
  it("the first run arms the window and an immediate retry reports remaining seconds", async () => {
    await clearCooldown(serviceDiagnosticsCooldownKey(owner.id, service.id));
    const first = await checkDiagnosticsCooldown(owner.id, service.id);
    expect(first.onCooldown).toBe(false);
    const second = await checkDiagnosticsCooldown(owner.id, service.id);
    expect(second.onCooldown).toBe(true);
    expect(second.remainingSeconds).toBeGreaterThan(0);
    await clearCooldown(serviceDiagnosticsCooldownKey(owner.id, service.id));
  });
});

d("service-diagnostics: safe support snapshot", () => {
  it("attaches an owner-consistent, secret-free snapshot to a real ticket the admin can read", async () => {
    panelState.account = { ok: true, status: "active", usedBytes: 5n * GIB, totalBytes: 10n * GIB, remainingBytes: 5n * GIB };
    const run = await runServiceDiagnostics(service, owner.id);
    const snapshot = snapshotForSupport(run.report, run.primary);
    const outcome = await createSupportTicket(owner.id, "بررسی مشکل سرویس — x", "کار نمی‌کند", {
      serviceId: service.id,
      diagnosticSnapshot: snapshot,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.ticket.serviceId).toBe(service.id);
    const detail = await getAdminTicketDetail(outcome.ticket.id.slice(0, 8));
    expect(detail?.service?.id).toBe(service.id);
    const stored = validateDiagnosticSnapshot(detail?.diagnosticSnapshot);
    expect(stored).not.toBeNull();
    // No secret ever enters the persisted snapshot.
    expect(JSON.stringify(detail?.diagnosticSnapshot)).not.toContain("DEADBEEF");
    expect(JSON.stringify(detail?.diagnosticSnapshot)).not.toContain("SUBSCRIPTIONSECRET");
  });

  it("a normal ticket (no attachment) keeps serviceId null — regression", async () => {
    const outcome = await createSupportTicket(owner.id, "سوال عادی", "سلام");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.ticket.serviceId).toBeNull();
  });

  it("a stale/foreign service is not owner-consistent, so the guard drops the attachment", async () => {
    expect(await getOwnedServiceById(service.id, foreigner.id)).toBeNull();
    expect(await getOwnedServiceById(service.id, owner.id)).not.toBeNull();
  });
});

d("service-diagnostics: handoff safety", () => {
  it("opening a preview disarms a handoff armed for a DIFFERENT service (stale keyboard)", async () => {
    await setSetting(SERVICE_DIAGNOSTICS_ENABLED_KEY, "true", "BOOLEAN");
    clearSettingsCache();
    const session = initialSession();
    // A handoff previously armed for ANOTHER service (via an older `:sup_yes`).
    session.currentFlow = "support:message";
    session.temp.supportDraft = { subject: "armed for another service" };
    session.temp.diagnosticSupportContext = {
      sid: "deadbeef",
      serviceId: "00000000-0000-0000-0000-000000000000",
      snapshot: {
        version: 1,
        overall: "HEALTHY",
        evidenceSource: "STORED_ONLY",
        checkedAt: new Date().toISOString(),
        checks: [],
      },
    };
    // Tapping THIS service's stale «support» button (mismatched snapshot) must
    // disarm the previously-armed flow so the next message is NOT a ticket.
    await runHandler(`user:svc:diag:${sid()}:support`, owner, session);
    expect(session.currentFlow).toBeNull();
    expect(session.temp.supportDraft).toBeUndefined();
    expect(session.temp.diagnosticSupportContext).toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
// §1 — cancel armed support handoffs on EVERY diagnostic exit path. Each
// early-return case must leave: currentFlow != "support:message", supportDraft
// deleted, and the stale diagnosticSupportContext deleted, so the user's next
// ordinary message can never be captured into a ticket for a previously-armed
// service.
// -----------------------------------------------------------------------------

/** Pre-arms a session as if `:sup_yes` had already fired for `serviceId`. */
function armedSession(serviceId: string, shortId: string): SessionData {
  const session = initialSession();
  session.currentFlow = "support:message";
  session.temp.supportDraft = { subject: "بررسی مشکل سرویس — armed" };
  session.temp.diagnosticSupportContext = {
    sid: shortId,
    serviceId,
    snapshot: {
      version: 1,
      overall: "HEALTHY",
      evidenceSource: "STORED_ONLY",
      checkedAt: new Date().toISOString(),
      checks: [],
    },
  };
  return session;
}

/** Drives the real support text handler once against a session. */
async function driveText(text: string, user: User, session: SessionData): Promise<void> {
  const message = { text, message_id: 6, chat: { id: 1, type: "private" }, from: { id: 1, first_name: "T" } };
  const ctx = {
    session,
    dbUser: user,
    message,
    from: message.from,
    update: { update_id: 2, message },
    reply: async () => ({}),
    api: {} as never,
  };
  await supportTextHandler.middleware()(ctx as never, async () => undefined);
}

/** Drives the support text handler; returns whether it created a ticket (by
 * counting the user's tickets before/after). */
async function sendOrdinaryText(text: string, user: User, session: SessionData): Promise<boolean> {
  const before = await prisma.supportTicket.count({ where: { userId: user.id } });
  await driveText(text, user, session);
  const after = await prisma.supportTicket.count({ where: { userId: user.id } });
  return after > before;
}

function expectHandoffCleared(session: SessionData): void {
  expect(session.currentFlow).not.toBe("support:message");
  expect(session.temp.supportDraft).toBeUndefined();
  expect(session.temp.diagnosticSupportContext).toBeUndefined();
}

d("service-diagnostics: §1 handoff cleanup on every exit path", () => {
  it("master switch disabled: disarms the handoff and no ticket is created", async () => {
    await setSetting(SERVICE_DIAGNOSTICS_ENABLED_KEY, "false", "BOOLEAN");
    clearSettingsCache();
    const session = armedSession(service.id, sid());
    await runHandler(`user:svc:diag:${sid()}`, owner, session);
    expectHandoffCleared(session);
    expect(await sendOrdinaryText("سلام، سرویسم کار نمی‌کند", owner, session)).toBe(false);
    await setSetting(SERVICE_DIAGNOSTICS_ENABLED_KEY, "true", "BOOLEAN");
    clearSettingsCache();
  });

  it("foreign service: disarms the handoff and no ticket is created", async () => {
    const session = armedSession(service.id, sid());
    await runHandler(`user:svc:diag:${sid()}`, foreigner, session);
    expectHandoffCleared(session);
    expect(await sendOrdinaryText("این سرویس مال من نیست", foreigner, session)).toBe(false);
  });

  it("unknown short id: disarms the handoff and no ticket is created", async () => {
    const session = armedSession(service.id, "ffffffff");
    await runHandler("user:svc:diag:ffffffff", owner, session);
    expectHandoffCleared(session);
    expect(await sendOrdinaryText("id ناشناخته", owner, session)).toBe(false);
  });

  it("dbUser absent: disarms the handoff (no toast, no edit)", async () => {
    const session = armedSession(service.id, sid());
    const cap = await runHandler(`user:svc:diag:${sid()}`, null, session);
    expectHandoffCleared(session);
    expect(cap.edits).toHaveLength(0);
  });

  it("stale :sup_yes (mismatched snapshot) disarms then FAILS SAFE (never re-arms)", async () => {
    // Armed for a DIFFERENT service, then a stale :sup_yes for THIS service.
    const session = initialSession();
    session.currentFlow = "support:message";
    session.temp.supportDraft = { subject: "armed for another service" };
    session.temp.diagnosticSupportContext = {
      sid: "deadbeef",
      serviceId: "00000000-0000-0000-0000-000000000000",
      snapshot: {
        version: 1,
        overall: "HEALTHY",
        evidenceSource: "STORED_ONLY",
        checkedAt: new Date().toISOString(),
        checks: [],
      },
    };
    await runHandler(`user:svc:diag:${sid()}:sup_yes`, owner, session);
    expectHandoffCleared(session);
    expect(await sendOrdinaryText("متن عادی", owner, session)).toBe(false);
  });

  it("a fresh run replaces the previous snapshot and leaves the flow disarmed", async () => {
    await clearCooldown(serviceDiagnosticsCooldownKey(owner.id, service.id));
    panelState.account = { ok: true, status: "active", usedBytes: 5n * GIB, totalBytes: 10n * GIB, remainingBytes: 5n * GIB };
    const session = armedSession(service.id, sid());
    const prevSnapshot = session.temp.diagnosticSupportContext;
    await runHandler(`user:svc:diag:${sid()}`, owner, session);
    // Armed flow is gone, but a FRESH snapshot now exists for this service.
    expect(session.currentFlow).not.toBe("support:message");
    expect(session.temp.supportDraft).toBeUndefined();
    expect(session.temp.diagnosticSupportContext).toBeDefined();
    expect(session.temp.diagnosticSupportContext).not.toBe(prevSnapshot);
    expect(session.temp.diagnosticSupportContext?.serviceId).toBe(service.id);
    await clearCooldown(serviceDiagnosticsCooldownKey(owner.id, service.id));
  });

  it("a VALID preview preserves the latest snapshot and stays UNARMED", async () => {
    await clearCooldown(serviceDiagnosticsCooldownKey(owner.id, service.id));
    panelState.account = { ok: true, status: "active", usedBytes: 5n * GIB, totalBytes: 10n * GIB, remainingBytes: 5n * GIB };
    const session = initialSession();
    // Populate a genuine, matching snapshot via one real diagnosis.
    await runHandler(`user:svc:diag:${sid()}`, owner, session);
    const snapshot = session.temp.diagnosticSupportContext;
    expect(snapshot).toBeDefined();
    // Opening the preview keeps the snapshot but must NOT arm the flow.
    const cap = await runHandler(`user:svc:diag:${sid()}:support`, owner, session);
    expect(session.currentFlow).not.toBe("support:message");
    expect(session.temp.supportDraft).toBeUndefined();
    expect(session.temp.diagnosticSupportContext).toBe(snapshot);
    expect(cap.edits.length).toBeGreaterThan(0);
    await clearCooldown(serviceDiagnosticsCooldownKey(owner.id, service.id));
  });

  it("a VALID :sup_yes arms EXACTLY ONE support-message flow", async () => {
    await clearCooldown(serviceDiagnosticsCooldownKey(owner.id, service.id));
    panelState.account = { ok: true, status: "active", usedBytes: 5n * GIB, totalBytes: 10n * GIB, remainingBytes: 5n * GIB };
    const session = initialSession();
    await runHandler(`user:svc:diag:${sid()}`, owner, session);
    await runHandler(`user:svc:diag:${sid()}:sup_yes`, owner, session);
    expect(session.currentFlow).toBe("support:message");
    expect(session.temp.supportDraft?.subject).toBeDefined();
    expect(session.temp.diagnosticSupportContext?.serviceId).toBe(service.id);
    await clearCooldown(serviceDiagnosticsCooldownKey(owner.id, service.id));
  });
});

// -----------------------------------------------------------------------------
// §5 — support attachment integrity + idempotency. A valid handoff attaches the
// snapshot to EXACTLY ONE ticket; a repeated/concurrent submission never
// double-creates or double-attaches; a stale/foreign context never attaches.
// -----------------------------------------------------------------------------

const okAccount5 = {
  ok: true,
  status: "active",
  usedBytes: 5n * GIB,
  totalBytes: 10n * GIB,
  remainingBytes: 5n * GIB,
} as Record<string, unknown>;

/** Runs a real diagnosis then confirms — leaving a genuinely armed handoff. */
async function armValidHandoff(): Promise<SessionData> {
  await clearCooldown(serviceDiagnosticsCooldownKey(owner.id, service.id));
  panelState.account = { ...okAccount5 };
  const session = initialSession();
  await runHandler(`user:svc:diag:${sid()}`, owner, session);
  await runHandler(`user:svc:diag:${sid()}:sup_yes`, owner, session);
  await clearCooldown(serviceDiagnosticsCooldownKey(owner.id, service.id));
  return session;
}

async function latestTicket(userId: string) {
  return prisma.supportTicket.findFirst({ where: { userId }, orderBy: { createdAt: "desc" } });
}

d("service-diagnostics: §5 attachment integrity + idempotency", () => {
  it("a valid armed handoff attaches the snapshot to EXACTLY ONE ticket", async () => {
    const session = await armValidHandoff();
    const before = await prisma.supportTicket.count({ where: { userId: owner.id } });
    await driveText("سرویسم وصل نمی‌شود", owner, session);
    const after = await prisma.supportTicket.count({ where: { userId: owner.id } });
    expect(after - before).toBe(1);
    const ticket = await latestTicket(owner.id);
    expect(ticket?.serviceId).toBe(service.id);
    expect(ticket?.diagnosticSnapshot).not.toBeNull();
    // The handoff is fully consumed — a second text creates NO further ticket.
    expect(session.currentFlow).not.toBe("support:message");
    expect(session.temp.diagnosticSupportContext).toBeUndefined();
    expect(await sendOrdinaryText("پیام دوم", owner, session)).toBe(false);
  });

  it("two concurrent submissions create ONE ticket with ONE attachment", async () => {
    const session = await armValidHandoff();
    const before = await prisma.supportTicket.count({ where: { userId: owner.id } });
    // Fire the same handoff twice concurrently against the SAME session.
    await Promise.all([
      driveText("همزمان الف", owner, session),
      driveText("همزمان ب", owner, session),
    ]);
    const after = await prisma.supportTicket.count({ where: { userId: owner.id } });
    // The synchronous claim-before-await guarantees at most one ticket, carrying
    // the attachment exactly once.
    expect(after - before).toBe(1);
    const ticket = await latestTicket(owner.id);
    expect(ticket?.serviceId).toBe(service.id);
    expect(ticket?.diagnosticSnapshot).not.toBeNull();
  });

  it("a stale/foreign context is dropped — the ticket carries NO attachment", async () => {
    const session = initialSession();
    session.currentFlow = "support:message";
    session.temp.supportDraft = { subject: "بررسی مشکل سرویس — stale" };
    // A context for a service this user does NOT own (owned by the foreigner).
    session.temp.diagnosticSupportContext = {
      sid: "deadbeef",
      serviceId: "00000000-0000-0000-0000-000000000000",
      snapshot: {
        version: 1,
        overall: "HEALTHY",
        evidenceSource: "STORED_ONLY",
        checkedAt: new Date().toISOString(),
        checks: [],
      },
    };
    const before = await prisma.supportTicket.count({ where: { userId: owner.id } });
    await driveText("سرویس غریبه", owner, session);
    const after = await prisma.supportTicket.count({ where: { userId: owner.id } });
    // A normal ticket is still created, but with NO diagnostic attachment.
    expect(after - before).toBe(1);
    const ticket = await latestTicket(owner.id);
    expect(ticket?.serviceId).toBeNull();
    expect(ticket?.diagnosticSnapshot).toBeNull();
  });

  it("an invalid message keeps the handoff armed (claim restored) so a retry still attaches", async () => {
    const session = await armValidHandoff();
    const before = await prisma.supportTicket.count({ where: { userId: owner.id } });
    // Whitespace-only trims to empty → createSupportTicket rejects → claim restored.
    await driveText("   ", owner, session);
    expect(await prisma.supportTicket.count({ where: { userId: owner.id } })).toBe(before);
    expect(session.currentFlow).toBe("support:message");
    expect(session.temp.diagnosticSupportContext?.serviceId).toBe(service.id);
    // A corrected retry now creates the ticket WITH the attachment.
    await driveText("حالا یک پیام معتبر و کامل می‌نویسم", owner, session);
    expect(await prisma.supportTicket.count({ where: { userId: owner.id } })).toBe(before + 1);
    const ticket = await latestTicket(owner.id);
    expect(ticket?.serviceId).toBe(service.id);
  });

  it("a THROWN owner-lookup during the claimed window restores the handoff (retryable)", async () => {
    const session = await armValidHandoff();
    const before = await prisma.supportTicket.count({ where: { userId: owner.id } });
    // Simulate a transient DB outage during the owner-scoped re-resolve.
    const userServices = await import("../src/services/user-services.service.js");
    const spy = vi
      .spyOn(userServices, "getOwnedServiceById")
      .mockRejectedValueOnce(new Error("transient db outage"));
    await expect(driveText("پیام هنگام خطای موقت دیتابیس", owner, session)).rejects.toThrow();
    spy.mockRestore();
    // No ticket was created, and the WHOLE claim is restored for a retry.
    expect(await prisma.supportTicket.count({ where: { userId: owner.id } })).toBe(before);
    expect(session.currentFlow).toBe("support:message");
    expect(session.temp.supportDraft?.subject).toBeDefined();
    expect(session.temp.diagnosticSupportContext?.serviceId).toBe(service.id);
    // The retry now succeeds and still carries the diagnostic attachment.
    await driveText("اتصال برقرار شد، دوباره تلاش می‌کنم", owner, session);
    expect(await prisma.supportTicket.count({ where: { userId: owner.id } })).toBe(before + 1);
    expect((await latestTicket(owner.id))?.serviceId).toBe(service.id);
  });
});

d("service-diagnostics: Telegram safety", () => {
  it("the rendered report and its callbacks never expose the subscription secret and stay bounded", async () => {
    panelState.account = { ok: true, status: "active", usedBytes: 5n * GIB, totalBytes: 10n * GIB, remainingBytes: 5n * GIB };
    const run = await runServiceDiagnostics(service, owner.id);
    const page = await renderDiagnosticReport(service, run.report);
    expect(page.text).not.toContain("DEADBEEF");
    expect(page.text).not.toContain("SUBSCRIPTIONSECRET");
    expect(page.text.length).toBeLessThanOrEqual(4096);
    const buttons = flatButtons(page.keyboard);
    for (const b of buttons) {
      expect((b.data ?? "").length).toBeLessThanOrEqual(64);
      expect((b.text ?? "").length).toBeLessThanOrEqual(64);
      expect(b.data ?? "").not.toContain("DEADBEEF");
    }
  });
});
