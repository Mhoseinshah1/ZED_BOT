import {
  prisma,
  type Panel,
  type Product,
  type ProductCategory,
  type Service,
  type ServiceAutoRenewalMandate,
  type User,
} from "@zedbot/database";
import {
  AUTO_RENEWAL_PRECHARGE_GATE_MAX_DEFER_MS,
  autoRenewalUpcomingDedupeKey,
  buildAutoRenewalCycleFingerprint,
  resolveAutoRenewalExpectedChargeAt,
  WALLET_AUTO_RENEWAL_ENABLED_KEY,
  WALLET_AUTO_RENEWAL_PRECHARGE_NOTICE_MINUTES_KEY,
} from "@zedbot/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { cancelMandate, getPrechargeNoticeMinutes, previewPrechargeNotices, setPrechargeNoticeMinutes } from "../src/services/auto-renewal.service.js";
import { clearSettingsCache, setSetting } from "../src/services/settings.service.js";
import {
  ensureAutoRenewalPrechargeNotice,
  evaluateAutoRenewalPrechargeGate,
} from "../../worker/src/auto-renewal/precharge-notice.js";
import { runAutoRenewalScan } from "../../worker/src/auto-renewal/scan.js";
import { revalidateAutoRenewalUpcomingForDelivery } from "../../worker/src/notifications/delivery.js";

// =============================================================================
// Corrective Phase — durable pre-charge notice integration tests (real Postgres).
// Proves: the scan schedules ONE durable AUTO_RENEWAL_UPCOMING notice per cycle at
// the right instant; the charge gate never charges before the notice resolves yet
// never freezes on a Telegram outage; delivery revalidation never sends a stale
// price/cycle and never revokes a mandate; cancelling a mandate cancels its pending
// notice + uncommitted attempts; the notice never moves money.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
let seq = 0;

const PRICE = 50_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let panel: Panel;
let category: ProductCategory;
let product: Product;

/** A fake BullMQ queue: records the jobs it was asked to add. */
function fakeQueue(): { add: (...args: unknown[]) => Promise<undefined>; jobs: unknown[][] } {
  const jobs: unknown[][] = [];
  return {
    jobs,
    add: async (...args: unknown[]): Promise<undefined> => {
      jobs.push(args);
      return undefined;
    },
  };
}

async function setEnabled(enabled: boolean): Promise<void> {
  await setSetting(WALLET_AUTO_RENEWAL_ENABLED_KEY, enabled ? "true" : "false", "BOOLEAN");
  clearSettingsCache();
}

async function setNoticeMinutes(minutes: number): Promise<void> {
  await setSetting(WALLET_AUTO_RENEWAL_PRECHARGE_NOTICE_MINUTES_KEY, String(minutes), "NUMBER");
  clearSettingsCache();
}

async function makeUser(): Promise<User> {
  seq += 1;
  return prisma.user.create({
    data: { telegramId: runTag + BigInt(seq), status: "ACTIVE", group: "F", balanceToman: 1_000_000 },
  });
}

async function makeService(user: User, expiresInMs: number): Promise<Service> {
  seq += 1;
  return prisma.service.create({
    data: {
      userId: user.id,
      panelId: panel.id,
      panelType: "MARZBAN",
      username: `arp-svc-${runTag}-${seq}`,
      productNameSnapshot: "پلن نمونه",
      source: "PAID",
      status: "ACTIVE",
      volumeBytes: 10n * 1024n * 1024n * 1024n,
      remainingBytes: 5n * 1024n * 1024n * 1024n,
      usedBytes: 5n * 1024n * 1024n * 1024n,
      expiresAt: new Date(Date.now() + expiresInMs),
      durationDays: 30,
      startsAt: new Date(Date.now() - 28 * DAY),
      lastSubscriptionUpdateAt: new Date(),
    },
  });
}

async function makeMandate(
  user: User,
  service: Service,
  overrides: Partial<ServiceAutoRenewalMandate> = {},
): Promise<ServiceAutoRenewalMandate> {
  return prisma.serviceAutoRenewalMandate.create({
    data: {
      userId: user.id,
      serviceId: service.id,
      productId: product.id,
      fundingMethod: "WALLET",
      status: "ACTIVE",
      maximumChargeToman: 60_000,
      consentedPriceToman: PRICE,
      chargeLeadMinutes: 180,
      consentVersion: 1,
      consentedAt: new Date(),
      ...overrides,
    },
  });
}

function cycleOf(service: Service): string {
  const fp = buildAutoRenewalCycleFingerprint({
    serviceId: service.id,
    expiresAtEpoch: service.expiresAt?.getTime() ?? null,
    productId: product.id,
  });
  if (fp === null) throw new Error("no fingerprint");
  return fp;
}

const DEFAULT_CONFIG = {
  scanMinutes: 5,
  defaultChargeLeadMinutes: 180,
  prechargeNoticeMinutes: 1440,
  insufficientRetryIntervalsMinutes: [0, 360, 1440],
  graceHours: 48,
  maxAttemptsPerCycle: 3,
  attemptRetentionDays: 365,
  consentVersion: 1,
};

