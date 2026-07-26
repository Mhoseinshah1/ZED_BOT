import { Prisma, prisma, type ForceJoinChannel } from "@zedbot/database";
import { createLogger, errorMessage } from "@zedbot/shared";

// =============================================================================
// Force Join: the channel-configuration primitives a MEMBERSHIP CHECK needs.
//
// These moved out of `apps/bot` so the API can enforce the same gate. They are
// exactly the transport-independent parts: reading the active channel set, and
// the bounded unhealthy-channel lifecycle a check advances as a side effect.
// Everything that renders a Telegram message, or that only an admin screen
// calls, stayed in the bot — this package must never pull in grammY.
//
// `apps/bot/src/services/force-join/force-join-channel.service.ts` re-exports
// each of these, so every existing bot caller and test is unaffected.
// =============================================================================

const logger = createLogger("force-join");

/** Master enable switch — REUSES the existing Setting (§4.14), never duplicated. */
export const FORCE_JOIN_ENABLED_KEY = "force_join_enabled";

/**
 * Invalidator for a process-local Setting cache.
 *
 * The bot memoizes Setting reads, so retiring a channel (which may flip
 * `force_join_enabled`) has to drop that entry or the bot would keep gating on
 * a stale `true`. The API reads settings straight from the row and has no cache
 * to invalidate, so the default is a no-op — the invariant lives with whoever
 * owns the cache, not here.
 */
let settingCacheInvalidator: (keys: string[]) => void = () => {};

export function setForceJoinSettingCacheInvalidator(fn: (keys: string[]) => void): void {
  settingCacheInvalidator = fn;
}

// --- configuration serialization ---------------------------------------------

/**
 * ONE dedicated advisory-lock namespace serializing EVERY force-join
 * configuration mutation. A row lock on the active set (`… WHERE "isActive" =
 * true FOR UPDATE`) locks nothing at all when the active set is empty, so two
 * concurrent "create the first channel" / "activate" / "enable" transactions
 * could both observe `activeCount = 0` and both commit. A transaction-level
 * advisory lock has no such hole: it exists independently of any row, and it is
 * released automatically when the transaction commits or rolls back.
 */
export const FORCE_JOIN_CONFIG_LOCK = "zedbot-force-join-config";

