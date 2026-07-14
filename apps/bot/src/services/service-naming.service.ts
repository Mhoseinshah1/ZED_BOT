import { randomBytes } from "node:crypto";

import {
  prisma,
  Prisma,
  UsernamePatternType,
  type Order,
  type Panel,
  type User,
} from "@zedbot/database";

import { logger } from "../core/logger.js";

// =============================================================================
// Central service naming (naming phase): the ONE place VPN remote identities
// are resolved. The admin-selected Panel.usernamePatternType (8 strategies,
// previously write-only dead config) becomes authoritative:
//
//   admin selects strategy -> checkout captures strategy+config ->
//   ensureOrderNamingSnapshot persists the IMMUTABLE resolution exactly once
//   BEFORE the first remote mutation -> provisioning/adapters/retries/
//   reconciliation reuse the stored identity verbatim.
//
// Determinism: sequences and random parts are consumed ONCE at resolution and
// live in the snapshot forever - a retry can never mint a second identity,
// and mutable data (Telegram username, product/panel renames, admin strategy
// changes) can never rename a paid order. Secrets never enter names: the
// sources are limited to Telegram id/username, admin-set texts, counters,
// random bytes and the order short id.
// =============================================================================

export const NAMING_STRATEGY_VERSION = 1;

// Persian admin texts (single render site - view constants, like the other
// panel-wizard strings).
export const NAMING_SAVED_TEXT = "روش نام‌گذاری با موفقیت ذخیره شد ✅";
export const NAMING_INCOMPLETE_TEXT = "اطلاعات لازم برای این روش نام‌گذاری کامل نیست.";
export const NAMING_INVALID_FOR_PANEL_TEXT = "این روش برای پنل انتخاب‌شده معتبر نیست.";
export const NAMING_FAILED_USER_TEXT =
  "ساخت نام سرویس ناموفق بود. لطفاً تنظیمات نام‌گذاری را بررسی کنید.";
export const NAMING_PANEL_LIMIT_TEXT = "نام انتخاب‌شده با محدودیت‌های پنل سازگار نیست.";

/**
 * Provider profile shared by MARZBAN_USERNAME and XUI_GLOBAL_CLIENT_EMAIL:
 * both accept lowercase [a-z0-9_] and the repo's established 32-char cap
 * (audited separately: Marzban rejects >32; the pinned 3X-UI global-client
 * email is a free string where 32 keeps subscription/label handling safe).
 */
const MAX_REMOTE_USERNAME_LENGTH = 32;
const MIN_REMOTE_USERNAME_LENGTH = 3;

/** Strategy metadata: Persian label + semantics for admin UX and docs. */
export interface UsernameStrategyInfo {
  fa: string;
  /** Persian one-line description rendered on the settings page. */
  descriptionFa: string;
  /** Persian labels of panel fields this strategy requires. */
  requiresFa: string[];
  usesSequence: boolean;
  usesRandom: boolean;
  usesRepresentative: boolean;
  usesCustomText: boolean;
}

