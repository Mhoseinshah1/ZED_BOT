import { Prisma, prisma, type ForceJoinChannel } from "@zedbot/database";
import { errorMessage } from "@zedbot/shared";

import { logger } from "../../core/logger.js";
import { clearSettingCacheKeys } from "../settings.service.js";

// =============================================================================
// Mandatory channel membership (Force Join): channel configuration SERVICE.
//
// Owns every admin-side mutation of ForceJoinChannel plus the master-switch
// guards. All mutations are transaction-safe (T8): they take `SELECT … FOR
// UPDATE` row locks on the active set (the repo's established concurrency idiom
// — there is no Serializable-isolation precedent here) and lean on the DB
// unique constraints (D5 chatId, D6 partial-unique normalizedLink) as the final
// race guard. `chatId` (BigInt) is NEVER logged or surfaced — only internal DB
// ids and normalized error classes leave this module (§4.11, T6).
// =============================================================================

/** Master enable switch — REUSES the existing Setting (§4.14), never duplicated. */
export const FORCE_JOIN_ENABLED_KEY = "force_join_enabled";

/** Hard cap on ACTIVE channels (§4.4), enforced here in the service layer. */
export const MAX_ACTIVE_FORCE_JOIN_CHANNELS = 10;

/** Deterministic ordering (T7): sortOrder, then createdAt, then id. */
const CHANNEL_ORDER_BY: Prisma.ForceJoinChannelOrderByWithRelationInput[] = [
  { sortOrder: "asc" },
  { createdAt: "asc" },
  { id: "asc" },
];

const TRUTHY = ["true", "1", "yes"];

function isTruthySettingValue(value: string | null | undefined): boolean {
  return value !== null && value !== undefined && TRUTHY.includes(value.toLowerCase());
}

// --- Telegram bot-access validation (D1, T9, §4.3) ---------------------------

/**
 * The narrow Telegram surface the validation needs. The handler injects an
 * adapter over `ctx.api`; tests inject a fake. Keeping it minimal decouples the
 * service from grammY and makes the D1/T9 sequence unit-testable.
 */
export interface ForceJoinBotApi {
  getMe(): Promise<{ id: number }>;
  getChat(
    chatId: number | string,
  ): Promise<{ id: number; type: string; title?: string; username?: string }>;
  getChatMember(
    chatId: number | string,
    userId: number,
  ): Promise<{ status: string; is_member?: boolean }>;
}

/** Public target resolves by @username; private target is already a chatId. */
export type BotAccessTarget =
  | { kind: "PUBLIC"; username: string }
  | { kind: "PRIVATE"; chatId: bigint };

/** Normalized bot-access failure classes (safe to log; no raw payload). */
export type BotAccessErrorCode =
  | "TEMP_FAILURE"
  | "CHANNEL_NOT_FOUND"
  | "NOT_A_CHANNEL"
  | "BOT_NOT_ADMIN";

export type BotAccessResult =
  | {
      ok: true;
      chatId: bigint;
      type: string;
      title: string;
      /** Authoritative public username from getChat (null for private). */
      username: string | null;
    }
  | { ok: false; code: BotAccessErrorCode };

/**
 * Classifies a caught Telegram error into a temporary vs permanent class by
 * duck-typing grammY's `GrammyError` shape (error_code / description) — without
 * importing grammY, and without ever surfacing the raw description. Unknown /
 * network errors fail closed to TEMP (D2: never lie that a channel is invalid
 * when we simply could not reach Telegram).
 */
