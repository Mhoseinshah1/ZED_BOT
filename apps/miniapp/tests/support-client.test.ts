import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createSupportTicket,
  fetchSupportMessages,
  fetchSupportSummary,
  fetchSupportTicket,
  fetchSupportTickets,
  newClientRequestId,
  replySupportTicket,
  SERVER_FAILURE_CODES,
  type ApiFailureCode,
} from "../src/api";
import { FAILURE_TEXT, SUPPORT_CATEGORIES, SUPPORT_CATEGORY_TEXT } from "../src/i18n";

// =============================================================================
// The support client, without a DOM (S21-S31).
//
// Three properties that are cheaper to prove here than through a rendered
// screen, and that a screen test would prove only incidentally:
//
//   THE IDEMPOTENCY KEY IS UNPREDICTABLE. It is the only thing standing between
//   a retried submission and a duplicate ticket, so a weak generator is a
//   correctness bug, not a style preference. `Math.random` is seeded per
//   context and guarantees nothing about distribution across contexts.
//
//   EVERY SERVER CODE HAS PERSIAN TEXT. A code with no entry renders
//   `undefined` and throws inside the render — an error path that breaks worse
//   than the error it was reporting.
//
//   THE CATEGORY CODES MIRROR THE SHARED TABLE. This app does not depend on
//   `@zedbot/shared`, so the codes are written out locally; a drifted code is
//   refused by the server with INVALID_CATEGORY, which is a dead end the user
//   cannot escape.
// =============================================================================

/** The server's own pattern, from `packages/support-tickets/src/contract.ts`. */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

interface Recorded {
  url: string;
  init: RequestInit;
}

let calls: Recorded[] = [];

function mockFetch(status: number, body: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
      } as Response;
    }),
  );
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("support idempotency keys", () => {
  it("S21 mints a key the server's pattern accepts", () => {
    for (let i = 0; i < 200; i += 1) {
      expect(newClientRequestId()).toMatch(REQUEST_ID_PATTERN);
    }
  });

  it("S22 draws from crypto.getRandomValues, never Math.random", () => {
    const random = vi.spyOn(Math, "random");
    const getRandomValues = vi.spyOn(crypto, "getRandomValues");
    newClientRequestId();
    expect(getRandomValues).toHaveBeenCalled();
    // A per-context seeded PRNG is not an acceptable source for the one value
    // that keeps a retry from opening a second ticket.
    expect(random).not.toHaveBeenCalled();
  });

  it("S23 mints a distinct key every time", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) {
      seen.add(newClientRequestId());
    }
    expect(seen.size).toBe(500);
  });

  it("S24 sends the caller's key verbatim on both write endpoints", async () => {
    const key = newClientRequestId();
    mockFetch(201, { ok: true, ticket: {} });
    await createSupportTicket({
      subject: "موضوع",
      message: "متن",
      category: "OTHER",
      clientRequestId: key,
    });
    await replySupportTicket("a1b2c3d4", { message: "متن", clientRequestId: key });

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.init.method).toBe("POST");
      // Same credential rule as every other call: the cookie, same-origin.
      expect(call.init.credentials).toBe("same-origin");
      const body = JSON.parse(String(call.init.body)) as { clientRequestId: string };
      // Not normalised, not re-cased, not regenerated — the server matches on
      // the exact string, so any transformation here would defeat the record.
      expect(body.clientRequestId).toBe(key);
    }
  });
});

