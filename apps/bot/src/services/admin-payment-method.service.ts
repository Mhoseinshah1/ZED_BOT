import {
  prisma,
  type CardToCardAccount,
  type PaymentGateway,
} from "@zedbot/database";
import { encryptSecret } from "@zedbot/shared";

import { logger } from "../core/logger.js";
import { normalizeAmountText } from "./wallet-topup.service.js";

// =============================================================================
// Admin card-to-card payment method management (Phase 21): create/toggle the
// CARD_TO_CARD PaymentGateway, edit its amount limits/instruction text and
// manage its CardToCardAccount rows. Configuration only - NEVER creates
// Payment/Order/CheckoutSession rows and never touches receipt review or
// the user payment flow (Phase 7 reads this data as-is). Card numbers are
// stored encrypted (encryptSecret) and NEVER logged or returned raw by this
// module - only masked.
// =============================================================================

export const CARD_GATEWAY_DEFAULT_NAME = "کارت‌به‌کارت";
export const INSTRUCTION_MAX_LENGTH = 1000;
export const OWNER_NAME_MIN = 2;
export const OWNER_NAME_MAX = 100;
export const DISPLAY_ORDER_MAX = 9999;

export const INVALID_CARD_NUMBER_TEXT = "شماره کارت باید دقیقاً ۱۶ رقم باشد.";
export const INVALID_OWNER_NAME_TEXT = `نام صاحب کارت باید بین ${OWNER_NAME_MIN} تا ${OWNER_NAME_MAX} کاراکتر باشد.`;
export const INVALID_DISPLAY_ORDER_TEXT = `ترتیب نمایش باید عددی بین 0 تا ${DISPLAY_ORDER_MAX} باشد.`;
export const INVALID_LIMIT_TEXT = "مبلغ نامعتبر است. یک عدد صحیح وارد کنید (0 = بدون محدودیت).";
export const MIN_ABOVE_MAX_TEXT = "حداقل مبلغ نمی‌تواند از حداکثر مبلغ بیشتر باشد.";
export const INSTRUCTION_TOO_LONG_TEXT = `متن راهنما حداکثر ${INSTRUCTION_MAX_LENGTH} کاراکتر است.`;

export type CardGatewayWithCounts = PaymentGateway & {
  activeCardCount: number;
  totalCardCount: number;
};

async function withCounts(gateway: PaymentGateway): Promise<CardGatewayWithCounts> {
  const [activeCardCount, totalCardCount] = await Promise.all([
    prisma.cardToCardAccount.count({ where: { gatewayId: gateway.id, isActive: true } }),
    prisma.cardToCardAccount.count({ where: { gatewayId: gateway.id } }),
  ]);
  return { ...gateway, activeCardCount, totalCardCount };
}

/** All CARD_TO_CARD gateways with card counts, stable order. */
export async function listCardGateways(): Promise<CardGatewayWithCounts[]> {
  const gateways = await prisma.paymentGateway.findMany({
    where: { type: "CARD_TO_CARD" },
    orderBy: [{ displayOrder: "asc" }, { createdAt: "asc" }],
  });
  return Promise.all(gateways.map(withCounts));
}

/**
 * Creates THE card-to-card gateway when none exists; a concurrent/repeated
 * click returns the existing one instead of a duplicate. No card account is
 * created automatically.
 */
export async function createCardGatewayIfMissing(): Promise<{
  created: boolean;
  gateway: PaymentGateway;
}> {
  const existing = await prisma.paymentGateway.findFirst({
    where: { type: "CARD_TO_CARD" },
    orderBy: { createdAt: "asc" },
  });
  if (existing !== null) {
    return { created: false, gateway: existing };
  }
  const gateway = await prisma.paymentGateway.create({
    data: {
      type: "CARD_TO_CARD",
      name: CARD_GATEWAY_DEFAULT_NAME,
      isEnabled: true,
      isHidden: false,
      minAmountToman: null,
      maxAmountToman: null,
      instructionText: null,
      displayOrder: 1,
    },
  });
  logger.info("card-to-card gateway created", { gatewayId: gateway.id });
  return { created: true, gateway };
}