export function classifyTelegramFailure(err: unknown): "TEMP" | "PERMANENT" {
  const code = (err as { error_code?: unknown } | null)?.error_code;
  const desc = String((err as { description?: unknown } | null)?.description ?? "").toLowerCase();
  if (code === 429) {
    return "TEMP";
  }
  if (typeof code === "number" && code >= 500) {
    return "TEMP";
  }
  const permanentMarkers = [
    "chat not found",
    "user not found",
    "username not found",
    "username_not_occupied",
    "username_invalid",
    "bot is not a member",
    "member list is inaccessible",
    "not enough rights",
    "chat_admin_required",
    "peer_id_invalid",
    "invite hash",
  ];
  if (permanentMarkers.some((m) => desc.includes(m))) {
    return "PERMANENT";
  }
  if (typeof code === "number" && code >= 400 && code < 500) {
    return "PERMANENT";
  }
  return "TEMP";
}

/**
 * The full §4.3 bot-permission validation in T9 order: getMe → getChat →
 * getChatMember(chat, botId), then assert D1 (bot is administrator/creator).
 * Never throws; every Telegram failure is mapped to a normalized code. Returns
 * the authoritative identity (chatId/title/username) from getChat, so a public
 * channel's canonical username — not the admin's typed casing — is persisted
 * (T4: chat_shared / typed values are not authoritative).
 */
export async function validateBotChannelAccess(
  api: ForceJoinBotApi,
  target: BotAccessTarget,
): Promise<BotAccessResult> {
  let botId: number;
  try {
    botId = (await api.getMe()).id;
  } catch (err) {
    logger.warn("force-join: getMe failed during validation", { error: errorMessage(err) });
    return { ok: false, code: "TEMP_FAILURE" };
  }

  const chatRef = target.kind === "PUBLIC" ? `@${target.username}` : Number(target.chatId);
  let chat: { id: number; type: string; title?: string; username?: string };
  try {
    chat = await api.getChat(chatRef);
  } catch (err) {
    const cls = classifyTelegramFailure(err);
    return { ok: false, code: cls === "TEMP" ? "TEMP_FAILURE" : "CHANNEL_NOT_FOUND" };
  }

  if (chat.type !== "channel" && chat.type !== "supergroup") {
    return { ok: false, code: "NOT_A_CHANNEL" };
  }
  // A public target must expose a username; without one it is not a public
  // channel we can render a join link for.
  if (target.kind === "PUBLIC" && !chat.username) {
    return { ok: false, code: "NOT_A_CHANNEL" };
  }

  let member: { status: string; is_member?: boolean };
  try {
    member = await api.getChatMember(Number(chat.id), botId);
  } catch (err) {
    const cls = classifyTelegramFailure(err);
    return { ok: false, code: cls === "TEMP" ? "TEMP_FAILURE" : "BOT_NOT_ADMIN" };
  }

  if (member.status !== "administrator" && member.status !== "creator") {
    return { ok: false, code: "BOT_NOT_ADMIN" };
  }

  return {
    ok: true,
    chatId: BigInt(chat.id),
    type: chat.type,
    title: chat.title ?? "",
    username: chat.username ?? null,
  };
}

// --- reads --------------------------------------------------------------------

/** Every channel (admin list), deterministically ordered (T7). */
export function listAllChannels(): Promise<ForceJoinChannel[]> {
  return prisma.forceJoinChannel.findMany({ orderBy: CHANNEL_ORDER_BY });
}

/**
 * The active channel set, deterministically ordered (T7). This is the SINGLE
 * snapshot a membership check reads once per request (§4.13) — callers must not
 * re-query per channel.
 */
export function listActiveChannels(): Promise<ForceJoinChannel[]> {
  return prisma.forceJoinChannel.findMany({
    where: { isActive: true },
    orderBy: CHANNEL_ORDER_BY,
  });
}

export function countActiveChannels(): Promise<number> {
  return prisma.forceJoinChannel.count({ where: { isActive: true } });
}

export function getChannelById(id: string): Promise<ForceJoinChannel | null> {
  return prisma.forceJoinChannel.findUnique({ where: { id } });
}

/**
 * Resolves a channel from the short id prefix carried in callback data (D7).
 * Returns null when the prefix is ambiguous (matches ≥2 rows) or matches none,
 * so a stale/colliding callback can never mutate the wrong record (§4.13).
 */
