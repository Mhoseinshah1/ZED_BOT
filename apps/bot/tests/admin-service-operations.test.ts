import http from "node:http";
import { randomUUID } from "node:crypto";

import { prisma, type Admin, type Panel, type Service, type User } from "@zedbot/database";
import { encryptSecret } from "@zedbot/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.PANEL_HTTP_TIMEOUT_MS = "700";
process.env.APP_SECRET ??= "admin-service-operations-tests-secret-0001";

import {
  addAdminServiceNote,
  adminServiceEligibleMutations,
  adminServiceSnapshotFingerprint,
  buildAdminServiceSnapshot,
  countUnresolvedAdminOperations,
  EXTRA_TIME_GRANTED_BY_ADMIN_EVENT_TYPE,
  EXTRA_VOLUME_GRANTED_BY_ADMIN_EVENT_TYPE,
  ADMIN_SERVICE_NOTE_EVENT_TYPE,
  executeAdminServiceOperation,
  getAdminServiceDetail,
  markAdminServiceOperationReviewed,
  reconcileAdminServiceOperation,
  refreshAdminServiceReadOnly,
  type AdminServiceMutationType,
} from "../src/services/admin-service-operation.service.js";
import { setAdminServiceMutationsEnabled } from "../src/services/admin-service-settings.service.js";
import {
  SERVICE_DISABLED_BY_ADMIN_EVENT_TYPE,
  SERVICE_ENABLED_BY_ADMIN_EVENT_TYPE,
} from "../src/services/service-toggle.service.js";
import { clearSettingsCache } from "../src/services/settings.service.js";
import { resetServiceLockClientForTests } from "../src/services/service-lock.service.js";

// =============================================================================
// Admin Service Operations — the authoritative executor, appliers, read-only
// refresh, reconciliation, notes, idempotency, rollout gates and the mandated
// FINANCIAL ISOLATION proof (§6). Real PostgreSQL + Redis + a faithful mock
// Marzban panel (GET/PUT-preserving-used/revoke_sub + injectable modify
// failures). E2E suites skip themselves without DATABASE_URL/REDIS_URL.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const hasRedis = (process.env.REDIS_URL ?? "") !== "" || (process.env.REDIS_HOST ?? "") !== "";
const hasDeps = hasDb && hasRedis;

const GIB = 1024n * 1024n * 1024n;
const DAY_MS = 86_400_000;
const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
let seq = 0;

// --- faithful mock Marzban panel ---------------------------------------------
interface MockUser {
  data_limit: number;
  expire: number;
  used_traffic: number;
  status: string;
  subSeq: number;
}
const panelUsers = new Map<string, MockUser>();
// "ok" | "fail" (500, no apply) | "applyThenFail" (apply the change, then 500).
let nextModify: "ok" | "fail" | "applyThenFail" = "ok";
let server: http.Server;
let panelUrl = "";

function userJson(username: string, u: MockUser): string {
  return JSON.stringify({
    username,
    status: u.status,
    used_traffic: u.used_traffic,
    data_limit: u.data_limit,
    expire: u.expire,
    proxies: { vless: {} },
    inbounds: { vless: ["VLESS"] },
    subscription_url: `/sub/${username}-${u.subSeq}`,
  });
}

