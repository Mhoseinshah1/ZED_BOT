import { createLogger, errorMessage, panelBreakerKey } from "@zedbot/shared";

import type { RawRedis } from "../redis.js";

// =============================================================================
// Per-panel circuit breaker (notification/retention engine).
//
// A single Redis counter per panel (panelBreakerKey) tracks consecutive
// panel-level read failures inside a decaying window. When the count reaches
// the threshold the breaker is "open" and the worker skips syncing that panel
// until the window decays, so one dead/misconfigured panel cannot burn the
// whole sync cadence on doomed HTTP calls. A single successful read clears the
// counter (recovery).
//
// FAILURE POLICY (documented on purpose): every function here is best-effort
// and NEVER throws.
//   - isPanelBreakerOpen fails CLOSED-as-in-not-open: if Redis cannot be read
//     we return false (breaker treated as closed) so a transient Redis blip
//     does NOT wedge every panel's sync. A genuinely unhealthy panel simply
//     re-trips the breaker on its next real failure. The alternative
//     (treating an unreadable breaker as open) would let one Redis hiccup
//     freeze all synchronization - the worse failure mode here.
//   - recordPanelFailure / recordPanelSuccess swallow Redis errors; the
//     counter's own TTL is the safety net if a write is lost.
// =============================================================================

const log = createLogger("worker:service-sync");

/** Decay window: a burst of failures must recur within this window to add up. */
const BREAKER_DECAY_SECONDS = 600;

/** Consecutive failures at or above this open the breaker. */
const DEFAULT_BREAKER_THRESHOLD = 5;

/**
 * Records one panel-level failure: INCR the breaker counter and, on the first
 * failure in a fresh window, arm the decay TTL. Returns the new count (0 when
 * the write could not be recorded). Never throws.
 */
export async function recordPanelFailure(redis: RawRedis, panelId: string): Promise<number> {
  const key = panelBreakerKey(panelId);
  try {
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, BREAKER_DECAY_SECONDS);
    }
    return count;
  } catch (err) {
    log.warn("panel breaker increment failed", { code: errorMessage(err) });
    return 0;
  }
}

/** Clears the breaker counter after a successful panel read (recovery). Never throws. */
export async function recordPanelSuccess(redis: RawRedis, panelId: string): Promise<void> {
  try {
    await redis.del(panelBreakerKey(panelId));
  } catch (err) {
    // The counter decays on its own via the TTL; nothing else to do.
    log.warn("panel breaker clear failed", { code: errorMessage(err) });
  }
}

/**
 * True when the panel's failure count has reached the threshold. On a Redis
 * read error returns false (breaker treated as NOT open) so sync keeps making
 * progress - see the failure policy above. Never throws.
 */
export async function isPanelBreakerOpen(
  redis: RawRedis,
  panelId: string,
  threshold = DEFAULT_BREAKER_THRESHOLD,
): Promise<boolean> {
  try {
    const raw = await redis.get(panelBreakerKey(panelId));
    if (raw === null) {
      return false;
    }
    const count = Number.parseInt(raw, 10);
    return Number.isFinite(count) && count >= threshold;
  } catch (err) {
    log.warn("panel breaker read failed; treating as closed", { code: errorMessage(err) });
    return false;
  }
}