export async function resolveChannelByShortId(shortId: string): Promise<ForceJoinChannel | null> {
  if (!/^[0-9a-f-]{4,36}$/i.test(shortId)) {
    return null;
  }
  const matches = await prisma.forceJoinChannel.findMany({
    where: { id: { startsWith: shortId.toLowerCase() } },
    take: 2,
  });
  return matches.length === 1 ? matches[0] : null;
}

// --- create / rebind ----------------------------------------------------------

export interface ChannelUpsertInput {
  chatId: bigint;
  title: string;
  joinUrl: string;
  normalizedLink: string;
  isPrivate: boolean;
  publicUsername: string | null;
  createdByAdminId: string | null;
}

export type UpsertChannelResult =
  | { ok: true; channel: ForceJoinChannel; created: boolean; activated: boolean }
  | { ok: false; code: "LINK_CONFLICT" };

/**
 * Creates a channel, or REBINDS the existing row when a row already holds this
 * `chatId` (D5 — a rebind updates the row, never inserts a duplicate). A brand
 * new channel is created ACTIVE when there is room under the 10-active cap,
 * otherwise created INACTIVE (never silently dropped, never over the cap — §4.4).
 * A duplicate normalized PUBLIC link (D6) surfaces as LINK_CONFLICT.
 */
export async function createOrRebindChannel(
  input: ChannelUpsertInput,
): Promise<UpsertChannelResult> {
  try {
    return await prisma.$transaction(async (tx) => {
      // Serialize against concurrent activations/creations by locking the
      // active set (the cap is read against this locked snapshot).
      await tx.$queryRaw`SELECT id FROM "ForceJoinChannel" WHERE "isActive" = true FOR UPDATE`;

      const existing = await tx.forceJoinChannel.findUnique({ where: { chatId: input.chatId } });
      if (existing) {
        const channel = await tx.forceJoinChannel.update({
          where: { id: existing.id },
          data: {
            title: input.title,
            joinUrl: input.joinUrl,
            normalizedLink: input.normalizedLink,
            isPrivate: input.isPrivate,
            publicUsername: input.publicUsername,
            lastValidatedAt: new Date(),
            lastValidationErrorCode: null,
          },
        });
        return { ok: true as const, channel, created: false, activated: channel.isActive };
      }

      const activeCount = await tx.forceJoinChannel.count({ where: { isActive: true } });
      const activate = activeCount < MAX_ACTIVE_FORCE_JOIN_CHANNELS;
      const maxSort = await tx.forceJoinChannel.aggregate({ _max: { sortOrder: true } });
      const channel = await tx.forceJoinChannel.create({
        data: {
          chatId: input.chatId,
          title: input.title,
          joinUrl: input.joinUrl,
          normalizedLink: input.normalizedLink,
          isPrivate: input.isPrivate,
          publicUsername: input.publicUsername,
          isActive: activate,
          sortOrder: (maxSort._max.sortOrder ?? -1) + 1,
          createdByAdminId: input.createdByAdminId,
          lastValidatedAt: new Date(),
        },
      });
      return { ok: true as const, channel, created: true, activated: activate };
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      // Unique violation: either the public normalizedLink (D6) or the chatId
      // (D5) collided with a concurrently-inserted row. Both mean "this channel
      // / link is already configured" from the admin's point of view.
      return { ok: false, code: "LINK_CONFLICT" };
    }
    throw err;
  }
}

// --- edit link / rebind identity ---------------------------------------------

export type MutateResult =
  | { ok: true; channel: ForceJoinChannel }
  | { ok: false; code: "NOT_FOUND" | "LINK_CONFLICT" | "DUPLICATE_CHANNEL" };

/** Updates only the buyer-facing join URL (and normalized key for public rows). */
export async function updateChannelJoinUrl(
  id: string,
  joinUrl: string,
  normalizedLink: string,
): Promise<MutateResult> {
  try {
    const existing = await prisma.forceJoinChannel.findUnique({ where: { id } });
    if (!existing) {
      return { ok: false, code: "NOT_FOUND" };
    }
    const channel = await prisma.forceJoinChannel.update({
      where: { id },
      data: { joinUrl, normalizedLink },
    });
    return { ok: true, channel };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { ok: false, code: "LINK_CONFLICT" };
    }
    throw err;
  }
}

