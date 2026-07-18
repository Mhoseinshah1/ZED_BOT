import {
  AutomatedNotificationCategory,
  AutomatedNotificationStatus,
  NotificationInteractionType,
  prisma,
  type Admin,
  type Panel,
  type Service,
  type User,
} from "@zedbot/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "notification-ui-tests-secret-0123456789";

import { initialSession } from "../src/core/session.js";
import { adminNotificationsHandler, NTF_ADMIN_CB } from "../src/handlers/admin-settings/notifications.handler.js";
import { userNotificationsHandler } from "../src/handlers/user-notifications/notification.handler.js";
import { clearSettingsCache, setSetting } from "../src/services/settings.service.js";

// =============================================================================
// Notification-engine BOT UI (real DB): ntf:* action callbacks (ownership,
// capability-aware fallback, dismiss, idempotency, no-secret), the user +
// per-service settings pages, and the admin OWNER-only activation gate.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const d = hasDb ? describe : describe.skip;

const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));

interface Captured {
  edits: string[];
  replies: string[];
  toasts: Array<string | undefined>;
  replyMarkupCleared: boolean;
  apiSends: Array<{ chatId: number; text: string }>;
}

function fakeCtx(data: string, opts: { user?: User | null; admin?: Admin | null; sendFails?: boolean } = {}) {
  const cap: Captured = { edits: [], replies: [], toasts: [], replyMarkupCleared: false, apiSends: [] };
  const callbackQuery = {
    id: "cbq",
    chat_instance: "ci",
    from: { id: 1, is_bot: false, first_name: "T" },
    data,
    message: { message_id: 5, date: 0, chat: { id: 1, type: "private" } },
  };
  const ctx = {
    session: initialSession(),
    dbUser: opts.user ?? null,
    admin: opts.admin ?? null,
    from: { id: 1, first_name: "T" },
    callbackQuery,
    update: { update_id: 1, callback_query: callbackQuery },
    match: undefined as unknown,
    reply: async (t: string) => {
      cap.replies.push(t);
      return {};
    },
    editMessageText: async (t: string) => {
      cap.edits.push(t);
      return {};
    },
    editMessageReplyMarkup: async () => {
      cap.replyMarkupCleared = true;
      return {};
    },
    answerCallbackQuery: async (p?: { text?: string }) => {
      cap.toasts.push(p?.text);
      return true;
    },
    api: {
      sendMessage: async (chatId: number, text: string) => {
        if (opts.sendFails === true) {
          throw new Error("blocked");
        }
        cap.apiSends.push({ chatId, text });
        return {};
      },
    },
  };
  return { ctx: ctx as never, cap };
}

