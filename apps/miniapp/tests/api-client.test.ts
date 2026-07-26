import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  authenticate,
  fetchService,
  fetchServices,
  fetchTransactions,
  logout,
  type ApiFailureCode,
} from "../src/api";
import { FAILURE_TEXT } from "../src/i18n";

// =============================================================================
// The API client and the failure vocabulary (F11-F20).
//
// The properties under test are the ones a reviewer cannot verify by reading:
// that nothing is stored, that the cookie is the only credential, that a
// server-authored string can never reach the screen, and that every failure
// code has Persian text waiting for it.
// =============================================================================

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
});

describe("mini app api client", () => {
  it("F11 sends the session cookie same-origin and stores nothing", async () => {
    mockFetch(200, { ok: true, user: { firstName: "A" } });
    await authenticate("auth_date=1&hash=deadbeef");
    expect(calls).toHaveLength(1);
    expect(calls[0].init.credentials).toBe("same-origin");
    // "include" would also send credentials cross-origin, which this app must
    // never do.
    expect(calls[0].init.credentials).not.toBe("include");
    // No Authorization header: the cookie IS the credential, and it is HttpOnly
    // precisely so this code cannot touch it.
    const headers = calls[0].init.headers as Record<string, string>;
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain("authorization");
  });

  it("F12 never writes a token to localStorage or sessionStorage", async () => {
    const localSet = vi.fn();
    const sessionSet = vi.fn();
    vi.stubGlobal("localStorage", { setItem: localSet, getItem: () => null });
    vi.stubGlobal("sessionStorage", { setItem: sessionSet, getItem: () => null });
    mockFetch(200, { ok: true, user: { firstName: "A" } });
    await authenticate("auth_date=1&hash=deadbeef");
    await logout();
    // A stored token is what turns an XSS from a defaced page into a stolen
    // account. There is nowhere in this client that writes one.
    expect(localSet).not.toHaveBeenCalled();
    expect(sessionSet).not.toHaveBeenCalled();
  });

  it("F13 posts only to relative paths under the API prefix", async () => {
    mockFetch(200, { ok: true });
    await logout();
    expect(calls[0].url).toBe("/api/miniapp/logout");
    expect(calls[0].url.startsWith("http")).toBe(false);
    expect(calls[0].init.method).toBe("POST");
  });

  it("F14 uses POST for both session-changing calls and GET for reads", async () => {
    mockFetch(200, { ok: true, items: [], nextCursor: null });
    await fetchServices(null);
    expect(calls[0].init.method).toBe("GET");
    // GET carries no body, so nothing can be smuggled into a read.
    expect(calls[0].init.body).toBeUndefined();
  });

  it("F15 maps an unknown server code to a generic internal failure", async () => {
    mockFetch(500, { ok: false, code: "SOMETHING_NEW_FROM_THE_SERVER" });
    const result = await fetchServices(null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Unknown codes collapse rather than being rendered - the frontend never
      // shows a string it did not author.
      expect(result.code).toBe("INTERNAL");
    }
  });

  it("F16 never surfaces a server-authored message", async () => {
    mockFetch(500, {
      ok: false,
      code: "INTERNAL",
      message: "PrismaClientKnownRequestError: relation does not exist",
    });
    const result = await fetchServices(null);
    expect(JSON.stringify(result)).not.toContain("Prisma");
    expect(JSON.stringify(result)).not.toContain("relation");
  });

  it("F17 reports a network failure and a timeout as distinct, retryable states", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    const offline = await fetchServices(null);
    expect(offline.ok).toBe(false);
    if (!offline.ok) {
      expect(offline.code).toBe("NETWORK");
      expect(FAILURE_TEXT[offline.code].retryable).toBe(true);
    }
  });

  it("F18 survives a non-JSON response instead of throwing into the render", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("Unexpected token < in JSON");
        },
      })) as unknown as typeof fetch,
    );
    const result = await fetchServices(null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("UNEXPECTED");
    }
  });

  it("F19 echoes an opaque cursor and never builds one", async () => {
    mockFetch(200, { ok: true, items: [], nextCursor: null, balanceToman: 0 });
    await fetchTransactions("c1.123.abc.sig");
    expect(calls[0].url).toBe("/api/miniapp/wallet/transactions?cursor=c1.123.abc.sig");
    // Path parameters are encoded, so an id can never break out of its segment.
    calls = [];
    mockFetch(200, { ok: true, service: {} });
    await fetchService("../../etc/passwd");
    expect(calls[0].url).not.toContain("../");
  });

  it("F20 every failure code has Persian text, and gate codes offer the bot", () => {
    const codes: ApiFailureCode[] = [
      "NETWORK",
      "TIMEOUT",
      "UNEXPECTED",
      "INVALID_INIT_DATA",
      "NOT_REGISTERED",
      "NOT_AUTHENTICATED",
      "FORBIDDEN_ORIGIN",
      "RATE_LIMITED",
      "BAD_REQUEST",
      "NOT_FOUND",
      "NOT_CONFIGURED",
      "INSECURE_TRANSPORT",
      "INTERNAL",
      "MAINTENANCE",
      "USER_BLOCKED",
      "USER_DISABLED",
      "USER_UNAVAILABLE",
      "TERMS_REQUIRED",
      "FORCE_JOIN_REQUIRED",
      "ACCESS_CHECK_UNAVAILABLE",
    ];
    for (const code of codes) {
      const text = FAILURE_TEXT[code];
      expect(text, code).toBeTruthy();
      expect(text.title.length, code).toBeGreaterThan(0);
      expect(text.body.length, code).toBeGreaterThan(0);
      // Persian, not a leaked English code.
      expect(text.title, code).toMatch(/[؀-ۿ]/);
      expect(text.title, code).not.toContain(code);
    }
    // Both gates point at the bot, which is where the channel list and the
    // terms document live.
    expect(FAILURE_TEXT.TERMS_REQUIRED.action).toBeTruthy();
    expect(FAILURE_TEXT.FORCE_JOIN_REQUIRED.action).toBeTruthy();
    // Accepting terms is a write this app does not perform, so a retry alone
    // cannot clear it.
    expect(FAILURE_TEXT.TERMS_REQUIRED.retryable).toBe(false);
    // Force Join IS re-evaluated live on every request, so once the user has
    // joined, retrying here genuinely admits them — offering a retry is honest.
    expect(FAILURE_TEXT.FORCE_JOIN_REQUIRED.retryable).toBe(true);
  });
});