export const USERNAME_STRATEGY_INFO: Record<UsernamePatternType, UsernameStrategyInfo> = {
  TELEGRAM_USERNAME_SEQUENCE: {
    fa: "نام کاربری تلگرام + شماره ترتیبی",
    descriptionFa:
      "نام کاربری تلگرام خریدار به‌همراه شماره ترتیبی پنل. بدون نام کاربری، از u + آیدی عددی استفاده می‌شود.",
    requiresFa: [],
    usesSequence: true,
    usesRandom: false,
    usesRepresentative: false,
    usesCustomText: false,
  },
  TELEGRAM_ID_RANDOM: {
    fa: "آیدی عددی تلگرام + بخش تصادفی",
    descriptionFa: "آیدی عددی تلگرام خریدار به‌همراه بخش تصادفی (طول قابل تنظیم).",
    requiresFa: [],
    usesSequence: false,
    usesRandom: true,
    usesRepresentative: false,
    usesCustomText: false,
  },
  CUSTOM: {
    fa: "متن دلخواه + شناسه سفارش",
    descriptionFa: "متن دلخواه پنل به‌همراه شناسه کوتاه سفارش (کاملاً قطعی، بدون بخش تصادفی).",
    requiresFa: ["متن دلخواه username"],
    usesSequence: false,
    usesRandom: false,
    usesRepresentative: false,
    usesCustomText: true,
  },
  CUSTOM_RANDOM: {
    fa: "تصادفی کامل",
    descriptionFa: "شناسه کاملاً تصادفی (طول قابل تنظیم، حداقل ۸).",
    requiresFa: [],
    usesSequence: false,
    usesRandom: true,
    usesRepresentative: false,
    usesCustomText: false,
  },
  CUSTOM_TEXT_RANDOM: {
    fa: "متن دلخواه + بخش تصادفی",
    descriptionFa: "متن دلخواه پنل به‌همراه بخش تصادفی (طول قابل تنظیم).",
    requiresFa: ["متن دلخواه username"],
    usesSequence: false,
    usesRandom: true,
    usesRepresentative: false,
    usesCustomText: true,
  },
  CUSTOM_TEXT_SEQUENCE: {
    fa: "متن دلخواه + شماره ترتیبی",
    descriptionFa: "متن دلخواه پنل به‌همراه شماره ترتیبی پنل.",
    requiresFa: ["متن دلخواه username"],
    usesSequence: true,
    usesRandom: false,
    usesRepresentative: false,
    usesCustomText: true,
  },
  TELEGRAM_ID_SEQUENCE: {
    fa: "آیدی عددی تلگرام + شماره ترتیبی",
    descriptionFa: "آیدی عددی تلگرام خریدار به‌همراه شماره ترتیبی پنل.",
    requiresFa: [],
    usesSequence: true,
    usesRandom: false,
    usesRepresentative: false,
    usesCustomText: false,
  },
  REPRESENTATIVE_TEXT_SEQUENCE: {
    fa: "پیشوند نماینده + شماره ترتیبی",
    descriptionFa: "پیشوند username نماینده به‌همراه شماره ترتیبی جداگانه نماینده.",
    requiresFa: ["پیشوند username نماینده"],
    usesSequence: true,
    usesRandom: false,
    usesRepresentative: true,
    usesCustomText: false,
  },
};

/** Config subset a strategy resolves from (captured at checkout). */
export interface NamingConfigSnapshot {
  strategy: UsernamePatternType;
  customText: string | null;
  randomLength: number | null;
  representativePrefix: string | null;
}

export function namingConfigFromPanel(
  panel: Pick<
    Panel,
    | "usernamePatternType"
    | "usernameCustomText"
    | "usernameRandomLength"
    | "representativeUsernamePrefix"
  >,
): NamingConfigSnapshot {
  return {
    strategy: panel.usernamePatternType,
    customText: panel.usernameCustomText,
    randomLength: panel.usernameRandomLength,
    representativePrefix: panel.representativeUsernamePrefix,
  };
}

/** Missing-config check (Persian field labels for the admin/checkout gate). */
export function validateNamingConfig(config: NamingConfigSnapshot): {
  ok: boolean;
  missingFa: string[];
} {
  const info = USERNAME_STRATEGY_INFO[config.strategy];
  const missingFa: string[] = [];
  if (info.usesCustomText && (config.customText === null || config.customText.trim() === "")) {
    missingFa.push("متن دلخواه username");
  }
  if (
    info.usesRepresentative &&
    (config.representativePrefix === null || config.representativePrefix.trim() === "")
  ) {
    missingFa.push("پیشوند username نماینده");
  }
  return { ok: missingFa.length === 0, missingFa };
}

// --- normalization (provider profiles) ---------------------------------------------------

/**
 * Provider-safe normalization shared by the Marzban username and the XUI
 * global-client email profiles: lowercase, [a-z0-9_], collapsed separators,
 * no leading/trailing separator, 32-char cap. Truncation keeps uniqueness by
 * reserving the tail for the deterministic order-derived suffix. Never
 * returns an empty result - the caller provides a non-empty fallback core.
 */