export async function lockForceJoinConfig(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${FORCE_JOIN_CONFIG_LOCK}))`;
}

// --- bounded channel-health policy (§4.11) -----------------------------------

/** Consecutive PERMANENT unverifiable results before a channel is retired. */
export const FORCE_JOIN_HEALTH_FAILURE_THRESHOLD = 5;
/**
 * The failures must also have persisted for at least this long. Threshold alone
 * would retire a channel within seconds on a busy bot; requiring a sustained
 * window means a brief anomaly that merely *looks* permanent cannot rewrite the
 * operator's configuration.
 */
export const FORCE_JOIN_HEALTH_MIN_WINDOW_MS = 10 * 60_000;
/** A failure this long after the previous one starts a fresh window. */
export const FORCE_JOIN_HEALTH_RESET_MS = 60 * 60_000;
/**
 * Write-debounce: at most one failure increment per channel per this interval,
 * so a broken channel costs O(1) writes per interval instead of one write per
 * gated user request. It only slows counting, never the decision.
 */
export const FORCE_JOIN_HEALTH_COUNT_DEBOUNCE_MS = 5_000;

/** Deterministic ordering (T7): sortOrder, then createdAt, then id. */
export const CHANNEL_ORDER_BY: Prisma.ForceJoinChannelOrderByWithRelationInput[] = [
  { sortOrder: "asc" },
  { createdAt: "asc" },
  { id: "asc" },
];

const TRUTHY = ["true", "1", "yes"];

export function isTruthySettingValue(value: string | null | undefined): boolean {
  return value !== null && value !== undefined && TRUTHY.includes(value.toLowerCase());
}

// --- reads --------------------------------------------------------------------

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

// --- health bookkeeping -------------------------------------------------------

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

export type HealthFailureOutcome =
  /** Counted (or debounced); the channel remains configured as-is. */
  | { action: "COUNTED"; count: number }
  /** Threshold + window reached: the channel was retired. */
  | { action: "RETIRED"; forceJoinDisabled: boolean }
  /** Nothing to do (row gone, or already inactive). */
  | { action: "NOOP" };

/**
 * Records ONE permanent "the bot can no longer verify this channel" result and
 * applies the bounded health policy.
 *
 * An unverifiable ACTIVE channel is excluded from gating so users are never
 * bricked (D4) — but excluding it forever would silently leave the admin panel
 * advertising a required channel that is not actually enforced. So the failures
 * are counted durably, and once they are BOTH numerous
 * (`FORCE_JOIN_HEALTH_FAILURE_THRESHOLD`) and sustained
 * (`FORCE_JOIN_HEALTH_MIN_WINDOW_MS`) the channel is atomically deactivated.
 * If it was the LAST active channel while force join was globally enabled, the
 * master switch is disabled in the SAME transaction — never leaving the bot
 * switched on with zero enforceable channels.
 *
 * Only PERMANENT results reach this function; transient Telegram/network
 * failures never mutate configuration. Any success resets the window.
 */
export async function recordChannelHealthFailure(
  id: string,
  errorClass: string,
): Promise<HealthFailureOutcome> {
  try {
    return await prisma.$transaction(async (tx) => {
      await lockForceJoinConfig(tx);
      const row = await tx.forceJoinChannel.findUnique({ where: { id } });
      if (!row || !row.isActive) {
        return { action: "NOOP" as const };
      }

      const now = Date.now();
      const lastAt = row.healthFailureLastAt?.getTime() ?? null;
      // Write-debounce: many gated users hitting the same broken channel within
      // a few seconds is ONE observation, not N.
      if (lastAt !== null && now - lastAt < FORCE_JOIN_HEALTH_COUNT_DEBOUNCE_MS) {
        return { action: "COUNTED" as const, count: row.healthFailureCount };
      }

      // A long gap since the previous failure means the earlier trouble is not
      // evidence about this one — start a fresh window.
      const staleWindow = lastAt === null || now - lastAt > FORCE_JOIN_HEALTH_RESET_MS;
      const firstAt = staleWindow ? new Date(now) : (row.healthFailureFirstAt ?? new Date(now));
      const count = staleWindow ? 1 : row.healthFailureCount + 1;

      const sustainedMs = now - firstAt.getTime();
      const retire =
        count >= FORCE_JOIN_HEALTH_FAILURE_THRESHOLD &&
        sustainedMs >= FORCE_JOIN_HEALTH_MIN_WINDOW_MS;

      if (!retire) {
        await tx.forceJoinChannel.update({
          where: { id },
          data: {
            healthFailureCount: count,
            healthFailureFirstAt: firstAt,
            healthFailureLastAt: new Date(now),
            lastValidatedAt: new Date(now),
            lastValidationErrorCode: errorClass,
          },
        });
        return { action: "COUNTED" as const, count };
      }

      const remainingActive = await tx.forceJoinChannel.count({
        where: { isActive: true, id: { not: id } },
      });
      const enabled = isTruthySettingValue(
        (await tx.setting.findUnique({ where: { key: FORCE_JOIN_ENABLED_KEY } }))?.value,
      );
      const forceJoinDisabled = enabled && remainingActive === 0;
      if (forceJoinDisabled) {
        await tx.setting.upsert({
          where: { key: FORCE_JOIN_ENABLED_KEY },
          update: { value: "false", type: "BOOLEAN" },
          create: { key: FORCE_JOIN_ENABLED_KEY, value: "false", type: "BOOLEAN" },
        });
      }
      await tx.forceJoinChannel.update({
        where: { id },
        data: {
          isActive: false,
          unhealthyAt: new Date(now),
          healthFailureCount: count,
          healthFailureFirstAt: firstAt,
          healthFailureLastAt: new Date(now),
          lastValidatedAt: new Date(now),
          lastValidationErrorCode: errorClass,
        },
      });
      return { action: "RETIRED" as const, forceJoinDisabled };
    });
  } catch (err) {
    // Health bookkeeping must never break a membership check.
    logger.warn("force-join: failed to record channel health failure", {
      channelId: id,
      error: errorMessage(err),
    });
    return { action: "NOOP" };
  } finally {
    settingCacheInvalidator([FORCE_JOIN_ENABLED_KEY]);
  }
}

/** Clears the bounded failure window after any successful verification. */
export async function recordChannelHealthSuccess(id: string): Promise<void> {
  try {
    await prisma.forceJoinChannel.updateMany({
      where: { id, healthFailureCount: { gt: 0 } },
      data: {
        healthFailureCount: 0,
        healthFailureFirstAt: null,
        healthFailureLastAt: null,
        unhealthyAt: null,
      },
    });
  } catch (err) {
    logger.warn("force-join: failed to clear channel health failures", {
      channelId: id,
      error: errorMessage(err),
    });
  }
}