/**
 * Rebinds a row's Telegram identity to a freshly validated one (انتخاب مجدد
 * کانال). If the new chatId already belongs to a DIFFERENT row the rebind is
 * rejected as DUPLICATE_CHANNEL rather than merging two configs.
 */
export async function rebindChannelIdentity(
  id: string,
  identity: {
    chatId: bigint;
    title: string;
    isPrivate: boolean;
    publicUsername: string | null;
    joinUrl?: string;
    normalizedLink?: string;
  },
): Promise<MutateResult> {
  try {
    return await prisma.$transaction(async (tx) => {
      const existing = await tx.forceJoinChannel.findUnique({ where: { id } });
      if (!existing) {
        return { ok: false as const, code: "NOT_FOUND" as const };
      }
      const other = await tx.forceJoinChannel.findUnique({ where: { chatId: identity.chatId } });
      if (other && other.id !== id) {
        return { ok: false as const, code: "DUPLICATE_CHANNEL" as const };
      }
      const channel = await tx.forceJoinChannel.update({
        where: { id },
        data: {
          chatId: identity.chatId,
          title: identity.title,
          isPrivate: identity.isPrivate,
          publicUsername: identity.publicUsername,
          ...(identity.joinUrl !== undefined ? { joinUrl: identity.joinUrl } : {}),
          ...(identity.normalizedLink !== undefined
            ? { normalizedLink: identity.normalizedLink }
            : {}),
          lastValidatedAt: new Date(),
          lastValidationErrorCode: null,
        },
      });
      return { ok: true as const, channel };
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { ok: false, code: "LINK_CONFLICT" };
    }
    throw err;
  }
}

/** Records a failed validation on a row without changing its identity (§4.11). */
export async function recordValidationError(id: string, code: string): Promise<void> {
  try {
    await prisma.forceJoinChannel.update({
      where: { id },
      data: { lastValidatedAt: new Date(), lastValidationErrorCode: code },
    });
  } catch (err) {
    logger.warn("force-join: failed to record validation error", {
      channelId: id,
      error: errorMessage(err),
    });
  }
}

/**
 * Records a SUCCESSFUL validation on a row (stamps lastValidatedAt and clears any
 * prior lastValidationErrorCode) without changing identity. Used by the «تست
 * دسترسی ربات» action and before an inactive→active transition so a restored
 * channel never keeps showing a stale error class next to a success outcome.
 */
export async function recordValidationSuccess(id: string): Promise<void> {
  try {
    await prisma.forceJoinChannel.update({
      where: { id },
      data: { lastValidatedAt: new Date(), lastValidationErrorCode: null },
    });
  } catch (err) {
    logger.warn("force-join: failed to record validation success", {
      channelId: id,
      error: errorMessage(err),
    });
  }
}

// --- activate / deactivate ----------------------------------------------------

export type SetActiveResult =
  | { ok: true; channel: ForceJoinChannel }
  | { ok: false; code: "NOT_FOUND" | "ACTIVE_LIMIT" | "LAST_ACTIVE_WHILE_ENABLED" };

/**
 * Activates or deactivates a channel with the full guard set, all under a lock
 * on the active set so concurrent toggles/enable cannot race:
 *  - activating is rejected at the 10-active cap (§4.4),
 *  - deactivating the LAST active channel while force join is globally enabled
 *    is rejected (D3) — force join must never brick with zero active channels
 *    while switched on; the caller offers the combined atomic action instead.
 * The `force_join_enabled` flag is read fresh INSIDE the transaction, so an
 * enable committed by a racing admin is observed here.
 */
export async function setChannelActive(id: string, active: boolean): Promise<SetActiveResult> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "ForceJoinChannel" WHERE "isActive" = true FOR UPDATE`;
    const row = await tx.forceJoinChannel.findUnique({ where: { id } });
    if (!row) {
      return { ok: false, code: "NOT_FOUND" };
    }
    if (row.isActive === active) {
      return { ok: true, channel: row };
    }
    if (active) {
      const activeCount = await tx.forceJoinChannel.count({ where: { isActive: true } });
      if (activeCount >= MAX_ACTIVE_FORCE_JOIN_CHANNELS) {
        return { ok: false, code: "ACTIVE_LIMIT" };
      }
    } else {
      const enabled = isTruthySettingValue(
        (await tx.setting.findUnique({ where: { key: FORCE_JOIN_ENABLED_KEY } }))?.value,
      );
      if (enabled) {
        const activeCount = await tx.forceJoinChannel.count({ where: { isActive: true } });
        if (activeCount <= 1) {
          return { ok: false, code: "LAST_ACTIVE_WHILE_ENABLED" };
        }
      }
    }
    const channel = await tx.forceJoinChannel.update({ where: { id }, data: { isActive: active } });
    return { ok: true, channel };
  });
}

// --- reorder (T7) -------------------------------------------------------------

export type ReorderResult =
  | { ok: true }
  | { ok: false; code: "NOT_FOUND" | "NO_MOVE" };

/**
 * Moves a channel up/down in the admin list. Under a full-table lock it loads
 * the deterministic order, swaps the target with its neighbour, and renumbers
 * sortOrder to contiguous 0..n-1 — so positions are always distinct after a
 * move and there is never a fragile UNIQUE(sortOrder) to fight (T7).
 */
export async function reorderChannel(id: string, direction: "up" | "down"): Promise<ReorderResult> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "ForceJoinChannel" FOR UPDATE`;
    const ordered = await tx.forceJoinChannel.findMany({ orderBy: CHANNEL_ORDER_BY });
    const idx = ordered.findIndex((r) => r.id === id);
    if (idx === -1) {
      return { ok: false, code: "NOT_FOUND" };
    }
    const swapWith = direction === "up" ? idx - 1 : idx + 1;
    if (swapWith < 0 || swapWith >= ordered.length) {
      return { ok: false, code: "NO_MOVE" };
    }
    const reordered = [...ordered];
    [reordered[idx], reordered[swapWith]] = [reordered[swapWith], reordered[idx]];
    for (let i = 0; i < reordered.length; i += 1) {
      if (reordered[i].sortOrder !== i) {
        await tx.forceJoinChannel.update({ where: { id: reordered[i].id }, data: { sortOrder: i } });
      }
    }
    return { ok: true };
  });
}

