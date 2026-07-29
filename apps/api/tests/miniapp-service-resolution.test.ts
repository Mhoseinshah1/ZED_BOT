import { PanelStatus, prisma, ServiceStatus } from "@zedbot/database";
import { resolveOwnedService, servicePublicId } from "@zedbot/service-renewal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// =============================================================================
// RS — owner-scoped Service resolution.
//
// This is the gate every owner-scoped Mini App commerce operation passes
// through, so the interesting assertions are not "does it find the right row"
// but "are all the ways it can refuse indistinguishable from one another".
//
// A caller who can tell "malformed" from "not yours" from "deleted" has an
// oracle: feed it prefixes, read the differences, and map out which services
// exist and who owns them. So every refusal below asserts the SAME value —
// `null` — and RS-13 asserts that on purpose as a single property rather than
// leaving it implied by twelve separate cases.
//
// Real rows, real Prisma, real panels. Without DATABASE_URL the suite skips
// itself (docs/testing.md).
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

const runTag = `${Date.now() % 1_000_000_000}`;

let ownerId = "";
let strangerId = "";
let activePanelId = "";
let disabledPanelId = "";
let xuiPanelId = "";
const serviceIds: string[] = [];
const panelIds: string[] = [];
const userIds: string[] = [];

async function makeUser(label: string): Promise<string> {
  const user = await prisma.user.create({
    data: {
      telegramId: BigInt(`${Date.now() % 1_000_000}${label.length}${userIds.length}`) * 1000n,
      firstName: `rs-${label}`,
      balanceToman: 0,
    },
  });
  userIds.push(user.id);
  return user.id;
}

async function makePanel(
  label: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const panel = await prisma.panel.create({
    data: {
      type: "MARZBAN",
      name: `rs-${runTag}-${label}`,
      baseUrl: `https://rs-${label}.internal.example`,
      username: "panel-admin",
      passwordEncrypted: "encrypted-blob",
      status: PanelStatus.ACTIVE,
      ...overrides,
    },
  });
  panelIds.push(panel.id);
  return panel.id;
}

async function makeService(
  userId: string,
  panelId: string,
  label: string,
  overrides: Record<string, unknown> = {},
) {
  const service = await prisma.service.create({
    data: {
      userId,
      panelId,
      panelType: "MARZBAN",
      username: `rs-${runTag}-${label}`,
      status: ServiceStatus.ACTIVE,
      volumeBytes: 1n,
      usedBytes: 0n,
      remainingBytes: 1n,
      durationDays: 30,
      ...overrides,
    },
  });
  serviceIds.push(service.id);
  return service;
}

beforeAll(async () => {
  if (!hasDb) return;
  ownerId = await makeUser("owner");
  strangerId = await makeUser("stranger");
  activePanelId = await makePanel("active");
  disabledPanelId = await makePanel("disabled", { status: PanelStatus.INACTIVE });
  xuiPanelId = await makePanel("xui", { type: "XUI", apiVariant: "SANAEI" });
});

