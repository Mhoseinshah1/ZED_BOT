// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../src/App";
import { UI } from "../src/i18n";
import {
  SupportNewTicketScreen,
  SupportScreen,
  SupportTicketScreen,
  SupportTicketsScreen,
} from "../src/support";

// =============================================================================
// S1 — the Support Centre, driven for real (S01-S15).
//
// This is the app's ONE write surface, so the properties worth testing are the
// ones that only exist while it is running:
//
//   THE REVIEW STEP IS A GATE, NOT A SUMMARY. Advancing through the wizard must
//   send nothing at all; exactly one request may leave, and only when the
//   confirmation is pressed. A wizard that posted on the way into the review
//   would look identical in a screenshot.
//
//   A RETRY REPLAYS THE KEY. After a failed submit, pressing send again must
//   carry the SAME `clientRequestId`. A fresh key describes a different
//   mutation, so the server's idempotency record would not recognise it and
//   the user would get a second ticket. The assertion is on the bodies of the
//   two requests, because that is the only place the property is visible.
//
//   A CLOSED TICKET LOSES ITS REPLY BOX. `TICKET_CLOSED` is a 409 with a
//   meaning — this conversation is over — and rendering it as a generic error
//   next to a live reply box invites the user to try again forever.
//
//   ATTACHMENTS ARE A HAND-OFF, NOT A FEATURE. An indicator and a way into the
//   bot, and nothing that could download a file: no anchor, no upload input.
//
//   NOTHING IS PERSISTED. Drafts and idempotency keys are support text and a
//   collision-critical token; both stay in memory.
// =============================================================================

interface FakeWebApp {
  initData: string;
  colorScheme: "light" | "dark";
  themeParams: Record<string, string>;
  ready: () => void;
  expand: () => void;
  close?: () => void;
  onEvent?: (event: string, handler: () => void) => void;
  offEvent?: (event: string, handler: () => void) => void;
  openTelegramLink?: (url: string) => void;
}

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

let container: HTMLDivElement;
let root: Root;
let calls: Call[] = [];
let opened: string[] = [];
/** Queued responses, consumed in order; falls back to `route` when empty. */
let queued: Array<{ status: number; body: unknown }> = [];

const SUMMARY = { total: 7, open: 3, waitingUser: 2, closed: 4 };

const TICKET_A = {
  id: "a1b2c3d4",
  subject: "قطع شدن اتصال",
  status: "WAITING_ADMIN",
  category: "CONNECTION",
  origin: "MINIAPP",
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-02T00:00:00.000Z",
};

const TICKET_B = {
  ...TICKET_A,
  id: "b2c3d4e5",
  subject: "پرداخت ناموفق",
  status: "WAITING_USER",
  category: "PAYMENT",
};

const DETAIL_OPEN = {
  ...TICKET_A,
  closedAt: null,
  canReply: true,
  hasAttachments: false,
  serviceId: null,
};

const MESSAGES = [
  {
    key: "m000000000001",
    senderType: "USER",
    text: "سلام، سرویس من وصل نمی‌شود.",
    hasAttachment: false,
    createdAt: "2026-07-01T00:00:00.000Z",
  },
  {
    key: "m000000000002",
    senderType: "ADMIN",
    text: "لطفاً سرور دیگری را امتحان کنید.",
    hasAttachment: false,
    createdAt: "2026-07-02T00:00:00.000Z",
  },
];

