import {
  isTelegramBotTokenConfigured,
  resolveTelegramBotTokenFromEnv,
  telegramBotTokenSourceFromEnv,
  getTelegramBotToken,
} from "@zedbot/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getBotToken, getTelegramApiRoot } from "../src/config/env.js";
// The worker's runtime accessor (built dist) — proves the WORKER resolves through
// the SAME shared contract as the bot.
import { botToken as workerBotToken, botTokenResolution } from "../../worker/dist/config.js";

// =============================================================================
// fix/worker-telegram-token-env-contract: the ONE shared Telegram-token
// precedence, consumed identically by the bot and the worker. Pure resolver +
// both runtime accessors. No token value may ever appear in a log/error/result
// field other than the explicitly-resolved string.
// =============================================================================

const CANONICAL = "111111:canonical-telegram-bot-token";
const LEGACY = "222222:legacy-bot-token";

const ORIGINAL_TELEGRAM = process.env.TELEGRAM_BOT_TOKEN;
const ORIGINAL_BOT = process.env.BOT_TOKEN;

function setEnv(telegram: string | undefined, bot: string | undefined): void {
  if (telegram === undefined) {
    delete process.env.TELEGRAM_BOT_TOKEN;
  } else {
    process.env.TELEGRAM_BOT_TOKEN = telegram;
  }
  if (bot === undefined) {
    delete process.env.BOT_TOKEN;
  } else {
    process.env.BOT_TOKEN = bot;
  }
}

afterEach(() => {
  setEnv(ORIGINAL_TELEGRAM, ORIGINAL_BOT);
  vi.restoreAllMocks();
});

describe("shared Telegram bot-token resolver (pure)", () => {
  it("only TELEGRAM_BOT_TOKEN → uses it (canonical, no warnings)", () => {
    const r = resolveTelegramBotTokenFromEnv({ TELEGRAM_BOT_TOKEN: CANONICAL });
    expect(r).toEqual({
      ok: true,
      token: CANONICAL,
      source: "TELEGRAM_BOT_TOKEN",
      legacyFallback: false,
      duplicateKeys: false,
    });
  });

  it("only BOT_TOKEN → legacy fallback", () => {
    const r = resolveTelegramBotTokenFromEnv({ BOT_TOKEN: LEGACY });
    expect(r).toEqual({
      ok: true,
      token: LEGACY,
      source: "BOT_TOKEN",
      legacyFallback: true,
      duplicateKeys: false,
    });
  });

  it("both equal → uses TELEGRAM_BOT_TOKEN with a duplicate-key warning", () => {
    const r = resolveTelegramBotTokenFromEnv({ TELEGRAM_BOT_TOKEN: CANONICAL, BOT_TOKEN: CANONICAL });
    expect(r).toEqual({
      ok: true,
      token: CANONICAL,
      source: "TELEGRAM_BOT_TOKEN",
      legacyFallback: false,
      duplicateKeys: true,
    });
  });

  it("both different → CONFLICT, fail closed (no token in result)", () => {
    const r = resolveTelegramBotTokenFromEnv({ TELEGRAM_BOT_TOKEN: CANONICAL, BOT_TOKEN: LEGACY });
    expect(r).toEqual({ ok: false, source: "CONFLICT" });
    expect(JSON.stringify(r)).not.toContain("canonical");
    expect(JSON.stringify(r)).not.toContain("legacy");
  });

  it("neither → MISSING", () => {
    expect(resolveTelegramBotTokenFromEnv({})).toEqual({ ok: false, source: "MISSING" });
  });

  it("whitespace-only values are treated as unset", () => {
    expect(resolveTelegramBotTokenFromEnv({ TELEGRAM_BOT_TOKEN: "   " })).toEqual({
      ok: false,
      source: "MISSING",
    });
    // canonical whitespace + real legacy → legacy fallback
    expect(resolveTelegramBotTokenFromEnv({ TELEGRAM_BOT_TOKEN: "  ", BOT_TOKEN: LEGACY }).source).toBe(
      "BOT_TOKEN",
    );
  });

  it("trims surrounding whitespace before comparing (equal after trim = duplicate, not conflict)", () => {
    const r = resolveTelegramBotTokenFromEnv({ TELEGRAM_BOT_TOKEN: CANONICAL, BOT_TOKEN: ` ${CANONICAL} ` });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.duplicateKeys).toBe(true);
      expect(r.token).toBe(CANONICAL);
    }
  });

  it("source helper + configured helper agree without exposing the token", () => {
    expect(telegramBotTokenSourceFromEnv({ TELEGRAM_BOT_TOKEN: CANONICAL })).toBe("TELEGRAM_BOT_TOKEN");
    expect(telegramBotTokenSourceFromEnv({ BOT_TOKEN: LEGACY })).toBe("BOT_TOKEN");
    expect(telegramBotTokenSourceFromEnv({ TELEGRAM_BOT_TOKEN: CANONICAL, BOT_TOKEN: LEGACY })).toBe(
      "CONFLICT",
    );
    expect(telegramBotTokenSourceFromEnv({})).toBe("MISSING");
    expect(isTelegramBotTokenConfigured({ TELEGRAM_BOT_TOKEN: CANONICAL })).toBe(true);
    expect(isTelegramBotTokenConfigured({})).toBe(false);
    expect(isTelegramBotTokenConfigured({ TELEGRAM_BOT_TOKEN: CANONICAL, BOT_TOKEN: LEGACY })).toBe(
      false,
    );
  });
});