afterAll(async () => {
  if (!hasDb) return;
  if (serviceIds.length > 0) {
    await prisma.service.deleteMany({ where: { id: { in: serviceIds } } });
  }
  if (panelIds.length > 0) {
    await prisma.panel.deleteMany({ where: { id: { in: panelIds } } });
  }
  if (userIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
});

describe.skipIf(!hasDb)("owner-scoped service resolution", () => {
  // RS-1 -----------------------------------------------------------------------
  it("RS-1: resolves a service the caller owns, with its panel", async () => {
    const svc = await makeService(ownerId, activePanelId, "owned-1");
    const found = await resolveOwnedService(
      prisma,
      ownerId,
      servicePublicId(svc),
      "renewService",
    );
    expect(found).not.toBeNull();
    expect(found?.service.id).toBe(svc.id);
    expect(found?.panel.id).toBe(activePanelId);
  });

  // RS-2 -----------------------------------------------------------------------
  it("RS-2: a malformed public id resolves to null", async () => {
    for (const bad of ["", "abc", "zzzzzzzz", "0123456789abcdef", "0123-456", "  ", "../../etc"]) {
      expect(await resolveOwnedService(prisma, ownerId, bad, "renewService")).toBeNull();
    }
  });

  // RS-3 -----------------------------------------------------------------------
  it("RS-3: a well-formed id nobody owns resolves to null", async () => {
    expect(await resolveOwnedService(prisma, ownerId, "deadbeef", "renewService")).toBeNull();
  });

  // RS-4 -----------------------------------------------------------------------
  it("RS-4: an ambiguous prefix refuses rather than picking one", async () => {
    // Two rows the caller owns whose ids share the whole 8-character public
    // prefix. Astronomically unlikely in production and catastrophic if the
    // resolver guessed, so it is constructed explicitly here.
    const a = await makeService(ownerId, activePanelId, "ambig-a");
    const shared = servicePublicId(a);
    const collidingId = `${shared}${a.id.slice(8, 36).replace(/^./, (c) => (c === "0" ? "1" : "0"))}`;
    const b = await prisma.service.create({
      data: {
        id: collidingId,
        userId: ownerId,
        panelId: activePanelId,
        panelType: "MARZBAN",
        username: `rs-${runTag}-ambig-b`,
        status: ServiceStatus.ACTIVE,
        volumeBytes: 1n,
        usedBytes: 0n,
        remainingBytes: 1n,
        durationDays: 30,
      },
    });
    serviceIds.push(b.id);
    expect(servicePublicId(b)).toBe(shared);

    expect(await resolveOwnedService(prisma, ownerId, shared, "renewService")).toBeNull();
  });

  // RS-5 -----------------------------------------------------------------------
  it("RS-5: another user's service is indistinguishable from missing", async () => {
    const foreign = await makeService(strangerId, activePanelId, "foreign");
    // The stranger can resolve it; the owner cannot. Both halves matter: the
    // first proves the row is genuinely resolvable, so the second is really
    // testing the ownership scope rather than a broken fixture.
    expect(
      await resolveOwnedService(prisma, strangerId, servicePublicId(foreign), "renewService"),
    ).not.toBeNull();
    expect(
      await resolveOwnedService(prisma, ownerId, servicePublicId(foreign), "renewService"),
    ).toBeNull();
  });

  // RS-6 -----------------------------------------------------------------------
  it("RS-6: a soft-deleted service resolves to null", async () => {
    const svc = await makeService(ownerId, activePanelId, "soft", { deletedAt: new Date() });
    expect(
      await resolveOwnedService(prisma, ownerId, servicePublicId(svc), "renewService"),
    ).toBeNull();
  });

  // RS-7 -----------------------------------------------------------------------
  it("RS-7: status DELETED resolves to null", async () => {
    const svc = await makeService(ownerId, activePanelId, "status-del", {
      status: ServiceStatus.DELETED,
    });
    expect(
      await resolveOwnedService(prisma, ownerId, servicePublicId(svc), "renewService"),
    ).toBeNull();
  });

  // RS-8 -----------------------------------------------------------------------
  it("RS-8: a disabled panel makes its services unresolvable for operations", async () => {
    const svc = await makeService(ownerId, disabledPanelId, "disabled-panel");
    expect(
      await resolveOwnedService(prisma, ownerId, servicePublicId(svc), "renewService"),
    ).toBeNull();
  });

  // RS-9 -----------------------------------------------------------------------
  it("RS-9: an operation the panel's adapter cannot perform resolves to null", async () => {
    const svc = await makeService(ownerId, activePanelId, "unsupported");
    // The service itself is fine — same row, resolvable for a capability the
    // Marzban adapter implements.
    expect(
      await resolveOwnedService(prisma, ownerId, servicePublicId(svc), "renewService"),
    ).not.toBeNull();
    expect(
      await resolveOwnedService(
        prisma,
        ownerId,
        servicePublicId(svc),
        "totallyNotACapability" as never,
      ),
    ).toBeNull();
  });

  // RS-10 ----------------------------------------------------------------------
  it("RS-10: a legacy per-inbound XUI service is never resolvable for mutation", async () => {
    const legacy = await makeService(ownerId, xuiPanelId, "legacy-xui", {
      panelType: "XUI",
      remoteMetadata: { clients: [{ email: `rs-${runTag}-legacy-xui-3` }] },
    });
    expect(
      await resolveOwnedService(prisma, ownerId, servicePublicId(legacy), "renewService"),
    ).toBeNull();
  });

  // RS-11 ----------------------------------------------------------------------
  it("RS-11: a global-client XUI service resolves normally", async () => {
    const modern = await makeService(ownerId, xuiPanelId, "global-xui", {
      panelType: "XUI",
      remoteMetadata: { email: `rs-${runTag}-global-xui` },
    });
    expect(
      await resolveOwnedService(prisma, ownerId, servicePublicId(modern), "renewService"),
    ).not.toBeNull();
  });

  // RS-12 ----------------------------------------------------------------------
  it("RS-12: EXPIRED, LIMITED and DISABLED services stay operable", async () => {
    // The person most likely to want a renewal is the one whose service ran
    // out, so these must resolve rather than being treated as gone.
    for (const status of [
      ServiceStatus.EXPIRED,
      ServiceStatus.LIMITED,
      ServiceStatus.DISABLED,
    ]) {
      const svc = await makeService(ownerId, activePanelId, `st-${status}`, { status });
      expect(
        await resolveOwnedService(prisma, ownerId, servicePublicId(svc), "renewService"),
        `${status} must stay renewable`,
      ).not.toBeNull();
    }
  });

  // RS-13 ----------------------------------------------------------------------
  it("RS-13: every refusal is the same value, so none of them is an oracle", async () => {
    const foreign = await makeService(strangerId, activePanelId, "oracle-foreign");
    const deleted = await makeService(ownerId, activePanelId, "oracle-deleted", {
      deletedAt: new Date(),
    });
    const onDisabled = await makeService(ownerId, disabledPanelId, "oracle-panel");

    const refusals = await Promise.all([
      resolveOwnedService(prisma, ownerId, "zzzzzzzz", "renewService"), // malformed
      resolveOwnedService(prisma, ownerId, "deadbeef", "renewService"), // missing
      resolveOwnedService(prisma, ownerId, servicePublicId(foreign), "renewService"),
      resolveOwnedService(prisma, ownerId, servicePublicId(deleted), "renewService"),
      resolveOwnedService(prisma, ownerId, servicePublicId(onDisabled), "renewService"),
    ]);
    // Not `every(r => r === null)` — an assertion on the whole array shows the
    // shape in the failure message if one of them ever starts differing.
    expect(refusals).toEqual([null, null, null, null, null]);
  });

  // RS-14 ----------------------------------------------------------------------
  it("RS-14: the resolved object carries no secret the browser must not see", async () => {
    const svc = await makeService(ownerId, activePanelId, "no-secrets");
    const found = await resolveOwnedService(
      prisma,
      ownerId,
      servicePublicId(svc),
      "renewService",
    );
    expect(found).not.toBeNull();
    // The resolver returns full rows on purpose — the SERVER needs the panel
    // credentials to act. What matters is that this is a server-side value and
    // the serialisers, not the resolver, decide what reaches the browser. This
    // test pins the boundary: the row is here, so any DTO built from it must be
    // an explicit allowlist rather than a spread.
    expect(found?.panel.passwordEncrypted).toBe("encrypted-blob");
    // And the public id never widens into the uuid.
    expect(servicePublicId(svc)).toHaveLength(8);
    expect(svc.id.startsWith(servicePublicId(svc))).toBe(true);
  });
});
