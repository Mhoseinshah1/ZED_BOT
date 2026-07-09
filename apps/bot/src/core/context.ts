import type { Admin, User } from "@zedbot/database";
import type { Context, SessionFlavor } from "grammy";

import type { SessionData } from "./session.js";

/**
 * Typed bot context: grammY context + session + the database user/admin rows
 * attached by the middleware chain (null when not registered / not admin).
 */
export type BotContext = Context &
  SessionFlavor<SessionData> & {
    dbUser: User | null;
    admin: Admin | null;
  };