// --- delete -------------------------------------------------------------------

export type DeleteResult =
  | { ok: true }
  | { ok: false; code: "NOT_FOUND" | "LAST_ACTIVE_WHILE_ENABLED" };

/**
 * Deletes a channel. Deleting the LAST active channel while force join is
 * globally enabled is rejected (D3) — same fail-safe as deactivation. The
 * `force_join_enabled` flag is read fresh inside the transaction.
 */
export async function deleteChannel(id: string): Promise<DeleteResult> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "ForceJoinChannel" WHERE "isActive" = true FOR UPDATE`;
    const row = await tx.forceJoinChannel.findUnique({ where: { id } });
    if (!row) {
      return { ok: false, code: "NOT_FOUND" };
    }
    if (row.isActive) {
      const enabled = isTruthySettingValue(
        (await tx.setting.findUnique({ where: { key: FORCE_JOIN_ENABLED_KEY } }))?.value,
      );
      if (enabled) {
        const activeCount = await tx.forceJoinChannel.count({ where: { isActive: true } });
        if (activeCount <= 1) {
          return { ok: false, code: "LAST_ACTIVE_WHILE_ENABLED" };
        }
      }
    }
    await tx.forceJoinChannel.delete({ where: { id } });
    return { ok: true };
  });
}

// --- master switch (§4.10, D3, D4) -------------------------------------------

export type EnableResult = { ok: true } | { ok: false; code: "NO_ACTIVE" };

/**
 * Enables force join globally, but ONLY when at least one active channel exists
 * (§4.10) — enabling with zero active channels is rejected so the bot can never
 * be switched into a state that blocks everyone with nothing to join. The active
 * set is locked so this cannot race with a deactivation/deletion of the last
 * active channel (§4.13).
 */
export async function enableForceJoin(): Promise<EnableResult> {
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "ForceJoinChannel" WHERE "isActive" = true FOR UPDATE`;
    const activeCount = await tx.forceJoinChannel.count({ where: { isActive: true } });
    if (activeCount === 0) {
      return { ok: false as const, code: "NO_ACTIVE" as const };
    }
    await tx.setting.upsert({
      where: { key: FORCE_JOIN_ENABLED_KEY },
      update: { value: "true", type: "BOOLEAN" },
      create: { key: FORCE_JOIN_ENABLED_KEY, value: "true", type: "BOOLEAN" },
    });
    return { ok: true as const };
  });
  if (result.ok) {
    clearSettingCacheKeys([FORCE_JOIN_ENABLED_KEY]);
  }
  return result;
}