/** The default happy-path body for a request, used when nothing is queued. */
function route(url: string, method: string): { status: number; body: unknown } {
  if (url.includes("/support/summary")) {
    return { status: 200, body: { ok: true, summary: SUMMARY } };
  }
  if (url.includes("/messages")) {
    return { status: 200, body: { ok: true, items: MESSAGES, nextCursor: null } };
  }
  if (url.includes("/replies")) {
    return { status: 201, body: { ok: true, ticket: DETAIL_OPEN } };
  }
  // A create is a POST to the collection path a list is GET from, so the
  // method has to be part of the routing or a created ticket comes back as a
  // page of tickets.
  if (url.endsWith("/support/tickets") && method === "POST") {
    return { status: 201, body: { ok: true, ticket: DETAIL_OPEN } };
  }
  if (/\/support\/tickets\/[^/?]+$/.test(url)) {
    return { status: 200, body: { ok: true, ticket: DETAIL_OPEN } };
  }
  if (url.includes("/support/tickets")) {
    return { status: 200, body: { ok: true, items: [TICKET_A, TICKET_B], nextCursor: null } };
  }
  if (url.includes("/wallet/transactions")) {
    return { status: 200, body: { ok: true, balanceToman: 0, items: [], nextCursor: null } };
  }
  if (url.includes("/services")) {
    return { status: 200, body: { ok: true, items: [], nextCursor: null } };
  }
  if (url.includes("/me")) {
    return { status: 200, body: { ok: true, user: {}, services: { active: 0, total: 0 } } };
  }
  if (url.includes("/auth")) {
    return {
      status: 200,
      body: {
        ok: true,
        user: {
          firstName: "زد",
          lastName: null,
          username: "zed",
          status: "ACTIVE",
          group: "F",
          balanceToman: 0,
          joinedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    };
  }
  if (url.includes("/dashboard")) {
    return {
      status: 200,
      body: {
        ok: true,
        serverTimestamp: "2026-07-27T00:00:00.000Z",
        dataFreshnessTimestamp: "2026-07-27T00:00:00.000Z",
        user: {},
        services: { total: 0, byStatus: {}, expiringWithin7Days: 0, recent: [] },
        wallet: { balanceToman: 0, recentTransactions: [] },
      },
    };
  }
  return { status: 200, body: { ok: true } };
}

function setBotUsername(value: string | undefined): void {
  const env = import.meta.env as unknown as Record<string, unknown>;
  if (value === undefined) {
    delete env.VITE_BOT_USERNAME;
  } else {
    env.VITE_BOT_USERNAME = value;
  }
}

const originalUsername = (import.meta.env as unknown as Record<string, unknown>)
  .VITE_BOT_USERNAME as string | undefined;

beforeEach(() => {
  // React 19 refuses to believe an `act()` outside a test runner unless it is
  // told it is in one; without this every state update logs a warning that
  // buries the real output.
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  calls = [];
  opened = [];
  queued = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);

  const app: FakeWebApp = {
    initData: "user=%7B%22id%22%3A1%7D&hash=abc",
    colorScheme: "light",
    themeParams: {},
    ready: () => {},
    expand: () => {},
    onEvent: () => {},
    offEvent: () => {},
    openTelegramLink: (url: string) => opened.push(url),
  };
  (window as unknown as { Telegram?: { WebApp: FakeWebApp } }).Telegram = { WebApp: app };

  setBotUsername("zedbot_public");
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const raw = init?.body;
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : null,
    });
    const answer = queued.shift() ?? route(url, init?.method ?? "GET");
    return Promise.resolve(
      new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  setBotUsername(originalUsername);
  vi.unstubAllGlobals();
  delete (window as unknown as { Telegram?: unknown }).Telegram;
});

/**
 * Renders a screen into a FRESH root.
 *
 * Deliberately not a re-render of the existing one. React reconciles two
 * renders of the same component type in the same position by KEEPING its
 * state, so "mount a second wizard" would silently reuse the first one's
 * idempotency key — and S11, which exists to prove a new submission mints a new
 * key, would pass while asserting the opposite of the truth.
 */
async function mount(node: React.ReactNode): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  await settle();
}

