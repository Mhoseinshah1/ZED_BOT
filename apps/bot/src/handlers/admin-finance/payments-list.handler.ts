import {
  PaymentGatewayType,
  PaymentStatus,
  prisma,
  type Payment,
  type PaymentGateway,
  type Prisma,
  type User,
} from "@zedbot/database";
import { Composer, InlineKeyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import type { BotContext } from "../../core/context.js";
import { paymentStatusInfo } from "../../services/user-history.service.js";
import { escapeHtml } from "../../utils/html.js";
import { safeAnswerCallback, safeEditOrReply } from "../../utils/safe-reply.js";

// =============================================================================
// «لیست پرداخت‌ها 💳» - read-only admin payment browser under مالی 💎 with
// status/provider filters and a per-payment detail page. Shows business
// fields only: NEVER gateway config, api keys, signatures or provider
// authorities - the external tracking line carries the settlement reference
// (externalTransactionId / externalReference).
// =============================================================================

const NOT_FOUND = "مورد یافت نشد.";
const HTML = { parseMode: "HTML" as const };

export const PAYMENTS_LIST_PAGE_SIZE = 10;

export type PaymentListFilter = "all" | "ok" | "pend" | "fail" | "zp" | "np" | "st";

const FILTERS: readonly PaymentListFilter[] = ["all", "ok", "pend", "fail", "zp", "np", "st"];

/** Callback builders - `admin:fin:pay:<filter>:<page>` and `...:d:<sid>`. */
export const plcb = {
  list: (filter: PaymentListFilter, page: number): string => `admin:fin:pay:${filter}:${page}`,
  detail: (sid: string): string => `admin:fin:pay:d:${sid}`,
} as const;

const FILTER_WHERE: Record<PaymentListFilter, Prisma.PaymentWhereInput> = {
  all: {},
  ok: { status: PaymentStatus.APPROVED },
  pend: {
    status: {
      in: [PaymentStatus.PENDING, PaymentStatus.PROCESSING, PaymentStatus.PENDING_REVIEW],
    },
  },
  fail: {
    status: {
      in: [
        PaymentStatus.FAILED,
        PaymentStatus.REJECTED,
        PaymentStatus.EXPIRED,
        PaymentStatus.CANCELLED,
      ],
    },
  },
  zp: { provider: PaymentGatewayType.ZARINPAL },
  np: { provider: PaymentGatewayType.NOWPAYMENTS },
  st: { provider: PaymentGatewayType.TELEGRAM_STARS },
};

const FILTER_TITLE: Record<PaymentListFilter, string> = {
  all: "همه",
  ok: "موفق",
  pend: "در انتظار",
  fail: "ناموفق",
  zp: "زرین‌پال",
  np: "کریپتو",
  st: "Stars",
};

function formatToman(value: number): string {
  return `${value.toLocaleString("en-US")} تومان`;
}

function formatUtc(date: Date): string {
  return `${date.toISOString().replace("T", " ").slice(0, 16)} (UTC)`;
}

/** Persian payment-method label; never renders raw enum values. */
export function providerLabel(
  payment: Pick<Payment, "provider" | "purpose">,
  gatewayType: PaymentGatewayType | null,
): string {
  switch (payment.provider ?? gatewayType) {
    case PaymentGatewayType.ZARINPAL:
      return "زرین‌پال";
    case PaymentGatewayType.NOWPAYMENTS:
      return "کریپتو";
    case PaymentGatewayType.TELEGRAM_STARS:
      return "Stars";
    case PaymentGatewayType.CARD_TO_CARD:
      return "کارت‌به‌کارت";
    default:
      return payment.purpose === "PAY_WITH_WALLET" ? "کیف پول" : "روش";
  }
}

type PaymentWithUserGateway = Payment & { user: User; gateway: PaymentGateway | null };

async function listPayments(
  filter: PaymentListFilter,
  page: number,
): Promise<{ payments: PaymentWithUserGateway[]; page: number; pages: number; total: number }> {
  const where = FILTER_WHERE[filter];
  const total = await prisma.payment.count({ where });
  const pages = Math.max(1, Math.ceil(total / PAYMENTS_LIST_PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), pages);
  const payments = await prisma.payment.findMany({
    where,
    include: { user: true, gateway: true },
    orderBy: { createdAt: "desc" },
    skip: (safePage - 1) * PAYMENTS_LIST_PAGE_SIZE,
    take: PAYMENTS_LIST_PAGE_SIZE,
  });
  return { payments, page: safePage, pages, total };
}

/** Exported for tests: the list keyboard with rows, pagination and filters. */
export function paymentsListKeyboard(
  filter: PaymentListFilter,
  pageData: { payments: PaymentWithUserGateway[]; page: number; pages: number },
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const payment of pageData.payments) {
    const icon = paymentStatusInfo(payment.status).icon;
    kb.text(
      `${icon} ${formatToman(payment.amountToman)} | ${providerLabel(payment, payment.gateway?.type ?? null)} | ${payment.user.telegramId}`,
      plcb.detail(payment.id.slice(0, 8)),
    ).row();
  }
  if (pageData.pages > 1) {
    if (pageData.page > 1) {
      kb.text("« قبلی", plcb.list(filter, pageData.page - 1));
    }
    kb.text(`${pageData.page}/${pageData.pages}`, plcb.list(filter, pageData.page));
    if (pageData.page < pageData.pages) {
      kb.text("بعدی »", plcb.list(filter, pageData.page + 1));
    }
    kb.row();
  }
  kb.text("همه", plcb.list("all", 1))
    .text("موفق", plcb.list("ok", 1))
    .text("در انتظار", plcb.list("pend", 1))
    .text("ناموفق", plcb.list("fail", 1))
    .row();
  kb.text("زرین‌پال", plcb.list("zp", 1))
    .text("کریپتو", plcb.list("np", 1))
    .text("Stars", plcb.list("st", 1))
    .row();
  kb.text("بازگشت به مالی", CB.ADMIN_FINANCE);
  return kb;
}