export function normalizeRemoteUsername(raw: string, orderShort: string): string {
  let normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (normalized === "") {
    normalized = `o_${orderShort}`;
  }
  if (normalized.length > MAX_REMOTE_USERNAME_LENGTH) {
    // Keep a deterministic order-derived tail so two truncated names from
    // different orders can never collapse into the same value.
    const keep = MAX_REMOTE_USERNAME_LENGTH - orderShort.length - 1;
    normalized = `${normalized.slice(0, keep).replace(/_+$/g, "")}_${orderShort}`;
  }
  if (normalized.length < MIN_REMOTE_USERNAME_LENGTH) {
    normalized = `${normalized}_${orderShort}`.slice(0, MAX_REMOTE_USERNAME_LENGTH);
  }
  return normalized;
}

/** Lowercase alphanumeric random part - consumed ONCE per order. */
function randomToken(length: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

/** Deterministic fallback for users without a Telegram username. */
function telegramUsernameOrFallback(user: Pick<User, "telegramId" | "username">): string {
  const username = (user.username ?? "").trim();
  return username !== "" ? username : `u${user.telegramId.toString()}`;
}

function orderShortId(orderId: string): string {
  return orderId.replace(/-/g, "").slice(0, 8).toLowerCase();
}

// --- resolution ---------------------------------------------------------------------------

/** The immutable identity resolution persisted on Order.namingSnapshot. */
export interface ResolvedVpnIdentity {
  strategy: UsernamePatternType;
  version: number;
  resolvedRemoteUsername: string;
  resolvedDisplayName: string;
  sources: {
    telegramId: string;
    telegramUsername: string | null;
    orderShort: string;
    customText?: string;
    representativePrefix?: string;
    sequence?: number;
    random?: string;
  };
}

export type ResolveIdentityResult =
  | { ok: true; identity: ResolvedVpnIdentity }
  | { ok: false; error: string; safeUserMessage: string };

/** Atomically reserves the next panel sequence number for a strategy. */
async function reserveSequence(panelId: string, representative: boolean): Promise<number> {
  if (representative) {
    const updated = await prisma.panel.update({
      where: { id: panelId },
      data: { representativeSequenceLastNumber: { increment: 1 } },
      select: { representativeSequenceLastNumber: true },
    });
    return updated.representativeSequenceLastNumber;
  }
  const updated = await prisma.panel.update({
    where: { id: panelId },
    data: { usernameSequenceLastNumber: { increment: 1 } },
    select: { usernameSequenceLastNumber: true },
  });
  return updated.usernameSequenceLastNumber;
}

/** Raw (pre-normalization) name for a strategy from already-fixed parts. */
function buildRawName(
  config: NamingConfigSnapshot,
  parts: {
    telegramId: string;
    telegramUsernameOrFallback: string;
    orderShort: string;
    sequence?: number;
    random?: string;
  },
): string {
  switch (config.strategy) {
    case UsernamePatternType.TELEGRAM_USERNAME_SEQUENCE:
      return `${parts.telegramUsernameOrFallback}_${parts.sequence}`;
    case UsernamePatternType.TELEGRAM_ID_RANDOM:
      return `${parts.telegramId}_${parts.random}`;
    case UsernamePatternType.CUSTOM:
      return `${config.customText ?? ""}_${parts.orderShort}`;
    case UsernamePatternType.CUSTOM_RANDOM:
      return parts.random ?? "";
    case UsernamePatternType.CUSTOM_TEXT_RANDOM:
      return `${config.customText ?? ""}_${parts.random}`;
    case UsernamePatternType.CUSTOM_TEXT_SEQUENCE:
      return `${config.customText ?? ""}_${parts.sequence}`;
    case UsernamePatternType.TELEGRAM_ID_SEQUENCE:
      return `${parts.telegramId}_${parts.sequence}`;
    case UsernamePatternType.REPRESENTATIVE_TEXT_SEQUENCE:
      return `${config.representativePrefix ?? ""}_${parts.sequence}`;
  }
}

function randomLengthFor(config: NamingConfigSnapshot): number {
  const info = USERNAME_STRATEGY_INFO[config.strategy];
  if (!info.usesRandom) {
    return 0;
  }
  const requested = config.randomLength ?? (config.strategy === "CUSTOM_RANDOM" ? 8 : 4);
  // Full-random names need enough entropy to avoid casual collisions.
  const min = config.strategy === "CUSTOM_RANDOM" ? 8 : 3;
  return Math.min(16, Math.max(min, requested));
}

/**
 * Resolves one order's remote identity, consuming its sequence/random parts.
 * Called ONLY by ensureOrderNamingSnapshot (exactly-once persistence) and
 * never on retries. Local collision policy is bounded and deterministic:
 * base name -> base + order-derived suffix -> safe failure. Never adopts a
 * colliding name (remote ownership is verified by the provisioning recovery
 * ladder via the order note marker, not by name equality).
 */
export async function resolveVpnRemoteIdentity(
  order: Pick<Order, "id">,
  user: Pick<User, "telegramId" | "username">,
  panelId: string,
  config: NamingConfigSnapshot,
): Promise<ResolveIdentityResult> {
  const validation = validateNamingConfig(config);
  if (!validation.ok) {
    return {
      ok: false,
      error: `naming config incomplete: ${config.strategy} missing ${validation.missingFa.length} field(s)`,
      safeUserMessage: NAMING_FAILED_USER_TEXT,
    };
  }
  const info = USERNAME_STRATEGY_INFO[config.strategy];
  const orderShort = orderShortId(order.id);
  const sequence = info.usesSequence
    ? await reserveSequence(panelId, info.usesRepresentative)
    : undefined;
  const random = info.usesRandom ? randomToken(randomLengthFor(config)) : undefined;

  const parts = {
    telegramId: user.telegramId.toString(),
    telegramUsernameOrFallback: telegramUsernameOrFallback(user),
    orderShort,
    ...(sequence !== undefined ? { sequence } : {}),
    ...(random !== undefined ? { random } : {}),
  };
  const raw = buildRawName(config, parts);
  let normalized = normalizeRemoteUsername(raw, orderShort);

  // Bounded collision policy: a same-name Service from ANOTHER order gets a
  // deterministic order-derived suffix; a second collision is a safe error.
  const existing = await prisma.service.findUnique({ where: { username: normalized } });
  if (existing !== null && existing.orderId !== order.id) {
    normalized = normalizeRemoteUsername(`${raw}_${orderShort}`, orderShort);
    const stillTaken = await prisma.service.findUnique({ where: { username: normalized } });
    if (stillTaken !== null && stillTaken.orderId !== order.id) {
      return {
        ok: false,
        error: `naming collision for strategy ${config.strategy}`,
        safeUserMessage: NAMING_FAILED_USER_TEXT,
      };
    }
  }

  return {
    ok: true,
    identity: {
      strategy: config.strategy,
      version: NAMING_STRATEGY_VERSION,
      resolvedRemoteUsername: normalized,
      resolvedDisplayName: raw,
      sources: {
        telegramId: parts.telegramId,
        telegramUsername: user.username ?? null,
        orderShort,
        ...(info.usesCustomText && config.customText !== null
          ? { customText: config.customText }
          : {}),
        ...(info.usesRepresentative && config.representativePrefix !== null
          ? { representativePrefix: config.representativePrefix }
          : {}),
        ...(sequence !== undefined ? { sequence } : {}),
        ...(random !== undefined ? { random } : {}),
      },
    },
  };
}

/** Parses a stored Order.namingSnapshot back into a typed identity. */
export function parseNamingSnapshot(value: Prisma.JsonValue | null): ResolvedVpnIdentity | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.resolvedRemoteUsername !== "string" ||
    record.resolvedRemoteUsername === "" ||
    typeof record.strategy !== "string"
  ) {
    return null;
  }
  return record as unknown as ResolvedVpnIdentity;
}