/** Lets the microtask queue drain so a screen reaches its LOADED state. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

function buttons(): HTMLButtonElement[] {
  return [...container.querySelectorAll("button")] as HTMLButtonElement[];
}

function button(label: string): HTMLButtonElement {
  const found = buttons().find((b) => b.textContent === label);
  expect(found, `no button labelled "${label}"`).toBeDefined();
  return found as HTMLButtonElement;
}

async function click(label: string): Promise<void> {
  const target = button(label);
  await act(async () => {
    target.click();
  });
  await settle();
}

async function type(selector: string, value: string): Promise<void> {
  const field = container.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement | null;
  expect(field, `no field matching ${selector}`).not.toBeNull();
  await act(async () => {
    // React tracks the DOM value it last wrote, so a plain assignment is
    // swallowed as "no change". The native setter is what a real keystroke
    // ultimately calls.
    const proto = Object.getPrototypeOf(field) as object;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    setter?.call(field, value);
    field?.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function writes(): Call[] {
  return calls.filter((c) => c.method !== "GET");
}

// --- landing -----------------------------------------------------------------

describe("support landing", () => {
  it("S01 renders the summary counts the server sent", async () => {
    await mount(<SupportScreen onOpenTickets={() => {}} onNewTicket={() => {}} />);

    expect(calls.map((c) => c.url)).toEqual(["/api/miniapp/support/summary"]);
    // Persian digits, because the rest of the product is Persian.
    expect(container.textContent).toContain("۷");
    expect(container.textContent).toContain("۳");
    expect(container.textContent).toContain("۴");
    expect(container.textContent).toContain(UI.supportTicketsTotal);
    expect(container.textContent).toContain(UI.supportTicketsWaitingUser);
    // Both ways forward are on the landing screen.
    expect(buttons().map((b) => b.textContent)).toContain(UI.supportNewTicket);
    expect(buttons().map((b) => b.textContent)).toContain(UI.supportOpenList);
  });

  it("S02 shows the shared failure screen when the summary cannot be read", async () => {
    queued = [{ status: 503, body: { ok: false, code: "INTERNAL" } }];
    await mount(<SupportScreen onOpenTickets={() => {}} onNewTicket={() => {}} />);
    expect(container.textContent).toContain("خطای سرور");
    // A read that failed is retryable, and nothing was written on the way.
    expect(writes()).toEqual([]);
  });
});

// --- list --------------------------------------------------------------------

describe("ticket list", () => {
  it("S03 renders a row per ticket with subject, status and category", async () => {
    await mount(<SupportTicketsScreen onOpenTicket={() => {}} onNewTicket={() => {}} />);

    expect(container.textContent).toContain(TICKET_A.subject);
    expect(container.textContent).toContain(TICKET_B.subject);
    expect(container.textContent).toContain("در انتظار پشتیبانی");
    expect(container.textContent).toContain("در انتظار پاسخ شما");
    expect(container.textContent).toContain("اتصال");
    expect(container.textContent).toContain("پرداخت و سفارش");
  });

  it("S04 pages with the server's cursor and appends, never refetches page one", async () => {
    queued = [
      { status: 200, body: { ok: true, items: [TICKET_A], nextCursor: "cursor-page-2" } },
      { status: 200, body: { ok: true, items: [TICKET_B], nextCursor: null } },
    ];
    await mount(<SupportTicketsScreen onOpenTicket={() => {}} onNewTicket={() => {}} />);

    expect(calls[0].url).toBe("/api/miniapp/support/tickets");
    expect(container.textContent).toContain(TICKET_A.subject);
    expect(container.textContent).not.toContain(TICKET_B.subject);

    await click(UI.loadMore);

    // The cursor is echoed, never built.
    expect(calls[1].url).toBe("/api/miniapp/support/tickets?cursor=cursor-page-2");
    expect(container.textContent).toContain(TICKET_A.subject);
    expect(container.textContent).toContain(TICKET_B.subject);
    // The last page has no cursor, so the control goes away rather than
    // offering a request that would return the same rows again.
    expect(buttons().map((b) => b.textContent)).not.toContain(UI.loadMore);
    expect(calls).toHaveLength(2);
  });

  it("S05 opens a ticket by its public id, never a uuid", async () => {
    const requested: string[] = [];
    await mount(
      <SupportTicketsScreen onOpenTicket={(id) => requested.push(id)} onNewTicket={() => {}} />,
    );
    const row = buttons().find((b) => b.textContent?.includes(TICKET_A.subject));
    await act(async () => {
      row?.click();
    });
    expect(requested).toEqual(["a1b2c3d4"]);
    // Eight hex characters — the same public id the bot shows, never a uuid.
    expect(requested[0]).toMatch(/^[0-9a-f]{8}$/);
  });
});

// --- the wizard --------------------------------------------------------------

/** Walks the wizard as far as the review step, sending nothing. */
async function fillWizard(subject: string, message: string): Promise<void> {
  await click("اتصال");
  await type("#support-subject", subject);
  await click(UI.supportNext);
  await type("#support-message", message);
  await click(UI.supportNext);
}

