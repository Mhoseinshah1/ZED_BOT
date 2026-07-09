import {
  CheckoutStatus,
  prisma,
  type CheckoutSession,
  type User,
} from "@zedbot/database";

import { checkoutExpiryMinutes } from "./checkout.service.js";
import { getSetting } from "./settings.service.js";

// =============================================================================
// Wallet top-up (Phase 14). The browse flow is write-free; the ONLY write is
// a CheckoutSession with purpose WALLET_CHARGE (the schema's wallet top-up
// purpose - no enum change needed) created after the user confirms the
// pre-invoice. No Order/orderType/product/service is ever attached; the
// wallet balance moves exclusively when an admin approves the receipt.
// =============================================================================

export const WALLET_TOPUP_REASON = "WALLET_TOPUP_CARD_TO_CARD";

const DEFAULT_MIN_TOPUP_TOMAN = 10_000;
const DEFAULT_MAX_TOPUP_TOMAN = 50_000_000;

export interface WalletTopupLimits {
  minToman: number;
  maxToman: number;
}

/** Operator-configurable limits with safe defaults. */
export async function walletTopupLimits(): Promise<WalletTopupLimits> {
  const rawMin = Number.parseInt(await getSetting("wallet_topup_min_toman", ""), 10);
  const rawMax = Number.parseInt(await getSetting("wallet_topup_max_toman", ""), 10);
  const minToman = Number.isInteger(rawMin) && rawMin > 0 ? rawMin : DEFAULT_MIN_TOPUP_TOMAN;
  const maxToman = Number.isInteger(rawMax) && rawMax >= minToman ? rawMax : DEFAULT_MAX_TOPUP_TOMAN;
  return { minToman, maxToman };
}

const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";

/** Persian/Arabic digits -> ASCII; separators (commas/spaces/٬) stripped. */
export function normalizeAmountText(raw: string): string {
  let out = "";
  for (const ch of raw.trim()) {
    const persian = PERSIAN_DIGITS.indexOf(ch);
    const arabic = ARABIC_DIGITS.indexOf(ch);
    if (persian >= 0) {
      out += String(persian);
    } else if (arabic >= 0) {
      out += String(arabic);
    } else if (ch === "," || ch === "٬" || ch === "،" || ch === " ") {
      continue;
    } else {
      out += ch;
    }
  }
  return out;
}

/** Positive integer Toman amount, or null when the text is not a plain number. */
export function parseTopupAmount(raw: string): number | null {
  const normalized = normalizeAmountText(raw);
  if (!/^\d{1,12}$/.test(normalized)) {
    return null;
  }
  const value = Number.parseInt(normalized, 10);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * The ONLY write of the top-up browse flow: a PENDING WALLET_CHARGE
 * CheckoutSession. Older PENDING top-up sessions of the same user are
 * cancelled first so repeated confirms never pile up.
 */
export async function createWalletTopupCheckout(
  user: User,
  amountToman: number,
): Promise<CheckoutSession> {
  const minutes = await checkoutExpiryMinutes();

  await prisma.checkoutSession.updateMany({
    where: { userId: user.id, purpose: "WALLET_CHARGE", status: CheckoutStatus.PENDING },
    data: { status: CheckoutStatus.CANCELLED },
  });

  return prisma.checkoutSession.create({
    data: {
      userId: user.id,
      purpose: "WALLET_CHARGE",
      // No product/service/orderType - a top-up is not an order.
      productSnapshot: {
        flowType: "WALLET_TOPUP",
        walletTopupAmountToman: amountToman,
        title: "شارژ کیف پول",
      },
      originalPriceToman: amountToman,
      discountAmountToman: 0,
      finalPriceToman: amountToman,
      status: CheckoutStatus.PENDING,
      expiresAt: new Date(Date.now() + minutes * 60_000),
    },
  });
}