export type EnsureSnapshotResult =
  | { ok: true; identity: ResolvedVpnIdentity }
  | { ok: false; error: string; safeUserMessage: string };

/**
 * The exactly-once naming snapshot gate: returns the order's stored identity
 * or resolves+persists it atomically (updateMany CAS on namingSnapshot IS
 * NULL - a concurrent first-provision race consumes at most one extra
 * counter value but only ONE snapshot ever wins, and the loser re-reads it).
 * Strategy/config come from the CHECKOUT capture when present, else from the
 * panel's current config (legacy checkouts) - after this call, admin config
 * changes can never affect this order again.
 */
export async function ensureOrderNamingSnapshot(
  order: Pick<Order, "id" | "namingSnapshot"> & {
    user: Pick<User, "telegramId" | "username">;
  },
  panel: Panel,
  checkoutCapturedConfig: NamingConfigSnapshot | null,
): Promise<EnsureSnapshotResult> {
  const stored = parseNamingSnapshot(order.namingSnapshot);
  if (stored !== null) {
    return { ok: true, identity: stored };
  }
  const config = checkoutCapturedConfig ?? namingConfigFromPanel(panel);
  const resolved = await resolveVpnRemoteIdentity(order, order.user, panel.id, config);
  if (!resolved.ok) {
    return resolved;
  }
  const written = await prisma.order.updateMany({
    where: { id: order.id, namingSnapshot: { equals: Prisma.DbNull } },
    data: { namingSnapshot: resolved.identity as unknown as Prisma.InputJsonObject },
  });
  if (written.count === 1) {
    logger.info("order naming snapshot created", {
      orderId: order.id,
      strategy: resolved.identity.strategy,
      version: resolved.identity.version,
    });
    return { ok: true, identity: resolved.identity };
  }
  // Lost the race - the concurrent resolver's snapshot is authoritative.
  const fresh = await prisma.order.findUnique({
    where: { id: order.id },
    select: { namingSnapshot: true },
  });
  const winner = parseNamingSnapshot(fresh?.namingSnapshot ?? null);
  if (winner !== null) {
    return { ok: true, identity: winner };
  }
  return {
    ok: false,
    error: "naming snapshot race produced no snapshot",
    safeUserMessage: NAMING_FAILED_USER_TEXT,
  };
}