describe("new-ticket wizard", () => {
  it("S06 shows exactly what will be sent, and has sent nothing yet", async () => {
    await mount(<SupportNewTicketScreen onCreated={() => {}} onCancel={() => {}} />);
    await fillWizard("قطع شدن اتصال", "از دیروز به هیچ سروری وصل نمی‌شوم.");

    expect(container.textContent).toContain(UI.supportStepReview);
    expect(container.textContent).toContain(UI.supportReviewLead);
    // The three values, verbatim.
    expect(container.textContent).toContain("اتصال");
    expect(container.textContent).toContain("قطع شدن اتصال");
    expect(container.textContent).toContain("از دیروز به هیچ سروری وصل نمی‌شوم.");
    // The whole point: reaching the review step is not submitting.
    expect(calls).toEqual([]);
  });

  it("S07 submits once, only on the explicit confirmation", async () => {
    let created: string | null = null;
    queued = [{ status: 201, body: { ok: true, ticket: { ...DETAIL_OPEN, id: "9f8e7d6c" } } }];
    await mount(<SupportNewTicketScreen onCreated={(id) => (created = id)} onCancel={() => {}} />);
    await fillWizard("قطع شدن اتصال", "توضیح مشکل.");
    expect(calls).toEqual([]);

    await click(UI.supportConfirmSend);

    expect(writes()).toHaveLength(1);
    const body = writes()[0].body as Record<string, unknown>;
    expect(writes()[0].url).toBe("/api/miniapp/support/tickets");
    expect(body.category).toBe("CONNECTION");
    expect(body.subject).toBe("قطع شدن اتصال");
    expect(body.message).toBe("توضیح مشکل.");
    expect(String(body.clientRequestId)).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    // `origin` is forced by the server; the client must not claim one.
    expect(body.origin).toBeUndefined();
    expect(created).toBe("9f8e7d6c");
  });

  it("S08 refuses a too-short subject locally, without a round trip", async () => {
    await mount(<SupportNewTicketScreen onCreated={() => {}} onCancel={() => {}} />);
    await click("اتصال");
    await type("#support-subject", "ab");
    await click(UI.supportNext);

    expect(container.textContent).toContain(UI.supportSubjectTooShort);
    // Still on the subject step, and the network was never touched.
    expect(container.textContent).toContain(UI.supportStepSubject);
    expect(calls).toEqual([]);
  });

  it("S09 refuses an empty message locally", async () => {
    await mount(<SupportNewTicketScreen onCreated={() => {}} onCancel={() => {}} />);
    await click("اتصال");
    await type("#support-subject", "یک موضوع معتبر");
    await click(UI.supportNext);
    await type("#support-message", "   ");
    await click(UI.supportNext);

    expect(container.textContent).toContain(UI.supportMessageTooShort);
    expect(container.textContent).toContain(UI.supportStepMessage);
    expect(calls).toEqual([]);
  });

  // S10 — the property this whole scheme exists for.
  it("S10 a retry after a failed submit replays the SAME clientRequestId", async () => {
    queued = [
      { status: 503, body: { ok: false, code: "INTERNAL" } },
      { status: 201, body: { ok: true, ticket: DETAIL_OPEN } },
    ];
    await mount(<SupportNewTicketScreen onCreated={() => {}} onCancel={() => {}} />);
    await fillWizard("قطع شدن اتصال", "توضیح مشکل.");

    await click(UI.supportConfirmSend);
    expect(writes()).toHaveLength(1);
    expect(container.textContent).toContain("خطای سرور");

    // The button now offers a retry rather than a first send.
    await click(UI.supportRetrySend);

    expect(writes()).toHaveLength(2);
    const first = writes()[0].body as Record<string, unknown>;
    const second = writes()[1].body as Record<string, unknown>;
    // A fresh key would describe a different mutation, so the server's
    // idempotency record would not recognise the replay and the user would end
    // up with two tickets.
    expect(second.clientRequestId).toBe(first.clientRequestId);
    // And the payload itself is unchanged — same key, same content.
    expect(second.subject).toBe(first.subject);
    expect(second.message).toBe(first.message);
    expect(second.category).toBe(first.category);
  });

  it("S11 a genuinely new ticket mints a new key", async () => {
    queued = [
      { status: 201, body: { ok: true, ticket: DETAIL_OPEN } },
      { status: 201, body: { ok: true, ticket: DETAIL_OPEN } },
    ];
    await mount(<SupportNewTicketScreen onCreated={() => {}} onCancel={() => {}} />);
    await fillWizard("موضوع نخست", "پیام نخست.");
    await click(UI.supportConfirmSend);

    // A second wizard is a second submission, so it must not reuse the key of
    // the one that already succeeded — the server would replay the first
    // ticket instead of opening a new one.
    await mount(<SupportNewTicketScreen onCreated={() => {}} onCancel={() => {}} />);
    await fillWizard("موضوع دوم", "پیام دوم.");
    await click(UI.supportConfirmSend);

    expect(writes()).toHaveLength(2);
    const first = writes()[0].body as Record<string, unknown>;
    const second = writes()[1].body as Record<string, unknown>;
    expect(second.clientRequestId).not.toBe(first.clientRequestId);
  });
});

