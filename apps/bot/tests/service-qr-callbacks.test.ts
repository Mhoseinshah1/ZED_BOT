import { prisma, type Panel, type Service, type User } from "@zedbot/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "service-qr-callbacks-tests-secret-0123456789";

import { initialSession } from "../src/core/session.js";
import { servicesHandler } from "../src/handlers/user-services/services.handler.js";
import { serviceShortId } from "../src/services/user-services.service.js";
import {
  QR_NO_CONFIGS_TEXT,
  QR_NO_SUBSCRIPTION_TEXT,
  QR_SEND_FAILED_TEXT,
} from "../src/services/qr-delivery.service.js";
import { decodeQrPng } from "./helpers/qr-decode.js";

// =============================================================================
// §3/§4/§5/§8 - the user-service QR callbacks over a real DB. Every route
// re-loads the Service owner-scoped, answers the callback, and delivers QR
// photos fail-soft. A captured fake ctx decodes each sent PNG to prove the EXACT
// raw payload was encoded and that a foreign user can never obtain the QR.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const d = hasDb ? describe : describe.skip;
const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));

interface Photo {
  decoded: string | null;
  caption: string;
  filename: string;
  buttons: string[];
}
interface Captured {
  toasts: Array<string | undefined>;
  replies: string[];
  photos: Photo[];
}

function fakeCtx(data: string, user: User | null, opts: { photoFails?: boolean } = {}) {
  const cap: Captured = { toasts: [], replies: [], photos: [] };
  const callbackQuery = {
    id: "cbq",
    chat_instance: "ci",
    from: { id: 1, is_bot: false, first_name: "T" },
    data,
    message: { message_id: 5, date: 0, chat: { id: 1, type: "private" } },
  };
  const ctx = {
    session: initialSession(),
    dbUser: user,
    from: { id: 1, first_name: "T" },
    callbackQuery,
    update: { update_id: 1, callback_query: callbackQuery },
    match: undefined as unknown,
    reply: async (t: string) => {
      cap.replies.push(t);
      return {};
    },
    editMessageText: async () => ({}),
    answerCallbackQuery: async (p?: { text?: string }) => {
      cap.toasts.push(p?.text);
      return true;
    },
    replyWithPhoto: async (
      photo: { fileData: Buffer; filename: string },
      other?: { caption?: string; reply_markup?: { inline_keyboard: Array<Array<{ text: string }>> } },
    ) => {
      if (opts.photoFails === true) {
        throw new Error("blocked by user");
      }
      cap.photos.push({
        decoded: decodeQrPng(photo.fileData),
        caption: other?.caption ?? "",
        filename: photo.filename,
        buttons: (other?.reply_markup?.inline_keyboard ?? []).flat().map((b) => b.text),
      });
      return {};
    },
  };
  return { ctx: ctx as never, cap };
}

async function run(data: string, user: User | null, opts: { photoFails?: boolean } = {}): Promise<Captured> {
  const { ctx, cap } = fakeCtx(data, user, opts);
  await servicesHandler.middleware()(ctx, async () => undefined);
  return cap;
}