/** Short-id resolution restricted to CARD_TO_CARD; ambiguous prefixes fail. */
export async function getCardGatewayByShortId(
  shortId: string,
): Promise<CardGatewayWithCounts | null> {
  if (!/^[0-9a-f-]{4,32}$/i.test(shortId)) {
    return null;
  }
  const matches = await prisma.paymentGateway.findMany({
    where: { id: { startsWith: shortId }, type: "CARD_TO_CARD" },
    take: 2,
  });
  return matches.length === 1 ? withCounts(matches[0]) : null;
}

export async function toggleGatewayEnabled(gatewayId: string): Promise<PaymentGateway | null> {
  const gateway = await prisma.paymentGateway.findUnique({ where: { id: gatewayId } });
  if (gateway === null || gateway.type !== "CARD_TO_CARD") {
    return null;
  }
  const updated = await prisma.paymentGateway.update({
    where: { id: gateway.id },
    data: { isEnabled: !gateway.isEnabled },
  });
  logger.info("card-to-card gateway toggled", { gatewayId: gateway.id, isEnabled: updated.isEnabled });
  return updated;
}

/** null clears the limit (= no minimum/maximum). Rejects min > max. */
export async function setGatewayLimit(
  gatewayId: string,
  field: "minAmountToman" | "maxAmountToman",
  value: number | null,
): Promise<{ ok: true; gateway: PaymentGateway } | { ok: false; safeMessage: string }> {
  const gateway = await prisma.paymentGateway.findUnique({ where: { id: gatewayId } });
  if (gateway === null || gateway.type !== "CARD_TO_CARD") {
    return { ok: false, safeMessage: "مورد یافت نشد." };
  }
  const min = field === "minAmountToman" ? value : gateway.minAmountToman;
  const max = field === "maxAmountToman" ? value : gateway.maxAmountToman;
  if (min !== null && max !== null && min > max) {
    return { ok: false, safeMessage: MIN_ABOVE_MAX_TEXT };
  }
  const updated = await prisma.paymentGateway.update({
    where: { id: gateway.id },
    data: { [field]: value },
  });
  return { ok: true, gateway: updated };
}

/** Empty/null clears the instruction text; capped at 1000 chars. */
export async function setGatewayInstruction(
  gatewayId: string,
  text: string | null,
): Promise<{ ok: true; gateway: PaymentGateway } | { ok: false; safeMessage: string }> {
  const value = text?.trim() ?? "";
  if (value.length > INSTRUCTION_MAX_LENGTH) {
    return { ok: false, safeMessage: INSTRUCTION_TOO_LONG_TEXT };
  }
  const gateway = await prisma.paymentGateway.findUnique({ where: { id: gatewayId } });
  if (gateway === null || gateway.type !== "CARD_TO_CARD") {
    return { ok: false, safeMessage: "مورد یافت نشد." };
  }
  const updated = await prisma.paymentGateway.update({
    where: { id: gateway.id },
    data: { instructionText: value === "" ? null : value },
  });
  return { ok: true, gateway: updated };
}

// --- amount-limit input parsing ------------------------------------------------------

/** "0" (or ۰) clears the limit; otherwise a positive integer up to 12 digits. */
export function parseLimitInput(raw: string): { ok: true; value: number | null } | { ok: false } {
  const normalized = normalizeAmountText(raw);
  if (!/^\d{1,12}$/.test(normalized)) {
    return { ok: false };
  }
  const value = Number.parseInt(normalized, 10);
  if (!Number.isSafeInteger(value) || value < 0) {
    return { ok: false };
  }
  return { ok: true, value: value === 0 ? null : value };
}

// --- card accounts -------------------------------------------------------------------

/**
 * Persian/Arabic digits accepted; spaces/dashes stripped; must be exactly
 * 16 digits. No Luhn rejection (deliberate - never reject a valid Iranian
 * card on a checksum guess).
 */
export function normalizeCardNumber(raw: string): string | null {
  const normalized = normalizeAmountText(raw.replace(/[\s-]/g, ""));
  return /^\d{16}$/.test(normalized) ? normalized : null;
}