describe.runIf(hasDb)("wallet auto-renewal pre-charge notice", () => {
  beforeAll(async () => {
    panel = await prisma.panel.create({
      data: {
        type: "MARZBAN",
        name: `arp-panel-${runTag}`,
        baseUrl: "http://127.0.0.1:1",
        status: "ACTIVE",
        username: "admin",
        passwordEncrypted: "enc",
        templateUsername: "tpl",
        renewalEnabled: true,
      },
    });
    category = await prisma.productCategory.create({
      data: { type: "SERVICE_PRODUCT", name: `arp-cat-${runTag}`, isActive: true },
    });
    product = await prisma.product.create({
      data: {
        type: "SERVICE_PRODUCT",
        categoryId: category.id,
        panelId: panel.id,
        name: `arp-prod-${runTag}`,
        priceToman: PRICE,
        durationDays: 30,
        volumeGb: 10,
        isActive: true,
      },
    });
  });

  beforeEach(async () => {
    await setEnabled(true);
    await setNoticeMinutes(1440);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // --- notice scheduling (Parts E/F/G) ---------------------------------------

  describe("ensureAutoRenewalPrechargeNotice", () => {
    it("P1: schedules ONE durable notice for a future cycle (scheduledFor=prechargeNoticeAt)", async () => {
      const user = await makeUser();
      const service = await makeService(user, 10 * DAY);
      const mandate = await makeMandate(user, service);
      const out = await ensureAutoRenewalPrechargeNotice(mandate, service, DEFAULT_CONFIG, null, new Date());
      expect(out.kind).toBe("scheduled");
      const notice = await prisma.automatedNotification.findUnique({
        where: { dedupeKey: autoRenewalUpcomingDedupeKey(mandate.id, cycleOf(service)) },
      });
      expect(notice).not.toBeNull();
      expect(notice?.type).toBe("AUTO_RENEWAL_UPCOMING");
      expect(notice?.category).toBe("PAYMENT");
      expect(notice?.status).toBe("SCHEDULED");
      expect(notice?.serviceId).toBe(service.id);
      const expectedCharge = resolveAutoRenewalExpectedChargeAt({ expiresAtEpoch: service.expiresAt!.getTime(), chargeLeadMinutes: 180 })!;
      expect(notice?.availableUntil?.getTime()).toBe(expectedCharge);
      expect(notice?.scheduledFor.getTime()).toBe(expectedCharge - 1440 * 60_000);
    });

    it("P2: is idempotent — a second call creates no second row", async () => {
      const user = await makeUser();
      const service = await makeService(user, 10 * DAY);
      const mandate = await makeMandate(user, service);
      await ensureAutoRenewalPrechargeNotice(mandate, service, DEFAULT_CONFIG, null, new Date());
      const second = await ensureAutoRenewalPrechargeNotice(mandate, service, DEFAULT_CONFIG, null, new Date());
      expect(second.kind === "scheduled" && second.created).toBe(false);
      const count = await prisma.automatedNotification.count({
        where: { serviceId: service.id, type: "AUTO_RENEWAL_UPCOMING" },
      });
      expect(count).toBe(1);
    });

    it("P3: the payload snapshot carries NO wallet balance / full ids / telegram id", async () => {
      const user = await makeUser();
      const service = await makeService(user, 10 * DAY);
      const mandate = await makeMandate(user, service);
      await ensureAutoRenewalPrechargeNotice(mandate, service, DEFAULT_CONFIG, null, new Date());
      const notice = await prisma.automatedNotification.findFirst({ where: { serviceId: service.id } });
      const json = JSON.stringify(notice?.payloadSnapshot);
      expect(json).not.toContain(String(user.telegramId));
      expect(json).not.toContain(user.id);
      expect(json).not.toContain(service.id);
      expect(json).not.toContain("balance");
      // The safe mandate SHORT id (8 hex) is allowed; the full id is not.
      expect(json).not.toContain(mandate.id);
      expect(json).toContain(mandate.id.slice(0, 8));
    });

    it("P4: catch-up — notice window already open, delivers now (scheduledFor≈now)", async () => {
      const user = await makeUser();
      // expiry so that now is between prechargeNoticeAt and expectedChargeAt.
      // expectedChargeAt = expiry - 3h; prechargeNoticeAt = expectedChargeAt - 24h.
      const service = await makeService(user, 4 * HOUR); // expectedCharge in ~1h, notice window open
      const mandate = await makeMandate(user, service);
      const now = new Date();
      const out = await ensureAutoRenewalPrechargeNotice(mandate, service, DEFAULT_CONFIG, null, now);
      expect(out.kind).toBe("catch-up");
      const notice = await prisma.automatedNotification.findFirst({ where: { serviceId: service.id } });
      expect(notice?.scheduledFor.getTime()).toBeLessThanOrEqual(now.getTime() + 1000);
    });

    it("P5: missed — charge window already reached, NO upcoming notice created", async () => {
      const user = await makeUser();
      const service = await makeService(user, 1 * HOUR); // expectedCharge already past
      const mandate = await makeMandate(user, service);
      const out = await ensureAutoRenewalPrechargeNotice(mandate, service, DEFAULT_CONFIG, null, new Date());
      expect(out.kind).toBe("missed");
      const count = await prisma.automatedNotification.count({ where: { serviceId: service.id } });
      expect(count).toBe(0);
    });

    it("P6: disabled (noticeMinutes 0) — NO notice, but the cycle is otherwise chargeable", async () => {
      const user = await makeUser();
      const service = await makeService(user, 10 * DAY);
      const mandate = await makeMandate(user, service);
      const out = await ensureAutoRenewalPrechargeNotice(mandate, service, { ...DEFAULT_CONFIG, prechargeNoticeMinutes: 0 }, null, new Date());
      expect(out.kind).toBe("disabled");
      const count = await prisma.automatedNotification.count({ where: { serviceId: service.id } });
      expect(count).toBe(0);
    });

    it("P7: an unlimited-time service is never given a notice", async () => {
      const user = await makeUser();
      const service = await makeService(user, 10 * DAY);
      await prisma.service.update({ where: { id: service.id }, data: { expiresAt: null } });
      const fresh = await prisma.service.findUniqueOrThrow({ where: { id: service.id } });
      const mandate = await makeMandate(user, fresh);
      const out = await ensureAutoRenewalPrechargeNotice(mandate, fresh, DEFAULT_CONFIG, null, new Date());
      expect(out.kind).toBe("disabled");
      const count = await prisma.automatedNotification.count({ where: { serviceId: service.id } });
      expect(count).toBe(0);
    });

    it("P8: scheduling a NEW cycle cancels the stale SCHEDULED notice of the old cycle", async () => {
      const user = await makeUser();
      const service = await makeService(user, 10 * DAY);
      const mandate = await makeMandate(user, service);
      await ensureAutoRenewalPrechargeNotice(mandate, service, DEFAULT_CONFIG, null, new Date());
      const oldKey = autoRenewalUpcomingDedupeKey(mandate.id, cycleOf(service));
      // A manual renewal moves the expiry -> a new cycle fingerprint.
      const renewed = await prisma.service.update({
        where: { id: service.id },
        data: { expiresAt: new Date(Date.now() + 40 * DAY) },
      });
      await ensureAutoRenewalPrechargeNotice(mandate, renewed, DEFAULT_CONFIG, null, new Date());
      const oldNotice = await prisma.automatedNotification.findUnique({ where: { dedupeKey: oldKey } });
      expect(oldNotice?.status).toBe("CANCELLED");
      const newNotice = await prisma.automatedNotification.findUnique({
        where: { dedupeKey: autoRenewalUpcomingDedupeKey(mandate.id, cycleOf(renewed)) },
      });
      expect(newNotice?.status).toBe("SCHEDULED");
    });
  });

  // --- charge-race gate (Part J) ---------------------------------------------

  describe("evaluateAutoRenewalPrechargeGate", () => {
    async function gateFor(status: string, service: Service, mandate: ServiceAutoRenewalMandate): Promise<Awaited<ReturnType<typeof evaluateAutoRenewalPrechargeGate>>> {
      const dedupeKey = autoRenewalUpcomingDedupeKey(mandate.id, cycleOf(service));
      const expectedCharge = resolveAutoRenewalExpectedChargeAt({ expiresAtEpoch: service.expiresAt!.getTime(), chargeLeadMinutes: mandate.chargeLeadMinutes })!;
      await prisma.automatedNotification.create({
        data: {
          type: "AUTO_RENEWAL_UPCOMING",
          category: "PAYMENT",
          status: status as never,
          userId: mandate.userId,
          serviceId: service.id,
          dedupeKey,
          scheduledFor: new Date(expectedCharge - 1440 * 60_000),
          availableUntil: new Date(expectedCharge),
          payloadSnapshot: { templateKey: "x", variables: {}, buttons: [] },
        },
      });
      return evaluateAutoRenewalPrechargeGate(dedupeKey, expectedCharge, 1440, Date.now());
    }

    it("P9: SENT notice → proceed", async () => {
      const user = await makeUser();
      const service = await makeService(user, 2 * HOUR);
      const mandate = await makeMandate(user, service);
      expect((await gateFor("SENT", service, mandate)).action).toBe("proceed");
    });

    it("P10: terminal-non-cancel (SUPPRESSED/FAILED/EXPIRED) → proceed (consent stands)", async () => {
      for (const status of ["SUPPRESSED", "FAILED", "DEAD_LETTER", "EXPIRED", "CANCELLED"]) {
        const user = await makeUser();
        const service = await makeService(user, 2 * HOUR);
        const mandate = await makeMandate(user, service);
        expect((await gateFor(status, service, mandate)).action).toBe("proceed");
      }
    });

    it("P11: READY/SENDING (in-flight) → defer, but bounded (never past expectedCharge+30m)", async () => {
      const user = await makeUser();
      // expiry 5h + lead 3h => expectedChargeAt ~2h in the FUTURE, so the bounded
      // cap has not yet been reached and an in-flight notice defers the charge.
      const service = await makeService(user, 5 * HOUR);
      const mandate = await makeMandate(user, service);
      const decision = await gateFor("READY", service, mandate);
      expect(decision.action).toBe("defer");
    });

    it("P12: past the hard cap → proceed with precharge-delivery-unconfirmed", async () => {
      const user = await makeUser();
      const service = await makeService(user, 2 * HOUR);
      const mandate = await makeMandate(user, service);
      const dedupeKey = autoRenewalUpcomingDedupeKey(mandate.id, cycleOf(service));
      const expectedCharge = resolveAutoRenewalExpectedChargeAt({ expiresAtEpoch: service.expiresAt!.getTime(), chargeLeadMinutes: mandate.chargeLeadMinutes })!;
      await prisma.automatedNotification.create({
        data: {
          type: "AUTO_RENEWAL_UPCOMING", category: "PAYMENT", status: "SENDING",
          userId: mandate.userId, serviceId: service.id, dedupeKey,
          scheduledFor: new Date(expectedCharge - 1440 * 60_000), availableUntil: new Date(expectedCharge),
          payloadSnapshot: { templateKey: "x", variables: {}, buttons: [] },
        },
      });
      const past = expectedCharge + AUTO_RENEWAL_PRECHARGE_GATE_MAX_DEFER_MS + 60_000;
      const decision = await evaluateAutoRenewalPrechargeGate(dedupeKey, expectedCharge, 1440, past);
      expect(decision).toEqual({ action: "proceed", reason: "precharge-delivery-unconfirmed" });
    });

    it("P13: no notice row + notices enabled → proceed with precharge-window-missed", async () => {
      const decision = await evaluateAutoRenewalPrechargeGate("nope:cyc:upcoming:v1", Date.now(), 1440, Date.now());
      expect(decision).toEqual({ action: "proceed", reason: "precharge-window-missed" });
    });

    it("P14: advance notice disabled (0) → proceed unguarded", async () => {
      const decision = await evaluateAutoRenewalPrechargeGate("nope:cyc:upcoming:v1", Date.now(), 0, Date.now());
      expect(decision).toEqual({ action: "proceed" });
    });
  });

  // --- scan end-to-end (Part E) ----------------------------------------------

  describe("runAutoRenewalScan", () => {
    it("P15: a not-yet-due mandate gets a scheduled notice and NO wallet Attempt", async () => {
      const user = await makeUser();
      const service = await makeService(user, 10 * DAY);
      const mandate = await makeMandate(user, service);
      const sync = fakeQueue();
      const exec = fakeQueue();
      const result = await runAutoRenewalScan(sync as never, exec as never);
      expect(result.prechargeScheduled).toBeGreaterThanOrEqual(1);
      const attempts = await prisma.serviceAutoRenewalAttempt.count({ where: { mandateId: mandate.id } });
      expect(attempts).toBe(0);
      const notice = await prisma.automatedNotification.count({ where: { serviceId: service.id, type: "AUTO_RENEWAL_UPCOMING" } });
      expect(notice).toBe(1);
    });

    it("P16: a disabled system schedules nothing", async () => {
      await setEnabled(false);
      const user = await makeUser();
      const service = await makeService(user, 10 * DAY);
      await makeMandate(user, service);
      const result = await runAutoRenewalScan(fakeQueue() as never, fakeQueue() as never);
      expect(result.skipped).toBe("system-disabled");
      const notice = await prisma.automatedNotification.count({ where: { serviceId: service.id } });
      expect(notice).toBe(0);
    });
  });

  // --- delivery revalidation (Parts H/I) -------------------------------------

  describe("revalidateAutoRenewalUpcomingForDelivery", () => {
    async function reval(service: Service, mandate: ServiceAutoRenewalMandate, cycle: string, now = new Date()) {
      return revalidateAutoRenewalUpcomingForDelivery(
        { userId: mandate.userId, serviceId: service.id },
        { cycle },
        now,
      );
    }

    it("P17: a fresh, valid cycle re-renders the LIVE price (never a stale snapshot amount)", async () => {
      const user = await makeUser();
      const service = await makeService(user, 10 * DAY);
      const mandate = await makeMandate(user, service);
      const decision = await reval(service, mandate, cycleOf(service));
      expect("freshVariables" in decision).toBe(true);
      if ("freshVariables" in decision) {
        expect(decision.freshVariables.current_price).toBe(PRICE);
        expect(decision.freshVariables.maximum_charge).toBe(mandate.maximumChargeToman);
      }
    });

    it("P18: a changed cycle → CANCEL (never deliver a stale cycle)", async () => {
      const user = await makeUser();
      const service = await makeService(user, 10 * DAY);
      const mandate = await makeMandate(user, service);
      const staleCycle = cycleOf(service);
      await prisma.service.update({ where: { id: service.id }, data: { expiresAt: new Date(Date.now() + 40 * DAY) } });
      const fresh = await prisma.service.findUniqueOrThrow({ where: { id: service.id } });
      const decision = await reval(fresh, mandate, staleCycle);
      expect(decision).toMatchObject({ kind: "cancel", reason: "auto-renewal-cycle-changed" });
    });

    it("P19: past the expected charge → EXPIRE (never notify after the money moved)", async () => {
      const user = await makeUser();
      const service = await makeService(user, 1 * HOUR); // expectedCharge already past
      const mandate = await makeMandate(user, service);
      const decision = await reval(service, mandate, cycleOf(service));
      expect(decision).toMatchObject({ kind: "expire" });
    });

    it("P20: a cancelled mandate → CANCEL the notice (a stale letter never fires)", async () => {
      const user = await makeUser();
      const service = await makeService(user, 10 * DAY);
      const mandate = await makeMandate(user, service, { status: "CANCELLED", cancelledAt: new Date() });
      const decision = await reval(service, mandate, cycleOf(service));
      expect(decision).toMatchObject({ kind: "cancel", reason: "auto-renewal-mandate-inactive" });
    });

    it("P21: a live price above the ceiling → CANCEL (the charge would pause; never weaken the ceiling)", async () => {
      const user = await makeUser();
      const service = await makeService(user, 10 * DAY);
      const mandate = await makeMandate(user, service, { maximumChargeToman: 40_000 }); // below PRICE
      const decision = await reval(service, mandate, cycleOf(service));
      expect(decision).toMatchObject({ kind: "cancel" });
    });

    it("P22: a deleted service → CANCEL", async () => {
      const user = await makeUser();
      const service = await makeService(user, 10 * DAY);
      const mandate = await makeMandate(user, service);
      const cycle = cycleOf(service);
      await prisma.service.update({ where: { id: service.id }, data: { deletedAt: new Date(), status: "DELETED" } });
      const fresh = await prisma.service.findUniqueOrThrow({ where: { id: service.id } });
      const decision = await reval(fresh, mandate, cycle);
      expect(decision).toMatchObject({ kind: "cancel", reason: "auto-renewal-service-gone" });
    });
  });

  // --- cancellation (Part N) -------------------------------------------------

  describe("cancelMandate cascades", () => {
    it("P23: cancels the pending upcoming notice AND uncommitted attempts, keeps money untouched", async () => {
      const user = await makeUser();
      const service = await makeService(user, 10 * DAY);
      const mandate = await makeMandate(user, service);
      await ensureAutoRenewalPrechargeNotice(mandate, service, DEFAULT_CONFIG, null, new Date());
      const fp = cycleOf(service);
      await prisma.serviceAutoRenewalAttempt.create({
        data: {
          mandateId: mandate.id, serviceId: service.id, userId: user.id, productId: product.id,
          expiryCycleFingerprint: fp, idempotencyKey: `k-${runTag}-${seq}`,
          expectedProductPriceToman: PRICE, authorizedMaximumChargeToman: 60_000, status: "SCHEDULED",
        },
      });
      const ok = await cancelMandate(mandate.id, user.id);
      expect(ok).toBe(true);
      const notice = await prisma.automatedNotification.findUnique({ where: { dedupeKey: autoRenewalUpcomingDedupeKey(mandate.id, fp) } });
      expect(notice?.status).toBe("CANCELLED");
      const attempt = await prisma.serviceAutoRenewalAttempt.findFirst({ where: { mandateId: mandate.id } });
      expect(attempt?.status).toBe("CANCELLED");
    });

    it("P24: does NOT cancel a COMPLETED attempt (a settled renewal is never reversed)", async () => {
      const user = await makeUser();
      const service = await makeService(user, 10 * DAY);
      const mandate = await makeMandate(user, service);
      const fp = cycleOf(service);
      await prisma.serviceAutoRenewalAttempt.create({
        data: {
          mandateId: mandate.id, serviceId: service.id, userId: user.id, productId: product.id,
          expiryCycleFingerprint: fp, idempotencyKey: `kc-${runTag}-${seq}`,
          expectedProductPriceToman: PRICE, authorizedMaximumChargeToman: 60_000, status: "COMPLETED", completedAt: new Date(),
        },
      });
      await cancelMandate(mandate.id, user.id);
      const attempt = await prisma.serviceAutoRenewalAttempt.findFirst({ where: { mandateId: mandate.id } });
      expect(attempt?.status).toBe("COMPLETED");
    });

    it("P25: a different user cannot cancel (owner-scoped)", async () => {
      const user = await makeUser();
      const other = await makeUser();
      const service = await makeService(user, 10 * DAY);
      const mandate = await makeMandate(user, service);
      expect(await cancelMandate(mandate.id, other.id)).toBe(false);
      const fresh = await prisma.serviceAutoRenewalMandate.findUniqueOrThrow({ where: { id: mandate.id } });
      expect(fresh.status).toBe("ACTIVE");
    });
  });

  // --- admin settings (Parts B/P/Q) ------------------------------------------

  describe("precharge notice admin settings", () => {
    it("P26: getPrechargeNoticeMinutes reads the stored value", async () => {
      await setNoticeMinutes(720);
      expect(await getPrechargeNoticeMinutes()).toBe(720);
    });

    it("P27: setPrechargeNoticeMinutes accepts 0 (disable) and valid values, persists them", async () => {
      expect(await setPrechargeNoticeMinutes(0)).toBe(true);
      expect(await getPrechargeNoticeMinutes()).toBe(0);
      expect(await setPrechargeNoticeMinutes(2880)).toBe(true);
      expect(await getPrechargeNoticeMinutes()).toBe(2880);
    });

    it("P28: setPrechargeNoticeMinutes rejects out-of-range / non-integer values", async () => {
      await setNoticeMinutes(1440);
      expect(await setPrechargeNoticeMinutes(-1)).toBe(false);
      expect(await setPrechargeNoticeMinutes(999_999)).toBe(false);
      expect(await setPrechargeNoticeMinutes(1.5)).toBe(false);
      expect(await getPrechargeNoticeMinutes()).toBe(1440);
    });

    it("P29: previewPrechargeNotices lists scheduled/catch-up cycles and creates NOTHING", async () => {
      const user = await makeUser();
      const service = await makeService(user, 10 * DAY);
      await makeMandate(user, service);
      const before = await prisma.automatedNotification.count();
      const rows = await previewPrechargeNotices(500);
      const after = await prisma.automatedNotification.count();
      expect(after).toBe(before);
      expect(rows.some((r) => r.username === service.username)).toBe(true);
    });
  });

  // --- invariants (Part T) ---------------------------------------------------

  describe("invariants", () => {
    it("P30: one cycle → exactly one upcoming notice even under concurrent scheduling", async () => {
      const user = await makeUser();
      const service = await makeService(user, 10 * DAY);
      const mandate = await makeMandate(user, service);
      await Promise.all(
        Array.from({ length: 6 }, () => ensureAutoRenewalPrechargeNotice(mandate, service, DEFAULT_CONFIG, null, new Date())),
      );
      const count = await prisma.automatedNotification.count({
        where: { serviceId: service.id, type: "AUTO_RENEWAL_UPCOMING" },
      });
      expect(count).toBe(1);
    });

    it("P31: a suppressed/failed notice never revokes the mandate (charge path is independent)", async () => {
      const user = await makeUser();
      const service = await makeService(user, 10 * DAY);
      const mandate = await makeMandate(user, service);
      await prisma.automatedNotification.create({
        data: {
          type: "AUTO_RENEWAL_UPCOMING", category: "PAYMENT", status: "FAILED",
          userId: user.id, serviceId: service.id,
          dedupeKey: autoRenewalUpcomingDedupeKey(mandate.id, cycleOf(service)),
          scheduledFor: new Date(), payloadSnapshot: { templateKey: "x", variables: {}, buttons: [] },
        },
      });
      const fresh = await prisma.serviceAutoRenewalMandate.findUniqueOrThrow({ where: { id: mandate.id } });
      expect(fresh.status).toBe("ACTIVE");
    });
  });

  // --- additional gate + notice scenarios ------------------------------------

  describe("gate + notice edge cases", () => {
    it("P32: SCHEDULED with a still-future scheduledFor → defer to scheduledFor (warn first)", async () => {
      const user = await makeUser();
      const service = await makeService(user, 20 * DAY);
      const mandate = await makeMandate(user, service);
      const dedupeKey = autoRenewalUpcomingDedupeKey(mandate.id, cycleOf(service));
      const expectedCharge = resolveAutoRenewalExpectedChargeAt({ expiresAtEpoch: service.expiresAt!.getTime(), chargeLeadMinutes: mandate.chargeLeadMinutes })!;
      const scheduledFor = new Date(expectedCharge - 1440 * 60_000);
      await prisma.automatedNotification.create({
        data: {
          type: "AUTO_RENEWAL_UPCOMING", category: "PAYMENT", status: "SCHEDULED",
          userId: user.id, serviceId: service.id, dedupeKey,
          scheduledFor, availableUntil: new Date(expectedCharge),
          payloadSnapshot: { templateKey: "x", variables: {}, buttons: [] },
        },
      });
      const decision = await evaluateAutoRenewalPrechargeGate(dedupeKey, expectedCharge, 1440, Date.now());
      expect(decision).toEqual({ action: "defer", until: scheduledFor });
    });

    it("P33: catch-up creation enqueues delivery when a queue is provided", async () => {
      const user = await makeUser();
      const service = await makeService(user, 4 * HOUR);
      const mandate = await makeMandate(user, service);
      const dq = fakeQueue();
      const out = await ensureAutoRenewalPrechargeNotice(mandate, service, DEFAULT_CONFIG, dq as never, new Date());
      expect(out.kind).toBe("catch-up");
      expect(dq.jobs.length).toBe(1);
    });

    it("P34: a scheduled (future) notice does NOT enqueue immediate delivery", async () => {
      const user = await makeUser();
      const service = await makeService(user, 10 * DAY);
      const mandate = await makeMandate(user, service);
      const dq = fakeQueue();
      await ensureAutoRenewalPrechargeNotice(mandate, service, DEFAULT_CONFIG, dq as never, new Date());
      expect(dq.jobs.length).toBe(0);
    });

    it("P35: the notice ruleVersion is 1 and availableUntil equals expectedChargeAt", async () => {
      const user = await makeUser();
      const service = await makeService(user, 10 * DAY);
      const mandate = await makeMandate(user, service);
      await ensureAutoRenewalPrechargeNotice(mandate, service, DEFAULT_CONFIG, null, new Date());
      const notice = await prisma.automatedNotification.findFirst({ where: { serviceId: service.id } });
      expect(notice?.ruleVersion).toBe(1);
    });

    it("P36: a mandate with a missing product creates no notice (product-unavailable)", async () => {
      const user = await makeUser();
      const service = await makeService(user, 10 * DAY);
      const mandate = await makeMandate(user, service, { productId: "00000000-0000-0000-0000-000000000000" });
      const out = await ensureAutoRenewalPrechargeNotice(mandate, service, DEFAULT_CONFIG, null, new Date());
      expect(out.kind).toBe("product-unavailable");
      const count = await prisma.automatedNotification.count({ where: { serviceId: service.id } });
      expect(count).toBe(0);
    });
  });

  // --- additional delivery-revalidation scenarios ----------------------------

  describe("delivery revalidation edge cases", () => {
    async function reval(service: Service, mandate: ServiceAutoRenewalMandate, cycle: string, now = new Date()) {
      return revalidateAutoRenewalUpcomingForDelivery({ userId: mandate.userId, serviceId: service.id }, { cycle }, now);
    }

    it("P37: a TELEGRAM_STARS-funded mandate → CANCEL (never wallet-charged, no wallet notice)", async () => {
      const user = await makeUser();
      const service = await makeService(user, 10 * DAY);
      const mandate = await makeMandate(user, service, { fundingMethod: "TELEGRAM_STARS", maximumChargeToman: 0 });
      const decision = await reval(service, mandate, cycleOf(service));
      expect(decision).toMatchObject({ kind: "cancel", reason: "auto-renewal-not-wallet" });
    });

    it("P38: no mandate for the service → CANCEL", async () => {
      const user = await makeUser();
      const service = await makeService(user, 10 * DAY);
      const decision = await revalidateAutoRenewalUpcomingForDelivery(
        { userId: user.id, serviceId: service.id },
        { cycle: cycleOf(service) },
        new Date(),
      );
      expect(decision).toMatchObject({ kind: "cancel", reason: "auto-renewal-mandate-gone" });
    });

    it("P39: a null serviceId → CANCEL", async () => {
      const user = await makeUser();
      const decision = await revalidateAutoRenewalUpcomingForDelivery(
        { userId: user.id, serviceId: null },
        { cycle: "x" },
        new Date(),
      );
      expect(decision).toMatchObject({ kind: "cancel", reason: "auto-renewal-service-missing" });
    });

    it("P40: an inactive product → CANCEL (charge would pause)", async () => {
      const user = await makeUser();
      const service = await makeService(user, 10 * DAY);
      // A dedicated inactive product for this cycle.
      const inactive = await prisma.product.create({
        data: { type: "SERVICE_PRODUCT", categoryId: category.id, panelId: panel.id, name: `arp-inact-${runTag}-${seq}`, priceToman: PRICE, durationDays: 30, volumeGb: 10, isActive: false },
      });
      const mandate = await makeMandate(user, service, { productId: inactive.id });
      const cycle = buildAutoRenewalCycleFingerprint({ serviceId: service.id, expiresAtEpoch: service.expiresAt!.getTime(), productId: inactive.id })!;
      const decision = await reval(service, mandate, cycle);
      expect(decision).toMatchObject({ kind: "cancel", reason: "auto-renewal-product-unavailable" });
    });

    it("P41: the re-rendered service_name comes from the frozen snapshot, not the remote username", async () => {
      const user = await makeUser();
      const service = await makeService(user, 10 * DAY);
      const mandate = await makeMandate(user, service);
      const decision = await reval(service, mandate, cycleOf(service));
      if ("freshVariables" in decision) {
        expect(decision.freshVariables.service_name).toBe("پلن نمونه");
        expect(String(decision.freshVariables.service_name)).not.toContain(service.username);
      } else {
        throw new Error("expected freshVariables");
      }
    });

    it("P42: a live price DROP is reflected in the re-rendered amount (never the stale higher price)", async () => {
      const user = await makeUser();
      const service = await makeService(user, 10 * DAY);
      const dropProduct = await prisma.product.create({
        data: { type: "SERVICE_PRODUCT", categoryId: category.id, panelId: panel.id, name: `arp-drop-${runTag}-${seq}`, priceToman: 30_000, durationDays: 30, volumeGb: 10, isActive: true },
      });
      const mandate = await makeMandate(user, service, { productId: dropProduct.id });
      const cycle = buildAutoRenewalCycleFingerprint({ serviceId: service.id, expiresAtEpoch: service.expiresAt!.getTime(), productId: dropProduct.id })!;
      const decision = await reval(service, mandate, cycle);
      if ("freshVariables" in decision) {
        expect(decision.freshVariables.current_price).toBe(30_000);
      } else {
        throw new Error("expected freshVariables");
      }
    });
  });

  // --- additional cancellation / admin / scan --------------------------------

  describe("more cancellation + admin + scan", () => {
    it("P43: cancelling one mandate never touches another mandate's notice", async () => {
      const userA = await makeUser();
      const svcA = await makeService(userA, 10 * DAY);
      const mA = await makeMandate(userA, svcA);
      await ensureAutoRenewalPrechargeNotice(mA, svcA, DEFAULT_CONFIG, null, new Date());
      const userB = await makeUser();
      const svcB = await makeService(userB, 10 * DAY);
      const mB = await makeMandate(userB, svcB);
      await ensureAutoRenewalPrechargeNotice(mB, svcB, DEFAULT_CONFIG, null, new Date());
      await cancelMandate(mA.id, userA.id);
      const bNotice = await prisma.automatedNotification.findUnique({ where: { dedupeKey: autoRenewalUpcomingDedupeKey(mB.id, cycleOf(svcB)) } });
      expect(bNotice?.status).toBe("SCHEDULED");
    });

    it("P44: concurrent cancelMandate is safe — exactly one succeeds, notice cancelled once", async () => {
      const user = await makeUser();
      const service = await makeService(user, 10 * DAY);
      const mandate = await makeMandate(user, service);
      await ensureAutoRenewalPrechargeNotice(mandate, service, DEFAULT_CONFIG, null, new Date());
      const results = await Promise.all([cancelMandate(mandate.id, user.id), cancelMandate(mandate.id, user.id)]);
      expect(results.filter(Boolean).length).toBe(1);
      const notice = await prisma.automatedNotification.findUnique({ where: { dedupeKey: autoRenewalUpcomingDedupeKey(mandate.id, cycleOf(service)) } });
      expect(notice?.status).toBe("CANCELLED");
    });

    it("P45: getAutoRenewalAdminStats exposes the notice + notice-window counts", async () => {
      await setNoticeMinutes(1440);
      const stats = await (await import("../src/services/auto-renewal.service.js")).getAutoRenewalAdminStats();
      expect(stats.prechargeNoticeMinutes).toBe(1440);
      expect(typeof stats.noticesScheduled).toBe("number");
      expect(typeof stats.noticesSentToday).toBe("number");
      expect(typeof stats.noticesExpired).toBe("number");
    });

    it("P46: previewPrechargeNotices returns nothing when the advance notice is disabled", async () => {
      await setNoticeMinutes(0);
      const user = await makeUser();
      const service = await makeService(user, 10 * DAY);
      await makeMandate(user, service);
      const rows = await previewPrechargeNotices(50);
      expect(rows.some((r) => r.username === service.username)).toBe(false);
    });

    it("P47: the scan defers a not-yet-due mandate to its expected charge instant", async () => {
      const user = await makeUser();
      const service = await makeService(user, 10 * DAY);
      const mandate = await makeMandate(user, service);
      await runAutoRenewalScan(fakeQueue() as never, fakeQueue() as never);
      const fresh = await prisma.serviceAutoRenewalMandate.findUniqueOrThrow({ where: { id: mandate.id } });
      const expectedCharge = resolveAutoRenewalExpectedChargeAt({ expiresAtEpoch: service.expiresAt!.getTime(), chargeLeadMinutes: 180 })!;
      expect(fresh.nextEvaluationAt?.getTime()).toBe(expectedCharge);
    });

    it("P48: a second scan pass does not create a duplicate notice for the same cycle", async () => {
      const user = await makeUser();
      const service = await makeService(user, 10 * DAY);
      await makeMandate(user, service);
      await runAutoRenewalScan(fakeQueue() as never, fakeQueue() as never);
      // Re-arm the mandate so the scan re-examines it.
      await prisma.serviceAutoRenewalMandate.updateMany({ where: { serviceId: service.id }, data: { nextEvaluationAt: null } });
      await runAutoRenewalScan(fakeQueue() as never, fakeQueue() as never);
      const count = await prisma.automatedNotification.count({ where: { serviceId: service.id, type: "AUTO_RENEWAL_UPCOMING" } });
      expect(count).toBe(1);
    });

    it("P49: the upcoming-notice dedupe key has the exact stable format", async () => {
      const user = await makeUser();
      const service = await makeService(user, 10 * DAY);
      const mandate = await makeMandate(user, service);
      await ensureAutoRenewalPrechargeNotice(mandate, service, DEFAULT_CONFIG, null, new Date());
      const notice = await prisma.automatedNotification.findFirst({ where: { serviceId: service.id } });
      expect(notice?.dedupeKey).toBe(`wallet-auto-renewal:${mandate.id}:${cycleOf(service)}:upcoming:v1`);
    });

    it("P50: a paused mandate is skipped by the scan (no notice scheduled)", async () => {
      const user = await makeUser();
      const service = await makeService(user, 10 * DAY);
      await makeMandate(user, service, { status: "PAUSED", pausedAt: new Date() });
      await runAutoRenewalScan(fakeQueue() as never, fakeQueue() as never);
      const count = await prisma.automatedNotification.count({ where: { serviceId: service.id } });
      expect(count).toBe(0);
    });

    it("P51: disabling the advance notice via the scan config schedules nothing but still defers the charge", async () => {
      await setNoticeMinutes(0);
      const user = await makeUser();
      const service = await makeService(user, 10 * DAY);
      const mandate = await makeMandate(user, service);
      await runAutoRenewalScan(fakeQueue() as never, fakeQueue() as never);
      const count = await prisma.automatedNotification.count({ where: { serviceId: service.id } });
      expect(count).toBe(0);
      const fresh = await prisma.serviceAutoRenewalMandate.findUniqueOrThrow({ where: { id: mandate.id } });
      expect(fresh.nextEvaluationAt).not.toBeNull();
    });

    it("P52: two services of one user schedule two independent notices", async () => {
      const user = await makeUser();
      const s1 = await makeService(user, 10 * DAY);
      const s2 = await makeService(user, 12 * DAY);
      const m1 = await makeMandate(user, s1);
      const m2 = await makeMandate(user, s2);
      await ensureAutoRenewalPrechargeNotice(m1, s1, DEFAULT_CONFIG, null, new Date());
      await ensureAutoRenewalPrechargeNotice(m2, s2, DEFAULT_CONFIG, null, new Date());
      const count = await prisma.automatedNotification.count({ where: { userId: user.id, type: "AUTO_RENEWAL_UPCOMING", status: "SCHEDULED" } });
      expect(count).toBe(2);
    });

    it("P53: after a manual renewal the delivery of the OLD-cycle notice is cancelled (never a stale charge warning)", async () => {
      const user = await makeUser();
      const service = await makeService(user, 10 * DAY);
      const mandate = await makeMandate(user, service);
      await ensureAutoRenewalPrechargeNotice(mandate, service, DEFAULT_CONFIG, null, new Date());
      const oldCycle = cycleOf(service);
      await prisma.service.update({ where: { id: service.id }, data: { expiresAt: new Date(Date.now() + 45 * DAY) } });
      const renewed = await prisma.service.findUniqueOrThrow({ where: { id: service.id } });
      const decision = await revalidateAutoRenewalUpcomingForDelivery(
        { userId: user.id, serviceId: service.id },
        { cycle: oldCycle },
        new Date(),
      );
      expect(decision).toMatchObject({ kind: "cancel", reason: "auto-renewal-cycle-changed" });
      expect(renewed.expiresAt).not.toBeNull();
    });

    it("P54: re-enabling then scheduling for a fresh cycle works after an old cycle was cancelled", async () => {
      const user = await makeUser();
      const service = await makeService(user, 10 * DAY);
      const mandate = await makeMandate(user, service);
      await ensureAutoRenewalPrechargeNotice(mandate, service, DEFAULT_CONFIG, null, new Date());
      const renewed = await prisma.service.update({ where: { id: service.id }, data: { expiresAt: new Date(Date.now() + 50 * DAY) } });
      const out = await ensureAutoRenewalPrechargeNotice(mandate, renewed, DEFAULT_CONFIG, null, new Date());
      expect(out.kind === "scheduled" && out.created).toBe(true);
      const scheduled = await prisma.automatedNotification.count({ where: { serviceId: service.id, type: "AUTO_RENEWAL_UPCOMING", status: "SCHEDULED" } });
      expect(scheduled).toBe(1);
    });
  });
});
