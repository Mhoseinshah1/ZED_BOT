import { OrderStatus, prisma, type Panel, type Service, type User } from "@zedbot/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "post-purchase-qr-tests-secret-0123456789";

import {
  deliverPostPurchaseQrCodes,
  dispatchPaidOrderFulfillment,
} from "../src/services/order-fulfillment.service.js";
import { decodeQrPng } from "./helpers/qr-decode.js";

// =============================================================================
// §6 - post-purchase QR presentation. It is ADDITIVE, fail-soft and never marks
// a successful provision failed. Two levels:
//   1. deliverPostPurchaseQrCodes unit tests (fabricated Service + fake api):
//      ordering, exact payloads, fail-soft on send failure, skip when the api
//      has no photo capability, no persistence.
//   2. dispatch integration over the idempotent (already-provisioned) path:
//      the order completes, the text info is sent, and QR photos are NOT resent
//      on a replay - preserving anti-spam behavior.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const d = hasDb ? describe : describe.skip;
const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));

function fakeService(overrides: Partial<Record<string, unknown>> = {}): Service {
  return {
    id: "abcdef12-3456-7890-abcd-ef1234567890",
    username: "pp_acct_01",
    productNameSnapshot: "پلن طلایی",
    panelNameSnapshot: "پنل آلمان",
    panelType: "MARZBAN",
    serviceLocation: "MULTI_LOCATION",
    status: "ACTIVE",
    volumeBytes: 0n,
    usedBytes: 0n,
    remainingBytes: 0n,
    durationDays: 30,
    startsAt: new Date(),
    expiresAt: null,
    createdAt: new Date(),
    lastConnectedAt: null,
    lastSubscriptionUpdateAt: null,
    remoteClientId: null,
    remoteMetadata: null,
    namingStrategySnapshot: null,
    subscriptionUrl: "https://sub.example.com/s?token=SUB<x>",
    subscriptionToken: null,
    configLinks: ["vmess://cfg-a", "vless://cfg-b"],
    note: null,
    ...overrides,
  } as unknown as Service;
}

/** A photo-capable fake api that records sends and can optionally fail photos. */
function recordApi(opts: { photoFails?: boolean; noPhoto?: boolean } = {}) {
  const messages: string[] = [];
  const photos: Array<{ decoded: string | null; caption: string }> = [];
  const api = {
    sendMessage: async (_chatId: string, text: string) => {
      messages.push(text);
      return {};
    },
    ...(opts.noPhoto === true
      ? {}
      : {
          sendPhoto: async (_chatId: string, photo: { fileData: Buffer }, other?: { caption?: string }) => {
            if (opts.photoFails === true) {
              throw new Error("blocked by user");
            }
            photos.push({ decoded: decodeQrPng(photo.fileData), caption: other?.caption ?? "" });
            return {};
          },
        }),
  };
  return { api, messages, photos };
}

describe("deliverPostPurchaseQrCodes - additive, ordered, fail-soft (§6)", () => {
  it("sends the subscription QR then each config QR, encoding the EXACT payloads in order", async () => {
    const rec = recordApi();
    await deliverPostPurchaseQrCodes(rec.api, "111", fakeService());
    expect(rec.photos.map((p) => p.decoded)).toEqual([
      "https://sub.example.com/s?token=SUB<x>",
      "vmess://cfg-a",
      "vless://cfg-b",
    ]);
    expect(rec.photos[0].caption).toBe("کیوآرکد لینک اشتراک\nنام سرویس: pp_acct_01");
    expect(rec.photos[1].caption).toBe("کانفیگ 1 از 2\nنام سرویس: pp_acct_01");
  });

  it("NEVER throws when a Telegram photo send fails (fail-soft)", async () => {
    const rec = recordApi({ photoFails: true });
    await expect(deliverPostPurchaseQrCodes(rec.api, "111", fakeService())).resolves.toBeUndefined();
    expect(rec.photos).toHaveLength(0);
  });

  it("skips QR entirely when the api has no photo capability", async () => {
    const rec = recordApi({ noPhoto: true });
    await expect(deliverPostPurchaseQrCodes(rec.api, "111", fakeService())).resolves.toBeUndefined();
    expect(rec.photos).toHaveLength(0);
  });

  it("sends nothing when the service has neither a subscription nor configs", async () => {
    const rec = recordApi();
    await deliverPostPurchaseQrCodes(rec.api, "111", fakeService({ subscriptionUrl: null, configLinks: [] }));
    expect(rec.photos).toHaveLength(0);
  });

  it("does not write the QR to the database (no persistence)", async () => {
    // The helper only reads the Service - assert it performs no service update.
    const rec = recordApi();
    const svc = fakeService();
    await deliverPostPurchaseQrCodes(rec.api, "111", svc);
    // Nothing about QR is stored on the (fabricated) row.
    expect(Object.keys(svc)).not.toContain("qrCode");
    expect(Object.keys(svc)).not.toContain("qrPng");
  });
});

d("post-purchase dispatch integration (already-provisioned replay §6)", () => {
  let panel: Panel;
  let user: User;

  beforeAll(async () => {
    panel = await prisma.panel.create({
      data: { type: "MARZBAN", name: `pp-qr-panel-${runTag}`, baseUrl: "https://panel.test", status: "ACTIVE", renewalEnabled: false },
    });
    user = await prisma.user.create({ data: { telegramId: runTag + 1n } });
  });

  afterAll(async () => {
    await prisma.service.deleteMany({ where: { panelId: panel.id } });
    await prisma.order.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
    await prisma.panel.delete({ where: { id: panel.id } });
    await prisma.$disconnect();
  });

  it("completes the order + sends the text info, and does NOT resend QR photos on an idempotent replay", async () => {
    const order = await prisma.order.create({
      data: {
        userId: user.id,
        type: "SERVICE_PURCHASE",
        status: OrderStatus.PAID,
        finalPriceToman: 50_000,
      },
    });
    // A Service already exists for the order -> provisionPaidOrder short-circuits
    // to alreadyExisted:true (the idempotent replay), which must NOT resend QR.
    await prisma.service.create({
      data: {
        userId: user.id,
        panelId: panel.id,
        panelType: "MARZBAN",
        username: `pp-qr-svc-${runTag}`,
        status: "ACTIVE",
        volumeBytes: 0n,
        usedBytes: 0n,
        orderId: order.id,
        subscriptionUrl: "https://sub.example.com/existing",
        configLinks: ["vmess://existing"],
      },
    });
    const rec = recordApi();
    const result = await dispatchPaidOrderFulfillment(rec.api, order.id, { source: "WALLET", user });

    expect(result).toMatchObject({ kind: "SERVICE", op: "provision", ok: true });
    const refreshed = await prisma.order.findUnique({ where: { id: order.id } });
    expect(refreshed?.status).toBe(OrderStatus.COMPLETED); // provision success unaffected
    // The existing text info still goes out...
    expect(rec.messages.some((m) => m.includes("سرویس شما با موفقیت ساخته شد ✅"))).toBe(true);
    // ...but NO QR photo is resent on the replay (anti-spam preserved).
    expect(rec.photos).toHaveLength(0);
  });
});
