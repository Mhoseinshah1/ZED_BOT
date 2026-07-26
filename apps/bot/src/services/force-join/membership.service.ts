import { setForceJoinAlertSink } from "@zedbot/force-join";

import { OPS_EVENTS, writeSystemLog } from "../system-log.service.js";

// =============================================================================
// Force Join membership: the bot's binding to the SHARED checker.
//
// The checker itself moved to `@zedbot/force-join` so the API can run the exact
// same gate for a Mini App request — same live Telegram lookup, same Redis
// cache policy, same error classification, same unhealthy-channel handling. A
// user who verifies in the bot is therefore admitted by the Mini App, and a
// user who leaves a channel is refused by both.
//
// What stays here is the one thing that genuinely differs per process: where an
// OWNER alert goes. The bot has the Telegram log-group pipeline (BullMQ), so it
// installs a sink that writes a system log; the API process, which runs no
// queue, keeps the package's logging default. The DECISION never depends on it.
//
// Everything else is re-exported unchanged, so every existing bot caller and
// test keeps importing from this path.
// =============================================================================

setForceJoinAlertSink({
  async channelUnverifiable({ channelId, errorClass, isPrivate }) {
    await writeSystemLog({
      level: "WARN",
      eventType: OPS_EVENTS.FORCE_JOIN_CHANNEL_UNVERIFIABLE,
      // No secret: the channel DB id + class only; the chat id / invite link
      // never appear (§4.11, T6).
      message: `Force-join required channel became unverifiable (${errorClass}).`,
      metadata: { channelId, errorClass, isPrivate },
      topicKey: "SYSTEM",
    });
  },
  async channelRetired({ channelId, isPrivate, forceJoinDisabled, thresholdFailures, windowMs }) {
    await writeSystemLog({
      level: "ERROR",
      eventType: OPS_EVENTS.FORCE_JOIN_CHANNEL_RETIRED,
      message: forceJoinDisabled
        ? "Force-join channel stayed unverifiable and was deactivated; it was the last active channel, so mandatory membership was disabled too."
        : "Force-join channel stayed unverifiable and was deactivated.",
      metadata: { channelId, isPrivate, forceJoinDisabled, thresholdFailures, windowMs },
      topicKey: "SYSTEM",
    });
  },
});

export {
  acquireForceJoinCheckSlot,
  classifyMemberCheckError,
  evaluateForceJoinMembership,
  resetForceJoinRedisForTests,
  type EvaluateMembershipArgs,
  type ForceJoinGateOutcome,
  type ForceJoinMembershipApi,
} from "@zedbot/force-join";