function startMockPanel(): Promise<void> {
  server = http.createServer((req, res) => {
    void (async () => {
      const send = (status: number, body: unknown): void => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(typeof body === "string" ? body : JSON.stringify(body));
      };
      const url = req.url ?? "";
      if (req.method === "POST" && url === "/api/admin/token") {
        send(200, { access_token: "aso-token" });
        return;
      }
      const revoke = /^\/api\/user\/([^/]+)\/revoke_sub$/.exec(url);
      if (req.method === "POST" && revoke !== null) {
        const name = decodeURIComponent(revoke[1]);
        const u = panelUsers.get(name);
        if (u === undefined) {
          send(404, { detail: "User not found" });
          return;
        }
        u.subSeq += 1;
        send(200, userJson(name, u));
        return;
      }
      const match = /^\/api\/user\/([^/]+)$/.exec(url);
      if (match !== null) {
        const name = decodeURIComponent(match[1]);
        const u = panelUsers.get(name);
        if (req.method === "GET") {
          if (u === undefined) {
            send(404, { detail: "User not found" });
            return;
          }
          send(200, userJson(name, u));
          return;
        }
        if (req.method === "PUT") {
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(chunk as Buffer);
          }
          if (u === undefined) {
            send(404, { detail: "User not found" });
            return;
          }
          const body = JSON.parse(Buffer.concat(chunks).toString()) as {
            data_limit?: number;
            expire?: number;
            status?: string;
          };
          const apply = (): void => {
            if (typeof body.data_limit === "number") u.data_limit = body.data_limit;
            if (typeof body.expire === "number") u.expire = body.expire;
            if (typeof body.status === "string") u.status = body.status;
          };
          if (nextModify === "fail") {
            nextModify = "ok";
            send(500, { detail: "injected modify failure" });
            return;
          }
          if (nextModify === "applyThenFail") {
            nextModify = "ok";
            apply();
            send(500, { detail: "applied then failed" });
            return;
          }
          apply();
          send(200, userJson(name, u));
          return;
        }
      }
      send(404, { detail: "no route" });
    })();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      panelUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      resolve();
    });
  });
}

// --- fixtures ----------------------------------------------------------------
let panel: Panel;
let owner: Admin;
let seller: Admin;
let productId: string;

async function createUser(): Promise<User> {
  seq += 1;
  return prisma.user.create({ data: { telegramId: runTag + BigInt(seq) } });
}

interface CreateServiceArgs {
  volumeGib: number;
  usedGib: number;
  days: number | null; // null = never expires
  status?: "ACTIVE" | "LIMITED" | "DISABLED" | "EXPIRED";
}

async function createService(user: User, args: CreateServiceArgs): Promise<Service> {
  seq += 1;
  const username = `aso${runTag}u${seq}`;
  const volumeBytes = BigInt(args.volumeGib) * GIB;
  const usedBytes = BigInt(args.usedGib) * GIB;
  const remainingBytes = volumeBytes - usedBytes > 0n ? volumeBytes - usedBytes : 0n;
  const expiresAt = args.days === null ? null : new Date(Date.now() + args.days * DAY_MS);
  const marzbanStatus = (args.status ?? "ACTIVE") === "DISABLED" ? "disabled" : "active";
  panelUsers.set(username, {
    data_limit: Number(volumeBytes),
    expire: expiresAt === null ? 0 : Math.floor(expiresAt.getTime() / 1000),
    used_traffic: Number(usedBytes),
    status: marzbanStatus,
    subSeq: 0,
  });
  return prisma.service.create({
    data: {
      userId: user.id,
      panelId: panel.id,
      productId,
      panelType: "MARZBAN",
      username,
      status: args.status ?? "ACTIVE",
      volumeBytes,
      usedBytes,
      remainingBytes,
      expiresAt,
      startsAt: new Date(),
      subscriptionUrl: `${panelUrl}/sub/${username}-0`,
    },
  });
}

/** Runs one mutation through the executor with a valid fresh fingerprint. */
async function run(
  service: Service,
  type: AdminServiceMutationType,
  opts: {
    adminId?: string;
    requestedCount?: number;
    reason?: string;
    nonce?: string;
    fingerprint?: string;
    notifyUser?: boolean;
  } = {},
): Promise<Awaited<ReturnType<typeof executeAdminServiceOperation>>> {
  const detail = await getAdminServiceDetail(service.id.slice(0, 8));
  const fp =
    opts.fingerprint ??
    (detail === null
      ? "x"
      : adminServiceSnapshotFingerprint(buildAdminServiceSnapshot(detail.service, detail.panel)));
  return executeAdminServiceOperation({
    type,
    serviceId: service.id,
    adminId: opts.adminId ?? owner.id,
    reason: opts.reason ?? "admin operation test reason",
    requestedCount: opts.requestedCount ?? null,
    expectedFingerprint: fp,
    nonce: opts.nonce ?? randomUUID(),
    notifyUser: opts.notifyUser ?? true,
  });
}

interface FinancialSnapshot {
  orders: number;
  checkouts: number;
  payments: number;
  walletTx: number;
  discountUsage: number;
}
async function financialSnapshot(): Promise<FinancialSnapshot> {
  const [orders, checkouts, payments, walletTx, discountUsage] = await Promise.all([
    prisma.order.count(),
    prisma.checkoutSession.count(),
    prisma.payment.count(),
    prisma.walletTransaction.count(),
    prisma.discountCodeUsage.count(),
  ]);
  return { orders, checkouts, payments, walletTx, discountUsage };
}

