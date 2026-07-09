import type { MiddlewareFn } from "grammy";

import type { BotContext } from "../core/context.js";
import { logger } from "../core/logger.js";

// Very conservative in-memory rate limit: protects against update floods
// without ever bothering a normal user. Redis-backed limiting is a later
// phase (TODO).
const WINDOW_MS = 3_000;
const MAX_UPDATES_PER_WINDOW = 20;
const MAX_TRACKED_USERS = 10_000;

interface WindowState {
  windowStart: number;
  count: number;
}

const windows = new Map<number, WindowState>();

export function rateLimitMiddleware(): MiddlewareFn<BotContext> {
  return async (ctx, next) => {
    const fromId = ctx.from?.id;
    if (fromId === undefined) {
      return next();
    }
    const now = Date.now();
    const state = windows.get(fromId);
    if (state === undefined || now - state.windowStart >= WINDOW_MS) {
      // Opportunistic cleanup: cap the map so it can never grow unbounded.
      if (windows.size >= MAX_TRACKED_USERS) {
        windows.clear();
      }
      windows.set(fromId, { windowStart: now, count: 1 });
      return next();
    }
    state.count += 1;
    if (state.count > MAX_UPDATES_PER_WINDOW) {
      if (state.count === MAX_UPDATES_PER_WINDOW + 1) {
        logger.debug("rate limit hit, dropping updates", { fromId });
      }
      return; // Silently drop - replying would amplify the flood.
    }
    return next();
  };
}
