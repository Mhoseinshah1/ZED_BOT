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

import { initialSession } from "../src/core/session.js";
import { diagnosticsHandler } from "../src/handlers/user-services/diagnostics.handler.js";
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
function fakeCtx(data: string, user: User | null) {
  const session = initialSession();
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
async function runHandler(data: string, user: User | null): Promise<{ edits: Array<{ text: string; buttons: Btn[] }>; toasts: Array<string | undefined> }> {
  const { ctx, cap } = fakeCtx(data, user);
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

  it("the OWNER read-only preview (persist:false) reads live but NEVER writes the row", async () => {
    const before = await prisma.service.findUniqueOrThrow({ where: { id: service.id } });
    // A DIFFERENT usage than the stored row, so a persisted write would be visible.
    panelState.account = { ok: true, status: "active", usedBytes: 7n * GIB, totalBytes: 10n * GIB, remainingBytes: 3n * GIB };
    const run = await runServiceDiagnostics(service, owner.id, { persist: false });
    expect(run.report.evidenceSource).toBe("LIVE_PANEL"); // still a live read
    const after = await prisma.service.findUniqueOrThrow({ where: { id: service.id } });
    expect(after.usedBytes).toBe(before.usedBytes); // row untouched
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
