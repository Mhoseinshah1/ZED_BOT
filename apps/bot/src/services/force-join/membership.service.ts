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
// What stays here is the pre-retirement WARNING — "the bot still cannot see
// this channel". It changes no configuration, so a process-local sink is an
// adequate home: the bot has the Telegram log-group pipeline (BullMQ) and
// installs a sink that writes a system log; the API process, which runs no
// queue, keeps the package's logging default. The DECISION never depends on it.
//
// The RETIREMENT alert is deliberately NOT installed here any more. Retiring a
// channel — and, when it is the last one, switching mandatory membership off
// platform-wide — is a configuration mutation now reachable from an API
// request, and a sink installed by the bot process cannot fire for it. Those
// events are written as outbox rows inside the mutation's own transaction by
// `@zedbot/force-join`, and the worker delivers them through this same
// SystemLog → SystemLogDelivery → Telegram pipeline. Re-adding a sink for them
// here would only duplicate what is already durable.
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
