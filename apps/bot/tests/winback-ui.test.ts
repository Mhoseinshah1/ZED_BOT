import {
  AutomatedNotificationCategory,
  AutomatedNotificationStatus,
  NotificationInteractionType,
  prisma,
  type Admin,
  type Order,
  type Panel,
  type Service,
  type User,
} from "@zedbot/database";
import { buildCustomerLapseCycleFingerprint, buildCustomerWinbackDedupeKey, type CustomerLifecycleSnapshot } from "@zedbot/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "winback-ui-tests-secret-0123456789";

import { adminNotificationsHandler, adminNotificationsTextHandler } from "../src/handlers/admin-settings/notifications.handler.js";
import { userNotificationsHandler } from "../src/handlers/user-notifications/notification.handler.js";
import {
  clearWinbackSnooze,
  getActiveWinbackSnooze,
  optOutMarketing,
  previewWinbackAudience,
  snoozeWinback,
  suppressPendingWinback,
} from "../src/services/winback.service.js";
import { clearSettingsCache, setSetting } from "../src/services/settings.service.js";

// =============================================================================
// Customer win-back BOT UI (real DB): the ntf:(g|w|z|o) actions + wb:* confirm
// callbacks (ownership, type-guard, no-secret, idempotency, confirm-before-
// mutate), the snooze / opt-out services, the read-only audience preview, and the
// admin OWNER-only toggle + fail-safe activation gate.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const d = hasDb ? describe : describe.skip;

const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
const DAY = 24 * 3_600_000;

interface Captured {
  edits: string[];
  replies: string[];
  toasts: Array<string | undefined>;
  replyMarkupCleared: boolean;
  apiSends: Array<{ chatId: number; text: string }>;
}

function fakeCtx(
  data: string,
  opts: { user?: User | null; admin?: Admin | null; text?: string; flow?: string; draft?: unknown } = {},
) {
  const cap: Captured = { edits: [], replies: [], toasts: [], replyMarkupCleared: false, apiSends: [] };
  const isText = opts.text !== undefined;
  const callbackQuery = {
    id: "cbq",
    chat_instance: "ci",
    from: { id: 1, is_bot: false, first_name: "T" },
    data,
    message: { message_id: 5, date: 0, chat: { id: 1, type: "private" } },
  };
  const message = { message_id: 6, date: 0, text: opts.text ?? "", from: { id: 1, is_bot: false, first_name: "T" }, chat: { id: 1, type: "private" } };
  const update = isText
    ? { update_id: 1, message }
    : { update_id: 1, callback_query: callbackQuery };
  const ctx = {
    session: { temp: opts.draft !== undefined ? { adminWinbackNtfDraft: opts.draft } : {}, currentFlow: opts.flow, lastMenu: undefined },
    dbUser: opts.user ?? null,
    admin: opts.admin ?? null,
    from: { id: 1, first_name: "T" },
    callbackQuery: isText ? undefined : callbackQuery,
    message: isText ? message : undefined,
    update,
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
        cap.apiSends.push({ chatId, text });
        return {};
      },
    },
  };
  return { ctx: ctx as never, cap };
}

function rendered(cap: Captured): string {
  return [...cap.edits, ...cap.replies].join("\n");
}

function fingerprint(orderId: string, effectiveEnd: Date): string {
  const snap = { latestCompletedPaidServiceOrderId: orderId, latestPaidServiceEffectiveEndAt: effectiveEnd } as unknown as CustomerLifecycleSnapshot;
  const fp = buildCustomerLapseCycleFingerprint(snap);
  if (fp === null) {
    throw new Error("null fingerprint");
  }
  return fp;
}