/** Disables force join globally. Always allowed (never bricks anything). */
export async function disableForceJoin(): Promise<void> {
  await prisma.setting.upsert({
    where: { key: FORCE_JOIN_ENABLED_KEY },
    update: { value: "false", type: "BOOLEAN" },
    create: { key: FORCE_JOIN_ENABLED_KEY, value: "false", type: "BOOLEAN" },
  });
  clearSettingCacheKeys([FORCE_JOIN_ENABLED_KEY]);
}

/**
 * D3 combined atomic action: disable force join AND deactivate the given
 * channel in one transaction, so an admin can retire the last active channel
 * without a transient window where the switch is on with zero active channels.
 */
export async function disableForceJoinAndDeactivate(id: string): Promise<DeleteResult> {
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "ForceJoinChannel" WHERE "isActive" = true FOR UPDATE`;
    const row = await tx.forceJoinChannel.findUnique({ where: { id } });
    if (!row) {
      return { ok: false as const, code: "NOT_FOUND" as const };
    }
    await tx.setting.upsert({
      where: { key: FORCE_JOIN_ENABLED_KEY },
      update: { value: "false", type: "BOOLEAN" },
      create: { key: FORCE_JOIN_ENABLED_KEY, value: "false", type: "BOOLEAN" },
    });
    await tx.forceJoinChannel.update({ where: { id }, data: { isActive: false } });
    return { ok: true as const };
  });
  clearSettingCacheKeys([FORCE_JOIN_ENABLED_KEY]);
  return result;
}

/** D3 combined atomic action: disable force join AND delete the given channel. */
export async function disableForceJoinAndDelete(id: string): Promise<DeleteResult> {
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "ForceJoinChannel" WHERE "isActive" = true FOR UPDATE`;
    const row = await tx.forceJoinChannel.findUnique({ where: { id } });
    if (!row) {
      return { ok: false as const, code: "NOT_FOUND" as const };
    }
    await tx.setting.upsert({
      where: { key: FORCE_JOIN_ENABLED_KEY },
      update: { value: "false", type: "BOOLEAN" },
      create: { key: FORCE_JOIN_ENABLED_KEY, value: "false", type: "BOOLEAN" },
    });
    await tx.forceJoinChannel.delete({ where: { id } });
    return { ok: true as const };
  });
  clearSettingCacheKeys([FORCE_JOIN_ENABLED_KEY]);
  return result;
}