describe("support endpoints", () => {
  it("S25 reads use GET with no body and write to no path but their own", async () => {
    mockFetch(200, { ok: true, summary: {}, items: [], nextCursor: null, ticket: {} });
    await fetchSupportSummary();
    await fetchSupportTickets(null);
    await fetchSupportTicket("a1b2c3d4");
    await fetchSupportMessages("a1b2c3d4", null);

    expect(calls.map((c) => c.url)).toEqual([
      "/api/miniapp/support/summary",
      "/api/miniapp/support/tickets",
      "/api/miniapp/support/tickets/a1b2c3d4",
      "/api/miniapp/support/tickets/a1b2c3d4/messages",
    ]);
    for (const call of calls) {
      expect(call.init.method).toBe("GET");
      expect(call.init.body).toBeUndefined();
    }
  });

  it("S26 echoes an opaque cursor and never lets an id escape its path segment", async () => {
    mockFetch(200, { ok: true, items: [], nextCursor: null });
    await fetchSupportTickets("c1.123.abc.sig");
    expect(calls[0].url).toBe("/api/miniapp/support/tickets?cursor=c1.123.abc.sig");

    calls = [];
    mockFetch(200, { ok: true, items: [], nextCursor: null });
    await fetchSupportMessages("../../wallet/transactions", "c2.9.z");
    expect(calls[0].url).not.toContain("../");
    expect(calls[0].url).toContain("?cursor=c2.9.z");
  });

  it("S27 maps every new support code, and collapses one it does not know", async () => {
    for (const code of [
      "TICKET_CLOSED",
      "IDEMPOTENCY_CONFLICT",
      "INVALID_SUBJECT",
      "INVALID_MESSAGE",
      "INVALID_CATEGORY",
      "INVALID_SERVICE",
      "INVALID_REQUEST_ID",
      "TICKET_NOT_FOUND",
      "INVALID_TICKET_ID",
      "UNSUPPORTED_MEDIA_TYPE",
    ]) {
      calls = [];
      mockFetch(409, { ok: false, code });
      const result = await replySupportTicket("a1b2c3d4", {
        message: "x",
        clientRequestId: newClientRequestId(),
      });
      expect(result.ok, code).toBe(false);
      if (!result.ok) {
        expect(result.code, code).toBe(code);
      }
    }

    mockFetch(409, { ok: false, code: "SOME_NEW_SUPPORT_ERROR" });
    const unknown = await replySupportTicket("a1b2c3d4", {
      message: "x",
      clientRequestId: newClientRequestId(),
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.code).toBe("INTERNAL");
    }
  });

  it("S28 never surfaces a server-authored message from a write", async () => {
    mockFetch(409, {
      ok: false,
      code: "TICKET_CLOSED",
      message: "PrismaClientKnownRequestError: ticket 9f2c is closed",
    });
    const result = await replySupportTicket("a1b2c3d4", {
      message: "x",
      clientRequestId: newClientRequestId(),
    });
    expect(JSON.stringify(result)).not.toContain("Prisma");
    expect(JSON.stringify(result)).not.toContain("9f2c");
  });
});

describe("the failure vocabulary is complete", () => {
  it("S29 every server code this client accepts has Persian text", () => {
    // The list is read from the client, not retyped here, so a code added to
    // the client without Persian text fails this rather than a user's screen.
    expect(SERVER_FAILURE_CODES.length).toBeGreaterThan(20);
    for (const code of SERVER_FAILURE_CODES) {
      const text = FAILURE_TEXT[code];
      expect(text, code).toBeTruthy();
      expect(text.title.length, code).toBeGreaterThan(0);
      expect(text.body.length, code).toBeGreaterThan(0);
      expect(text.title, code).toMatch(/[؀-ۿ]/);
      expect(text.body, code).toMatch(/[؀-ۿ]/);
      // A leaked English code is the failure mode this whole scheme exists to
      // avoid: the user reads Persian, the log reads the code.
      expect(text.title, code).not.toContain(code);
      expect(text.body, code).not.toContain(code);
    }
    // Transport codes are client-authored and are not in the server list, so
    // they are checked explicitly rather than assumed.
    for (const code of ["NETWORK", "TIMEOUT", "UNEXPECTED"] as ApiFailureCode[]) {
      expect(FAILURE_TEXT[code].retryable, code).toBe(true);
    }
  });

  it("S30 the conflicts offer no retry, because retrying cannot clear them", () => {
    // A closed ticket and a spent idempotency key are both durable state. A
    // retry button on either is a lie: the same request will fail identically.
    expect(FAILURE_TEXT.TICKET_CLOSED.retryable).toBe(false);
    expect(FAILURE_TEXT.IDEMPOTENCY_CONFLICT.retryable).toBe(false);
    // And neither sends the user to the bot: both are resolved here, by
    // starting a new ticket.
    expect(FAILURE_TEXT.TICKET_CLOSED.action).toBeUndefined();
    expect(FAILURE_TEXT.IDEMPOTENCY_CONFLICT.action).toBeUndefined();
  });

  it("S31 the category codes and labels mirror the shared table", () => {
    // Mirrored from `packages/shared/src/support-tickets-v2.ts`. Written out
    // rather than imported because this bundle depends on nothing from the
    // workspace — which is exactly why it needs pinning.
    expect([...SUPPORT_CATEGORIES]).toEqual([
      "CONNECTION",
      "PAYMENT",
      "SERVICE_MANAGEMENT",
      "ACCOUNT",
      "OTHER",
    ]);
    expect(SUPPORT_CATEGORY_TEXT).toMatchObject({
      CONNECTION: "اتصال",
      PAYMENT: "پرداخت و سفارش",
      SERVICE_MANAGEMENT: "مدیریت سرویس",
      ACCOUNT: "حساب کاربری",
      OTHER: "سایر",
    });
    for (const code of SUPPORT_CATEGORIES) {
      expect(SUPPORT_CATEGORY_TEXT[code], code).toMatch(/[؀-ۿ]/);
    }
  });
});
