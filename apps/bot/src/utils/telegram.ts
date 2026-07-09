import type { BotContext } from "../core/context.js";

/** The deep-link payload of "/start <payload>", or null when absent. */
export function getStartPayload(ctx: BotContext): string | null {
  const match = ctx.match;
  if (typeof match !== "string") {
    return null;
  }
  const trimmed = match.trim();
  return trimmed === "" ? null : trimmed;
}