d("user-service QR callbacks", () => {
  let panel: Panel;
  let owner: User;
  let stranger: User;
  let seq = 0;

  beforeAll(async () => {
    panel = await prisma.panel.create({
      data: { type: "MARZBAN", name: `qr-cb-panel-${runTag}`, baseUrl: "https://panel.test", status: "ACTIVE", renewalEnabled: false },
    });
    owner = await prisma.user.create({ data: { telegramId: runTag + 1n } });
    stranger = await prisma.user.create({ data: { telegramId: runTag + 2n } });
  });

  afterAll(async () => {
    await prisma.service.deleteMany({ where: { panelId: panel.id } });
    await prisma.user.deleteMany({ where: { id: { in: [owner.id, stranger.id] } } });
    await prisma.panel.delete({ where: { id: panel.id } });
    await prisma.$disconnect();
  });

  async function makeService(data: Partial<Parameters<typeof prisma.service.create>[0]["data"]> = {}): Promise<Service> {
    seq += 1;
    return prisma.service.create({
      data: {
        userId: owner.id,
        panelId: panel.id,
        panelType: "MARZBAN",
        username: `qr-cb-svc-${runTag}-${seq}`,
        status: "ACTIVE",
        volumeBytes: 0n,
        usedBytes: 0n,
        ...data,
      },
    });
  }

  it("subscription QR: owner gets a photo encoding the EXACT url, with the text-link keyboard", async () => {
    const url = "https://sub.example.com/s?token=SECRET<x>&n=%D8%AA#f";
    const service = await makeService({ subscriptionUrl: url });
    const cap = await run(`user:svc:qr_sub:${serviceShortId(service)}`, owner);
    expect(cap.photos).toHaveLength(1);
    expect(cap.photos[0].decoded).toBe(url); // exact raw string, byte-identical
    expect(cap.photos[0].filename).toBe("subscription-qr.png");
    expect(cap.photos[0].caption).toBe(`کیوآرکد لینک اشتراک\nنام سرویس: ${service.username}`);
    expect(cap.photos[0].buttons).toEqual(["لینک متنی 🔗", "بازگشت به سرویس"]);
    // The caption/filename never contain the raw URL.
    expect(cap.photos[0].caption).not.toContain("SECRET");
    expect(cap.photos[0].filename).not.toContain("SECRET");
  });

  it("subscription QR: a STRANGER cannot obtain another user's QR", async () => {
    const service = await makeService({ subscriptionUrl: "https://sub.example.com/private" });
    const cap = await run(`user:svc:qr_sub:${serviceShortId(service)}`, stranger);
    expect(cap.photos).toHaveLength(0);
    expect(cap.toasts).toContain("مورد یافت نشد.");
  });

  it("subscription QR: a service with no subscriptionUrl answers the safe notice, no photo", async () => {
    const service = await makeService({ subscriptionUrl: null });
    const cap = await run(`user:svc:qr_sub:${serviceShortId(service)}`, owner);
    expect(cap.photos).toHaveLength(0);
    expect(cap.toasts).toContain(QR_NO_SUBSCRIPTION_TEXT);
  });

  it("subscription QR: a Telegram send failure is fail-soft (falls back to the text link)", async () => {
    const service = await makeService({ subscriptionUrl: "https://sub.example.com/s" });
    const cap = await run(`user:svc:qr_sub:${serviceShortId(service)}`, owner, { photoFails: true });
    // No throw; the user is told to use the text link.
    expect(cap.replies).toContain(QR_SEND_FAILED_TEXT);
  });

  it("config QR: one config -> one photo with the back keyboard", async () => {
    const service = await makeService({ configLinks: ["vmess://ONLY<one>"] });
    const cap = await run(`user:svc:qr_configs:${serviceShortId(service)}`, owner);
    expect(cap.photos).toHaveLength(1);
    expect(cap.photos[0].decoded).toBe("vmess://ONLY<one>");
    expect(cap.photos[0].caption).toBe(`کانفیگ 1 از 1\nنام سرویس: ${service.username}`);
    // Additive text-link button (to the copyable configs) + back navigation.
    expect(cap.photos[0].buttons).toEqual(["لینک متنی 📄", "بازگشت به سرویس"]);
  });

  it("config QR: multiple configs -> ordered individual photos + a trailing back message", async () => {
    const links = ["vmess://a", "vless://b", "trojan://c"];
    const service = await makeService({ configLinks: links });
    const cap = await run(`user:svc:qr_configs:${serviceShortId(service)}`, owner);
    expect(cap.photos.map((p) => p.decoded)).toEqual(links); // exact order + exact payloads
    expect(cap.photos.map((p) => p.caption)).toEqual([
      `کانفیگ 1 از 3\nنام سرویس: ${service.username}`,
      `کانفیگ 2 از 3\nنام سرویس: ${service.username}`,
      `کانفیگ 3 از 3\nنام سرویس: ${service.username}`,
    ]);
    expect(cap.replies.some((r) => r.includes("بازگشت") || r.includes("ارسال شد"))).toBe(true);
  });

  it("config QR: more than 10 configs are bounded to 10 with a safe overflow summary", async () => {
    const links = Array.from({ length: 12 }, (_, i) => `vmess://cfg-${i}`);
    const service = await makeService({ configLinks: links });
    const cap = await run(`user:svc:qr_configs:${serviceShortId(service)}`, owner);
    expect(cap.photos).toHaveLength(10);
    expect(cap.photos.map((p) => p.decoded)).toEqual(links.slice(0, 10));
    const summary = cap.replies.join("\n");
    expect(summary).toContain("۱۰ کانفیگ اول به‌صورت QR ارسال شد.");
    expect(summary).toContain("2 کانفیگ دیگر نمایش داده نشد.");
    // The skipped configs are never leaked.
    expect(summary).not.toContain("cfg-10");
    expect(summary).not.toContain("cfg-11");
  });

  it("config QR: a service with no configs answers the safe notice, no photo", async () => {
    const service = await makeService({ configLinks: [] });
    const cap = await run(`user:svc:qr_configs:${serviceShortId(service)}`, owner);
    expect(cap.photos).toHaveLength(0);
    expect(cap.toasts).toContain(QR_NO_CONFIGS_TEXT);
  });

  it("§7: the subscription QR always encodes the CURRENT stored link (never stale after regen)", async () => {
    const service = await makeService({ subscriptionUrl: "https://sub.example.com/OLD-link" });
    const sid = serviceShortId(service);
    const before = await run(`user:svc:qr_sub:${sid}`, owner);
    expect(before.photos[0].decoded).toBe("https://sub.example.com/OLD-link");
    // Simulate a link regeneration that stored a NEW subscription URL.
    await prisma.service.update({ where: { id: service.id }, data: { subscriptionUrl: "https://sub.example.com/NEW-link" } });
    const after = await run(`user:svc:qr_sub:${sid}`, owner);
    expect(after.photos[0].decoded).toBe("https://sub.example.com/NEW-link");
    expect(after.photos[0].decoded).not.toContain("OLD");
  });
});
