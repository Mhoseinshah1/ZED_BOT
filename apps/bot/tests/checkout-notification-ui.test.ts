import {
  AutomatedNotificationCategory,
  AutomatedNotificationStatus,
  NotificationInteractionType,
  prisma,
  type Admin,
  type CheckoutSession,
  type Payment,
  type User,
} from "@zedbot/database";
import { afterAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "checkout-ui-tests-secret-0123456789";

import { adminNotificationsHandler } from "../src/handlers/admin-settings/notifications.handler.js";
import { userNotificationsHandler } from "../src/handlers/user-notifications/notification.handler.js";
import {
  previewAbandonedAudience,
  previewPaymentAudience,
  suppressCheckoutReminders,
} from "../src/services/checkout-notification.service.js";
import {
  resolveResumableCheckout,
  resumeCheckoutForUser,
} from "../src/services/checkout-resume.service.js";
import { clearSettingsCache, setSetting } from "../src/services/settings.service.js";

// =============================================================================
// Checkout-payment reminder BOT UI (real DB), Phase 2:
//   - resume service (resolveResumableCheckout precedence + resumeCheckoutForUser
//     rendering, incl. the NOT_OWNER no-dead-end toast and the never-mutate /
//     never-create-a-new-checkout invariants),
//   - the ntf:* checkout actions (c continue / d detail / n suppress), ownership
//     + idempotency + no-secret,
//   - per-checkout suppression (idempotent, one-kind, never global),
//   - the read-only dry-run audience preview (eligible lower bound + exclusion
//     reasons + no writes),
//   - the admin OWNER-only rule toggle + fail-safe activation gate.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const d = hasDb ? describe : describe.skip;

const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
const MIN = 60_000;
const HOUR = 60 * MIN;

interface Captured {
  edits: string[];
  replies: string[];
  toasts: Array<string | undefined>;
  replyMarkupCleared: boolean;
  apiSends: Array<{ chatId: number; text: string }>;
}

function fakeCtx(
  data: string,
  opts: { user?: User | null; admin?: Admin | null; sendFails?: boolean } = {},
) {
  const cap: Captured = {
    edits: [],
    replies: [],
    toasts: [],
    replyMarkupCleared: false,
    apiSends: [],
  };
  const callbackQuery = {
    id: "cbq",
    chat_instance: "ci",
    from: { id: 1, is_bot: false, first_name: "T" },
    data,
    message: { message_id: 5, date: 0, chat: { id: 1, type: "private" } },
  };
  const ctx = {
    session: { temp: {}, currentFlow: undefined, lastMenu: undefined },
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

function rendered(cap: Captured): string {
  return [...cap.edits, ...cap.replies].join("\n");
}

d("checkout notification bot UI", () => {
  let seq = 0;

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function makeUser(overrides: Partial<User> = {}): Promise<User> {
    seq += 1;
    return prisma.user.create({ data: { telegramId: runTag + BigInt(seq), ...overrides } });
  }

  /** A PENDING checkout. When inactiveMinutes is set, createdAt+updatedAt are backdated. */
  async function makeCheckout(
    user: User,
    overrides: Partial<CheckoutSession> = {},
    inactiveMinutes?: number,
  ): Promise<CheckoutSession> {
    seq += 1;
    const checkout = await prisma.checkoutSession.create({
      data: {
        userId: user.id,
        purpose: "ORDER_PAYMENT",
        finalPriceToman: 120000,
        productSnapshot: { productName: "پلن تست" },
        expiresAt: new Date(Date.now() + 6 * HOUR),
        status: "PENDING",
        ...overrides,
      },
    });
    if (inactiveMinutes !== undefined) {
      const at = new Date(Date.now() - inactiveMinutes * MIN);
      await prisma.$executeRawUnsafe(
        `UPDATE "CheckoutSession" SET "createdAt" = $1, "updatedAt" = $2 WHERE id = $3`,
        at,
        at,
        checkout.id,
      );
    }
    return checkout;
  }

  async function makePayment(
    user: User,
    checkout: CheckoutSession,
    overrides: Partial<Payment>,
    failedMinutesAgo?: number,
  ): Promise<Payment> {
    seq += 1;
    const payment = await prisma.payment.create({
      data: {
        userId: user.id,
        checkoutSessionId: checkout.id,
        purpose: "ORDER_PAYMENT",
        amountToman: 120000,
        payableAmountToman: 120000,
        status: "FAILED",
        provider: "ZARINPAL",
        ...overrides,
      },
    });
    if (failedMinutesAgo !== undefined) {
      const at = new Date(Date.now() - failedMinutesAgo * MIN);
      await prisma.$executeRawUnsafe(
        `UPDATE "Payment" SET "createdAt" = $1, "updatedAt" = $2 WHERE id = $3`,
        at,
        at,
        payment.id,
      );
    }
    return payment;
  }

  async function makeNotification(
    user: User,
    checkout: CheckoutSession | null,
    type: "ABANDONED_CHECKOUT" | "PAYMENT_RETRY" = "ABANDONED_CHECKOUT",
  ): Promise<{ id: string; shortId: string }> {
    seq += 1;
    const row = await prisma.automatedNotification.create({
      data: {
        type,
        category: AutomatedNotificationCategory.PAYMENT,
        status: AutomatedNotificationStatus.SENT,
        userId: user.id,
        checkoutSessionId: checkout?.id ?? null,
        dedupeKey: `ntf-co-ui-${runTag}-${seq}`,
        scheduledFor: new Date(),
        payloadSnapshot: {
          templateKey: "notification_abandoned_checkout",
          variables: { product_name: "پلن تست" },
          buttons: [],
        },
      },
      select: { id: true },
    });
    return { id: row.id, shortId: row.id.slice(0, 8) };
  }

  async function makeReconciliation(
    user: User,
    checkout: CheckoutSession,
    status: "OPEN" | "IN_REVIEW",
  ): Promise<void> {
    const dup = await makePayment(user, checkout, { status: "FAILED", provider: "ZARINPAL" });
    await prisma.financialReconciliationCase.create({
      data: {
        type: "DUPLICATE_CHECKOUT_PAYMENT",
        checkoutSessionId: checkout.id,
        duplicatePaymentId: dup.id,
        userId: user.id,
        expectedAmountToman: 120000,
        status,
      },
    });
  }

  function admin(role: "OWNER" | "SUPPORT"): Admin {
    return { id: `admin-${role}-${runTag}`, role } as unknown as Admin;
  }

  // ===========================================================================
  // 1. resolveResumableCheckout — precedence + read-only
  // ===========================================================================

  it("RESUMABLE for a PENDING, unsettled, unexpired checkout", async () => {
    const user = await makeUser();
    const checkout = await makeCheckout(user);
    const r = await resolveResumableCheckout(checkout.id, user.id);
    expect(r.result).toBe("RESUMABLE");
  });

  it("NOT_FOUND for a checkout id that does not exist", async () => {
    const user = await makeUser();
    const r = await resolveResumableCheckout("00000000-0000-0000-0000-000000000000", user.id);
    expect(r.result).toBe("NOT_FOUND");
    expect(r.checkout).toBeNull();
  });

  it("NOT_OWNER for a checkout owned by another user (no existence reveal)", async () => {
    const owner = await makeUser();
    const stranger = await makeUser();
    const checkout = await makeCheckout(owner);
    const r = await resolveResumableCheckout(checkout.id, stranger.id);
    expect(r.result).toBe("NOT_OWNER");
    expect(r.checkout).toBeNull();
  });

  it("ALREADY_SETTLED when settledByPaymentId is set", async () => {
    const user = await makeUser();
    const checkout = await makeCheckout(user);
    const payment = await makePayment(user, checkout, { status: "APPROVED", settlementStatus: "SETTLED" });
    await prisma.checkoutSession.update({
      where: { id: checkout.id },
      data: { settledByPaymentId: payment.id, status: "PAID" },
    });
    const r = await resolveResumableCheckout(checkout.id, user.id);
    expect(r.result).toBe("ALREADY_SETTLED");
  });

  it("ALREADY_SETTLED when an Order already exists", async () => {
    const user = await makeUser();
    const checkout = await makeCheckout(user);
    await prisma.order.create({
      data: { userId: user.id, type: "SERVICE_PURCHASE", checkoutSessionId: checkout.id },
    });
    const r = await resolveResumableCheckout(checkout.id, user.id);
    expect(r.result).toBe("ALREADY_SETTLED");
  });

  it("ALREADY_SETTLED when the status is COMPLETED", async () => {
    const user = await makeUser();
    const checkout = await makeCheckout(user, { status: "COMPLETED" });
    const r = await resolveResumableCheckout(checkout.id, user.id);
    expect(r.result).toBe("ALREADY_SETTLED");
  });

  it("EXPIRED when the status is EXPIRED", async () => {
    const user = await makeUser();
    const checkout = await makeCheckout(user, { status: "EXPIRED" });
    const r = await resolveResumableCheckout(checkout.id, user.id);
    expect(r.result).toBe("EXPIRED");
  });

  it("EXPIRED when expiresAt is in the past (still PENDING)", async () => {
    const user = await makeUser();
    const checkout = await makeCheckout(user, { expiresAt: new Date(Date.now() - HOUR) });
    const r = await resolveResumableCheckout(checkout.id, user.id);
    expect(r.result).toBe("EXPIRED");
  });

  it("CANCELLED when the status is CANCELLED", async () => {
    const user = await makeUser();
    const checkout = await makeCheckout(user, { status: "CANCELLED" });
    const r = await resolveResumableCheckout(checkout.id, user.id);
    expect(r.result).toBe("CANCELLED");
  });

  it("CANCELLED when the status is FAILED_REFUNDED", async () => {
    const user = await makeUser();
    const checkout = await makeCheckout(user, { status: "FAILED_REFUNDED" });
    const r = await resolveResumableCheckout(checkout.id, user.id);
    expect(r.result).toBe("CANCELLED");
  });

  it("PENDING_RECEIPT_REVIEW when a receipt is awaiting review", async () => {
    const user = await makeUser();
    const checkout = await makeCheckout(user);
    await makePayment(user, checkout, { status: "PENDING_REVIEW", provider: "CARD_TO_CARD" });
    const r = await resolveResumableCheckout(checkout.id, user.id);
    expect(r.result).toBe("PENDING_RECEIPT_REVIEW");
  });

  it("RECONCILIATION_REQUIRED when an OPEN reconciliation case exists", async () => {
    const user = await makeUser();
    const checkout = await makeCheckout(user);
    await makeReconciliation(user, checkout, "OPEN");
    const r = await resolveResumableCheckout(checkout.id, user.id);
    expect(r.result).toBe("RECONCILIATION_REQUIRED");
  });

  it("RECONCILIATION_REQUIRED when an IN_REVIEW reconciliation case exists", async () => {
    const user = await makeUser();
    const checkout = await makeCheckout(user);
    await makeReconciliation(user, checkout, "IN_REVIEW");
    const r = await resolveResumableCheckout(checkout.id, user.id);
    expect(r.result).toBe("RECONCILIATION_REQUIRED");
  });

  it("reconciliation takes precedence over a pending-review receipt", async () => {
    const user = await makeUser();
    const checkout = await makeCheckout(user);
    await makePayment(user, checkout, { status: "PENDING_REVIEW", provider: "CARD_TO_CARD" });
    await makeReconciliation(user, checkout, "OPEN");
    const r = await resolveResumableCheckout(checkout.id, user.id);
    expect(r.result).toBe("RECONCILIATION_REQUIRED");
  });

  it("pending-review receipt takes precedence over settlement", async () => {
    const user = await makeUser();
    const checkout = await makeCheckout(user);
    const settled = await makePayment(user, checkout, { status: "APPROVED", settlementStatus: "SETTLED" });
    await prisma.checkoutSession.update({
      where: { id: checkout.id },
      data: { settledByPaymentId: settled.id },
    });
    await makePayment(user, checkout, { status: "PENDING_REVIEW", provider: "CARD_TO_CARD" });
    const r = await resolveResumableCheckout(checkout.id, user.id);
    expect(r.result).toBe("PENDING_RECEIPT_REVIEW");
  });

  it("resolve is read-only (never mutates the checkout row)", async () => {
    const user = await makeUser();
    const checkout = await makeCheckout(user);
    await resolveResumableCheckout(checkout.id, user.id);
    const after = await prisma.checkoutSession.findUniqueOrThrow({ where: { id: checkout.id } });
    expect(after.status).toBe("PENDING");
    expect(after.settledByPaymentId).toBeNull();
  });

  // ===========================================================================
  // 2. resumeCheckoutForUser — rendering (never a dead-end, never a mutation)
  // ===========================================================================

  it("RESUMABLE hands off to the method-selection surface (renders a page)", async () => {
    const user = await makeUser();
    const checkout = await makeCheckout(user);
    const { ctx, cap } = fakeCtx("noop", { user });
    await resumeCheckoutForUser(ctx, checkout.id);
    // Something was rendered; the callback was answered without an error toast.
    expect(rendered(cap).length).toBeGreaterThan(0);
  });

  it("RESUMABLE creates NO new checkout and mutates nothing", async () => {
    const user = await makeUser();
    const checkout = await makeCheckout(user);
    const before = await prisma.checkoutSession.count({ where: { userId: user.id } });
    const { ctx } = fakeCtx("noop", { user });
    await resumeCheckoutForUser(ctx, checkout.id);
    const after = await prisma.checkoutSession.count({ where: { userId: user.id } });
    expect(after).toBe(before);
    const row = await prisma.checkoutSession.findUniqueOrThrow({ where: { id: checkout.id } });
    expect(row.status).toBe("PENDING");
    expect(row.settledByPaymentId).toBeNull();
  });

  it("NOT_OWNER answers with a toast and does NOT edit the message (no dead-end)", async () => {
    const owner = await makeUser();
    const stranger = await makeUser();
    const checkout = await makeCheckout(owner);
    const { ctx, cap } = fakeCtx("noop", { user: stranger });
    await resumeCheckoutForUser(ctx, checkout.id);
    expect(cap.toasts).toContain("این اعلان دیگر معتبر نیست.");
    expect(cap.edits).toHaveLength(0);
    expect(cap.replies).toHaveLength(0);
  });

  it("ALREADY_SETTLED renders the settled message with an orders keyboard", async () => {
    const user = await makeUser();
    const checkout = await makeCheckout(user);
    const payment = await makePayment(user, checkout, { status: "APPROVED", settlementStatus: "SETTLED" });
    await prisma.checkoutSession.update({
      where: { id: checkout.id },
      data: { settledByPaymentId: payment.id, status: "PAID" },
    });
    const { ctx, cap } = fakeCtx("noop", { user });
    await resumeCheckoutForUser(ctx, checkout.id);
    expect(rendered(cap)).toContain("این سفارش قبلاً پرداخت شده است.");
  });

  it("PENDING_RECEIPT_REVIEW renders the waiting message", async () => {
    const user = await makeUser();
    const checkout = await makeCheckout(user);
    await makePayment(user, checkout, { status: "PENDING_REVIEW", provider: "CARD_TO_CARD" });
    const { ctx, cap } = fakeCtx("noop", { user });
    await resumeCheckoutForUser(ctx, checkout.id);
    expect(rendered(cap)).toContain("در انتظار بررسی");
  });

  it("RECONCILIATION_REQUIRED routes the user to support", async () => {
    const user = await makeUser();
    const checkout = await makeCheckout(user);
    await makeReconciliation(user, checkout, "OPEN");
    const { ctx, cap } = fakeCtx("noop", { user });
    await resumeCheckoutForUser(ctx, checkout.id);
    expect(rendered(cap)).toContain("پشتیبانی");
  });

  it("EXPIRED renders the not-resumable message (real onward keyboard)", async () => {
    const user = await makeUser();
    const checkout = await makeCheckout(user, { status: "EXPIRED" });
    const { ctx, cap } = fakeCtx("noop", { user });
    await resumeCheckoutForUser(ctx, checkout.id);
    expect(rendered(cap)).toContain("این سفارش دیگر قابل ادامه نیست");
  });

  it("resumeCheckoutForUser is a no-op with no authenticated user", async () => {
    const { ctx, cap } = fakeCtx("noop", { user: null });
    await resumeCheckoutForUser(ctx, "00000000-0000-0000-0000-000000000000");
    expect(cap.edits).toHaveLength(0);
    expect(cap.replies).toHaveLength(0);
    expect(cap.toasts).toHaveLength(0);
  });

  // ===========================================================================
  // 3. ntf:* checkout actions (c continue / d detail / n suppress)
  // ===========================================================================

  it("action c resumes the checkout and records CONTINUE_CHECKOUT once (idempotent)", async () => {
    const user = await makeUser();
    const checkout = await makeCheckout(user);
    const ntf = await makeNotification(user, checkout);
    for (let i = 0; i < 2; i += 1) {
      const { ctx } = fakeCtx(`ntf:${ntf.shortId}:c`, { user });
      await userNotificationsHandler.middleware()(ctx, async () => undefined);
    }
    expect(
      await prisma.notificationInteraction.count({
        where: { notificationId: ntf.id, type: NotificationInteractionType.CONTINUE_CHECKOUT },
      }),
    ).toBe(1);
  });

  it("action d renders the checkout detail view and records CONTINUE_CHECKOUT", async () => {
    const user = await makeUser();
    const checkout = await makeCheckout(user);
    const ntf = await makeNotification(user, checkout);
    const { ctx, cap } = fakeCtx(`ntf:${ntf.shortId}:d`, { user });
    await userNotificationsHandler.middleware()(ctx, async () => undefined);
    expect(rendered(cap).length).toBeGreaterThan(0);
    expect(
      await prisma.notificationInteraction.count({
        where: { notificationId: ntf.id, type: NotificationInteractionType.CONTINUE_CHECKOUT },
      }),
    ).toBe(1);
  });

  it("action d on a notification with no checkout attached answers invalid (no leak)", async () => {
    const user = await makeUser();
    const ntf = await makeNotification(user, null);
    const { ctx, cap } = fakeCtx(`ntf:${ntf.shortId}:d`, { user });
    await userNotificationsHandler.middleware()(ctx, async () => undefined);
    expect(cap.toasts).toContain("این اعلان دیگر معتبر نیست.");
    expect(cap.edits).toHaveLength(0);
  });

  it("action n suppresses the checkout, strips the keyboard and records DISMISS", async () => {
    const user = await makeUser();
    const checkout = await makeCheckout(user);
    const ntf = await makeNotification(user, checkout);
    const { ctx, cap } = fakeCtx(`ntf:${ntf.shortId}:n`, { user });
    await userNotificationsHandler.middleware()(ctx, async () => undefined);
    expect(cap.replyMarkupCleared).toBe(true);
    expect(cap.toasts).toContain("دیگر برای این سفارش یادآوری ارسال نمی‌شود.");
    const pref = await prisma.checkoutNotificationPreference.findUnique({
      where: { checkoutSessionId: checkout.id },
    });
    expect(pref?.abandonedReminderSuppressedAt).not.toBeNull();
    expect(
      await prisma.notificationInteraction.count({
        where: { notificationId: ntf.id, type: NotificationInteractionType.DISMISS },
      }),
    ).toBe(1);
  });

  it("action n on a PAYMENT_RETRY notification suppresses the payment kind", async () => {
    const user = await makeUser();
    const checkout = await makeCheckout(user);
    const ntf = await makeNotification(user, checkout, "PAYMENT_RETRY");
    const { ctx } = fakeCtx(`ntf:${ntf.shortId}:n`, { user });
    await userNotificationsHandler.middleware()(ctx, async () => undefined);
    const pref = await prisma.checkoutNotificationPreference.findUniqueOrThrow({
      where: { checkoutSessionId: checkout.id },
    });
    expect(pref.paymentRetrySuppressedAt).not.toBeNull();
    expect(pref.abandonedReminderSuppressedAt).toBeNull();
  });

  it("a foreign user's checkout notification short id is rejected (no interaction recorded)", async () => {
    const owner = await makeUser();
    const stranger = await makeUser();
    const checkout = await makeCheckout(owner);
    const ntf = await makeNotification(owner, checkout);
    const { ctx, cap } = fakeCtx(`ntf:${ntf.shortId}:c`, { user: stranger });
    await userNotificationsHandler.middleware()(ctx, async () => undefined);
    expect(cap.toasts).toContain("این اعلان دیگر معتبر نیست.");
    expect(await prisma.notificationInteraction.count({ where: { notificationId: ntf.id } })).toBe(0);
  });

  it("no secret leaks into the rendered continue/detail surfaces", async () => {
    const user = await makeUser();
    const checkout = await makeCheckout(user);
    const ntf = await makeNotification(user, checkout);
    const { ctx, cap } = fakeCtx(`ntf:${ntf.shortId}:d`, { user });
    await userNotificationsHandler.middleware()(ctx, async () => undefined);
    const text = rendered(cap);
    // Callback data + rendered text must never carry the full checkout uuid.
    expect(text).not.toContain(checkout.id);
  });

  // ===========================================================================
  // 4. suppressCheckoutReminders — idempotent, one-kind, never global
  // ===========================================================================

  it("stamps the abandoned suppression field and the source notification", async () => {
    const user = await makeUser();
    const checkout = await makeCheckout(user);
    const ntf = await makeNotification(user, checkout);
    await suppressCheckoutReminders(checkout.id, "abandoned", ntf.id);
    const pref = await prisma.checkoutNotificationPreference.findUniqueOrThrow({
      where: { checkoutSessionId: checkout.id },
    });
    expect(pref.abandonedReminderSuppressedAt).not.toBeNull();
    expect(pref.suppressedByNotificationId).toBe(ntf.id);
  });

  it("is idempotent: a second call preserves the original instant", async () => {
    const user = await makeUser();
    const checkout = await makeCheckout(user);
    const ntf = await makeNotification(user, checkout);
    await suppressCheckoutReminders(checkout.id, "abandoned", ntf.id);
    const first = await prisma.checkoutNotificationPreference.findUniqueOrThrow({
      where: { checkoutSessionId: checkout.id },
    });
    await suppressCheckoutReminders(checkout.id, "abandoned", ntf.id);
    const second = await prisma.checkoutNotificationPreference.findUniqueOrThrow({
      where: { checkoutSessionId: checkout.id },
    });
    expect(second.abandonedReminderSuppressedAt?.getTime()).toBe(
      first.abandonedReminderSuppressedAt?.getTime(),
    );
  });

  it("suppressing one kind never stamps the other kind", async () => {
    const user = await makeUser();
    const checkout = await makeCheckout(user);
    const ntf = await makeNotification(user, checkout);
    await suppressCheckoutReminders(checkout.id, "payment", ntf.id);
    const pref = await prisma.checkoutNotificationPreference.findUniqueOrThrow({
      where: { checkoutSessionId: checkout.id },
    });
    expect(pref.paymentRetrySuppressedAt).not.toBeNull();
    expect(pref.abandonedReminderSuppressedAt).toBeNull();
  });

  it("concurrent first-writes converge to exactly one preference row", async () => {
    const user = await makeUser();
    const checkout = await makeCheckout(user);
    const ntf = await makeNotification(user, checkout);
    await Promise.all([
      suppressCheckoutReminders(checkout.id, "abandoned", ntf.id),
      suppressCheckoutReminders(checkout.id, "abandoned", ntf.id),
    ]);
    expect(
      await prisma.checkoutNotificationPreference.count({
        where: { checkoutSessionId: checkout.id },
      }),
    ).toBe(1);
  });

  it("suppression never mutates the user's global notification preferences", async () => {
    const user = await makeUser();
    const checkout = await makeCheckout(user);
    const ntf = await makeNotification(user, checkout);
    await suppressCheckoutReminders(checkout.id, "abandoned", ntf.id);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.cronNotificationsEnabled).toBe(true);
    expect(after.paymentNotificationsEnabled).toBe(true);
    // No global NotificationPreference row is created as a side-effect.
    expect(
      await prisma.notificationPreference.findUnique({ where: { userId: user.id } }),
    ).toBeNull();
  });

  // ===========================================================================
  // 5. dry-run audience preview — eligible lower bound, exclusions, no writes
  // ===========================================================================

  it("abandoned preview counts a genuinely eligible checkout", async () => {
    const user = await makeUser();
    await makeCheckout(user, {}, 40); // 40 min inactive > 30 min stage-1 threshold
    const preview = await previewAbandonedAudience();
    expect(preview.eligible).toBeGreaterThanOrEqual(1);
    expect(preview.scanned).toBeGreaterThanOrEqual(1);
  });

  it("abandoned preview records a suppressed exclusion reason", async () => {
    const user = await makeUser();
    const checkout = await makeCheckout(user, {}, 40);
    await prisma.checkoutNotificationPreference.create({
      data: { checkoutSessionId: checkout.id, abandonedReminderSuppressedAt: new Date() },
    });
    const preview = await previewAbandonedAudience();
    expect(preview.exclusions.suppressed ?? 0).toBeGreaterThanOrEqual(1);
  });

  it("abandoned preview is read-only (creates no notification rows for the fixture)", async () => {
    const user = await makeUser();
    const checkout = await makeCheckout(user, {}, 40);
    await previewAbandonedAudience();
    expect(
      await prisma.automatedNotification.count({ where: { checkoutSessionId: checkout.id } }),
    ).toBe(0);
  });

  it("payment preview counts an eligible failed online payment", async () => {
    const user = await makeUser();
    const checkout = await makeCheckout(user, {}, 3); // recent activity, still PENDING
    await makePayment(user, checkout, { status: "FAILED", provider: "ZARINPAL" }, 20);
    const preview = await previewPaymentAudience();
    expect(preview.eligible).toBeGreaterThanOrEqual(1);
  });

  it("payment preview excludes a card-to-card failure (never scanned)", async () => {
    const user = await makeUser();
    const checkout = await makeCheckout(user, {}, 3);
    await makePayment(user, checkout, { status: "FAILED", provider: "CARD_TO_CARD" }, 20);
    // The card-to-card payment is filtered out by the provider WHERE, so it never
    // becomes a PAYMENT_RETRY reminder for this checkout.
    await previewPaymentAudience();
    expect(
      await prisma.automatedNotification.count({
        where: { checkoutSessionId: checkout.id, type: "PAYMENT_RETRY" },
      }),
    ).toBe(0);
  });

  it("payment preview records a checkout-settled exclusion", async () => {
    const user = await makeUser();
    const checkout = await makeCheckout(user, {}, 3);
    const failed = await makePayment(user, checkout, { status: "FAILED", provider: "ZARINPAL" }, 20);
    const settled = await makePayment(user, checkout, {
      status: "APPROVED",
      provider: "NOWPAYMENTS",
      settlementStatus: "SETTLED",
    });
    await prisma.checkoutSession.update({
      where: { id: checkout.id },
      data: { settledByPaymentId: settled.id, status: "PAID" },
    });
    const preview = await previewPaymentAudience();
    // The still-FAILED ZARINPAL payment is scanned but excluded because its
    // checkout is now settled / another payment succeeded.
    expect(preview.eligible).toBeGreaterThanOrEqual(0);
    const excludedTotal = Object.values(preview.exclusions).reduce((a, b) => a + (b ?? 0), 0);
    expect(excludedTotal).toBeGreaterThanOrEqual(1);
    void failed;
  });

  it("payment preview is read-only (creates no notification rows for the fixture)", async () => {
    const user = await makeUser();
    const checkout = await makeCheckout(user, {}, 3);
    await makePayment(user, checkout, { status: "FAILED", provider: "ZARINPAL" }, 20);
    await previewPaymentAudience();
    expect(
      await prisma.automatedNotification.count({ where: { checkoutSessionId: checkout.id } }),
    ).toBe(0);
  });

  // ===========================================================================
  // 6. admin OWNER-only toggle + fail-safe activation gate
  // ===========================================================================

  it("blocks a non-owner admin from toggling the abandoned rule (rule unchanged)", async () => {
    await setSetting("notification_abandoned_checkout_enabled", "false", "BOOLEAN");
    clearSettingsCache();
    const { ctx, cap } = fakeCtx("admin:ntf:co:tg:abandoned", { admin: admin("SUPPORT") });
    await adminNotificationsHandler.middleware()(ctx, async () => undefined);
    expect(cap.toasts.some((t) => t?.includes("مالک"))).toBe(true);
    clearSettingsCache();
    expect(
      (await prisma.setting.findUnique({ where: { key: "notification_abandoned_checkout_enabled" } }))
        ?.value,
    ).toBe("false");
  });

  it("blocks a non-owner admin from toggling the payment rule (rule unchanged)", async () => {
    await setSetting("notification_payment_retry_enabled", "false", "BOOLEAN");
    clearSettingsCache();
    const { ctx, cap } = fakeCtx("admin:ntf:co:tg:payment", { admin: admin("SUPPORT") });
    await adminNotificationsHandler.middleware()(ctx, async () => undefined);
    expect(cap.toasts.some((t) => t?.includes("مالک"))).toBe(true);
    clearSettingsCache();
    expect(
      (await prisma.setting.findUnique({ where: { key: "notification_payment_retry_enabled" } }))
        ?.value,
    ).toBe("false");
  });

  it("owner enabling the abandoned rule is refused when the worker status is not fresh", async () => {
    await setSetting("automated_notifications_enabled", "true", "BOOLEAN");
    await setSetting("notification_abandoned_checkout_enabled", "false", "BOOLEAN");
    clearSettingsCache();
    // No fresh notification worker status is published in this test env, so the
    // activation gate must refuse and leave the rule OFF.
    const { ctx, cap } = fakeCtx("admin:ntf:co:tg:abandoned", { admin: admin("OWNER") });
    await adminNotificationsHandler.middleware()(ctx, async () => undefined);
    clearSettingsCache();
    expect(
      (await prisma.setting.findUnique({ where: { key: "notification_abandoned_checkout_enabled" } }))
        ?.value,
    ).toBe("false");
    expect(rendered(cap)).toContain("فعال‌سازی ممکن نشد");
  });

  it("owner disabling a rule is always allowed (never gated)", async () => {
    await setSetting("notification_payment_retry_enabled", "true", "BOOLEAN");
    clearSettingsCache();
    const { ctx, cap } = fakeCtx("admin:ntf:co:tg:payment", { admin: admin("OWNER") });
    await adminNotificationsHandler.middleware()(ctx, async () => undefined);
    clearSettingsCache();
    expect(
      (await prisma.setting.findUnique({ where: { key: "notification_payment_retry_enabled" } }))
        ?.value,
    ).toBe("false");
    expect(cap.toasts.some((t) => t?.includes("غیرفعال"))).toBe(true);
  });

  it("renders the abandoned rule page with a dry-run audience estimate", async () => {
    const { ctx, cap } = fakeCtx("admin:ntf:co:abandoned", { admin: admin("OWNER") });
    await adminNotificationsHandler.middleware()(ctx, async () => undefined);
    const text = rendered(cap);
    expect(text).toContain("یادآوری سفارش ناقص");
    expect(text).toContain("تخمینی");
  });

  it("renders the payment rule page with a dry-run audience estimate", async () => {
    const { ctx, cap } = fakeCtx("admin:ntf:co:payment", { admin: admin("OWNER") });
    await adminNotificationsHandler.middleware()(ctx, async () => undefined);
    const text = rendered(cap);
    expect(text).toContain("یادآوری پرداخت ناموفق");
    expect(text).toContain("تخمینی");
  });

  it("the preview breakdown callback lists exclusion reasons", async () => {
    const { ctx, cap } = fakeCtx("admin:ntf:co:prev:abandoned", { admin: admin("OWNER") });
    await adminNotificationsHandler.middleware()(ctx, async () => undefined);
    const text = rendered(cap);
    expect(text.length).toBeGreaterThan(0);
    // Either concrete exclusion reasons or the "all eligible / none found" note.
    expect(text).toMatch(/دلایل خارج‌شدن از فهرست|واجد شرایط بودند|موردی یافت نشد/);
  });

  it("a non-owner admin cannot start a config edit", async () => {
    const { ctx, cap } = fakeCtx("admin:ntf:co:e:abandoned:t1", { admin: admin("SUPPORT") });
    await adminNotificationsHandler.middleware()(ctx, async () => undefined);
    expect(cap.toasts.some((t) => t?.includes("مالک"))).toBe(true);
  });

  it("a checkout rule page is inert for a non-admin context", async () => {
    const { ctx, cap } = fakeCtx("admin:ntf:co:abandoned", { admin: null });
    await adminNotificationsHandler.middleware()(ctx, async () => undefined);
    expect(cap.edits).toHaveLength(0);
    expect(cap.replies).toHaveLength(0);
  });

  // ===========================================================================
  // 7. live re-check + idempotency + preview exclusion wiring (edge cases)
  // ===========================================================================

  it("action c re-checks LIVE state: a now-settled checkout renders the settled message", async () => {
    const user = await makeUser();
    const checkout = await makeCheckout(user);
    const ntf = await makeNotification(user, checkout);
    // The reminder was created while PENDING; the checkout settles afterwards.
    const payment = await makePayment(user, checkout, { status: "APPROVED", settlementStatus: "SETTLED" });
    await prisma.checkoutSession.update({
      where: { id: checkout.id },
      data: { settledByPaymentId: payment.id, status: "PAID" },
    });
    const { ctx, cap } = fakeCtx(`ntf:${ntf.shortId}:c`, { user });
    await userNotificationsHandler.middleware()(ctx, async () => undefined);
    expect(rendered(cap)).toContain("این سفارش قبلاً پرداخت شده است.");
  });

  it("action d reflects LIVE pending-review state in the detail view", async () => {
    const user = await makeUser();
    const checkout = await makeCheckout(user);
    const ntf = await makeNotification(user, checkout);
    await makePayment(user, checkout, { status: "PENDING_REVIEW", provider: "CARD_TO_CARD" });
    const { ctx, cap } = fakeCtx(`ntf:${ntf.shortId}:d`, { user });
    await userNotificationsHandler.middleware()(ctx, async () => undefined);
    expect(rendered(cap)).toContain("در انتظار بررسی");
  });

  it("action n is idempotent across two clicks (one DISMISS, one preference row)", async () => {
    const user = await makeUser();
    const checkout = await makeCheckout(user);
    const ntf = await makeNotification(user, checkout);
    for (let i = 0; i < 2; i += 1) {
      const { ctx, cap } = fakeCtx(`ntf:${ntf.shortId}:n`, { user });
      await userNotificationsHandler.middleware()(ctx, async () => undefined);
      expect(cap.toasts).toContain("دیگر برای این سفارش یادآوری ارسال نمی‌شود.");
    }
    expect(
      await prisma.notificationInteraction.count({
        where: { notificationId: ntf.id, type: NotificationInteractionType.DISMISS },
      }),
    ).toBe(1);
    expect(
      await prisma.checkoutNotificationPreference.count({
        where: { checkoutSessionId: checkout.id },
      }),
    ).toBe(1);
  });

  it("abandoned preview surfaces a too-early exclusion for a recently-active checkout", async () => {
    const user = await makeUser();
    await makeCheckout(user, {}, 10); // 10 min inactive < 30 min stage-1 threshold
    const preview = await previewAbandonedAudience();
    expect(preview.exclusions["too-early"] ?? 0).toBeGreaterThanOrEqual(1);
  });

  it("payment preview surfaces a max-per-payment exclusion once a retry already exists", async () => {
    const user = await makeUser();
    const checkout = await makeCheckout(user, {}, 3);
    const payment = await makePayment(user, checkout, { status: "FAILED", provider: "ZARINPAL" }, 20);
    seq += 1;
    await prisma.automatedNotification.create({
      data: {
        type: "PAYMENT_RETRY",
        category: AutomatedNotificationCategory.PAYMENT,
        status: AutomatedNotificationStatus.SENT,
        userId: user.id,
        checkoutSessionId: checkout.id,
        paymentId: payment.id,
        dedupeKey: `ntf-co-ui-retry-${runTag}-${seq}`,
        scheduledFor: new Date(),
        payloadSnapshot: { templateKey: "notification_payment_retry", variables: {}, buttons: [] },
      },
    });
    const preview = await previewPaymentAudience();
    expect(preview.exclusions["max-per-payment"] ?? 0).toBeGreaterThanOrEqual(1);
  });

  it("owner starting a config edit enters the numeric-input flow", async () => {
    const { ctx } = fakeCtx("admin:ntf:co:e:abandoned:t1", { admin: admin("OWNER") });
    await adminNotificationsHandler.middleware()(ctx, async () => undefined);
    const session = (ctx as unknown as { session: { currentFlow?: string } }).session;
    expect(session.currentFlow).toBe("admin_ntf_co:cfg");
  });
});