describe.runIf(hasDeps)("admin service operations", () => {
  beforeAll(async () => {
    resetServiceLockClientForTests();
    await startMockPanel();
    owner = await prisma.admin.create({
      data: { telegramId: runTag + 800_000_000n, role: "OWNER", isActive: true },
    });
    seller = await prisma.admin.create({
      data: { telegramId: runTag + 800_000_001n, role: "SELLER", isActive: true },
    });
    panel = await prisma.panel.create({
      data: {
        type: "MARZBAN",
        name: `aso-panel-${runTag}`,
        baseUrl: panelUrl,
        username: "admin",
        passwordEncrypted: encryptSecret("mock-password"),
        status: "ACTIVE",
      },
    });
    const category = await prisma.productCategory.create({
      data: { type: "SERVICE_PRODUCT", name: `aso-cat-${runTag}`, isActive: true },
    });
    const product = await prisma.product.create({
      data: {
        type: "SERVICE_PRODUCT",
        categoryId: category.id,
        panelId: panel.id,
        name: `aso-product-${runTag}`,
        priceToman: 10_000,
        volumeGb: 10,
        durationDays: 30,
        isActive: true,
      },
    });
    productId = product.id;
  });

  beforeEach(async () => {
    nextModify = "ok";
    await setAdminServiceMutationsEnabled(true);
    clearSettingsCache();
  });

  afterAll(async () => {
    await setAdminServiceMutationsEnabled(false);
    server?.close();
    await prisma.$disconnect();
  });

  // --- §14 volume grant: preserve used, increase total+remaining equally ------
  it("grants volume preserving used and never resetting traffic", async () => {
    const user = await createUser();
    const service = await createService(user, { volumeGib: 10, usedGib: 3, days: 20 });
    const before = await financialSnapshot();

    const result = await run(service, "ADD_VOLUME", { requestedCount: 5 });
    expect(result.outcome).toBe("succeeded");

    const updated = await prisma.service.findUniqueOrThrow({ where: { id: service.id } });
    // total 10 -> 15, remaining 7 -> 12, used PRESERVED at 3.
    expect(updated.volumeBytes).toBe(15n * GIB);
    expect(updated.usedBytes).toBe(3n * GIB);
    expect(updated.remainingBytes).toBe(12n * GIB);
    expect(updated.status).toBe("ACTIVE");
    // Panel used_traffic must be untouched (no reset).
    expect(panelUsers.get(service.username)?.used_traffic).toBe(Number(3n * GIB));

    // Distinct admin audit event, no orderId, no financial rows (§6).
    const ev = await prisma.serviceEventLog.findFirst({
      where: { serviceId: service.id, eventType: EXTRA_VOLUME_GRANTED_BY_ADMIN_EVENT_TYPE },
    });
    expect(ev).not.toBeNull();
    expect((ev?.metadata as Record<string, unknown>)?.orderId).toBeUndefined();
    expect(await financialSnapshot()).toEqual(before);

    const op = await prisma.adminServiceOperation.findFirstOrThrow({
      where: { serviceId: service.id, type: "ADD_VOLUME" },
    });
    expect(op.status).toBe("SUCCEEDED");
    expect(op.adminId).toBe(owner.id);
    expect(op.afterSnapshot).not.toBeNull();
  });

  // --- §16 time grant: extend from current expiry, quota unchanged ------------
  it("grants time extending from the current expiry with quota unchanged", async () => {
    const user = await createUser();
    const service = await createService(user, { volumeGib: 10, usedGib: 2, days: 10 });
    const beforeExpiry = service.expiresAt!.getTime();

    const result = await run(service, "ADD_TIME", { requestedCount: 7 });
    expect(result.outcome).toBe("succeeded");

    const updated = await prisma.service.findUniqueOrThrow({ where: { id: service.id } });
    // future expiry + 7 days (~within a minute tolerance).
    expect(updated.expiresAt!.getTime()).toBeGreaterThan(beforeExpiry + 6.9 * DAY_MS);
    expect(updated.volumeBytes).toBe(10n * GIB); // quota unchanged
    expect(updated.usedBytes).toBe(2n * GIB); // usage never reset
    const ev = await prisma.serviceEventLog.findFirst({
      where: { serviceId: service.id, eventType: EXTRA_TIME_GRANTED_BY_ADMIN_EVENT_TYPE },
    });
    expect(ev).not.toBeNull();
  });

  it("extends an EXPIRED service from now (revival)", async () => {
    const user = await createUser();
    const service = await createService(user, { volumeGib: 10, usedGib: 1, days: -3, status: "EXPIRED" });
    const result = await run(service, "ADD_TIME", { requestedCount: 5 });
    expect(result.outcome).toBe("succeeded");
    const updated = await prisma.service.findUniqueOrThrow({ where: { id: service.id } });
    // past expiry -> now + 5 days.
    expect(updated.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 4.9 * DAY_MS);
    expect(updated.status).toBe("ACTIVE");
  });

  // --- §13 enable / disable ---------------------------------------------------
  it("disables and re-enables a service, auditing the admin actor", async () => {
    const user = await createUser();
    const service = await createService(user, { volumeGib: 10, usedGib: 1, days: 20 });

    const disabled = await run(service, "DISABLE");
    expect(disabled.outcome).toBe("succeeded");
    let updated = await prisma.service.findUniqueOrThrow({ where: { id: service.id } });
    expect(updated.status).toBe("DISABLED");
    const disEv = await prisma.serviceEventLog.findFirst({
      where: { serviceId: service.id, eventType: SERVICE_DISABLED_BY_ADMIN_EVENT_TYPE },
    });
    expect(disEv).not.toBeNull();
    // NEVER audited as the user.
    expect(
      await prisma.serviceEventLog.count({
        where: { serviceId: service.id, eventType: "SERVICE_DISABLED_BY_USER" },
      }),
    ).toBe(0);

    const enabled = await run(service, "ENABLE");
    expect(enabled.outcome).toBe("succeeded");
    updated = await prisma.service.findUniqueOrThrow({ where: { id: service.id } });
    expect(updated.status).toBe("ACTIVE");
    const enEv = await prisma.serviceEventLog.findFirst({
      where: { serviceId: service.id, eventType: SERVICE_ENABLED_BY_ADMIN_EVENT_TYPE },
    });
    expect(enEv).not.toBeNull();
  });

  // --- §16 regenerate link ----------------------------------------------------
  it("regenerates the subscription link (revokes on the panel)", async () => {
    const user = await createUser();
    const service = await createService(user, { volumeGib: 10, usedGib: 1, days: 20 });
    const result = await run(service, "REGENERATE_LINK");
    expect(result.outcome).toBe("succeeded");
    expect(panelUsers.get(service.username)?.subSeq).toBe(1);
    // The event log NEVER stores a link/token — booleans only.
    const ev = await prisma.serviceEventLog.findFirst({
      where: { serviceId: service.id, eventType: "SERVICE_SUBSCRIPTION_REGENERATED_BY_ADMIN" },
    });
    expect(ev).not.toBeNull();
    const meta = JSON.stringify(ev?.metadata ?? {});
    expect(meta).not.toContain("http");
    expect(meta).not.toContain("/sub/");
  });

  // --- §6 financial isolation across a batch of grants ------------------------
  it("never touches any financial table across a batch of admin operations", async () => {
    const user = await createUser();
    const before = await financialSnapshot();
    const balanceBefore = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).balanceToman;

    const s1 = await createService(user, { volumeGib: 10, usedGib: 4, days: 15 });
    await run(s1, "ADD_VOLUME", { requestedCount: 10 });
    await run(s1, "ADD_TIME", { requestedCount: 3 });
    await run(s1, "DISABLE");
    await run(s1, "ENABLE");
    await run(s1, "REGENERATE_LINK");

    expect(await financialSnapshot()).toEqual(before);
    const balanceAfter = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).balanceToman;
    expect(balanceAfter).toBe(balanceBefore);
  });

  // --- §3 rollout gates -------------------------------------------------------
  it("fails closed when mutations are disabled", async () => {
    await setAdminServiceMutationsEnabled(false);
    clearSettingsCache();
    const user = await createUser();
    const service = await createService(user, { volumeGib: 10, usedGib: 1, days: 20 });
    const result = await run(service, "ADD_VOLUME", { requestedCount: 5 });
    expect(result).toEqual({ outcome: "rejected", errorCode: "MUTATIONS_DISABLED" });
    // No row, no panel change.
    expect(await prisma.adminServiceOperation.count({ where: { serviceId: service.id } })).toBe(0);
    expect(panelUsers.get(service.username)?.data_limit).toBe(Number(10n * GIB));
  });

  it("rejects a non-OWNER admin", async () => {
    const user = await createUser();
    const service = await createService(user, { volumeGib: 10, usedGib: 1, days: 20 });
    const result = await run(service, "DISABLE", { adminId: seller.id });
    expect(result).toEqual({ outcome: "rejected", errorCode: "NOT_OWNER" });
  });

  // --- §22 stale preview ------------------------------------------------------
  it("rejects a stale preview (fingerprint mismatch)", async () => {
    const user = await createUser();
    const service = await createService(user, { volumeGib: 10, usedGib: 1, days: 20 });
    const result = await run(service, "DISABLE", { fingerprint: "definitely-stale" });
    expect(result).toEqual({ outcome: "rejected", errorCode: "STALE_PREVIEW" });
    const updated = await prisma.service.findUniqueOrThrow({ where: { id: service.id } });
    expect(updated.status).toBe("ACTIVE"); // untouched
  });

  // --- idempotency: same nonce converges --------------------------------------
  it("converges a repeated confirm (same nonce) to one operation", async () => {
    const user = await createUser();
    const service = await createService(user, { volumeGib: 10, usedGib: 2, days: 20 });
    const nonce = randomUUID();
    const first = await run(service, "ADD_VOLUME", { requestedCount: 5, nonce });
    expect(first.outcome).toBe("succeeded");
    const second = await run(service, "ADD_VOLUME", { requestedCount: 5, nonce });
    expect(second.outcome).toBe("succeeded");
    // Only ONE grant applied and ONE operation row.
    const updated = await prisma.service.findUniqueOrThrow({ where: { id: service.id } });
    expect(updated.volumeBytes).toBe(15n * GIB);
    expect(
      await prisma.adminServiceOperation.count({ where: { serviceId: service.id, type: "ADD_VOLUME" } }),
    ).toBe(1);
  });

  // --- eligibility blocks -----------------------------------------------------
  it("blocks a volume grant on an unlimited-volume service", async () => {
    const user = await createUser();
    const service = await createService(user, { volumeGib: 0, usedGib: 0, days: 20 });
    const result = await run(service, "ADD_VOLUME", { requestedCount: 5 });
    expect(result.outcome).toBe("rejected");
    if (result.outcome === "rejected") {
      expect(result.errorCode).toBe("UNLIMITED_BLOCKED");
    }
  });

  it("blocks a time grant on a never-expiring service", async () => {
    const user = await createUser();
    const service = await createService(user, { volumeGib: 10, usedGib: 1, days: null });
    const result = await run(service, "ADD_TIME", { requestedCount: 5 });
    expect(result.outcome).toBe("rejected");
    if (result.outcome === "rejected") {
      expect(result.errorCode).toBe("NEVER_EXPIRING_BLOCKED");
    }
  });

  it("does not offer volume/time on a disabled service (eligibility)", async () => {
    const user = await createUser();
    const service = await createService(user, { volumeGib: 10, usedGib: 1, days: 20, status: "DISABLED" });
    const detail = await getAdminServiceDetail(service.id.slice(0, 8));
    const eligible = adminServiceEligibleMutations(detail!.service, detail!.panel);
    expect(eligible).toContain("ENABLE");
    expect(eligible).not.toContain("ADD_VOLUME");
    expect(eligible).not.toContain("ADD_TIME");
  });

  // --- §17 internal notes -----------------------------------------------------
  it("records an immutable internal note without a panel call", async () => {
    const user = await createUser();
    const service = await createService(user, { volumeGib: 10, usedGib: 1, days: 20 });
    const before = await financialSnapshot();
    const nonce = randomUUID();
    const r1 = await addAdminServiceNote({
      serviceId: service.id,
      adminId: owner.id,
      note: "internal reminder for the account",
      nonce,
    });
    expect(r1.ok).toBe(true);
    // Idempotent on the nonce.
    const r2 = await addAdminServiceNote({
      serviceId: service.id,
      adminId: owner.id,
      note: "internal reminder for the account",
      nonce,
    });
    expect(r2.ok).toBe(true);
    expect(
      await prisma.adminServiceOperation.count({ where: { serviceId: service.id, type: "ADD_NOTE" } }),
    ).toBe(1);
    const op = await prisma.adminServiceOperation.findFirstOrThrow({
      where: { serviceId: service.id, type: "ADD_NOTE" },
    });
    expect(op.status).toBe("SUCCEEDED");
    expect(op.reason).toBe("internal reminder for the account");
    expect(op.notifyUser).toBe(false);
    expect(
      await prisma.serviceEventLog.count({
        where: { serviceId: service.id, eventType: ADMIN_SERVICE_NOTE_EVENT_TYPE },
      }),
    ).toBe(1);
    // No panel change, no financial rows.
    expect(await financialSnapshot()).toEqual(before);
  });

  it("rejects an out-of-range note", async () => {
    const user = await createUser();
    const service = await createService(user, { volumeGib: 10, usedGib: 1, days: 20 });
    const result = await addAdminServiceNote({
      serviceId: service.id,
      adminId: owner.id,
      note: "",
      nonce: randomUUID(),
    });
    expect(result).toEqual({ ok: false, errorCode: "VALIDATION" });
  });

  // --- §9 read-only refresh ---------------------------------------------------
  it("read-only refresh syncs from the panel and creates no operation row", async () => {
    const user = await createUser();
    const service = await createService(user, { volumeGib: 10, usedGib: 1, days: 20 });
    // Mutate the panel out-of-band (used grows).
    panelUsers.get(service.username)!.used_traffic = Number(6n * GIB);
    const outcome = await refreshAdminServiceReadOnly(service.id, user.id);
    expect(outcome.kind).toBe("refreshed");
    const updated = await prisma.service.findUniqueOrThrow({ where: { id: service.id } });
    expect(updated.usedBytes).toBe(6n * GIB);
    expect(await prisma.adminServiceOperation.count({ where: { serviceId: service.id } })).toBe(0);
  });

  it("read-only refresh distinguishes a positive not-found", async () => {
    const user = await createUser();
    const service = await createService(user, { volumeGib: 10, usedGib: 1, days: 20 });
    panelUsers.delete(service.username); // panel now reports 404
    const outcome = await refreshAdminServiceReadOnly(service.id, user.id);
    expect(outcome.kind).toBe("not-found");
  });

  it("read-only refresh works even while mutations are disabled", async () => {
    await setAdminServiceMutationsEnabled(false);
    clearSettingsCache();
    const user = await createUser();
    const service = await createService(user, { volumeGib: 10, usedGib: 1, days: 20 });
    const outcome = await refreshAdminServiceReadOnly(service.id, user.id);
    expect(outcome.kind).toBe("refreshed");
  });

  // --- §11 uncertain: possibly-landed grant is never FAILED -------------------
  it("classifies a landed-but-errored grant as RECONCILIATION_REQUIRED and blocks conflicts", async () => {
    const user = await createUser();
    const service = await createService(user, { volumeGib: 10, usedGib: 2, days: 20 });
    nextModify = "applyThenFail"; // panel applies the change then returns 500
    const result = await run(service, "ADD_VOLUME", { requestedCount: 5 });
    expect(result.outcome).toBe("uncertain");
    if (result.outcome === "uncertain") {
      expect(result.status).toBe("RECONCILIATION_REQUIRED");
    }
    // Local row NOT mutated (persist only on definite success).
    const updated = await prisma.service.findUniqueOrThrow({ where: { id: service.id } });
    expect(updated.volumeBytes).toBe(10n * GIB);
    // A new conflicting mutation is blocked.
    expect(await countUnresolvedAdminOperations(service.id)).toBe(1);
    const conflict = await run(service, "DISABLE");
    expect(conflict).toEqual({ outcome: "rejected", errorCode: "CONFLICTING_OPERATION" });

    // §18 reconciliation confirms the grant landed and resolves it.
    const op = await prisma.adminServiceOperation.findFirstOrThrow({
      where: { serviceId: service.id, type: "ADD_VOLUME" },
    });
    const recon = await reconcileAdminServiceOperation(op.id, owner.id);
    expect(recon.kind).toBe("reconciled");
    if (recon.kind === "reconciled") {
      expect(recon.newStatus).toBe("RECONCILED");
    }
    const synced = await prisma.service.findUniqueOrThrow({ where: { id: service.id } });
    expect(synced.volumeBytes).toBe(15n * GIB); // local now matches panel truth
    expect(await countUnresolvedAdminOperations(service.id)).toBe(0);
  });

  // --- P2: a time grant persists LIVE usage/remaining, not stale DB values ----
  it("persists live traffic and derives status from it after a time grant", async () => {
    const user = await createUser();
    // DB shows remaining quota, but the panel is exhausted out-of-band.
    const service = await createService(user, { volumeGib: 10, usedGib: 2, days: 10 });
    panelUsers.get(service.username)!.used_traffic = Number(10n * GIB); // fully used remotely
    const result = await run(service, "ADD_TIME", { requestedCount: 5 });
    expect(result.outcome).toBe("succeeded");
    const updated = await prisma.service.findUniqueOrThrow({ where: { id: service.id } });
    expect(updated.usedBytes).toBe(10n * GIB);
    expect(updated.remainingBytes).toBe(0n);
    // Exhausted finite volume → LIMITED, derived from the LIVE remaining.
    expect(updated.status).toBe("LIMITED");
  });

  // --- P2: OWNER manual review is a terminal resolution for a blocked op ------
  it("lets the OWNER manually resolve an unverifiable blocking operation", async () => {
    const user = await createUser();
    const service = await createService(user, { volumeGib: 10, usedGib: 1, days: 20 });
    const detail = await getAdminServiceDetail(service.id.slice(0, 8));
    // Simulate an uncertain regeneration that reconciliation can't classify.
    await prisma.adminServiceOperation.create({
      data: {
        serviceId: service.id,
        targetUserId: user.id,
        adminId: owner.id,
        type: "REGENERATE_LINK",
        status: "RECONCILIATION_REQUIRED",
        reason: "uncertain regen",
        idempotencyKey: `test-review-${runTag}-${service.id.slice(0, 8)}`,
        beforeSnapshot: buildAdminServiceSnapshot(detail!.service, detail!.panel) as never,
        startedAt: new Date(),
        completedAt: new Date(),
        safeErrorCode: "PANEL_UNCERTAIN",
      },
    });
    expect(await countUnresolvedAdminOperations(service.id)).toBe(1);
    // Reconciliation stays inconclusive for a regeneration; the op remains blocking.
    const op = await prisma.adminServiceOperation.findFirstOrThrow({
      where: { serviceId: service.id, type: "REGENERATE_LINK" },
    });
    const recon = await reconcileAdminServiceOperation(op.id, owner.id);
    expect(recon.kind).toBe("still-uncertain");
    expect(await countUnresolvedAdminOperations(service.id)).toBe(1);
    // The OWNER manually marks it reviewed → terminal RECONCILED, unblocking.
    const reviewed = await markAdminServiceOperationReviewed(op.id, owner.id);
    expect(reviewed.kind).toBe("resolved");
    const resolved = await prisma.adminServiceOperation.findUniqueOrThrow({ where: { id: op.id } });
    expect(resolved.status).toBe("RECONCILED");
    expect(resolved.reconciledByAdminId).toBe(owner.id);
    expect(await countUnresolvedAdminOperations(service.id)).toBe(0);
  });

  it("classifies a definite modify failure as FAILED with no local change", async () => {
    const user = await createUser();
    const service = await createService(user, { volumeGib: 10, usedGib: 2, days: 20 });
    nextModify = "fail"; // panel rejects without applying
    const result = await run(service, "ADD_VOLUME", { requestedCount: 5 });
    expect(result.outcome).toBe("failed");
    const updated = await prisma.service.findUniqueOrThrow({ where: { id: service.id } });
    expect(updated.volumeBytes).toBe(10n * GIB);
    const op = await prisma.adminServiceOperation.findFirstOrThrow({
      where: { serviceId: service.id, type: "ADD_VOLUME" },
    });
    expect(op.status).toBe("FAILED");
    // A FAILED op does not block a subsequent operation.
    expect(await countUnresolvedAdminOperations(service.id)).toBe(0);
  });
});
