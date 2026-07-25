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
  bindSettledReservationFromSnapshot,
  claimReservationForCheckout,
  checkServiceUsernameAvailability,
  consumeReservationForOrder,
  releaseHeldReservationForDraft,
  releaseReservation,
  reserveRandomServiceUsername,
  reserveServiceUsername,
  ReservationInvariantError,
} from "../src/services/service-username-selection.service.js";
import { resolveVpnRemoteIdentity } from "../src/services/service-naming.service.js";
import {
  coNonce,
  parseCoNonceCallback,
  shortDraftNonce,
} from "../src/handlers/user-checkout/checkout-cb.js";
import {
  fileServiceUsernameUnboundCase,
  hasBlockingServiceUsernameUnboundCase,
} from "../src/services/financial-reconciliation.service.js";
import { abandonCheckoutDraft } from "../src/handlers/user-checkout/checkout-state.js";
import { rebuildDraftForCurrentPanel } from "../src/handlers/user-checkout/checkout.handler.js";
import type { BotContext } from "../src/core/context.js";
import type { CheckoutDraft, ServiceCustomizationDraft } from "../src/core/session.js";
import type { ProductWithRelations } from "../src/services/product.service.js";
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

    const claim = await claimReservationForCheckout(
      prisma,
      {
        reservationId: id,
        userId,
        draftNonce: `${tag}-life`,
        normalizedUsername: name,
        mode: ServiceUsernameMode.CUSTOM,
        panelId,
      },
      checkout.id,
    );
    expect(claim.ok).toBe(true);
    await attachReservationToOrder(prisma, {
      reservationId: id,
      userId,
      checkoutSessionId: checkout.id,
      panelId,
      normalizedUsername: name,
      orderId: order.id,
    });
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

// =============================================================================
// fix/service-username-reservation-safety hotfix invariants.
// =============================================================================

