import { prisma, UserStatus } from "@zedbot/database";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.APP_SECRET ??= "force-join-stale-secret";

import { CB } from "../src/core/callbacks.js";
import { initialSession } from "../src/core/session.js";
import { forceJoinHandler } from "../src/handlers/force-join.handler.js";
import {
  FORCE_JOIN_ENABLED_KEY,
  disableForceJoin,
  enableForceJoin,
} from "../src/services/force-join/force-join-channel.service.js";
import { resetForceJoinRedisForTests } from "../src/services/force-join/membership.service.js";
import { clearSettingsCache } from "../src/services/settings.service.js";
import { clearTextCache } from "../src/services/text.service.js";

// =============================================================================
// "بررسی عضویت" on a STALE keyboard.
//
// The button lives on a message that may be arbitrarily old. Before the handler
// spends a debounce slot or a getChatMember call it must re-derive the current
// world: the user's access state, the master switch, the per-user bypass and the
// live active-channel set. If force join no longer applies, the tap must cost
// ZERO Telegram calls and simply return the user to the normal menu.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

const RUN_TAG = Date.now();
let seq = 0;
function nextChatId(): bigint {
  seq += 1;
  return -(1_000_000_000_000n + BigInt(RUN_TAG % 1_000_000_000) * 10n + BigInt(seq));
}
function nextTelegramId(): bigint {
  seq += 1;
  return BigInt(880_000_000 + (RUN_TAG % 1_000_000) * 10 + seq);
}

interface Harness {
  ctx: never;
  getChatMember: ReturnType<typeof vi.fn>;
  sent: string[];
  toasts: Array<string | undefined>;
}

function makeCtx(user: { id: string; telegramId: bigint; status: UserStatus; forceJoinBypass: boolean }): Harness {
  const sent: string[] = [];
  const toasts: Array<string | undefined> = [];
  const getChatMember = vi.fn(async () => ({ status: "left" }));
  const from = { id: Number(user.telegramId), is_bot: false, first_name: "U" };
  const callback_query = {
    id: "cbq",
    chat_instance: "ci",
    from,
    data: CB.FORCE_JOIN_CHECK,
    message: { message_id: 1, date: 0, chat: { id: Number(user.telegramId), type: "private" } },
  };
  const ctx = {
    from,
    admin: null,
    dbUser: user,
    session: initialSession(),
    chat: { id: Number(user.telegramId), type: "private" },
    callbackQuery: callback_query,
    update: { update_id: 1, callback_query },
    api: { getChatMember },
    reply: async (text: string) => {
      sent.push(text);
      return {};
    },
    editMessageText: async (text: string) => {
      sent.push(text);
      return {};
    },
    answerCallbackQuery: async (payload?: { text?: string }) => {
      toasts.push(payload?.text);
      return true;
    },
  };
  return { ctx: ctx as never, getChatMember, sent, toasts };
}

async function createUser(overrides: { status?: UserStatus; forceJoinBypass?: boolean } = {}) {
  return prisma.user.create({
    data: {
      telegramId: nextTelegramId(),
      status: overrides.status ?? UserStatus.ACTIVE,
      forceJoinBypass: overrides.forceJoinBypass ?? false,
      termsAcceptedAt: new Date(),
    },
  });
}

async function createActiveChannel(): Promise<void> {
  seq += 1;
  await prisma.forceJoinChannel.create({
    data: {
      title: `Stale ${seq}`,
      joinUrl: `https://t.me/stale_${RUN_TAG}_${seq}`,
      normalizedLink: `https://t.me/stale_${RUN_TAG}_${seq}`,
      chatId: nextChatId(),
      isPrivate: false,
      isActive: true,
      sortOrder: seq,
    },
  });
}

const run = (h: Harness) => forceJoinHandler.middleware()(h.ctx, async () => {});

describe.runIf(hasDb)("force join — stale 'بررسی عضویت' keyboards", () => {
  const userIds: string[] = [];

  beforeEach(async () => {
    await prisma.forceJoinChannel.deleteMany({});
    await disableForceJoin();
    clearSettingsCache();
    clearTextCache();
    resetForceJoinRedisForTests();
  });

  afterAll(async () => {
    await prisma.forceJoinChannel.deleteMany({});
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.setting.deleteMany({ where: { key: FORCE_JOIN_ENABLED_KEY } });
    clearSettingsCache();
    await prisma.$disconnect();
  });

  it("does not call Telegram when force join has been switched off since the keyboard was drawn", async () => {
    const user = await createUser();
    userIds.push(user.id);
    await createActiveChannel(); // channels still configured, but the switch is OFF
    clearSettingsCache();

    const h = makeCtx(user);
    await run(h);

    expect(h.getChatMember).not.toHaveBeenCalled();
  });

  it("does not call Telegram when the user has since been granted a bypass", async () => {
    const user = await createUser({ forceJoinBypass: true });
    userIds.push(user.id);
    await createActiveChannel();
    await enableForceJoin();
    clearSettingsCache();

    const h = makeCtx(user);
    await run(h);

    expect(h.getChatMember).not.toHaveBeenCalled();
  });

  it("does not call Telegram when every channel has been removed (D4 never-brick)", async () => {
    const user = await createUser();
    userIds.push(user.id);
    // Enable with a channel, then remove it: the switch stays on with zero
    // active channels, which must pass rather than block.
    await createActiveChannel();
    await enableForceJoin();
    await prisma.forceJoinChannel.deleteMany({});
    clearSettingsCache();

    const h = makeCtx(user);
    await run(h);

    expect(h.getChatMember).not.toHaveBeenCalled();
  });

  it("does not call Telegram for a user blocked since the keyboard was drawn", async () => {
    const user = await createUser({ status: UserStatus.BLOCKED });
    userIds.push(user.id);
    await createActiveChannel();
    await enableForceJoin();
    clearSettingsCache();

    const h = makeCtx(user);
    await run(h);

    expect(h.getChatMember).not.toHaveBeenCalled();
    // The user is told they are blocked, not that their membership is missing.
    expect(h.sent.join("\n")).toContain("مسدود");
  });

  it("still performs a real live check when force join genuinely applies", async () => {
    const user = await createUser();
    userIds.push(user.id);
    await createActiveChannel();
    await enableForceJoin();
    clearSettingsCache();

    const h = makeCtx(user);
    await run(h);

    expect(h.getChatMember).toHaveBeenCalled();
  });
});