describe("runtime accessors — bot AND worker share the resolver", () => {
  it("TELEGRAM_BOT_TOKEN only works in the bot AND the worker", () => {
    setEnv(CANONICAL, undefined);
    expect(getBotToken()).toBe(CANONICAL); // bot
    expect(workerBotToken()).toBe(CANONICAL); // worker (built dist)
    expect(getTelegramBotToken()).toBe(CANONICAL);
    expect(botTokenResolution().source).toBe("TELEGRAM_BOT_TOKEN");
  });

  it("BOT_TOKEN only works as a legacy fallback in the bot AND the worker", () => {
    setEnv(undefined, LEGACY);
    expect(getBotToken()).toBe(LEGACY);
    expect(workerBotToken()).toBe(LEGACY);
    expect(botTokenResolution()).toMatchObject({ ok: true, source: "BOT_TOKEN", legacyFallback: true });
  });

  it("both-equal works in both; source stays canonical", () => {
    setEnv(CANONICAL, CANONICAL);
    expect(getBotToken()).toBe(CANONICAL);
    expect(workerBotToken()).toBe(CANONICAL);
    expect(botTokenResolution()).toMatchObject({ ok: true, source: "TELEGRAM_BOT_TOKEN", duplicateKeys: true });
  });

  it("conflicting values fail closed to null in both processes", () => {
    setEnv(CANONICAL, LEGACY);
    expect(getBotToken()).toBeNull(); // bot never runs on an ambiguous token
    expect(workerBotToken()).toBeNull(); // worker never runs on an ambiguous token
    expect(botTokenResolution().source).toBe("CONFLICT");
  });

  it("neither returns null in both processes", () => {
    setEnv(undefined, undefined);
    expect(getBotToken()).toBeNull();
    expect(workerBotToken()).toBeNull();
    expect(botTokenResolution().source).toBe("MISSING");
  });

  it("no token bytes reach the logger from the resolver path", () => {
    // Any accidental logging inside the accessor would surface here.
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    setEnv(CANONICAL, LEGACY); // the most sensitive case (conflict)
    getBotToken();
    workerBotToken();
    for (const call of [...spy.mock.calls, ...errSpy.mock.calls].flat()) {
      const s = typeof call === "string" ? call : JSON.stringify(call);
      expect(s).not.toContain("canonical");
      expect(s).not.toContain("legacy");
    }
  });
});

describe("bounded Telegram Bot API root", () => {
  it("accepts an explicit HTTP(S) origin without leaking configuration", () => {
    expect(getTelegramApiRoot({ TELEGRAM_API_ROOT: " http://172.18.0.1:18081 " })).toBe(
      "http://172.18.0.1:18081",
    );
    expect(getTelegramApiRoot({ TELEGRAM_API_ROOT: "https://api.telegram.org/" })).toBe(
      "https://api.telegram.org",
    );
    expect(getTelegramApiRoot({})).toBeUndefined();
  });

  it.each([
    "ftp://127.0.0.1",
    "http://user:password@127.0.0.1",
    "http://127.0.0.1/path",
    "http://127.0.0.1/?query=value",
    "not-a-url",
  ])("rejects malformed or over-broad API roots without echoing them: %s", (value) => {
    expect(() => getTelegramApiRoot({ TELEGRAM_API_ROOT: value })).toThrow(
      "TELEGRAM_API_ROOT is invalid",
    );
  });
});