describe("nonce-bound username/note callbacks (pure, §2)", () => {
  it("builds ≤64-byte callbacks that round-trip through the ONE shared parser", () => {
    const nonce = shortDraftNonce("11111111-2222-3333-4444-555555555555");
    expect(nonce).toBe("111111112222");
    const cases: Array<[string, string]> = [
      [coNonce.unCustom(nonce), "un:c"],
      [coNonce.unRandom(nonce), "un:r"],
      [coNonce.unRegen(nonce), "un:g"],
      [coNonce.unMethod(nonce), "un:m"],
      [coNonce.unConfirm(nonce), "un:o"],
      [coNonce.noteSkip(nonce), "nt:s"],
      [coNonce.noteBack(nonce), "nt:b"],
    ];
    for (const [data, action] of cases) {
      expect(Buffer.byteLength(data, "utf8")).toBeLessThanOrEqual(64);
      // No username/note is ever embedded — only the action + hex nonce.
      const parsed = parseCoNonceCallback(data);
      expect(parsed).not.toBeNull();
      expect(parsed?.action).toBe(action);
      expect(parsed?.nonce).toBe(nonce);
    }
  });

  it("rejects a callback whose nonce differs from the current draft (stale keyboard)", () => {
    const current = shortDraftNonce("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    const stale = shortDraftNonce("00000000-0000-0000-0000-000000000000");
    const parsed = parseCoNonceCallback(coNonce.unConfirm(stale));
    expect(parsed).not.toBeNull();
    // The router compares parsed.nonce to the CURRENT draft nonce and fails closed.
    expect(parsed?.nonce).not.toBe(current);
  });

  it("returns null for non-username/note callbacks", () => {
    expect(parseCoNonceCallback("user:co:continue")).toBeNull();
    expect(parseCoNonceCallback("user:co:un:c:")).toBeNull();
    expect(parseCoNonceCallback("user:co:un:z:abcdef")).toBeNull();
  });
});

describe.runIf(hasDb)("authoritative reservation claim + strict order binding (DB, §3/§6)", () => {
  const tag = `svchf_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let panelId = "";
  let panelId2 = "";
  let userId = "";

  beforeAll(async () => {
    const [p1, p2, u] = await Promise.all([
      prisma.panel.create({ data: { type: PanelType.MARZBAN, name: `${tag}-p1`, baseUrl: "http://x", status: "ACTIVE" } }),
      prisma.panel.create({ data: { type: PanelType.MARZBAN, name: `${tag}-p2`, baseUrl: "http://x", status: "ACTIVE" } }),
      prisma.user.create({ data: { telegramId: BigInt(`${Date.now()}7`) } }),
    ]);
    panelId = p1.id;
    panelId2 = p2.id;
    userId = u.id;
    remote.getServiceAccount.mockResolvedValue({ ok: false, notFound: true });
  });
  afterAll(async () => {
    await prisma.serviceUsernameReservation.deleteMany({ where: { panelId: { in: [panelId, panelId2] } } });
    await prisma.financialReconciliationCase.deleteMany({ where: { userId } });
    await prisma.payment.deleteMany({ where: { userId } });
    await prisma.order.deleteMany({ where: { userId } });
    await prisma.checkoutSession.deleteMany({ where: { userId } });
    await prisma.panel.deleteMany({ where: { id: { in: [panelId, panelId2] } } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  const uname = (): string => `u_${Math.random().toString(36).slice(2, 10)}`.slice(0, 16).padEnd(8, "z");
  const newCheckout = async (): Promise<string> => {
    const c = await prisma.checkoutSession.create({
      data: { userId, purpose: "ORDER_PAYMENT", status: "PENDING", expiresAt: new Date(Date.now() + 3_600_000) },
    });
    return c.id;
  };
  const holdUsername = async (name: string, nonce: string): Promise<string> => {
    const held = await reserveServiceUsername({
      userId,
      panelId,
      mode: ServiceUsernameMode.CUSTOM,
      normalizedUsername: name,
      draftNonce: nonce,
    });
    if (held.outcome !== "AVAILABLE") throw new Error(`hold failed: ${held.outcome}`);
    return held.reservationId;
  };

  it("claims a HELD hold once; a second claim (or a claim on a foreign panel/nonce) fails closed", async () => {
    const name = uname();
    const id = await holdUsername(name, `${tag}-c1`);
    const checkoutId = await newCheckout();
    const claim = await claimReservationForCheckout(
      prisma,
      { reservationId: id, userId, draftNonce: `${tag}-c1`, normalizedUsername: name, mode: ServiceUsernameMode.CUSTOM, panelId },
      checkoutId,
    );
    expect(claim.ok).toBe(true);
    // Already BOUND → not claimable again.
    const again = await claimReservationForCheckout(
      prisma,
      { reservationId: id, userId, draftNonce: `${tag}-c1`, normalizedUsername: name, mode: ServiceUsernameMode.CUSTOM, panelId },
      await newCheckout(),
    );
    expect(again.ok).toBe(false);
  });

  it("rejects a claim on a stale nonce / drifted panel / expired hold", async () => {
    const name = uname();
    const id = await holdUsername(name, `${tag}-c2`);
    const checkoutId = await newCheckout();
    // Wrong nonce.
    const wrongNonce = await claimReservationForCheckout(
      prisma,
      { reservationId: id, userId, draftNonce: `${tag}-OTHER`, normalizedUsername: name, mode: ServiceUsernameMode.CUSTOM, panelId },
      checkoutId,
    );
    expect(wrongNonce.ok).toBe(false);
    // Drifted panel.
    const drifted = await claimReservationForCheckout(
      prisma,
      { reservationId: id, userId, draftNonce: `${tag}-c2`, normalizedUsername: name, mode: ServiceUsernameMode.CUSTOM, panelId: panelId2 },
      checkoutId,
    );
    expect(drifted.ok).toBe(false);
    // Still HELD (nothing consumed the slot).
    const still = await prisma.serviceUsernameReservation.findUniqueOrThrow({ where: { id } });
    expect(still.status).toBe(ServiceUsernameReservationStatus.HELD);
  });

  it("two concurrent claims on ONE hold bind exactly one (no double payable checkout)", async () => {
    const name = uname();
    const id = await holdUsername(name, `${tag}-race`);
    const [cA, cB] = await Promise.all([newCheckout(), newCheckout()]);
    const [rA, rB] = await Promise.all([
      claimReservationForCheckout(
        prisma,
        { reservationId: id, userId, draftNonce: `${tag}-race`, normalizedUsername: name, mode: ServiceUsernameMode.CUSTOM, panelId },
        cA,
      ),
      claimReservationForCheckout(
        prisma,
        { reservationId: id, userId, draftNonce: `${tag}-race`, normalizedUsername: name, mode: ServiceUsernameMode.CUSTOM, panelId },
        cB,
      ),
    ]);
    expect([rA.ok, rB.ok].filter(Boolean)).toHaveLength(1);
  });

  it("strict attach binds the exact order, is idempotent, and throws on a mismatch", async () => {
    const name = uname();
    const id = await holdUsername(name, `${tag}-att`);
    const checkoutId = await newCheckout();
    await claimReservationForCheckout(
      prisma,
      { reservationId: id, userId, draftNonce: `${tag}-att`, normalizedUsername: name, mode: ServiceUsernameMode.CUSTOM, panelId },
      checkoutId,
    );
    const order = await prisma.order.create({ data: { userId, type: "SERVICE_PURCHASE", checkoutSessionId: checkoutId } });
    const bind = { reservationId: id, userId, checkoutSessionId: checkoutId, panelId, normalizedUsername: name, orderId: order.id };
    await attachReservationToOrder(prisma, bind);
    await attachReservationToOrder(prisma, bind); // idempotent
    const row = await prisma.serviceUsernameReservation.findUniqueOrThrow({ where: { id } });
    expect(row.orderId).toBe(order.id);
    // A wrong username never binds — it throws the typed invariant error.
    await expect(
      attachReservationToOrder(prisma, { ...bind, normalizedUsername: "different1", orderId: order.id }),
    ).rejects.toBeInstanceOf(ReservationInvariantError);
  });

  it("external-settlement bind is a no-op-safe reconciliation (never throws) on an anomaly", async () => {
    const name = uname();
    const id = await holdUsername(name, `${tag}-ext`);
    const checkoutId = await newCheckout();
    await claimReservationForCheckout(
      prisma,
      { reservationId: id, userId, draftNonce: `${tag}-ext`, normalizedUsername: name, mode: ServiceUsernameMode.CUSTOM, panelId },
      checkoutId,
    );
    const order = await prisma.order.create({ data: { userId, type: "SERVICE_PURCHASE", checkoutSessionId: checkoutId } });
    const snapshot = { serviceUsernameReservationId: id, serviceUsername: name, panelId };
    // Happy path returns a typed { bound: true } and records the order.
    const okBind = await bindSettledReservationFromSnapshot(prisma, snapshot, {
      userId,
      checkoutSessionId: checkoutId,
      orderId: order.id,
    });
    expect(okBind).toEqual({ bound: true });
    expect((await prisma.serviceUsernameReservation.findUniqueOrThrow({ where: { id } })).orderId).toBe(order.id);
    // Anomaly (reservation released out from under settlement) returns a typed
    // { bound: false } WITHOUT throwing — the caller opens a durable case.
    await releaseReservation(id);
    const anomaly = await bindSettledReservationFromSnapshot(prisma, snapshot, {
      userId,
      checkoutSessionId: checkoutId,
      orderId: order.id,
    });
    expect(anomaly.bound).toBe(false);
  });

  it("exact-HELD abandonment release frees a HELD hold but never a BOUND one", async () => {
    const heldName = uname();
    const heldId = await holdUsername(heldName, `${tag}-rel`);
    await releaseHeldReservationForDraft({ userId, draftNonce: `${tag}-rel`, reservationId: heldId });
    expect((await prisma.serviceUsernameReservation.findUniqueOrThrow({ where: { id: heldId } })).status).toBe(
      ServiceUsernameReservationStatus.RELEASED,
    );
    // A BOUND reservation is untouched by the HELD-only release.
    const boundName = uname();
    const boundId = await holdUsername(boundName, `${tag}-rel2`);
    await claimReservationForCheckout(
      prisma,
      { reservationId: boundId, userId, draftNonce: `${tag}-rel2`, normalizedUsername: boundName, mode: ServiceUsernameMode.CUSTOM, panelId },
      await newCheckout(),
    );
    await releaseHeldReservationForDraft({ userId, draftNonce: `${tag}-rel2`, reservationId: boundId });
    expect((await prisma.serviceUsernameReservation.findUniqueOrThrow({ where: { id: boundId } })).status).toBe(
      ServiceUsernameReservationStatus.BOUND,
    );
  });

  // --- §3 panel-drift recovery + §6 authoritative abandonment (handler level) ---
  // A minimal BotContext: the two production entry points read only dbUser, the
  // checkout draft and the current flow, and mutate session state — no Telegram
  // API, DB session or middleware needed.
  const makeCtx = (draft: CheckoutDraft | undefined): BotContext =>
    ({
      dbUser: { id: userId },
      session: { currentFlow: null as string | null, temp: { checkoutDraft: draft } },
    }) as unknown as BotContext;

  // Arm a completed SERVICE customization holding a real HELD reservation on the
  // given panel, returned as a live CheckoutDraft (extra overrides the origin /
  // representative context that distinguishes the retail / Pricing / reseller
  // entry points).
  const armDraftOnPanel = async (
    nonce: string,
    targetPanelId: string,
    extra: Partial<CheckoutDraft> = {},
  ): Promise<CheckoutDraft> => {
    const name = uname();
    const held = await reserveServiceUsername({
      userId,
      panelId: targetPanelId,
      mode: ServiceUsernameMode.CUSTOM,
      normalizedUsername: name,
      draftNonce: nonce,
    });
    if (held.outcome !== "AVAILABLE") throw new Error(`hold failed: ${held.outcome}`);
    const serviceCustomization: ServiceCustomizationDraft = {
      usernameMode: ServiceUsernameMode.CUSTOM,
      normalizedUsername: name,
      reservationId: held.reservationId,
      note: null,
      usernameConfirmedAt: "2026-07-25T00:00:00.000Z",
      completed: true,
    };
    return {
      productId: "prod".padEnd(24, "0"),
      categoryId: "cat-old",
      panelId: targetPanelId,
      flowType: "SERVICE_PRODUCT",
      originalPriceToman: 50_000,
      discountAmountToman: 0,
      finalPriceToman: 50_000,
      draftNonce: nonce,
      serviceCustomization,
      ...extra,
    };
  };

  it("a deliberate nav exit releases the draft's EXACT held reservation and clears it (§6)", async () => {
    const draft = await armDraftOnPanel(`${tag}-abandon`, panelId);
    const heldId = draft.serviceCustomization!.reservationId;
    const ctx = makeCtx(draft);
    ctx.session.currentFlow = "checkout:service_username";
    await abandonCheckoutDraft(ctx, "MENU");
    // The exact HELD slot is freed immediately (not just the session draft)...
    expect(
      (await prisma.serviceUsernameReservation.findUniqueOrThrow({ where: { id: heldId } })).status,
    ).toBe(ServiceUsernameReservationStatus.RELEASED);
    // ...and the Telegram-side draft + interruptible flow are cleared.
    expect(ctx.session.temp.checkoutDraft).toBeUndefined();
    expect(ctx.session.currentFlow).toBeNull();

    // A BOUND (settling) reservation is NEVER released by abandonment, even when
    // the abandoned draft still references it.
    const draft2 = await armDraftOnPanel(`${tag}-abandon2`, panelId);
    const boundId = draft2.serviceCustomization!.reservationId;
    await claimReservationForCheckout(
      prisma,
      {
        reservationId: boundId,
        userId,
        draftNonce: `${tag}-abandon2`,
        normalizedUsername: draft2.serviceCustomization!.normalizedUsername,
        mode: ServiceUsernameMode.CUSTOM,
        panelId,
      },
      await newCheckout(),
    );
    const ctx2 = makeCtx(draft2);
    await abandonCheckoutDraft(ctx2, "MENU");
    expect(
      (await prisma.serviceUsernameReservation.findUniqueOrThrow({ where: { id: boundId } })).status,
    ).toBe(ServiceUsernameReservationStatus.BOUND);
    expect(ctx2.session.temp.checkoutDraft).toBeUndefined();
  });

  it("panel drift re-seats the draft on the current panel and allows a fresh attempt (retail/Pricing/reseller, §3)", async () => {
    const driftCases: Array<[string, Partial<CheckoutDraft>]> = [
      // retail buy-flow (no origin, no reseller context)
      ["retail", {}],
      // opened from the public Pricing catalog (origin = return location)
      [
        "pricing",
        { origin: { kind: "PRICING_SERVICE", panelId, categoryId: "cat-old", page: 0 } },
      ],
      // representative-priced checkout (frozen pricing agreement + fingerprints)
      [
        "reseller",
        {
          representative: {
            representativeId: "rep-1",
            tierId: "tier-1",
            tierSlug: "silver",
            priceMode: "FIXED_TOMAN",
            retailPriceToman: 80_000,
            basePriceToman: 60_000,
            tierFingerprint: "tf-1",
            priceFingerprint: "pf-1",
          },
        },
      ],
    ];
    for (const [label, extra] of driftCases) {
      const nonce = `${tag}-drift-${label}`;
      const draft = await armDraftOnPanel(nonce, panelId, extra);
      const oldHeldId = draft.serviceCustomization!.reservationId;
      const originBefore = draft.origin;
      const repBefore = draft.representative;
      const priceBefore = draft.finalPriceToman;
      const ctx = makeCtx(draft);
      ctx.session.currentFlow = "checkout:service_username";
      // The Product now lives on a DIFFERENT panel than the held reservation.
      const product = {
        id: draft.productId,
        type: "SERVICE_PRODUCT",
        panelId: panelId2,
        categoryId: "cat-new",
      } as unknown as ProductWithRelations;

      await rebuildDraftForCurrentPanel(ctx, draft, product);

      // The old panel's exact HELD reservation is released (freed for reuse)...
      expect(
        (await prisma.serviceUsernameReservation.findUniqueOrThrow({ where: { id: oldHeldId } })).status,
      ).toBe(ServiceUsernameReservationStatus.RELEASED);
      // ...the draft is re-seated on the CURRENT panel with its customization
      // cleared, so the buyer is sent back to the username-method page...
      expect(draft.panelId).toBe(panelId2);
      expect(draft.categoryId).toBe("cat-new");
      expect(draft.serviceCustomization).toBeUndefined();
      expect(ctx.session.currentFlow).toBeNull();
      // ...and NO money moved: the price + origin/reseller agreement survive intact.
      expect(draft.finalPriceToman).toBe(priceBefore);
      expect(draft.origin).toBe(originBefore);
      expect(draft.representative).toBe(repBefore);

      // A successful SECOND attempt on the NEW panel: the buyer picks a username on
      // panelId2 and claims it to a fresh checkout with no residue from the drift.
      const name2 = uname();
      const held2 = await reserveServiceUsername({
        userId,
        panelId: panelId2,
        mode: ServiceUsernameMode.CUSTOM,
        normalizedUsername: name2,
        draftNonce: nonce,
      });
      expect(held2.outcome).toBe("AVAILABLE");
      if (held2.outcome !== "AVAILABLE") continue;
      const claim = await claimReservationForCheckout(
        prisma,
        {
          reservationId: held2.reservationId,
          userId,
          draftNonce: nonce,
          normalizedUsername: name2,
          mode: ServiceUsernameMode.CUSTOM,
          panelId: panelId2,
        },
        await newCheckout(),
      );
      expect(claim.ok).toBe(true);
    }
  });

  it("cleanup reclaims a BOUND hold on an EXPIRED-but-PENDING checkout with no live order (defect 2)", async () => {
    const name = uname();
    const id = await holdUsername(name, `${tag}-exp`);
    const checkout = await prisma.checkoutSession.create({
      data: { userId, purpose: "ORDER_PAYMENT", status: "PENDING", expiresAt: new Date(Date.now() - 60_000) },
    });
    await claimReservationForCheckout(
      prisma,
      { reservationId: id, userId, draftNonce: `${tag}-exp`, normalizedUsername: name, mode: ServiceUsernameMode.CUSTOM, panelId },
      checkout.id,
    );
    await runReservationCleanup(new Date());
    const after = await prisma.serviceUsernameReservation.findUniqueOrThrow({ where: { id } });
    expect(after.status).toBe(ServiceUsernameReservationStatus.EXPIRED);
    expect(after.activeUsernameKey).toBeNull();
  });

  it("cleanup NEVER reclaims a BOUND hold whose checkout still owns a live PAID order", async () => {
    const name = uname();
    const id = await holdUsername(name, `${tag}-live`);
    const checkout = await prisma.checkoutSession.create({
      data: { userId, purpose: "ORDER_PAYMENT", status: "PENDING", expiresAt: new Date(Date.now() - 60_000) },
    });
    await claimReservationForCheckout(
      prisma,
      { reservationId: id, userId, draftNonce: `${tag}-live`, normalizedUsername: name, mode: ServiceUsernameMode.CUSTOM, panelId },
      checkout.id,
    );
    // A live PAID order on the same checkout — a settling reservation must survive.
    await prisma.order.create({
      data: { userId, type: "SERVICE_PURCHASE", status: "PAID", checkoutSessionId: checkout.id },
    });
    await runReservationCleanup(new Date());
    const after = await prisma.serviceUsernameReservation.findUniqueOrThrow({ where: { id } });
    expect(after.status).toBe(ServiceUsernameReservationStatus.BOUND);
  });

  // hotfix §1: a reservation whose checkout has ANY settleable payment must keep
  // its username. Sets up an EXPIRED-but-PENDING checkout with a BOUND hold and a
  // single payment in the given state, then runs cleanup.
  const bindExpiredWithPayment = async (
    nonce: string,
    payment: {
      status: string;
      providerStatus?: string | null;
      settlementStatus?: string;
    },
  ): Promise<string> => {
    const name = uname();
    const id = await holdUsername(name, nonce);
    const checkout = await prisma.checkoutSession.create({
      data: { userId, purpose: "ORDER_PAYMENT", status: "PENDING", expiresAt: new Date(Date.now() - 60_000) },
    });
    await claimReservationForCheckout(
      prisma,
      { reservationId: id, userId, draftNonce: nonce, normalizedUsername: name, mode: ServiceUsernameMode.CUSTOM, panelId },
      checkout.id,
    );
    await prisma.payment.create({
      data: {
        userId,
        checkoutSessionId: checkout.id,
        purpose: "ORDER_PAYMENT",
        amountToman: 1000,
        payableAmountToman: 1000,
        status: payment.status as never,
        ...(payment.providerStatus !== undefined ? { providerStatus: payment.providerStatus } : {}),
        ...(payment.settlementStatus !== undefined
          ? { settlementStatus: payment.settlementStatus as never }
          : {}),
      },
    });
    return id;
  };

  it("cleanup PRESERVES a BOUND hold while a settleable payment exists (§1)", async () => {
    // Every state a payment can still settle from → reservation preserved.
    const cases: Array<[string, { status: string; providerStatus?: string | null; settlementStatus?: string }]> = [
      [`${tag}-pr`, { status: "PENDING_REVIEW" }],
      [`${tag}-pp`, { status: "PENDING" }],
      [`${tag}-pc`, { status: "PROCESSING" }],
      [`${tag}-ap`, { status: "APPROVED" }],
      // provider SUCCESS but local settlement not yet done (awaiting recovery).
      [`${tag}-ps`, { status: "EXPIRED", providerStatus: "SUCCESS", settlementStatus: "UNSETTLED" }],
      // filed as duplicate-success review — still owns the username.
      [`${tag}-ds`, { status: "APPROVED", settlementStatus: "DUPLICATE_SUCCESS_REVIEW" }],
    ];
    const ids: string[] = [];
    for (const [nonce, payment] of cases) {
      ids.push(await bindExpiredWithPayment(nonce, payment));
    }
    await runReservationCleanup(new Date());
    for (const id of ids) {
      const row = await prisma.serviceUsernameReservation.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe(ServiceUsernameReservationStatus.BOUND);
    }
  });

  it("cleanup RECLAIMS a BOUND hold whose only payment is terminally dead with no provider success (§1)", async () => {
    const id = await bindExpiredWithPayment(`${tag}-dead`, {
      status: "REJECTED",
      providerStatus: null,
      settlementStatus: "UNSETTLED",
    });
    await runReservationCleanup(new Date());
    const row = await prisma.serviceUsernameReservation.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe(ServiceUsernameReservationStatus.EXPIRED);
  });

  it("durable reconciliation case: idempotent per payment, blocks provisioning, carries no username (§2)", async () => {
    const name = uname();
    const id = await holdUsername(name, `${tag}-rec`);
    const checkoutId = await newCheckout();
    await claimReservationForCheckout(
      prisma,
      { reservationId: id, userId, draftNonce: `${tag}-rec`, normalizedUsername: name, mode: ServiceUsernameMode.CUSTOM, panelId },
      checkoutId,
    );
    const payment = await prisma.payment.create({
      data: { userId, checkoutSessionId: checkoutId, purpose: "ORDER_PAYMENT", amountToman: 5000, payableAmountToman: 5000, status: "APPROVED" },
    });
    // File twice (duplicate settlement callbacks) → exactly ONE case.
    const first = await prisma.$transaction((tx) =>
      fileServiceUsernameUnboundCase(tx, {
        checkoutSessionId: checkoutId,
        paymentId: payment.id,
        userId,
        expectedAmountToman: 5000,
        safeReason: "gateway settlement reservation bind failed: ORDER_BIND_NO_MATCH",
      }),
    );
    const second = await prisma.$transaction((tx) =>
      fileServiceUsernameUnboundCase(tx, {
        checkoutSessionId: checkoutId,
        paymentId: payment.id,
        userId,
        expectedAmountToman: 5000,
        safeReason: "gateway settlement reservation bind failed: ORDER_BIND_NO_MATCH",
      }),
    );
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(await hasBlockingServiceUsernameUnboundCase(checkoutId)).toBe(true);
    // The case metadata never carries the username / note.
    const cases = await prisma.financialReconciliationCase.findMany({ where: { checkoutSessionId: checkoutId } });
    expect(cases).toHaveLength(1);
    expect(JSON.stringify(cases[0])).not.toContain(name);
  });
});