d("notification bot UI", () => {
  let seq = 0;
  let panelInactive: Panel;

  beforeAll(async () => {
    panelInactive = await prisma.panel.create({
      data: { type: "MARZBAN", name: `ntf-ui-panel-${runTag}`, baseUrl: "https://panel.test", status: "INACTIVE", renewalEnabled: false },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function makeUser(overrides: Partial<User> = {}): Promise<User> {
    seq += 1;
    return prisma.user.create({ data: { telegramId: runTag + BigInt(seq), ...overrides } });
  }

  async function makeService(user: User): Promise<Service> {
    seq += 1;
    return prisma.service.create({
      data: {
        userId: user.id,
        panelId: panelInactive.id,
        panelType: "MARZBAN",
        username: `ntf-ui-svc-${runTag}-${seq}`,
        status: "ACTIVE",
        volumeBytes: 100n,
        usedBytes: 0n,
        subscriptionToken: "UI-SECRET-TOKEN-abcdef",
        note: "پلن من",
      },
    });
  }

  async function makeNotification(user: User, service: Service | null): Promise<{ id: string; shortId: string }> {
    seq += 1;
    const row = await prisma.automatedNotification.create({
      data: {
        type: "SERVICE_EXPIRY",
        category: AutomatedNotificationCategory.SERVICE,
        status: AutomatedNotificationStatus.SENT,
        userId: user.id,
        serviceId: service?.id ?? null,
        dedupeKey: `ntf-ui-${runTag}-${seq}`,
        scheduledFor: new Date(),
        payloadSnapshot: { templateKey: "notif_service_expiry", variables: { service_name: "پلن من" }, buttons: [] },
      },
      select: { id: true },
    });
    return { id: row.id, shortId: row.id.slice(0, 8) };
  }

  // --- ntf:* action callbacks ------------------------------------------------

  it("rejects a foreign user's notification short id (no existence reveal)", async () => {
    const owner = await makeUser();
    const service = await makeService(owner);
    const ntf = await makeNotification(owner, service);
    const stranger = await makeUser();
    const { ctx, cap } = fakeCtx(`ntf:${ntf.shortId}:s`, { user: stranger });
    await userNotificationsHandler.middleware()(ctx, async () => undefined);
    expect(cap.toasts).toContain("این اعلان دیگر معتبر نیست.");
    expect(cap.edits).toHaveLength(0);
    // no interaction recorded for the stranger
    expect(await prisma.notificationInteraction.count({ where: { notificationId: ntf.id } })).toBe(0);
  });

  it("open action renders the service detail and records the click once (idempotent)", async () => {
    const owner = await makeUser();
    const service = await makeService(owner);
    const ntf = await makeNotification(owner, service);
    const first = fakeCtx(`ntf:${ntf.shortId}:s`, { user: owner });
    await userNotificationsHandler.middleware()(first.ctx, async () => undefined);
    const second = fakeCtx(`ntf:${ntf.shortId}:s`, { user: owner });
    await userNotificationsHandler.middleware()(second.ctx, async () => undefined);
    // exactly one OPEN_SERVICE interaction despite two clicks
    expect(
      await prisma.notificationInteraction.count({
        where: { notificationId: ntf.id, type: NotificationInteractionType.OPEN_SERVICE },
      }),
    ).toBe(1);
    // something was rendered and no secret leaked into it
    const rendered = [...first.cap.edits, ...first.cap.replies].join("\n");
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered).not.toContain("UI-SECRET-TOKEN");
  });

  it("renew action on a non-renewable service falls back to the detail (no dead button)", async () => {
    const owner = await makeUser();
    const service = await makeService(owner); // panel is INACTIVE + renewal disabled
    const ntf = await makeNotification(owner, service);
    const { ctx, cap } = fakeCtx(`ntf:${ntf.shortId}:r`, { user: owner });
    await userNotificationsHandler.middleware()(ctx, async () => undefined);
    const rendered = [...cap.edits, ...cap.replies].join("\n");
    expect(rendered).toContain("تمدید این سرویس در حال حاضر امکان‌پذیر نیست.");
  });

  it("dismiss strips the keyboard and toasts", async () => {
    const owner = await makeUser();
    const service = await makeService(owner);
    const ntf = await makeNotification(owner, service);
    const { ctx, cap } = fakeCtx(`ntf:${ntf.shortId}:x`, { user: owner });
    await userNotificationsHandler.middleware()(ctx, async () => undefined);
    expect(cap.replyMarkupCleared).toBe(true);
    expect(cap.toasts).toContain("بسته شد ✖️");
  });

  // --- user settings page ----------------------------------------------------

  it("toggles the user SERVICE category from the settings page", async () => {
    const user = await makeUser({ serviceNotificationsEnabled: true });
    const { ctx } = fakeCtx("user:nset:toggle:svc", { user });
    await userNotificationsHandler.middleware()(ctx, async () => undefined);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).serviceNotificationsEnabled).toBe(false);
  });

  it("renders the user settings landing", async () => {
    const user = await makeUser();
    const { ctx, cap } = fakeCtx("user:nset:root", { user });
    await userNotificationsHandler.middleware()(ctx, async () => undefined);
    expect([...cap.edits, ...cap.replies].join("\n")).toContain("تنظیمات اعلان‌ها");
  });

  // --- per-service override page ---------------------------------------------

  it("cycles a per-service override inherit -> on -> off", async () => {
    const user = await makeUser();
    const service = await makeService(user);
    const sid = service.id.slice(0, 8);
    const step = async () => {
      const { ctx } = fakeCtx(`user:nsvc:tg:${sid}:expiry`, { user });
      await userNotificationsHandler.middleware()(ctx, async () => undefined);
      return prisma.serviceNotificationPreference.findUnique({ where: { serviceId: service.id } });
    };
    expect((await step())?.expiryEnabled).toBe(true); // inherit(null) -> on
    expect((await step())?.expiryEnabled).toBe(false); // on -> off
    expect((await step())?.expiryEnabled).toBeNull(); // off -> inherit
  });

  // --- admin page ------------------------------------------------------------

  function admin(role: "OWNER" | "SUPPORT"): Admin {
    return { id: `admin-${role}`, role } as unknown as Admin;
  }

  it("blocks a non-owner admin from toggling a rule", async () => {
    await setSetting("notification_rule_expiry_enabled", "false", "BOOLEAN");
    clearSettingsCache();
    const { ctx, cap } = fakeCtx(NTF_ADMIN_CB.rule("expiry"), { admin: admin("SUPPORT") });
    await adminNotificationsHandler.middleware()(ctx, async () => undefined);
    expect(cap.toasts.some((t) => t?.includes("مالک"))).toBe(true);
    clearSettingsCache();
    expect((await prisma.setting.findUnique({ where: { key: "notification_rule_expiry_enabled" } }))?.value).toBe("false");
  });

  it("refuses master activation when the worker status is not fresh (stays disabled)", async () => {
    await setSetting("automated_notifications_enabled", "false", "BOOLEAN");
    await setSetting("notification_rule_expiry_enabled", "true", "BOOLEAN");
    clearSettingsCache();
    // No fresh notification worker status is published in this test env, so the
    // gate must refuse and leave the switch OFF.
    const { ctx, cap } = fakeCtx(NTF_ADMIN_CB.enable, { admin: admin("OWNER") });
    await adminNotificationsHandler.middleware()(ctx, async () => undefined);
    clearSettingsCache();
    expect((await prisma.setting.findUnique({ where: { key: "automated_notifications_enabled" } }))?.value).toBe("false");
    const shown = [...cap.edits, ...cap.replies].join("\n");
    expect(shown).toContain("فعال‌سازی ممکن نشد");
  });
});