/** "6037 99** **** 1234" - first 6 + last 4 visible, middle masked. */
export function maskCardNumber(digits: string): string {
  if (!/^\d{16}$/.test(digits)) {
    return "****";
  }
  const masked = `${digits.slice(0, 6)}******${digits.slice(12)}`;
  return masked.replace(/(.{4})(?=.)/g, "$1 ");
}

export function normalizeOwnerName(raw: string): string | null {
  const name = raw.trim();
  return name.length >= OWNER_NAME_MIN && name.length <= OWNER_NAME_MAX ? name : null;
}

export function parseDisplayOrder(raw: string): number | null {
  const normalized = normalizeAmountText(raw.trim() === "" ? "0" : raw);
  if (!/^\d{1,4}$/.test(normalized)) {
    return null;
  }
  const value = Number.parseInt(normalized, 10);
  return value >= 0 && value <= DISPLAY_ORDER_MAX ? value : null;
}

export async function listCardAccounts(gatewayId: string): Promise<CardToCardAccount[]> {
  return prisma.cardToCardAccount.findMany({
    where: { gatewayId },
    orderBy: [{ displayOrder: "asc" }, { createdAt: "asc" }],
  });
}

export async function getCardAccountByShortId(
  shortId: string,
): Promise<(CardToCardAccount & { gateway: PaymentGateway }) | null> {
  if (!/^[0-9a-f-]{4,32}$/i.test(shortId)) {
    return null;
  }
  const matches = await prisma.cardToCardAccount.findMany({
    where: { id: { startsWith: shortId } },
    include: { gateway: true },
    take: 2,
  });
  return matches.length === 1 ? matches[0] : null;
}

export interface CreateCardAccountArgs {
  gatewayId: string;
  /** Already-normalized 16-digit card number (never logged). */
  cardNumber: string;
  ownerName: string;
  displayOrder: number;
}

export type CreateCardAccountOutcome =
  | { ok: true; account: CardToCardAccount }
  | { ok: false; safeMessage: string };

/** Encrypts and stores one card account. The raw number never reaches logs. */
export async function createCardAccount(
  args: CreateCardAccountArgs,
): Promise<CreateCardAccountOutcome> {
  if (normalizeCardNumber(args.cardNumber) === null) {
    return { ok: false, safeMessage: INVALID_CARD_NUMBER_TEXT };
  }
  const ownerName = normalizeOwnerName(args.ownerName);
  if (ownerName === null) {
    return { ok: false, safeMessage: INVALID_OWNER_NAME_TEXT };
  }
  if (args.displayOrder < 0 || args.displayOrder > DISPLAY_ORDER_MAX) {
    return { ok: false, safeMessage: INVALID_DISPLAY_ORDER_TEXT };
  }
  const gateway = await prisma.paymentGateway.findUnique({ where: { id: args.gatewayId } });
  if (gateway === null || gateway.type !== "CARD_TO_CARD") {
    return { ok: false, safeMessage: "مورد یافت نشد." };
  }
  const account = await prisma.cardToCardAccount.create({
    data: {
      gatewayId: gateway.id,
      cardNumberEncrypted: encryptSecret(args.cardNumber),
      ownerName,
      isActive: true,
      displayOrder: args.displayOrder,
    },
  });
  logger.info("card account created", {
    gatewayId: gateway.id,
    accountId: account.id,
    displayOrder: account.displayOrder,
  });
  return { ok: true, account };
}

/** active <-> inactive. Deleting is deliberately NOT implemented (no deletedAt column). */
export async function toggleCardAccount(accountId: string): Promise<CardToCardAccount | null> {
  const account = await prisma.cardToCardAccount.findUnique({ where: { id: accountId } });
  if (account === null) {
    return null;
  }
  const updated = await prisma.cardToCardAccount.update({
    where: { id: account.id },
    data: { isActive: !account.isActive },
  });
  logger.info("card account toggled", { accountId: account.id, isActive: updated.isActive });
  return updated;
}

/** Active cards on the account's gateway (for the last-active-card warning). */
export async function countActiveCards(gatewayId: string): Promise<number> {
  return prisma.cardToCardAccount.count({ where: { gatewayId, isActive: true } });
}
