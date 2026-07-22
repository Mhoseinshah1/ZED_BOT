import { afterEach, describe, expect, it, vi } from "vitest";

// =============================================================================
// Worker Telegram client hardening (§5 timeouts + safe logging, §6
// operation-aware classification, §7 429 retry-after cap, thread-id
// validation). Imports the BUILT worker module - the exact code the worker
// runs. Pure-function + mocked-fetch; no DB/Redis required.
// =============================================================================

interface TelegramModule {
  classifySendMessageError: (
    status: number,
    body: unknown,
  ) => { safeErrorCode: string; retryable: boolean; retryAfterMs?: number };
  classifyCreateForumTopicError: (
    status: number,
    body: unknown,
  ) => { safeErrorCode: string; retryable: boolean; retryAfterMs?: number };
  createTelegramForumTopic: (input: {
    token: string;
    chatId: string;
    name: string;
  }) => Promise<{ ok: boolean; messageThreadId?: number; safeErrorCode?: string; retryable?: boolean }>;
  sendTelegramMessage: (input: {
    token: string;
    chatId: string;
    text: string;
    messageThreadId?: number;
  }) => Promise<{ ok: boolean; safeErrorCode?: string; retryable?: boolean; retryAfterMs?: number }>;
  TELEGRAM_MAX_RETRY_AFTER_MS: number;
  telegramApiTimeoutMs: () => number;
}

const mod = (await import("../../worker/dist/telegram.js")) as unknown as TelegramModule;

function body(description: string, extra: Record<string, unknown> = {}): unknown {
  return { ok: false, description, ...extra };
}

function fakeResponse(status: number, json: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => json,
  } as unknown as Response;
}