d("winback bot UI", () => {
  let seq = 0;
  let panel: Panel;

  beforeAll(async () => {
    panel = await prisma.panel.create({
      data: { type: "MARZBAN", name: `wb-ui-panel-${runTag}`, baseUrl: "https://panel.test", status: "ACTIVE", renewalEnabled: false },
    });
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function makeUser(overrides: Partial<User> = {}): Promise<User> {
    seq += 1;
    return prisma.user.create({
      data: {
        telegramId: runTag + BigInt(seq),
        status: "ACTIVE",
        group: "F",
        marketingMessagesEnabled: true,
        cronNotificationsEnabled: true,
        paidOrdersCount: 1,
        ...overrides,
      },
    });
  }

  async function makePurchaseOrder(user: User): Promise<Order> {
    seq += 1;
    return prisma.order.create({
      data: { userId: user.id, type: "SERVICE_PURCHASE", status: "COMPLETED", finalPriceToman: 120000, completedAt: new Date(Date.now() - 41 * DAY), productNameSnapshot: "پلن تست" },
    });
  }

  async function makeService(user: User, daysLapsed: number, overrides: Partial<Service> = {}): Promise<Service> {
    seq += 1;
    return prisma.service.create({
      data: {
        userId: user.id, panelId: panel.id, panelType: "MARZBAN", username: `wb-ui-svc-${runTag}-${seq}`,
        source: "PAID", status: "EXPIRED", expiresAt: new Date(Date.now() - daysLapsed * DAY),
        lastSubscriptionUpdateAt: new Date(), note: "پلن من", ...overrides,
      },
    });
  }

  /** A CUSTOMER_WINBACK notification for `user` (fp optional; defaults to a random cycle). */
  async function makeWinbackNotification(user: User, fp?: string, stageDays = 30): Promise<{ id: string; shortId: string }> {
    seq += 1;
    const cycle = fp ?? fingerprint(`ord-${runTag}-${seq}`, new Date(Date.now() - 40 * DAY));
    const row = await prisma.automatedNotification.create({
      data: {
        type: "CUSTOMER_WINBACK",
        category: AutomatedNotificationCategory.MARKETING,
        status: AutomatedNotificationStatus.SENT,
        userId: user.id,
        dedupeKey: buildCustomerWinbackDedupeKey(user.id, cycle, stageDays),
        scheduledFor: new Date(),
        payloadSnapshot: { templateKey: "notification_customer_winback", variables: { inactive_days: "۴۰" }, buttons: [], meta: { kind: "winback", stageKey: `s${stageDays}`, cycle } },
      },
      select: { id: true },
    });
    return { id: row.id, shortId: row.id.slice(0, 8) };
  }

  /** A Phase-1 SERVICE_EXPIRY notification (a non-win-back type for cross-type tests). */
  async function makeServiceNotification(user: User): Promise<{ id: string; shortId: string }> {
    seq += 1;
    const row = await prisma.automatedNotification.create({
      data: {
        type: "SERVICE_EXPIRY",
        category: AutomatedNotificationCategory.SERVICE,
        status: AutomatedNotificationStatus.SENT,
        userId: user.id,
        dedupeKey: `svc-ntf-${runTag}-${seq}`,
        scheduledFor: new Date(),
        payloadSnapshot: { templateKey: "notif_service_expiry", variables: {}, buttons: [] },
      },
      select: { id: true },
    });
    return { id: row.id, shortId: row.id.slice(0, 8) };
  }

  function admin(role: "OWNER" | "SUPPORT"): Admin {
    return { id: `admin-${role}-${runTag}`, role } as unknown as Admin;
  }

  async function runUser(data: string, opts: Parameters<typeof fakeCtx>[1]) {
    const h = fakeCtx(data, opts);
    await userNotificationsHandler.middleware()(h.ctx, async () => undefined);
    return h;
  }
  async function runAdmin(data: string, opts: Parameters<typeof fakeCtx>[1]) {
    const h = fakeCtx(data, opts);
    await adminNotificationsHandler.middleware()(h.ctx, async () => undefined);
    return h;
  }

  // ===========================================================================
  // 1. ntf:(g|w|z|o) win-back actions
  // ===========================================================================

  it("g (view plans) records VIEW_PRODUCTS and renders a page (no checkout created)", async () => {
    const user = await makeUser();
    const ntf = await makeWinbackNotification(user);
    const before = await prisma.checkoutSession.count({ where: { userId: user.id } });
    const { cap } = await runUser(`ntf:${ntf.shortId}:g`, { user });
    expect(rendered(cap).length).toBeGreaterThan(0);
    expect(await prisma.checkoutSession.count({ where: { userId: user.id } })).toBe(before);
    expect(await prisma.notificationInteraction.count({ where: { notificationId: ntf.id, type: NotificationInteractionType.VIEW_PRODUCTS } })).toBe(1);
  });

  it("w (wallet) records VIEW_WALLET and creates no payment", async () => {
    const user = await makeUser();
    const ntf = await makeWinbackNotification(user);
    const { cap } = await runUser(`ntf:${ntf.shortId}:w`, { user });
    expect(rendered(cap).length).toBeGreaterThan(0);
    expect(await prisma.payment.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.notificationInteraction.count({ where: { notificationId: ntf.id, type: NotificationInteractionType.VIEW_WALLET } })).toBe(1);
  });

  it("z (snooze) shows a confirmation and does NOT snooze yet", async () => {
    const user = await makeUser();
    const ntf = await makeWinbackNotification(user);
    const { cap } = await runUser(`ntf:${ntf.shortId}:z`, { user });
    expect(rendered(cap)).toContain("متوقف شود");
    expect(await getActiveWinbackSnooze(user.id)).toBeNull(); // not yet snoozed
    expect(await prisma.notificationInteraction.count({ where: { notificationId: ntf.id, type: NotificationInteractionType.SNOOZE_WINBACK } })).toBe(1);
  });

  it("o (opt-out) shows a confirmation and does NOT opt out yet", async () => {
    const user = await makeUser();
    const ntf = await makeWinbackNotification(user);
    const { cap } = await runUser(`ntf:${ntf.shortId}:o`, { user });
    expect(rendered(cap)).toContain("غیرفعال شود");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).marketingMessagesEnabled).toBe(true);
    expect(await prisma.notificationInteraction.count({ where: { notificationId: ntf.id, type: NotificationInteractionType.MARKETING_OPT_OUT } })).toBe(1);
  });

  it("a foreign user's win-back notification is rejected (no reveal, no interaction)", async () => {
    const owner = await makeUser();
    const stranger = await makeUser();
    const ntf = await makeWinbackNotification(owner);
    const { cap } = await runUser(`ntf:${ntf.shortId}:g`, { user: stranger });
    expect(cap.toasts).toContain("این اعلان دیگر معتبر نیست.");
    expect(await prisma.notificationInteraction.count({ where: { notificationId: ntf.id } })).toBe(0);
  });

  it("a win-back letter on a non-win-back (service) notification is invalid", async () => {
    const user = await makeUser();
    const svc = await makeServiceNotification(user);
    const { cap } = await runUser(`ntf:${svc.shortId}:g`, { user });
    expect(cap.toasts).toContain("این اعلان دیگر معتبر نیست.");
    expect(cap.edits).toHaveLength(0);
  });

  it("a service letter on a win-back notification is invalid", async () => {
    const user = await makeUser();
    const ntf = await makeWinbackNotification(user);
    const { cap } = await runUser(`ntf:${ntf.shortId}:s`, { user });
    expect(cap.toasts).toContain("این اعلان دیگر معتبر نیست.");
  });

  it("g is idempotent across two clicks (one VIEW_PRODUCTS interaction)", async () => {
    const user = await makeUser();
    const ntf = await makeWinbackNotification(user);
    await runUser(`ntf:${ntf.shortId}:g`, { user });
    await runUser(`ntf:${ntf.shortId}:g`, { user });
    expect(await prisma.notificationInteraction.count({ where: { notificationId: ntf.id, type: NotificationInteractionType.VIEW_PRODUCTS } })).toBe(1);
  });

  it("no secret (full notification/user id) leaks into a rendered win-back surface", async () => {
    const user = await makeUser();
    const ntf = await makeWinbackNotification(user);
    const { cap } = await runUser(`ntf:${ntf.shortId}:z`, { user });
    const text = rendered(cap);
    expect(text).not.toContain(ntf.id);
    expect(text).not.toContain(user.id);
  });

  // ===========================================================================
  // 2. wb:* confirm callbacks
  // ===========================================================================

  it("wb:snz snoozes, strips the keyboard and toasts", async () => {
    const user = await makeUser();
    const ntf = await makeWinbackNotification(user);
    const { cap } = await runUser(`wb:snz:${ntf.shortId}`, { user });
    expect(cap.replyMarkupCleared).toBe(true);
    expect(cap.toasts).toContain("یادآوری‌های بازگشت به‌صورت موقت متوقف شد.");
    expect(await getActiveWinbackSnooze(user.id)).not.toBeNull();
  });

  it("wb:opt opts out of marketing and suppresses pending win-back", async () => {
    const user = await makeUser();
    // a still-pending win-back row that must be suppressed on opt-out
    const pending = await prisma.automatedNotification.create({
      data: { type: "CUSTOMER_WINBACK", category: AutomatedNotificationCategory.MARKETING, status: AutomatedNotificationStatus.SCHEDULED, userId: user.id, dedupeKey: `wb-pending-${runTag}-${seq++}`, scheduledFor: new Date(), payloadSnapshot: {} },
    });
    const ntf = await makeWinbackNotification(user);
    const { cap } = await runUser(`wb:opt:${ntf.shortId}`, { user });
    expect(cap.toasts).toContain("پیشنهادها و پیام‌های بازاریابی غیرفعال شد.");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).marketingMessagesEnabled).toBe(false);
    expect((await prisma.automatedNotification.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe(AutomatedNotificationStatus.SUPPRESSED);
  });

  it("wb:cancel strips the keyboard and mutates nothing", async () => {
    const user = await makeUser();
    const ntf = await makeWinbackNotification(user);
    const { cap } = await runUser(`wb:cancel:${ntf.shortId}`, { user });
    expect(cap.replyMarkupCleared).toBe(true);
    expect(await getActiveWinbackSnooze(user.id)).toBeNull();
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).marketingMessagesEnabled).toBe(true);
  });

  it("wb:snz on a foreign notification is rejected", async () => {
    const owner = await makeUser();
    const stranger = await makeUser();
    const ntf = await makeWinbackNotification(owner);
    const { cap } = await runUser(`wb:snz:${ntf.shortId}`, { user: stranger });
    expect(cap.toasts).toContain("این اعلان دیگر معتبر نیست.");
    expect(await getActiveWinbackSnooze(owner.id)).toBeNull();
  });

  it("wb:opt on a non-win-back notification type is rejected", async () => {
    const user = await makeUser();
    const svc = await makeServiceNotification(user);
    const { cap } = await runUser(`wb:opt:${svc.shortId}`, { user });
    expect(cap.toasts).toContain("این اعلان دیگر معتبر نیست.");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).marketingMessagesEnabled).toBe(true);
  });

  // ===========================================================================
  // 3. snooze / opt-out services
  // ===========================================================================

  it("snoozeWinback stamps a future window + the source notification", async () => {
    const user = await makeUser();
    await snoozeWinback(user.id, 30, "ntf-1");
    const pref = await prisma.customerRetentionPreference.findUniqueOrThrow({ where: { userId: user.id } });
    expect(pref.winbackSnoozedUntil).not.toBeNull();
    expect(pref.lastSnoozedByNotificationId).toBe("ntf-1");
  });

  it("snoozeWinback is idempotent for the same notification (does not extend)", async () => {
    const user = await makeUser();
    await snoozeWinback(user.id, 30, "ntf-1");
    const first = await getActiveWinbackSnooze(user.id);
    await snoozeWinback(user.id, 30, "ntf-1");
    const second = await getActiveWinbackSnooze(user.id);
    expect(second?.getTime()).toBe(first?.getTime());
  });

  it("snoozeWinback from a different notification starts a fresh window", async () => {
    const user = await makeUser();
    await snoozeWinback(user.id, 30, "ntf-1");
    await snoozeWinback(user.id, 30, "ntf-2");
    const pref = await prisma.customerRetentionPreference.findUniqueOrThrow({ where: { userId: user.id } });
    expect(pref.lastSnoozedByNotificationId).toBe("ntf-2");
  });

  it("snooze touches only win-back state (marketing + other prefs unchanged)", async () => {
    const user = await makeUser();
    await snoozeWinback(user.id, 30, "ntf-1");
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.marketingMessagesEnabled).toBe(true);
    expect(after.serviceNotificationsEnabled).toBe(true);
    expect(after.paymentNotificationsEnabled).toBe(true);
  });

  it("optOutMarketing sets marketing off and leaves service/payment/support prefs", async () => {
    const user = await makeUser();
    await optOutMarketing(user.id);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.marketingMessagesEnabled).toBe(false);
    expect(after.serviceNotificationsEnabled).toBe(true);
    expect(after.paymentNotificationsEnabled).toBe(true);
    expect(after.supportMessagesEnabled).toBe(true);
  });

  it("optOutMarketing is idempotent", async () => {
    const user = await makeUser();
    await optOutMarketing(user.id);
    await optOutMarketing(user.id);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).marketingMessagesEnabled).toBe(false);
  });

  it("suppressPendingWinback suppresses only pending rows (idempotent)", async () => {
    const user = await makeUser();
    const scheduled = await prisma.automatedNotification.create({
      data: { type: "CUSTOMER_WINBACK", category: AutomatedNotificationCategory.MARKETING, status: AutomatedNotificationStatus.SCHEDULED, userId: user.id, dedupeKey: `wb-sup-${runTag}-${seq++}`, scheduledFor: new Date(), payloadSnapshot: {} },
    });
    const sent = await makeWinbackNotification(user); // already SENT
    await suppressPendingWinback(user.id, "test");
    expect((await prisma.automatedNotification.findUniqueOrThrow({ where: { id: scheduled.id } })).status).toBe(AutomatedNotificationStatus.SUPPRESSED);
    expect((await prisma.automatedNotification.findUniqueOrThrow({ where: { id: sent.id } })).status).toBe(AutomatedNotificationStatus.SENT);
  });

  it("clearWinbackSnooze clears only the snooze window", async () => {
    const user = await makeUser();
    await snoozeWinback(user.id, 30, "ntf-1");
    await clearWinbackSnooze(user.id);
    expect(await getActiveWinbackSnooze(user.id)).toBeNull();
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).marketingMessagesEnabled).toBe(true);
  });

  // ===========================================================================
  // 4. user settings marketing controls
  // ===========================================================================

  it("the settings page shows the marketing + snooze state and a toggle", async () => {
    const user = await makeUser();
    const { cap } = await runUser("user:nset:root", { user });
    expect(rendered(cap)).toContain("پیشنهادها و پیام‌های بازگشت");
  });

  it("toggling the marketing category flips ONLY marketingMessagesEnabled", async () => {
    const user = await makeUser({ marketingMessagesEnabled: true });
    await runUser("user:nset:toggle:mkt", { user });
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.marketingMessagesEnabled).toBe(false);
    expect(after.serviceNotificationsEnabled).toBe(true);
  });

  it("unsnooze from the settings page clears the win-back snooze", async () => {
    const user = await makeUser();
    await snoozeWinback(user.id, 30, "ntf-1");
    await runUser("user:nset:unsnooze", { user });
    expect(await getActiveWinbackSnooze(user.id)).toBeNull();
  });

  // ===========================================================================
  // 5. dry-run audience preview
  // ===========================================================================

  it("preview counts a genuinely eligible lapsed paying customer", async () => {
    const user = await makeUser();
    await makePurchaseOrder(user);
    await makeService(user, 40);
    const preview = await previewWinbackAudience();
    expect(preview.eligible).toBeGreaterThanOrEqual(1);
    expect(Object.values(preview.perStage).reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(1);
  });

  it("preview records a snoozed exclusion", async () => {
    const user = await makeUser();
    await makePurchaseOrder(user);
    await makeService(user, 40);
    await prisma.customerRetentionPreference.create({ data: { userId: user.id, winbackSnoozedUntil: new Date(Date.now() + 10 * DAY) } });
    const preview = await previewWinbackAudience();
    expect(preview.exclusions.snoozed ?? 0).toBeGreaterThanOrEqual(1);
  });

  it("preview records an active-service exclusion", async () => {
    const user = await makeUser();
    await makePurchaseOrder(user);
    await makeService(user, -10, { status: "ACTIVE" }); // future expiry -> usable
    const preview = await previewWinbackAudience();
    expect(preview.exclusions["active-service"] ?? 0).toBeGreaterThanOrEqual(1);
  });

  it("preview is read-only (creates no notification or preference rows for the fixture)", async () => {
    const user = await makeUser();
    await makePurchaseOrder(user);
    await makeService(user, 40);
    await previewWinbackAudience();
    expect(await prisma.automatedNotification.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.customerRetentionPreference.count({ where: { userId: user.id } })).toBe(0);
  });

  // ===========================================================================
  // 6. admin OWNER-only toggle + activation gate
  // ===========================================================================

  it("blocks a non-owner admin from toggling the win-back rule", async () => {
    await setSetting("notification_customer_winback_enabled", "false", "BOOLEAN");
    clearSettingsCache();
    const { cap } = await runAdmin("admin:ntf:wb:tg", { admin: admin("SUPPORT") });
    expect(cap.toasts.some((t) => t?.includes("مالک"))).toBe(true);
    clearSettingsCache();
    expect((await prisma.setting.findUnique({ where: { key: "notification_customer_winback_enabled" } }))?.value).toBe("false");
  });

  it("owner enabling is refused when the worker status is not fresh (stays disabled)", async () => {
    await setSetting("automated_notifications_enabled", "true", "BOOLEAN");
    await setSetting("notification_customer_winback_enabled", "false", "BOOLEAN");
    clearSettingsCache();
    const { cap } = await runAdmin("admin:ntf:wb:tg", { admin: admin("OWNER") });
    clearSettingsCache();
    expect((await prisma.setting.findUnique({ where: { key: "notification_customer_winback_enabled" } }))?.value).toBe("false");
    expect(rendered(cap)).toContain("امکان فعال‌سازی وجود ندارد");
  });

  it("owner disabling the rule is always allowed", async () => {
    await setSetting("notification_customer_winback_enabled", "true", "BOOLEAN");
    clearSettingsCache();
    const { cap } = await runAdmin("admin:ntf:wb:tg", { admin: admin("OWNER") });
    clearSettingsCache();
    expect((await prisma.setting.findUnique({ where: { key: "notification_customer_winback_enabled" } }))?.value).toBe("false");
    expect(cap.toasts.some((t) => t?.includes("غیرفعال"))).toBe(true);
  });

  it("renders the admin win-back page with a dry-run audience estimate", async () => {
    const { cap } = await runAdmin("admin:ntf:wb", { admin: admin("OWNER") });
    const text = rendered(cap);
    expect(text).toContain("بازگرداندن مشتریان غیرفعال");
    expect(text).toContain("تخمینی");
  });

  it("renders the preview breakdown", async () => {
    const { cap } = await runAdmin("admin:ntf:wb:prev", { admin: admin("OWNER") });
    expect(rendered(cap).length).toBeGreaterThan(0);
  });

  it("the groups page rejects removing the last allowed group", async () => {
    await setSetting("notification_winback_config", JSON.stringify({ stageDays: [30, 60, 90], allowedUserGroups: ["F"], minimumCompletedPaidOrders: 1, minimumLifetimeSpendToman: 0, snoozeDays: 30, maximumNotificationsPerLapseCycle: 3, serviceStateMaxAgeMinutes: 20 }), "JSON");
    clearSettingsCache();
    const { cap } = await runAdmin("admin:ntf:wb:g:F", { admin: admin("OWNER") });
    expect(cap.toasts.some((t) => t?.includes("حداقل یک گروه"))).toBe(true);
  });

  it("a non-owner cannot start a config edit", async () => {
    const { cap } = await runAdmin("admin:ntf:wb:e:stages", { admin: admin("SUPPORT") });
    expect(cap.toasts.some((t) => t?.includes("مالک"))).toBe(true);
  });

  it("a non-owner cannot toggle an allowed group", async () => {
    const { cap } = await runAdmin("admin:ntf:wb:g:N", { admin: admin("SUPPORT") });
    expect(cap.toasts.some((t) => t?.includes("مالک"))).toBe(true);
  });

  it("the test send goes to the requesting OWNER with sample values only", async () => {
    const before = await prisma.automatedNotification.count();
    const { ctx, cap } = fakeCtx("admin:ntf:wb:test", { admin: admin("OWNER") });
    await adminNotificationsHandler.middleware()(ctx, async () => undefined);
    expect(cap.apiSends).toHaveLength(1);
    expect(cap.apiSends[0].chatId).toBe(1); // ctx.from.id
    expect(cap.apiSends[0].text).toContain("پیام آزمایشی");
    // no audience notification created by the test send
    expect(await prisma.automatedNotification.count()).toBe(before);
  });

  it("the win-back page is inert for a non-admin context", async () => {
    const { cap } = await runAdmin("admin:ntf:wb", { admin: null });
    expect(cap.edits).toHaveLength(0);
    expect(cap.replies).toHaveLength(0);
  });

  // ===========================================================================
  // 7. admin config-edit via the numeric-input flow
  // ===========================================================================

  it("owner config edit (stages) validates + persists via the shared parser", async () => {
    const h = fakeCtx("noop", { admin: admin("OWNER"), text: "30، 60، 90", flow: "admin_ntf_wb:cfg", draft: { field: "stages" } });
    await adminNotificationsTextHandler.middleware()(h.ctx, async () => undefined);
    expect(h.cap.replies.some((r) => r.includes("ذخیره شد"))).toBe(true);
    clearSettingsCache();
    const raw = (await prisma.setting.findUnique({ where: { key: "notification_winback_config" } }))?.value ?? "{}";
    expect(JSON.parse(raw).stageDays).toEqual([30, 60, 90]);
  });

  it("an invalid config edit is rejected (no silent reset), flow preserved for retry", async () => {
    const h = fakeCtx("noop", { admin: admin("OWNER"), text: "3, 4", flow: "admin_ntf_wb:cfg", draft: { field: "stages" } });
    await adminNotificationsTextHandler.middleware()(h.ctx, async () => undefined);
    // stage days below the 7-day floor are rejected by the shared parser.
    expect(h.cap.replies.join("\n")).toContain("معتبر نیست");
  });

  it("a non-owner text edit is refused", async () => {
    const h = fakeCtx("noop", { admin: admin("SUPPORT"), text: "30 60 90", flow: "admin_ntf_wb:cfg", draft: { field: "stages" } });
    await adminNotificationsTextHandler.middleware()(h.ctx, async () => undefined);
    expect(h.cap.replies.some((r) => r.includes("مالک"))).toBe(true);
  });

  it("preview records a never-paid exclusion for a narrowed user without a real paid purchase", async () => {
    // paidOrdersCount passes the narrowing, but there is NO completed
    // SERVICE_PURCHASE order -> authoritative check excludes as never-paid.
    const user = await makeUser({ paidOrdersCount: 2 });
    await makeService(user, 40);
    const preview = await previewWinbackAudience();
    expect(preview.exclusions["never-paid"] ?? 0).toBeGreaterThanOrEqual(1);
  });

  it("an owner can add an allowed user group", async () => {
    await setSetting("notification_winback_config", JSON.stringify({ stageDays: [30, 60, 90], allowedUserGroups: ["F"], minimumCompletedPaidOrders: 1, minimumLifetimeSpendToman: 0, snoozeDays: 30, maximumNotificationsPerLapseCycle: 3, serviceStateMaxAgeMinutes: 20 }), "JSON");
    clearSettingsCache();
    await runAdmin("admin:ntf:wb:g:N", { admin: admin("OWNER") });
    clearSettingsCache();
    const raw = (await prisma.setting.findUnique({ where: { key: "notification_winback_config" } }))?.value ?? "{}";
    expect(JSON.parse(raw).allowedUserGroups).toContain("N");
    // Reset the shared config row so a leaked extra group cannot affect the
    // group-scoped assertions in other win-back suites.
    await prisma.setting.deleteMany({ where: { key: "notification_winback_config" } });
    clearSettingsCache();
  });

  it("wb:snz is idempotent across two confirm clicks (one snooze window)", async () => {
    const user = await makeUser();
    const ntf = await makeWinbackNotification(user);
    await runUser(`wb:snz:${ntf.shortId}`, { user });
    const first = await getActiveWinbackSnooze(user.id);
    await runUser(`wb:snz:${ntf.shortId}`, { user });
    const second = await getActiveWinbackSnooze(user.id);
    expect(second?.getTime()).toBe(first?.getTime());
    expect(await prisma.customerRetentionPreference.count({ where: { userId: user.id } })).toBe(1);
  });
});
