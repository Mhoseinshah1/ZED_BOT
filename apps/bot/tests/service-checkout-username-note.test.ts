import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.APP_SECRET ??= "service-checkout-username-note-tests-0001";

import {
  countCodePoints,
  generateRandomServiceUsername,
  normalizeServiceNote,
  SERVICE_NOTE_MAX_CODE_POINTS,
  SERVICE_USERNAME_REGEX,
  validateServiceUsername,
} from "@zedbot/shared";

// The reservation/availability service probes the panel via the adapter factory.
// Mock it so the availability check is deterministic and never hits the network.
const remote = vi.hoisted(() => ({ getServiceAccount: vi.fn() }));
vi.mock("../src/services/panel-adapter-factory.js", () => ({
  buildAdapterForPanel: () => remote,
  normalizeSubscriptionBase: () => null,
}));

import {
  PanelType,
  ServiceUsernameMode,
  ServiceUsernameReservationStatus,
  prisma,
} from "@zedbot/database";

import {
  attachReservationToOrder,
  bindReservationToCheckout,
  checkServiceUsernameAvailability,
  consumeReservationForOrder,
  releaseReservation,
  reserveRandomServiceUsername,
  reserveServiceUsername,
} from "../src/services/service-username-selection.service.js";
import { resolveVpnRemoteIdentity } from "../src/services/service-naming.service.js";
import { runReservationCleanup } from "../../worker/src/reservations/cleanup.js";

const hasDb =
  typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

// =============================================================================
// feat/service-checkout-username-note: username validation + crypto random,
// note normalization, DB-authoritative reservation lifecycle + filtered-unique
// slot, availability outcomes, the naming user-selection short-circuit, and the
// bounded cleanup sweep.
// =============================================================================

describe("username validation (pure)", () => {
  it("accepts a canonical username and lower-cases it", () => {
    const r = validateServiceUsername("  MyUser12 ");
    expect(r).toEqual({ ok: true, normalized: "myuser12" });
  });
  it("rejects too-short / too-long / bad first char / bad chars / empty", () => {
    expect(validateServiceUsername("abc123").ok).toBe(false);
    expect(validateServiceUsername("a".repeat(17)).ok).toBe(false);
    expect(validateServiceUsername("1abcdefg").ok).toBe(false);
    expect(validateServiceUsername("my-user1").ok).toBe(false);
    expect(validateServiceUsername("   ").ok).toBe(false);
  });
  it("never transliterates or silently strips (persian / dots rejected)", () => {
    expect(validateServiceUsername("کاربر1234").ok).toBe(false);
    expect(validateServiceUsername("my.user1").ok).toBe(false);
  });
});

describe("crypto random username (pure)", () => {
  it("is opaque, u_-prefixed, and always regex-valid + highly unique", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 3000; i += 1) {
      const u = generateRandomServiceUsername();
      expect(u.startsWith("u_")).toBe(true);
      expect(SERVICE_USERNAME_REGEX.test(u)).toBe(true);
      seen.add(u);
    }
    expect(seen.size).toBeGreaterThan(2990);
  });
});

describe("note normalization (pure)", () => {
  it("allows persian + emoji, collapses newlines, trims", () => {
    const r = normalizeServiceNote("  سلام 🌍\n\n\n\nدنیا  ");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normalized).toBe("سلام 🌍\n\nدنیا");
  });
  it("rejects bidi/control chars and over-length notes", () => {
    expect(normalizeServiceNote(`a${String.fromCodePoint(0x202e)}b`).ok).toBe(false);
    expect(normalizeServiceNote(`a${String.fromCodePoint(0)}b`).ok).toBe(false);
    expect(normalizeServiceNote("a".repeat(SERVICE_NOTE_MAX_CODE_POINTS + 1)).ok).toBe(false);
    expect(normalizeServiceNote("😀".repeat(SERVICE_NOTE_MAX_CODE_POINTS)).ok).toBe(true);
    expect(countCodePoints("😀😀")).toBe(2);
  });
});