// --- ticket detail -----------------------------------------------------------

describe("ticket detail", () => {
  it("S12 renders the thread oldest-first and pages backwards for older messages", async () => {
    const older = {
      key: "m000000000000",
      senderType: "USER",
      text: "پیام قدیمی‌تر",
      hasAttachment: false,
      createdAt: "2026-06-30T00:00:00.000Z",
    };
    queued = [
      { status: 200, body: { ok: true, ticket: DETAIL_OPEN } },
      { status: 200, body: { ok: true, items: MESSAGES, nextCursor: "older-cursor" } },
      { status: 200, body: { ok: true, items: [older], nextCursor: null } },
    ];
    await mount(<SupportTicketScreen ticketId="a1b2c3d4" />);

    const texts = [...container.querySelectorAll(".message__text")].map((n) => n.textContent);
    expect(texts).toEqual([MESSAGES[0].text, MESSAGES[1].text]);

    await click(UI.supportLoadOlder);

    expect(calls[2].url).toBe("/api/miniapp/support/tickets/a1b2c3d4/messages?cursor=older-cursor");
    // Prepended, not appended: the cursor walks backwards, so the new page is
    // older than everything already on screen.
    const after = [...container.querySelectorAll(".message__text")].map((n) => n.textContent);
    expect(after).toEqual([older.text, MESSAGES[0].text, MESSAGES[1].text]);
  });

  it("S13 offers the reply box only while the server says canReply", async () => {
    await mount(<SupportTicketScreen ticketId="a1b2c3d4" />);
    expect(container.querySelector("#support-reply")).not.toBeNull();

    queued = [
      { status: 200, body: { ok: true, ticket: { ...DETAIL_OPEN, status: "CLOSED", canReply: false, closedAt: "2026-07-03T00:00:00.000Z" } } },
    ];
    await mount(<SupportTicketScreen ticketId="a1b2c3d4" />);
    expect(container.querySelector("#support-reply")).toBeNull();
    expect(container.textContent).toContain(UI.supportClosedNotice);
  });

  // S14 — a 409 with a meaning, rendered as that meaning.
  it("S14 TICKET_CLOSED removes the reply box and says why", async () => {
    await mount(<SupportTicketScreen ticketId="a1b2c3d4" />);
    expect(container.querySelector("#support-reply")).not.toBeNull();

    queued = [
      { status: 409, body: { ok: false, code: "TICKET_CLOSED" } },
      // The refetch the screen issues to reconcile the rest of its state.
      { status: 200, body: { ok: true, ticket: { ...DETAIL_OPEN, status: "CLOSED", canReply: false } } },
      { status: 200, body: { ok: true, items: MESSAGES, nextCursor: null } },
    ];
    await type("#support-reply", "یک پاسخ تازه");
    await click(UI.supportReplySend);

    // Not a generic error: the specific Persian text for this conflict.
    expect(container.textContent).toContain("این تیکت بسته شده است");
    // And the box is gone, so there is nothing left to keep pressing.
    expect(container.querySelector("#support-reply")).toBeNull();
    expect(container.textContent).toContain(UI.supportClosedNotice);
    expect(buttons().map((b) => b.textContent)).not.toContain(UI.supportReplySend);
  });

  it("S14b a stale read that still says canReply does not bring the box back", async () => {
    await mount(<SupportTicketScreen ticketId="a1b2c3d4" />);
    expect(container.querySelector("#support-reply")).not.toBeNull();

    // A reply that SUCCEEDED first, so the screen is holding a fresher copy of
    // the ticket. The close below has to outrank it.
    await type("#support-reply", "پاسخ نخست");
    await click(UI.supportReplySend);
    expect(container.querySelector("#support-reply")).not.toBeNull();

    queued = [
      { status: 409, body: { ok: false, code: "TICKET_CLOSED" } },
      // A lagging replica, a cached read, an older API build — whatever the
      // cause, this read disagrees with the 409 the server just sent. The 409
      // is the more recent fact and it wins: re-offering a reply box here
      // would invite the user to send into a closed ticket forever.
      { status: 200, body: { ok: true, ticket: DETAIL_OPEN } },
    ];
    await type("#support-reply", "یک پاسخ تازه");
    await click(UI.supportReplySend);

    expect(container.querySelector("#support-reply")).toBeNull();
    expect(container.textContent).toContain(UI.supportClosedNotice);
  });

  it("S14c the close reconciles the rest of the screen, not just the reply box", async () => {
    await mount(<SupportTicketScreen ticketId="a1b2c3d4" />);

    // A successful reply first: the screen is now holding the ticket copy that
    // reply returned, which still reads WAITING_ADMIN.
    await type("#support-reply", "پاسخ نخست");
    await click(UI.supportReplySend);
    expect(container.querySelector(".badge")?.textContent).toBe("در انتظار پشتیبانی");

    queued = [
      { status: 409, body: { ok: false, code: "TICKET_CLOSED" } },
      {
        status: 200,
        body: {
          ok: true,
          ticket: {
            ...DETAIL_OPEN,
            status: "CLOSED",
            canReply: false,
            closedAt: "2026-07-03T00:00:00.000Z",
          },
        },
      },
      { status: 200, body: { ok: true, items: MESSAGES, nextCursor: null } },
    ];
    await type("#support-reply", "پاسخ دوم");
    await click(UI.supportReplySend);

    // The header must not still say the ticket is waiting on support: that
    // copy is older than the 409, so it has to lose to the reconciling read.
    expect(container.querySelector(".badge")?.textContent).toBe("بسته‌شده");
    expect(container.textContent).toContain(UI.supportClosedAt);
  });

  it("S15 a failed reply retried replays the same clientRequestId", async () => {
    await mount(<SupportTicketScreen ticketId="a1b2c3d4" />);

    queued = [{ status: 503, body: { ok: false, code: "INTERNAL" } }];
    await type("#support-reply", "یک پاسخ تازه");
    await click(UI.supportReplySend);
    expect(writes()).toHaveLength(1);

    queued = [
      { status: 201, body: { ok: true, ticket: DETAIL_OPEN } },
      { status: 200, body: { ok: true, items: MESSAGES, nextCursor: null } },
    ];
    await click(UI.supportReplyRetry);

    expect(writes()).toHaveLength(2);
    const first = writes()[0].body as Record<string, unknown>;
    const second = writes()[1].body as Record<string, unknown>;
    expect(second.clientRequestId).toBe(first.clientRequestId);
    expect(second.message).toBe("یک پاسخ تازه");
    expect(writes()[1].url).toBe("/api/miniapp/support/tickets/a1b2c3d4/replies");
  });

  // S16 — text only, and it stays that way.
  it("S16 an attachment is an indicator and a hand-off, never a download", async () => {
    queued = [
      { status: 200, body: { ok: true, ticket: { ...DETAIL_OPEN, hasAttachments: true } } },
      {
        status: 200,
        body: {
          ok: true,
          items: [{ ...MESSAGES[0], hasAttachment: true }],
          nextCursor: null,
        },
      },
    ];
    await mount(<SupportTicketScreen ticketId="a1b2c3d4" />);

    expect(container.textContent).toContain(UI.supportAttachmentsTitle);
    expect(container.textContent).toContain(UI.supportMessageHasAttachment);

    // No anchor at all, so nothing can be a download or an outbound link, and
    // no upload control either.
    expect(container.querySelectorAll("a")).toHaveLength(0);
    expect(container.querySelectorAll("input[type=file]")).toHaveLength(0);
    expect(container.querySelectorAll("[download]")).toHaveLength(0);
    expect(container.querySelectorAll("img")).toHaveLength(0);
    // And nothing asked the API for a file either — there is no such route,
    // and this screen must never be the reason one gets added.
    for (const call of calls) {
      expect(call.url, call.url).not.toMatch(/attachment|download|file/i);
    }

    // The hand-off opens the configured bot and nothing else.
    await click(UI.supportAttachmentsAction);
    expect(opened).toEqual(["https://t.me/zedbot_public"]);
    expect(new URL(opened[0]).search).toBe("");
    // Opening the bot issued no request of its own.
    expect(writes()).toEqual([]);
  });

  it("S17 explains itself when no bot handle is configured", async () => {
    setBotUsername(undefined);
    queued = [
      { status: 200, body: { ok: true, ticket: { ...DETAIL_OPEN, hasAttachments: true } } },
      { status: 200, body: { ok: true, items: MESSAGES, nextCursor: null } },
    ];
    await mount(<SupportTicketScreen ticketId="a1b2c3d4" />);

    expect(container.textContent).toContain(UI.supportAttachmentsTitle);
    // A dead button reads as a broken app; an explanation reads as an
    // unconfigured one, which is what it is.
    expect(buttons().map((b) => b.textContent)).not.toContain(UI.supportAttachmentsAction);
    expect(container.textContent).toContain(UI.botActionsUnavailable);
    expect(container.querySelectorAll("a")).toHaveLength(0);
  });
});