describe("worker telegram client hardening", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.TELEGRAM_API_TIMEOUT_MS;
  });

  // --- §6 sendMessage classification -------------------------------------------

  it("classifySendMessageError distinguishes topic-missing / topic-closed / chat-not-found", () => {
    expect(mod.classifySendMessageError(400, body("Bad Request: message thread not found")).safeErrorCode).toBe(
      "topic-missing",
    );
    expect(mod.classifySendMessageError(400, body("Bad Request: TOPIC_CLOSED")).safeErrorCode).toBe(
      "topic-closed",
    );
    expect(mod.classifySendMessageError(400, body("Bad Request: chat not found")).safeErrorCode).toBe(
      "chat-not-found",
    );
    expect(
      mod.classifySendMessageError(400, body("Bad Request: not enough rights to send text messages"))
        .safeErrorCode,
    ).toBe("bot-not-admin");
    expect(mod.classifySendMessageError(400, body("Bad Request: MESSAGE_TOO_LONG")).safeErrorCode).toBe(
      "bad-request",
    );
  });

  it("classifySendMessageError maps 403 kicked to bot-not-member, otherwise forbidden", () => {
    expect(
      mod.classifySendMessageError(403, body("Forbidden: bot was kicked from the supergroup chat"))
        .safeErrorCode,
    ).toBe("bot-not-member");
    expect(mod.classifySendMessageError(403, body("Forbidden: user is deactivated")).safeErrorCode).toBe(
      "forbidden",
    );
  });

  it("maps 5xx to a retryable telegram-server-error", () => {
    const r = mod.classifySendMessageError(500, body("Internal Server Error"));
    expect(r.safeErrorCode).toBe("telegram-server-error");
    expect(r.retryable).toBe(true);
  });

  // --- §6 createForumTopic classification (never topic-missing) -----------------

  it("classifyCreateForumTopicError never returns topic-missing and separates forum-disabled vs manage-topics", () => {
    // A description containing 'topic' must NOT become topic-missing for creation.
    expect(
      mod.classifyCreateForumTopicError(400, body("Bad Request: the chat is not a forum supergroup"))
        .safeErrorCode,
    ).toBe("topics-disabled");
    expect(
      mod.classifyCreateForumTopicError(400, body("Bad Request: not enough rights to manage topics"))
        .safeErrorCode,
    ).toBe("manage-topics-required");
    expect(
      mod.classifyCreateForumTopicError(400, body("Bad Request: chat not found")).safeErrorCode,
    ).toBe("chat-not-found");
    // Never topic-missing/topic-closed for creation.
    for (const desc of ["message thread not found", "TOPIC_CLOSED", "topic_deleted"]) {
      const code = mod.classifyCreateForumTopicError(400, body(`Bad Request: ${desc}`)).safeErrorCode;
      expect(["topic-missing", "topic-closed"]).not.toContain(code);
    }
  });

  // --- §7 429 retry-after cap ---------------------------------------------------

  it("caps an unreasonable 429 retry_after at the documented maximum", () => {
    const huge = mod.classifySendMessageError(429, body("Too Many Requests", { parameters: { retry_after: 999_999 } }));
    expect(huge.safeErrorCode).toBe("rate-limited");
    expect(huge.retryable).toBe(true);
    expect(huge.retryAfterMs).toBe(mod.TELEGRAM_MAX_RETRY_AFTER_MS);
    // A normal small value passes through (in ms).
    const normal = mod.classifySendMessageError(429, body("Too Many Requests", { parameters: { retry_after: 3 } }));
    expect(normal.retryAfterMs).toBe(3_000);
  });

  // --- §5 timeout config bounds -------------------------------------------------

  it("clamps TELEGRAM_API_TIMEOUT_MS to the 5s..60s range", () => {
    process.env.TELEGRAM_API_TIMEOUT_MS = "1000";
    expect(mod.telegramApiTimeoutMs()).toBe(5_000);
    process.env.TELEGRAM_API_TIMEOUT_MS = "999999";
    expect(mod.telegramApiTimeoutMs()).toBe(60_000);
    process.env.TELEGRAM_API_TIMEOUT_MS = "12000";
    expect(mod.telegramApiTimeoutMs()).toBe(12_000);
  });

  // --- §5 timeout -> telegram-timeout safe code --------------------------------

  it("returns telegram-timeout (retryable) when the request aborts", async () => {
    vi.stubGlobal("fetch", async () => {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });
    const send = await mod.sendTelegramMessage({ token: "t", chatId: "-100123", text: "hi" });
    expect(send.ok).toBe(false);
    expect(send.safeErrorCode).toBe("telegram-timeout");
    expect(send.retryable).toBe(true);

    const create = await mod.createTelegramForumTopic({ token: "t", chatId: "-100123", name: "x" });
    expect(create.ok).toBe(false);
    expect(create.safeErrorCode).toBe("telegram-timeout");
  });

  it("returns network-error for a non-abort fetch failure", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNRESET");
    });
    const send = await mod.sendTelegramMessage({ token: "t", chatId: "-100123", text: "hi" });
    expect(send.safeErrorCode).toBe("network-error");
    expect(send.retryable).toBe(true);
  });

  // --- message_thread_id validation --------------------------------------------

  it("rejects a non-positive / non-integer / unsafe message_thread_id as bad-response", async () => {
    for (const bad of [-5, 0, 1.5, Number.MAX_SAFE_INTEGER + 2]) {
      vi.stubGlobal("fetch", async () =>
        fakeResponse(200, { ok: true, result: { message_thread_id: bad } }),
      );
      const create = await mod.createTelegramForumTopic({ token: "t", chatId: "-100123", name: "x" });
      expect(create.ok, `thread=${bad}`).toBe(false);
      expect(create.safeErrorCode).toBe("bad-response");
      vi.unstubAllGlobals();
    }
    // A valid positive integer is accepted.
    vi.stubGlobal("fetch", async () =>
      fakeResponse(200, { ok: true, result: { message_thread_id: 42 } }),
    );
    const ok = await mod.createTelegramForumTopic({ token: "t", chatId: "-100123", name: "x" });
    expect(ok.ok).toBe(true);
    expect(ok.messageThreadId).toBe(42);
  });
});