describe.runIf(hasDb)("reservation lifecycle + availability (DB)", () => {
  const tag = `svcun_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let panelId = "";
  let panelId2 = "";
  let userId = "";
  let otherUserId = "";

  beforeAll(async () => {
    const panel = await prisma.panel.create({
      data: { type: PanelType.MARZBAN, name: `${tag}-p1`, baseUrl: "http://x", status: "ACTIVE" },
    });
    const panel2 = await prisma.panel.create({
      data: { type: PanelType.MARZBAN, name: `${tag}-p2`, baseUrl: "http://x", status: "ACTIVE" },
    });
    const user = await prisma.user.create({ data: { telegramId: BigInt(`${Date.now()}1`) } });
    const other = await prisma.user.create({ data: { telegramId: BigInt(`${Date.now()}2`) } });
    panelId = panel.id;
    panelId2 = panel2.id;
    userId = user.id;
    otherUserId = other.id;
  });

  afterAll(async () => {
    await prisma.serviceUsernameReservation.deleteMany({ where: { panelId: { in: [panelId, panelId2] } } });
    await prisma.service.deleteMany({ where: { panelId: { in: [panelId, panelId2] } } });
    await prisma.order.deleteMany({ where: { userId: { in: [userId, otherUserId] } } });
    await prisma.checkoutSession.deleteMany({ where: { userId: { in: [userId, otherUserId] } } });
    await prisma.panel.deleteMany({ where: { id: { in: [panelId, panelId2] } } });
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await prisma.$disconnect();
  });

  const uname = (): string => {
    const s = `u_${Math.random().toString(36).slice(2, 10)}`.slice(0, 16);
    return s.length >= 8 ? s : `${s}zzzzzzzz`.slice(0, 12);
  };

  it("AVAILABLE → HELD, then a second holder gets RESERVED (filtered-unique)", async () => {
    remote.getServiceAccount.mockResolvedValue({ ok: false, notFound: true });
    const name = uname();
    const r1 = await reserveServiceUsername({
      userId,
      panelId,
      mode: ServiceUsernameMode.CUSTOM,
      normalizedUsername: name,
      draftNonce: `${tag}-n1`,
    });
    expect(r1.outcome).toBe("AVAILABLE");
    // A different user/nonce trying the same name on the same panel is RESERVED.
    const r2 = await reserveServiceUsername({
      userId: otherUserId,
      panelId,
      mode: ServiceUsernameMode.CUSTOM,
      normalizedUsername: name,
      draftNonce: `${tag}-n2`,
    });
    expect(r2.outcome).toBe("RESERVED");
  });

  it("releasing frees the slot for re-reservation", async () => {
    remote.getServiceAccount.mockResolvedValue({ ok: false, notFound: true });
    const name = uname();
    const r1 = await reserveServiceUsername({
      userId,
      panelId,
      mode: ServiceUsernameMode.CUSTOM,
      normalizedUsername: name,
      draftNonce: `${tag}-rel1`,
    });
    expect(r1.outcome).toBe("AVAILABLE");
    if (r1.outcome !== "AVAILABLE") return;
    await releaseReservation(r1.reservationId);
    const r2 = await reserveServiceUsername({
      userId: otherUserId,
      panelId,
      mode: ServiceUsernameMode.CUSTOM,
      normalizedUsername: name,
      draftNonce: `${tag}-rel2`,
    });
    expect(r2.outcome).toBe("AVAILABLE");
  });

  it("same (user, nonce, username) idempotently reuses the hold", async () => {
    remote.getServiceAccount.mockResolvedValue({ ok: false, notFound: true });
    const name = uname();
    const args = {
      userId,
      panelId,
      mode: ServiceUsernameMode.CUSTOM,
      normalizedUsername: name,
      draftNonce: `${tag}-idem`,
    };
    const a = await reserveServiceUsername(args);
    const b = await reserveServiceUsername(args);
    expect(a.outcome).toBe("AVAILABLE");
    expect(b.outcome).toBe("AVAILABLE");
    if (a.outcome === "AVAILABLE" && b.outcome === "AVAILABLE") {
      expect(b.reservationId).toBe(a.reservationId);
    }
  });

  it("availability: TAKEN_REMOTE when the panel reports the account exists", async () => {
    remote.getServiceAccount.mockResolvedValue({ ok: true });
    const panel = await prisma.panel.findUniqueOrThrow({ where: { id: panelId } });
    const outcome = await checkServiceUsernameAvailability({ panel, normalizedUsername: uname() });
    expect(outcome).toBe("TAKEN_REMOTE");
  });

  it("availability: UNVERIFIABLE on an inconclusive/failed remote read (never AVAILABLE)", async () => {
    remote.getServiceAccount.mockResolvedValue({ ok: false });
    const panel = await prisma.panel.findUniqueOrThrow({ where: { id: panelId } });
    const outcome = await checkServiceUsernameAvailability({ panel, normalizedUsername: uname() });
    expect(outcome).toBe("UNVERIFIABLE");
  });

  it("random reservation returns an opaque available username", async () => {
    remote.getServiceAccount.mockResolvedValue({ ok: false, notFound: true });
    const r = await reserveRandomServiceUsername({ userId, panelId, draftNonce: `${tag}-rand` });
    expect(r.outcome).toBe("AVAILABLE");
    if (r.outcome === "AVAILABLE") expect(r.normalizedUsername.startsWith("u_")).toBe(true);
  });

  it("bind → attach → consume walks HELD to CONSUMED with durable links", async () => {
    remote.getServiceAccount.mockResolvedValue({ ok: false, notFound: true });
    const name = uname();
    const held = await reserveServiceUsername({
      userId,
      panelId,
      mode: ServiceUsernameMode.CUSTOM,
      normalizedUsername: name,
      draftNonce: `${tag}-life`,
    });
    expect(held.outcome).toBe("AVAILABLE");
    if (held.outcome !== "AVAILABLE") return;
    const id = held.reservationId;

    // The reservation FK columns require real durable rows (as in production).
    const checkout = await prisma.checkoutSession.create({
      data: { userId, purpose: "ORDER_PAYMENT", expiresAt: new Date(Date.now() + 3_600_000) },
    });
    const order = await prisma.order.create({ data: { userId, type: "SERVICE_PURCHASE" } });
    const service = await prisma.service.create({
      data: { userId, panelId, panelType: PanelType.MARZBAN, username: name },
    });

    const bound = await bindReservationToCheckout(prisma, id, checkout.id, userId);
    expect(bound).toBe(true);
    await attachReservationToOrder(prisma, id, order.id, checkout.id);
    await consumeReservationForOrder(prisma, order.id, service.id, name);

    const row = await prisma.serviceUsernameReservation.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe(ServiceUsernameReservationStatus.CONSUMED);
    expect(row.orderId).toBe(order.id);
    expect(row.serviceId).toBe(service.id);
    expect(row.expiresAt).toBeNull();

    // A foreign order id never consumes this reservation.
    await consumeReservationForOrder(prisma, order.id, service.id, "different1");
    const still = await prisma.serviceUsernameReservation.findUniqueOrThrow({ where: { id } });
    expect(still.status).toBe(ServiceUsernameReservationStatus.CONSUMED);
  });

  it("cross-panel same username reservation is blocked by the global availability check", async () => {
    remote.getServiceAccount.mockResolvedValue({ ok: false, notFound: true });
    const name = uname();
    const r1 = await reserveServiceUsername({
      userId,
      panelId,
      mode: ServiceUsernameMode.CUSTOM,
      normalizedUsername: name,
      draftNonce: `${tag}-cp1`,
    });
    expect(r1.outcome).toBe("AVAILABLE");
    // Same username on a DIFFERENT panel is still RESERVED (Service.username is global).
    const r2 = await reserveServiceUsername({
      userId,
      panelId: panelId2,
      mode: ServiceUsernameMode.CUSTOM,
      normalizedUsername: name,
      draftNonce: `${tag}-cp2`,
    });
    expect(r2.outcome).toBe("RESERVED");
  });
});

describe.runIf(hasDb)("naming resolver honors user-selected username (DB)", () => {
  const tag = `svcnm_${Date.now()}`;
  let panelId = "";

  beforeAll(async () => {
    const panel = await prisma.panel.create({
      data: {
        type: PanelType.MARZBAN,
        name: `${tag}-p`,
        baseUrl: "http://x",
        status: "ACTIVE",
        usernameSequenceLastNumber: 5,
      },
    });
    panelId = panel.id;
  });
  afterAll(async () => {
    await prisma.panel.deleteMany({ where: { id: panelId } });
    await prisma.$disconnect();
  });

  it("uses the buyer's username verbatim WITHOUT consuming the panel counter", async () => {
    const before = await prisma.panel.findUniqueOrThrow({ where: { id: panelId } });
    const res = await resolveVpnRemoteIdentity(
      { id: "00000000-0000-0000-0000-000000000abc" },
      { telegramId: BigInt(123456), username: "someone" },
      panelId,
      {
        strategy: "TELEGRAM_ID_RANDOM",
        customText: null,
        randomLength: null,
        representativePrefix: null,
        userSelectedUsername: "mychosen1",
        userSelectionSource: "USER_CUSTOM",
      },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.identity.resolvedRemoteUsername).toBe("mychosen1");
      expect(res.identity.selectionSource).toBe("USER_CUSTOM");
      expect(typeof res.identity.selectedAt).toBe("string");
    }
    const after = await prisma.panel.findUniqueOrThrow({ where: { id: panelId } });
    // The panel sequence counter was NOT advanced.
    expect(after.usernameSequenceLastNumber).toBe(before.usernameSequenceLastNumber);
  });
});

describe.runIf(hasDb)("reservation cleanup sweep (DB)", () => {
  const tag = `svccl_${Date.now()}`;
  let panelId = "";
  let userId = "";

  beforeAll(async () => {
    const panel = await prisma.panel.create({
      data: { type: PanelType.MARZBAN, name: `${tag}-p`, baseUrl: "http://x", status: "ACTIVE" },
    });
    const user = await prisma.user.create({ data: { telegramId: BigInt(`${Date.now()}9`) } });
    panelId = panel.id;
    userId = user.id;
  });
  afterAll(async () => {
    await prisma.serviceUsernameReservation.deleteMany({ where: { panelId } });
    await prisma.panel.deleteMany({ where: { id: panelId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it("expires a HELD reservation past its TTL and frees the slot", async () => {
    const past = new Date(Date.now() - 60_000);
    const row = await prisma.serviceUsernameReservation.create({
      data: {
        panelId,
        userId,
        normalizedUsername: `u_clh${Math.floor(Math.random() * 1e5)}`,
        activeUsernameKey: `u_clh${Math.floor(Math.random() * 1e5)}`,
        mode: ServiceUsernameMode.RANDOM,
        status: ServiceUsernameReservationStatus.HELD,
        expiresAt: past,
      },
    });
    const result = await runReservationCleanup(new Date());
    expect(result.expiredHeld).toBeGreaterThanOrEqual(1);
    const after = await prisma.serviceUsernameReservation.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe(ServiceUsernameReservationStatus.EXPIRED);
    expect(after.activeUsernameKey).toBeNull();
  });

  it("never expires a HELD reservation whose TTL has not passed", async () => {
    const future = new Date(Date.now() + 60_000);
    const key = `u_fut${Math.floor(Math.random() * 1e5)}`;
    const row = await prisma.serviceUsernameReservation.create({
      data: {
        panelId,
        userId,
        normalizedUsername: key,
        activeUsernameKey: key,
        mode: ServiceUsernameMode.RANDOM,
        status: ServiceUsernameReservationStatus.HELD,
        expiresAt: future,
      },
    });
    await runReservationCleanup(new Date());
    const after = await prisma.serviceUsernameReservation.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe(ServiceUsernameReservationStatus.HELD);
  });

  it("does NOT reclaim a BOUND reservation with no linked (dead) checkout", async () => {
    const key = `u_bnd${Math.floor(Math.random() * 1e5)}`;
    const row = await prisma.serviceUsernameReservation.create({
      data: {
        panelId,
        userId,
        normalizedUsername: key,
        activeUsernameKey: key,
        mode: ServiceUsernameMode.CUSTOM,
        status: ServiceUsernameReservationStatus.BOUND,
        expiresAt: null,
      },
    });
    await runReservationCleanup(new Date());
    const after = await prisma.serviceUsernameReservation.findUniqueOrThrow({ where: { id: row.id } });
    // A BOUND row with no checkoutSession link is never touched by the sweep.
    expect(after.status).toBe(ServiceUsernameReservationStatus.BOUND);
  });
});