// --- the shell ---------------------------------------------------------------

describe("support in the shell", () => {
  it("S18 the tab bar carries the Support tab and routes to the centre", async () => {
    await mount(<App />);
    expect(buttons().map((b) => b.textContent)).toContain(UI.navSupport);

    await click(UI.navSupport);

    expect(container.textContent).toContain(UI.supportTitle);
    expect(container.textContent).toContain(UI.supportNewTicket);
    expect(calls.some((c) => c.url.endsWith("/support/summary"))).toBe(true);
  });

  it("S19 leaving the Support tab discards where it was", async () => {
    await mount(<App />);
    await click(UI.navSupport);
    await click(UI.supportOpenList);
    expect(container.textContent).toContain(UI.supportListTitle);

    await click(UI.navWallet);
    await click(UI.navSupport);
    // Back to the landing view, not to the list it was left on — and certainly
    // not to a half-finished draft.
    expect(container.textContent).toContain(UI.supportTicketsTotal);
  });
});

// --- persistence -------------------------------------------------------------

describe("no browser storage", () => {
  it("S20 nothing about a ticket, a draft or a key is ever persisted", async () => {
    const localSet = vi.fn();
    const sessionSet = vi.fn();
    const localGet = vi.fn(() => null);
    const sessionGet = vi.fn(() => null);
    vi.stubGlobal("localStorage", {
      setItem: localSet,
      getItem: localGet,
      removeItem: vi.fn(),
      clear: vi.fn(),
    });
    vi.stubGlobal("sessionStorage", {
      setItem: sessionSet,
      getItem: sessionGet,
      removeItem: vi.fn(),
      clear: vi.fn(),
    });
    // `indexedDB` and `document.cookie` are the other two ways to persist.
    const openDb = vi.fn();
    vi.stubGlobal("indexedDB", { open: openDb, deleteDatabase: vi.fn() });
    const cookieWrites: string[] = [];
    Object.defineProperty(document, "cookie", {
      configurable: true,
      get: () => "",
      set: (value: string) => cookieWrites.push(value),
    });

    // Drive the whole surface: landing, list, a wizard through submission, and
    // a ticket thread with a reply.
    await mount(<SupportScreen onOpenTickets={() => {}} onNewTicket={() => {}} />);
    await mount(<SupportTicketsScreen onOpenTicket={() => {}} onNewTicket={() => {}} />);
    await mount(<SupportNewTicketScreen onCreated={() => {}} onCancel={() => {}} />);
    await fillWizard("موضوع", "پیام آزمایشی.");
    await click(UI.supportConfirmSend);
    await mount(<SupportTicketScreen ticketId="a1b2c3d4" />);
    await type("#support-reply", "پاسخ آزمایشی");
    await click(UI.supportReplySend);

    // A draft is a user's support text and an idempotency key is a
    // collision-critical token. Neither belongs anywhere a script can read it
    // after the page is gone.
    expect(localSet).not.toHaveBeenCalled();
    expect(sessionSet).not.toHaveBeenCalled();
    expect(localGet).not.toHaveBeenCalled();
    expect(sessionGet).not.toHaveBeenCalled();
    expect(openDb).not.toHaveBeenCalled();
    expect(cookieWrites).toEqual([]);
  });
});
