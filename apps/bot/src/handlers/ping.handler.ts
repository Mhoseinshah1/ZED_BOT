import { Composer } from "grammy";

import type { BotContext } from "../core/context.js";
import { safeReply } from "../utils/safe-reply.js";

/** Internal liveness command - intentionally bypasses all access gates. */
export const pingHandler = new Composer<BotContext>();

pingHandler.command("ping", async (ctx) => {
  await safeReply(ctx, "pong");
});