/** Exported for tests: HTML-escaped detail text - no authorities/secrets. */
export function paymentDetailText(payment: PaymentWithUserGateway): string {
  const user = payment.user;
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ") || "-";
  const externalRef = payment.externalTransactionId ?? payment.externalReference ?? "—";
  const lines = [
    `پرداخت 💳 <code>${escapeHtml(payment.id.slice(0, 8))}</code>`,
    "",
    `سفارش: ${payment.orderId === null ? "—" : `<code>${escapeHtml(payment.orderId.slice(0, 8))}</code>`}`,
    `کاربر: <code>${user.telegramId}</code> | ${escapeHtml(name)}`,
    `درگاه/روش: ${providerLabel(payment, payment.gateway?.type ?? null)}`,
    `مبلغ: <b>${formatToman(payment.amountToman)}</b>`,
    `وضعیت: ${paymentStatusInfo(payment.status).label}`,
    `زمان ثبت: ${formatUtc(payment.createdAt)}`,
    `زمان تایید: ${payment.verifiedAt === null ? "—" : formatUtc(payment.verifiedAt)}`,
    `کد پیگیری خارجی: ${externalRef === "—" ? "—" : `<code>${escapeHtml(externalRef)}</code>`}`,
  ];
  return lines.join("\n");
}

function paymentDetailKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("بازگشت به لیست پرداخت‌ها", plcb.list("all", 1))
    .row()
    .text("بازگشت به مالی", CB.ADMIN_FINANCE);
}

export const paymentsListHandler = new Composer<BotContext>();

paymentsListHandler.callbackQuery(
  /^admin:fin:pay:(all|ok|pend|fail|zp|np|st):(\d+)$/,
  async (ctx) => {
    if (ctx.admin === null) {
      return;
    }
    const filter = ctx.match[1] as PaymentListFilter;
    if (!FILTERS.includes(filter)) {
      await safeAnswerCallback(ctx, NOT_FOUND);
      return;
    }
    const pageData = await listPayments(filter, Number.parseInt(ctx.match[2], 10));
    await safeAnswerCallback(ctx);
    const title =
      pageData.total === 0
        ? `لیست پرداخت‌ها 💳 (${FILTER_TITLE[filter]})\n\nپرداختی یافت نشد.`
        : `لیست پرداخت‌ها 💳 (${FILTER_TITLE[filter]}) — ${pageData.total} مورد`;
    await safeEditOrReply(ctx, title, paymentsListKeyboard(filter, pageData));
  },
);

paymentsListHandler.callbackQuery(/^admin:fin:pay:d:([0-9a-f-]+)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  const shortId = ctx.match[1];
  if (!/^[0-9a-f-]{4,32}$/i.test(shortId)) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  const matches = await prisma.payment.findMany({
    where: { id: { startsWith: shortId } },
    include: { user: true, gateway: true },
    take: 2,
  });
  if (matches.length !== 1) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  await safeAnswerCallback(ctx);
  await safeEditOrReply(ctx, paymentDetailText(matches[0]), paymentDetailKeyboard(), HTML);
});