// --- admin preview ------------------------------------------------------------------------

/** Safe sample context - previews never consume counters or touch remotes. */
const PREVIEW_SAMPLE = {
  telegramId: "123456789",
  telegramUsername: "sample_user",
  orderShort: "a1b2c3d4",
};

/**
 * Builds the «نمونه نام ساخته‌شده» preview for the admin page: uses the
 * NEXT sequence value WITHOUT reserving it and a throwaway random sample.
 * Creates no order, no snapshot and no remote client.
 */
export function previewNamingStrategy(
  panel: Pick<
    Panel,
    | "usernameCustomText"
    | "usernameRandomLength"
    | "representativeUsernamePrefix"
    | "usernameSequenceLastNumber"
    | "representativeSequenceLastNumber"
  >,
  strategy: UsernamePatternType,
): { ok: boolean; preview: string } {
  const config: NamingConfigSnapshot = {
    strategy,
    customText: panel.usernameCustomText,
    randomLength: panel.usernameRandomLength,
    representativePrefix: panel.representativeUsernamePrefix,
  };
  if (!validateNamingConfig(config).ok) {
    return { ok: false, preview: NAMING_INCOMPLETE_TEXT };
  }
  const info = USERNAME_STRATEGY_INFO[strategy];
  const sequence = info.usesSequence
    ? (info.usesRepresentative
        ? panel.representativeSequenceLastNumber
        : panel.usernameSequenceLastNumber) + 1
    : undefined;
  const random = info.usesRandom ? randomToken(randomLengthFor(config)) : undefined;
  const raw = buildRawName(config, {
    telegramId: PREVIEW_SAMPLE.telegramId,
    telegramUsernameOrFallback: PREVIEW_SAMPLE.telegramUsername,
    orderShort: PREVIEW_SAMPLE.orderShort,
    ...(sequence !== undefined ? { sequence } : {}),
    ...(random !== undefined ? { random } : {}),
  });
  return { ok: true, preview: normalizeRemoteUsername(raw, PREVIEW_SAMPLE.orderShort) };
}
