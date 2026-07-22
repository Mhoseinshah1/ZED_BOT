import type { SupportMessage, TicketWithMessages, User } from "@zedbot/database";
import { describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "review-fix-secret-review-fix-secret-1";

import { initialSession } from "../src/core/session.js";
import { detailText } from "../src/handlers/admin-support/support-admin.handler.js";
import { supportHandler } from "../src/handlers/user-support/support.handler.js";

// =============================================================================
// Support Tickets V2 — Codex review-fix regressions:
//   (2) the untrusted-file warning shows on admin ticket detail for USER
//       attachments (and only then);
//   (3) service-picker callbacks never hijack an in-progress REPLY flow.
// Pure/near-pure: the picker callbacks return early for a reply draft before
// any DB call, so no database is needed.
// =============================================================================

const NOTICE = "⚠️ فایل غیرقابل‌اعتماد";

function ticketWith(messages: Array<Partial<SupportMessage>>): TicketWithMessages {
  const now = new Date("2026-01-01T00:00:00Z");
  return {
    id: "abcdef12-0000-0000-0000-000000000000",
    userId: "u0000000-0000-0000-0000-000000000000",
    subject: "موضوع",
    status: "WAITING_ADMIN",
    category: "CONNECTION",
    origin: "GENERAL",
    serviceId: null,
    diagnosticSnapshot: null,
    closedAt: null,
    closedByAdminId: null,
    createdAt: now,
    updatedAt: now,
    user: { telegramId: 12345n, username: null } as User,
    service: null,
    messages: messages.map(
      (m, i) =>
        ({
          id: `msg${i}0000-0000-0000-0000-000000000000`,
          ticketId: "abcdef12-0000-0000-0000-000000000000",
          senderType: "USER",
          attachmentType: null,
          fileId: null,
          fileName: null,
          text: "متن",
          ...m,
        }) as SupportMessage,
    ),
  } as unknown as TicketWithMessages;
}

describe("admin detail — untrusted attachment warning (§6)", () => {
  it("renders the warning when a USER message carries an attachment", () => {
    const ticket = ticketWith([{ senderType: "USER", attachmentType: "DOCUMENT", fileId: "F", fileName: "a.pdf" }]);
    expect(detailText(ticket, NOTICE)).toContain(NOTICE);
  });

  it("omits the warning for a text-only ticket", () => {
    const ticket = ticketWith([{ senderType: "USER", text: "سلام" }]);
    expect(detailText(ticket, NOTICE)).not.toContain(NOTICE);
  });

  it("omits the warning when only the ADMIN attached a file (admin uploads are trusted)", () => {
    const ticket = ticketWith([{ senderType: "ADMIN", attachmentType: "PHOTO", fileId: "F" }]);
    expect(detailText(ticket, NOTICE)).not.toContain(NOTICE);
  });
});

describe("service-picker callbacks never hijack a reply flow (§13)", () => {
  interface Cap {
    edits: number;
    session: ReturnType<typeof initialSession>;
  }

  function ctxFor(cap: Cap, data: string) {
    const callbackQuery = { id: "c", data, message: { message_id: 5, chat: { id: 1, type: "private" } } };
    return {
      session: cap.session,
      dbUser: { id: "u1" },
      from: { id: 1, first_name: "T" },
      callbackQuery,
      update: { update_id: 1, callback_query: callbackQuery },
      match: undefined as unknown,
      reply: async () => ({}),
      editMessageText: async () => {
        cap.edits += 1;
        return {};
      },
      answerCallbackQuery: async () => true,
    } as never;
  }

  async function drive(data: string, cap: Cap): Promise<void> {
    await supportHandler.middleware()(ctxFor(cap, data), async () => undefined);
  }

  function replySession() {
    const session = initialSession();
    session.currentFlow = "support:reply";
    session.temp.supportDraft = { ticketId: "abcdef12-0000-0000-0000-000000000000" };
    return session;
  }

  it("svc:link during a reply does not open the picker or change the flow", async () => {
    const cap: Cap = { edits: 0, session: replySession() };
    await drive("user:sup:svc:link", cap);
    expect(cap.edits).toBe(0);
    expect(cap.session.currentFlow).toBe("support:reply");
    expect(cap.session.temp.supportDraft?.ticketId).toBe("abcdef12-0000-0000-0000-000000000000");
    expect(cap.session.temp.supportDraft?.serviceId).toBeUndefined();
  });

  it("svc pagination during a reply is a no-op", async () => {
    const cap: Cap = { edits: 0, session: replySession() };
    await drive("user:sup:svc:2", cap);
    expect(cap.edits).toBe(0);
    expect(cap.session.currentFlow).toBe("support:reply");
  });

  it("svc:pick during a reply never sets serviceId or calls promptSubject", async () => {
    const cap: Cap = { edits: 0, session: replySession() };
    await drive("user:sup:svc:pick:abcdef12", cap);
    expect(cap.edits).toBe(0);
    expect(cap.session.currentFlow).toBe("support:reply");
    expect(cap.session.temp.supportDraft?.serviceId).toBeUndefined();
  });

  it("svc:none during a reply does not clear or convert the reply draft", async () => {
    const cap: Cap = { edits: 0, session: replySession() };
    await drive("user:sup:svc:none", cap);
    expect(cap.edits).toBe(0);
    expect(cap.session.temp.supportDraft?.ticketId).toBe("abcdef12-0000-0000-0000-000000000000");
  });

  it("cat button during a reply never overwrites the draft or advances the flow", async () => {
    const cap: Cap = { edits: 0, session: replySession() };
    await drive("user:sup:cat:p", cap);
    // The reply draft is untouched: no category set, flow stays REPLY, and it
    // never advances to the new-ticket subject step.
    expect(cap.edits).toBe(0);
    expect(cap.session.currentFlow).toBe("support:reply");
    expect(cap.session.temp.supportDraft?.ticketId).toBe("abcdef12-0000-0000-0000-000000000000");
    expect(cap.session.temp.supportDraft?.category).toBeUndefined();
  });
});
