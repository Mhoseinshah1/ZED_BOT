import { PanelStatus, prisma, ServiceStatus } from "@zedbot/database";
import {
  extraTimePackages,
  extraVolumePackages,
  isExtraTimePackageValid,
  isExtraVolumePackageValid,
  isRenewalPlanValid,
  listServiceOperationOptions,
  optionPublicId,
  renewalPlansForPanel,
  resolveServiceOperationOption,
  servicePublicId,
  type ServiceOperation,
} from "@zedbot/service-renewal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// =============================================================================
// OPT — the renewal / extra-volume / extra-time option authority.
//
// TWO PROPERTIES ARE ON TRIAL HERE, and the cases below are organised around
// them rather than around the three operations:
//
//   1. AN INELIGIBLE OPTION IS INDISTINGUISHABLE FROM ONE THAT NEVER EXISTED.
//      Deleted, deactivated, hidden from this group, moved to another panel,
//      incompatible with the panel's adapter, incompatible with the service's
//      remote model, ambiguous prefix, malformed prefix — one answer,
//      OPTION_UNAVAILABLE. Anything finer is a catalog-enumeration oracle.
//
//   2. THE SHARED AUTHORITY AND THE BOT AGREE, EXACTLY. Not "similar prices" —
//      the same list, the same order, the same numbers. The parity cases assert
//      the bot's own predicates against the shared ones on the same rows, which
//      is the only assertion that stays true after someone edits one of them.
//
// Real rows, real Prisma, real panels. Without DATABASE_URL the suite skips
// itself (docs/testing.md).
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

const runTag = `${Date.now() % 1_000_000_000}`;
let seq = 0;

let ownerId = "";
let strangerId = "";
let marzbanPanelId = "";
let otherPanelId = "";
let xuiPanelId = "";
let categoryId = "";
let inactiveCategoryId = "";

const serviceIds: string[] = [];
const panelIds: string[] = [];
const userIds: string[] = [];
const productIds: string[] = [];
const categoryIds: string[] = [];

async function makeUser(label: string, group: "F" | "N" | "N2" = "F"): Promise<string> {
  const user = await prisma.user.create({
    data: {
      telegramId: BigInt(`9${runTag}${(seq += 1)}`),
      firstName: `opt-${label}`,
      balanceToman: 0,
      group,
    },
  });
  userIds.push(user.id);
  return user.id;
}

async function makePanel(label: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const panel = await prisma.panel.create({
    data: {
      type: "MARZBAN",
      name: `opt-${runTag}-${label}`,
      baseUrl: `https://opt-${label}-${runTag}.internal.example`,
      username: "panel-admin",
      passwordEncrypted: "encrypted-blob",
      status: PanelStatus.ACTIVE,
      templateUsername: "template-user",
      ...overrides,
    },
  });
  panelIds.push(panel.id);
  return panel.id;
}

async function makeCategory(label: string, isActive = true): Promise<string> {
  const category = await prisma.productCategory.create({
    data: { type: "SERVICE_PRODUCT", name: `opt-${runTag}-${label}`, isActive, displayOrder: 1 },
  });
  categoryIds.push(category.id);
  return category.id;
}

async function makeProduct(
  label: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const product = await prisma.product.create({
    data: {
      type: "SERVICE_PRODUCT",
      name: `opt-${runTag}-${label}`,
      categoryId,
      panelId: marzbanPanelId,
      priceToman: 100_000,
      durationDays: 30,
      volumeGb: 50,
      isActive: true,
      displayGroups: ["ALL"],
      ...overrides,
    },
  });
  productIds.push(product.id);
  return product.id;
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
      username: `opt-${runTag}-${label}`,
      status: ServiceStatus.ACTIVE,
      volumeBytes: 1_000_000n,
      usedBytes: 0n,
      remainingBytes: 1_000_000n,
      durationDays: 30,
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
      ...overrides,
    },
  });
  serviceIds.push(service.id);
  return service;
}

/** Reload a product with the relations the shared predicates consume. */
async function withRelations(productId: string) {
  return prisma.product.findUniqueOrThrow({
    where: { id: productId },
    include: { category: true, panel: true },
  });
}

const ALL_OPERATIONS: ServiceOperation[] = ["RENEWAL", "EXTRA_VOLUME", "EXTRA_TIME"];

beforeAll(async () => {
  if (!hasDb) return;
  ownerId = await makeUser("owner");
  strangerId = await makeUser("stranger");
  marzbanPanelId = await makePanel("marzban");
  otherPanelId = await makePanel("other");
  xuiPanelId = await makePanel("xui", {
    type: "XUI",
    apiVariant: "SANAEI",
    authMode: "SESSION_COOKIE",
    inboundIds: [1],
  });
  categoryId = await makeCategory("cat");
  inactiveCategoryId = await makeCategory("cat-off", false);
});

afterAll(async () => {
  if (!hasDb) return;
  if (serviceIds.length > 0) {
    await prisma.service.deleteMany({ where: { id: { in: serviceIds } } });
  }
  if (productIds.length > 0) {
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
  }
  if (categoryIds.length > 0) {
    await prisma.productCategory.deleteMany({ where: { id: { in: categoryIds } } });
  }
  if (panelIds.length > 0) {
    await prisma.panel.deleteMany({ where: { id: { in: panelIds } } });
  }
  if (userIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
});

describe.skipIf(!hasDb)("service operation options", () => {
  // --- the happy paths, one per operation -----------------------------------

  // OPT-1 ---------------------------------------------------------------------
  it("OPT-1: lists valid renewal options for an owned service", async () => {
    const svc = await makeService(ownerId, marzbanPanelId, "renew-ok");
    const productId = await makeProduct("renew-plan");
    const result = await listServiceOperationOptions(prisma, {
      userId: ownerId,
      publicServiceId: servicePublicId(svc),
      operation: "RENEWAL",
      group: "F",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.options.map((o) => o.optionId);
    expect(ids).toContain(optionPublicId({ id: productId }));
    const option = result.options.find((o) => o.optionId === optionPublicId({ id: productId }));
    expect(option).toMatchObject({
      operation: "RENEWAL",
      priceToman: 100_000,
      durationDays: 30,
      trafficGb: 50,
      currency: "IRT",
      available: true,
    });
  });

  // OPT-2 ---------------------------------------------------------------------
  it("OPT-2: lists valid extra-volume options", async () => {
    const svc = await makeService(ownerId, marzbanPanelId, "vol-ok");
    const productId = await makeProduct("vol-pack", { volumeGb: 25, durationDays: null });
    const result = await listServiceOperationOptions(prisma, {
      userId: ownerId,
      publicServiceId: servicePublicId(svc),
      operation: "EXTRA_VOLUME",
      group: "F",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const option = result.options.find((o) => o.optionId === optionPublicId({ id: productId }));
    expect(option).toBeDefined();
    expect(option?.trafficGb).toBe(25);
    // Extra volume grants NO time, so the DTO must not advertise any, even
    // though some packages carry a durationDays the operation ignores.
    expect(option?.durationDays).toBeNull();
  });

  // OPT-3 ---------------------------------------------------------------------
  it("OPT-3: lists valid extra-time options", async () => {
    const svc = await makeService(ownerId, marzbanPanelId, "time-ok");
    const productId = await makeProduct("time-pack", { durationDays: 60, volumeGb: 10 });
    const result = await listServiceOperationOptions(prisma, {
      userId: ownerId,
      publicServiceId: servicePublicId(svc),
      operation: "EXTRA_TIME",
      group: "F",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const option = result.options.find((o) => o.optionId === optionPublicId({ id: productId }));
    expect(option?.durationDays).toBe(60);
    // Symmetrically: extra time never grants traffic, so no traffic is promised.
    expect(option?.trafficGb).toBeNull();
  });

  // --- eligibility exclusions -----------------------------------------------

  // OPT-4 ---------------------------------------------------------------------
  it("OPT-4: an inactive Product is excluded from every operation", async () => {
    const svc = await makeService(ownerId, marzbanPanelId, "inactive-prod");
    const productId = await makeProduct("inactive", { isActive: false });
    for (const operation of ALL_OPERATIONS) {
      const result = await listServiceOperationOptions(prisma, {
        userId: ownerId,
        publicServiceId: servicePublicId(svc),
        operation,
        group: "F",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.options.map((o) => o.optionId)).not.toContain(
        optionPublicId({ id: productId }),
      );
    }
  });

  // OPT-5 ---------------------------------------------------------------------
  it("OPT-5: a Product in an inactive Category is excluded", async () => {
    const svc = await makeService(ownerId, marzbanPanelId, "inactive-cat");
    const productId = await makeProduct("cat-off-prod", { categoryId: inactiveCategoryId });
    const result = await listServiceOperationOptions(prisma, {
      userId: ownerId,
      publicServiceId: servicePublicId(svc),
      operation: "RENEWAL",
      group: "F",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.options.map((o) => o.optionId)).not.toContain(optionPublicId({ id: productId }));
  });

  // OPT-6 ---------------------------------------------------------------------
  it("OPT-6: a Product on another Panel is excluded", async () => {
    const svc = await makeService(ownerId, marzbanPanelId, "other-panel");
    const productId = await makeProduct("foreign-panel", { panelId: otherPanelId });
    const result = await listServiceOperationOptions(prisma, {
      userId: ownerId,
      publicServiceId: servicePublicId(svc),
      operation: "RENEWAL",
      group: "F",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.options.map((o) => o.optionId)).not.toContain(optionPublicId({ id: productId }));
  });

  // OPT-7 ---------------------------------------------------------------------
  it("OPT-7: a service on an INACTIVE panel is not found at all", async () => {
    const deadPanelId = await makePanel("dead", { status: PanelStatus.INACTIVE });
    const svc = await makeService(ownerId, deadPanelId, "dead-panel");
    for (const operation of ALL_OPERATIONS) {
      const result = await listServiceOperationOptions(prisma, {
        userId: ownerId,
        publicServiceId: servicePublicId(svc),
        operation,
        group: "F",
      });
      // Not "no options" — NOT FOUND. Whether a service exists on a panel that
      // is currently down is not something a caller needs to be able to tell.
      expect(result).toEqual({ ok: false, code: "SERVICE_NOT_FOUND" });
    }
  });

  // OPT-8 ---------------------------------------------------------------------
  it("OPT-8: a GLOBAL_CLIENT XUI service can do all three operations", async () => {
    // The control for OPT-9 and OPT-26. Both Marzban and XUI adapters implement
    // renewService, addVolume and addTime (see MARZBAN_CAPABILITIES /
    // XUI_CAPABILITIES), so a healthy XUI service must be offered every one of
    // them — otherwise the two refusal cases below could be passing for a
    // reason that has nothing to do with what they claim to test.
    const svc = await makeService(ownerId, xuiPanelId, "xui-global", {
      panelType: "XUI",
      // GLOBAL_CLIENT is proven by remote METADATA naming one client whose email
      // is the service username exactly — not by remoteClientId, which the
      // classifier does not read.
      remoteMetadata: { email: `opt-${runTag}-xui-global` },
    });
    const productId = await makeProduct("xui-plan", { panelId: xuiPanelId });
    for (const operation of ALL_OPERATIONS) {
      const result = await listServiceOperationOptions(prisma, {
        userId: ownerId,
        publicServiceId: servicePublicId(svc),
        operation,
        group: "F",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.options.map((o) => o.optionId)).toContain(optionPublicId({ id: productId }));
    }
  });

  // OPT-8b --------------------------------------------------------------------
  it("OPT-8b: an unsupported XUI apiVariant has no capabilities at all", async () => {
    // A panel row may name any variant; only SANAEI has an adapter behind it.
    // An unrecognised one resolves to NO capabilities rather than to the
    // default, because guessing means calling endpoints that may not exist on a
    // panel someone is paying for.
    const oddPanelId = await makePanel("xui-odd", {
      type: "XUI",
      apiVariant: "SOME_FORK",
      authMode: "SESSION_COOKIE",
      inboundIds: [1],
    });
    const svc = await makeService(ownerId, oddPanelId, "xui-odd-svc", {
      panelType: "XUI",
      remoteMetadata: { email: `opt-${runTag}-xui-odd-svc` },
    });
    for (const operation of ALL_OPERATIONS) {
      const result = await listServiceOperationOptions(prisma, {
        userId: ownerId,
        publicServiceId: servicePublicId(svc),
        operation,
        group: "F",
      });
      expect(result).toEqual({ ok: false, code: "SERVICE_NOT_FOUND" });
    }
  });

  // OPT-9 ---------------------------------------------------------------------
  it("OPT-9: a legacy per-inbound XUI service is refused for every operation", async () => {
    // Per-inbound client labels (`username-<inboundId>`) are the pre-migration
    // remote model. Such an account is readable but never mutated through the
    // global-client endpoints: a global-client write against an account that is
    // not one can affect a DIFFERENT customer's client on a shared panel.
    const username = `opt-${runTag}-xui-legacy`;
    const svc = await makeService(ownerId, xuiPanelId, "xui-legacy", {
      panelType: "XUI",
      username,
      remoteMetadata: { clients: [{ email: `${username}-1` }, { email: `${username}-2` }] },
    });
    for (const operation of ALL_OPERATIONS) {
      const result = await listServiceOperationOptions(prisma, {
        userId: ownerId,
        publicServiceId: servicePublicId(svc),
        operation,
        group: "F",
      });
      expect(result).toEqual({ ok: false, code: "SERVICE_NOT_FOUND" });
    }
  });

  // OPT-9b --------------------------------------------------------------------
  it("OPT-9b: an XUI service whose remote model cannot be proven is refused", async () => {
    // Anything unprovable is treated like legacy — blocked, never guessed.
    const svc = await makeService(ownerId, xuiPanelId, "xui-unknown", {
      panelType: "XUI",
      remoteMetadata: undefined,
    });
    const result = await listServiceOperationOptions(prisma, {
      userId: ownerId,
      publicServiceId: servicePublicId(svc),
      operation: "RENEWAL",
      group: "F",
    });
    expect(result).toEqual({ ok: false, code: "SERVICE_NOT_FOUND" });
  });

  // OPT-10 --------------------------------------------------------------------
  it("OPT-10: service state gates the operation, and differently per operation", async () => {
    const expired = await makeService(ownerId, marzbanPanelId, "expired", {
      status: ServiceStatus.EXPIRED,
    });
    await makeProduct("state-plan");

    // Renewal and extra time accept an EXPIRED service — that is precisely the
    // person who wants them.
    for (const operation of ["RENEWAL", "EXTRA_TIME"] as ServiceOperation[]) {
      const ok = await listServiceOperationOptions(prisma, {
        userId: ownerId,
        publicServiceId: servicePublicId(expired),
        operation,
        group: "F",
      });
      expect(ok.ok).toBe(true);
    }
    // Extra volume does not: quota on an expired service cannot be spent.
    const volume = await listServiceOperationOptions(prisma, {
      userId: ownerId,
      publicServiceId: servicePublicId(expired),
      operation: "EXTRA_VOLUME",
      group: "F",
    });
    expect(volume).toEqual({ ok: false, code: "SERVICE_NOT_ELIGIBLE" });
  });

  // OPT-11 --------------------------------------------------------------------
  it("OPT-11: an unlimited-volume service cannot buy extra volume", async () => {
    const svc = await makeService(ownerId, marzbanPanelId, "unlimited-vol", {
      volumeBytes: 0n,
      remainingBytes: 0n,
    });
    const result = await listServiceOperationOptions(prisma, {
      userId: ownerId,
      publicServiceId: servicePublicId(svc),
      operation: "EXTRA_VOLUME",
      group: "F",
    });
    // Buying quota for a service that has no quota takes money and changes
    // nothing.
    expect(result).toEqual({ ok: false, code: "SERVICE_NOT_ELIGIBLE" });
  });

  // OPT-12 --------------------------------------------------------------------
  it("OPT-12: a never-expiring service cannot buy extra time", async () => {
    const svc = await makeService(ownerId, marzbanPanelId, "no-expiry", { expiresAt: null });
    const result = await listServiceOperationOptions(prisma, {
      userId: ownerId,
      publicServiceId: servicePublicId(svc),
      operation: "EXTRA_TIME",
      group: "F",
    });
    // Adding days to a service that never expires would DOWNGRADE it.
    expect(result).toEqual({ ok: false, code: "SERVICE_NOT_ELIGIBLE" });
  });

  // OPT-13 --------------------------------------------------------------------
  it("OPT-13: group visibility hides a Product from the wrong audience", async () => {
    const svc = await makeService(ownerId, marzbanPanelId, "group-svc");
    const productId = await makeProduct("n2-only", { displayGroups: ["N2"] });

    const forF = await listServiceOperationOptions(prisma, {
      userId: ownerId,
      publicServiceId: servicePublicId(svc),
      operation: "RENEWAL",
      group: "F",
    });
    expect(forF.ok).toBe(true);
    if (forF.ok) {
      expect(forF.options.map((o) => o.optionId)).not.toContain(optionPublicId({ id: productId }));
    }
    const forN2 = await listServiceOperationOptions(prisma, {
      userId: ownerId,
      publicServiceId: servicePublicId(svc),
      operation: "RENEWAL",
      group: "N2",
    });
    expect(forN2.ok).toBe(true);
    if (forN2.ok) {
      expect(forN2.options.map((o) => o.optionId)).toContain(optionPublicId({ id: productId }));
    }
  });

  // --- ownership -------------------------------------------------------------

  // OPT-14 --------------------------------------------------------------------
  it("OPT-14: another user's service yields SERVICE_NOT_FOUND", async () => {
    const foreign = await makeService(strangerId, marzbanPanelId, "foreign-svc");
    const result = await listServiceOperationOptions(prisma, {
      userId: ownerId,
      publicServiceId: servicePublicId(foreign),
      operation: "RENEWAL",
      group: "F",
    });
    expect(result).toEqual({ ok: false, code: "SERVICE_NOT_FOUND" });
  });

  // --- resolution ------------------------------------------------------------

  // OPT-15 --------------------------------------------------------------------
  it("OPT-15: resolves a listed option back to its Product", async () => {
    const svc = await makeService(ownerId, marzbanPanelId, "resolve-ok");
    const productId = await makeProduct("resolve-plan");
    const resolved = await resolveServiceOperationOption(prisma, {
      userId: ownerId,
      publicServiceId: servicePublicId(svc),
      operation: "RENEWAL",
      group: "F",
      publicOptionId: optionPublicId({ id: productId }),
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.product.id).toBe(productId);
    expect(resolved.owned.service.id).toBe(svc.id);
    expect(resolved.option.priceToman).toBe(100_000);
  });

  // OPT-16 --------------------------------------------------------------------
  it("OPT-16: malformed, unknown and ambiguous option ids are one answer", async () => {
    const svc = await makeService(ownerId, marzbanPanelId, "resolve-bad");
    const base = await makeProduct("ambig-a");

    // A second product sharing the whole 8-character public prefix.
    const shared = optionPublicId({ id: base });
    const collidingId = `${shared}${base.slice(8, 36).replace(/^./, (c) => (c === "0" ? "1" : "0"))}`;
    const twin = await prisma.product.create({
      data: {
        id: collidingId,
        type: "SERVICE_PRODUCT",
        name: `opt-${runTag}-ambig-b`,
        categoryId,
        panelId: marzbanPanelId,
        priceToman: 100_000,
        durationDays: 30,
        volumeGb: 50,
        isActive: true,
        displayGroups: ["ALL"],
      },
    });
    productIds.push(twin.id);
    expect(optionPublicId(twin)).toBe(shared);

    // A prefix that cannot be CHOSEN must not be OFFERED either. Listing it
    // would show the user two rows with an identical id and no way to pick
    // either — a button that does nothing, indistinguishable from a live one.
    const listed = await listServiceOperationOptions(prisma, {
      userId: ownerId,
      publicServiceId: servicePublicId(svc),
      operation: "RENEWAL",
      group: "F",
    });
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.options.map((o) => o.optionId)).not.toContain(shared);
      // Every id in a listing is unique, so "the option I tapped" is always a
      // single row.
      const ids = listed.options.map((o) => o.optionId);
      expect(new Set(ids).size).toBe(ids.length);
    }

    const candidates = [
      "", // empty
      "abc", // too short
      "zzzzzzzz", // not hex
      "0123456789abcdef", // a longer prefix than the convention
      "../../etc", // path-ish
      "deadbeef", // well-formed, nothing owns it
      shared, // well-formed, TWO products match
    ];
    for (const publicOptionId of candidates) {
      const result = await resolveServiceOperationOption(prisma, {
        userId: ownerId,
        publicServiceId: servicePublicId(svc),
        operation: "RENEWAL",
        group: "F",
        publicOptionId,
      });
      expect(result).toEqual({ ok: false, code: "OPTION_UNAVAILABLE" });
    }
  });

  // OPT-17 --------------------------------------------------------------------
  it("OPT-17: a Product disabled after listing no longer resolves", async () => {
    const svc = await makeService(ownerId, marzbanPanelId, "stale-disable");
    const productId = await makeProduct("goes-away");
    const publicOptionId = optionPublicId({ id: productId });

    const before = await resolveServiceOperationOption(prisma, {
      userId: ownerId,
      publicServiceId: servicePublicId(svc),
      operation: "RENEWAL",
      group: "F",
      publicOptionId,
    });
    expect(before.ok).toBe(true);

    await prisma.product.update({ where: { id: productId }, data: { isActive: false } });

    const after = await resolveServiceOperationOption(prisma, {
      userId: ownerId,
      publicServiceId: servicePublicId(svc),
      operation: "RENEWAL",
      group: "F",
      publicOptionId,
    });
    // Indistinguishable from an id that never existed — see OPT-16.
    expect(after).toEqual({ ok: false, code: "OPTION_UNAVAILABLE" });
  });

  // OPT-18 --------------------------------------------------------------------
  it("OPT-18: a price changed after listing resolves at the NEW price", async () => {
    const svc = await makeService(ownerId, marzbanPanelId, "stale-price");
    const productId = await makeProduct("reprices", { priceToman: 100_000 });
    const publicOptionId = optionPublicId({ id: productId });

    const listed = await listServiceOperationOptions(prisma, {
      userId: ownerId,
      publicServiceId: servicePublicId(svc),
      operation: "RENEWAL",
      group: "F",
    });
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.options.find((o) => o.optionId === publicOptionId)?.priceToman).toBe(100_000);
    }

    await prisma.product.update({ where: { id: productId }, data: { priceToman: 250_000 } });

    const resolved = await resolveServiceOperationOption(prisma, {
      userId: ownerId,
      publicServiceId: servicePublicId(svc),
      operation: "RENEWAL",
      group: "F",
      publicOptionId,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    // The resolver reports live truth. Holding the OLD price against a purchase
    // is the quote's job (§C), not this layer's — conflating the two is how a
    // stale list becomes a stale charge.
    expect(resolved.option.priceToman).toBe(250_000);
  });

  // OPT-19 --------------------------------------------------------------------
  it("OPT-19: a Service changed after listing stops resolving", async () => {
    const svc = await makeService(ownerId, marzbanPanelId, "svc-changes");
    const productId = await makeProduct("svc-changes-plan");
    const publicOptionId = optionPublicId({ id: productId });

    const before = await resolveServiceOperationOption(prisma, {
      userId: ownerId,
      publicServiceId: servicePublicId(svc),
      operation: "RENEWAL",
      group: "F",
      publicOptionId,
    });
    expect(before.ok).toBe(true);

    await prisma.service.update({
      where: { id: svc.id },
      data: { status: ServiceStatus.DELETED },
    });

    const after = await resolveServiceOperationOption(prisma, {
      userId: ownerId,
      publicServiceId: servicePublicId(svc),
      operation: "RENEWAL",
      group: "F",
      publicOptionId,
    });
    expect(after).toEqual({ ok: false, code: "SERVICE_NOT_FOUND" });
  });

  // --- what may leave the server --------------------------------------------

  // OPT-20 --------------------------------------------------------------------
  it("OPT-20: no uuid, panel address or credential appears in any DTO", async () => {
    const svc = await makeService(ownerId, marzbanPanelId, "leak-check");
    const productId = await makeProduct("leak-plan");
    const result = await listServiceOperationOptions(prisma, {
      userId: ownerId,
      publicServiceId: servicePublicId(svc),
      operation: "RENEWAL",
      group: "F",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const encoded = JSON.stringify(result);
    // The full uuids of every row that took part.
    for (const secret of [productId, svc.id, marzbanPanelId, categoryId, ownerId]) {
      expect(encoded).not.toContain(secret);
    }
    // Panel metadata and credentials.
    const panel = await prisma.panel.findUniqueOrThrow({ where: { id: marzbanPanelId } });
    expect(encoded).not.toContain(panel.baseUrl);
    expect(encoded).not.toContain(panel.name);
    expect(encoded).not.toContain("encrypted-blob");
    expect(encoded).not.toContain("template-user");

    // And positively: the keys are exactly the allowlist, so a field added to
    // the DTO later has to be added to this list on purpose.
    for (const option of result.options) {
      expect(Object.keys(option).sort()).toEqual([
        "available",
        "currency",
        "durationDays",
        "label",
        "operation",
        "optionId",
        "priceToman",
        "trafficGb",
      ]);
    }
    expect(Object.keys(result.target).sort()).toEqual([
      "expiresAt",
      "label",
      "remainingBytes",
      "serviceId",
      "status",
      "volumeBytes",
    ]);
  });

  // --- parity with the bot ---------------------------------------------------

  // OPT-21 --------------------------------------------------------------------
  it("OPT-21: the shared option list equals the bot's plan/package list", async () => {
    // Its OWN panel. OPT-16 deliberately plants two products sharing a public
    // prefix on the shared panel, and the shared authority drops both while the
    // bot's raw query still returns them — a real and intended difference that
    // would otherwise mask what this case is actually about.
    const parityPanelId = await makePanel("parity-panel");
    const svc = await makeService(ownerId, parityPanelId, "parity");
    await makeProduct("parity-a", {
      panelId: parityPanelId,
      priceToman: 120_000,
      volumeGb: 30,
      durationDays: 30,
    });
    await makeProduct("parity-b", {
      panelId: parityPanelId,
      priceToman: 240_000,
      volumeGb: 60,
      durationDays: 60,
    });

    // These three functions ARE what the bot calls: `renewal-checkout.service.ts`
    // and friends now re-export them. Asserting through them is what makes this
    // a parity test rather than a restatement of the implementation.
    const cases: Array<[ServiceOperation, () => Promise<Array<{ id: string }>>]> = [
      ["RENEWAL", () => renewalPlansForPanel("F", parityPanelId)],
      ["EXTRA_VOLUME", () => extraVolumePackages("F", parityPanelId)],
      ["EXTRA_TIME", () => extraTimePackages("F", parityPanelId)],
    ];
    for (const [operation, botQuery] of cases) {
      const shared = await listServiceOperationOptions(prisma, {
        userId: ownerId,
        publicServiceId: servicePublicId(svc),
        operation,
        group: "F",
      });
      expect(shared.ok).toBe(true);
      if (!shared.ok) continue;

      const botRows = await botQuery();
      const botIds = botRows.map((p) => optionPublicId(p));
      // Same ids AND same order: the order is what the user reads as "cheapest
      // first" / "smallest first", and a reordered list is a different screen.
      expect(shared.options.map((o) => o.optionId)).toEqual(botIds);
    }
  });

  // OPT-22 --------------------------------------------------------------------
  it("OPT-22: option price, duration and traffic match the Product row exactly", async () => {
    const svc = await makeService(ownerId, marzbanPanelId, "value-parity");
    const productId = await makeProduct("value-plan", {
      priceToman: 333_000,
      durationDays: 90,
      volumeGb: 75,
    });
    const resolved = await resolveServiceOperationOption(prisma, {
      userId: ownerId,
      publicServiceId: servicePublicId(svc),
      operation: "RENEWAL",
      group: "F",
      publicOptionId: optionPublicId({ id: productId }),
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const row = await withRelations(productId);
    // The bot charges `product.priceToman` for a renewal and grants
    // `durationDays` / `volumeGb`; the DTO must carry those numbers unmodified.
    expect(resolved.option.priceToman).toBe(row.priceToman);
    expect(resolved.option.durationDays).toBe(row.durationDays);
    expect(resolved.option.trafficGb).toBe(row.volumeGb);
  });

  // OPT-23 --------------------------------------------------------------------
  it("OPT-23: renewal pricing is RETAIL for a representative too", async () => {
    // The bot's own `representative-program.test.ts` asserts "RENEWAL purpose
    // stays retail" against `resolveEffectiveProductPrice`. Reseller pricing
    // applies to a NEW purchase made through «خرید نمایندگی», never to a
    // renewal or an add-on, so the price a renewal option quotes is
    // `product.priceToman` for every user regardless of their program status.
    const rep = await makeUser("rep");
    const svc = await makeService(rep, marzbanPanelId, "rep-renew");
    const productId = await makeProduct("rep-plan", { priceToman: 480_000 });
    const resolved = await resolveServiceOperationOption(prisma, {
      userId: rep,
      publicServiceId: servicePublicId(svc),
      operation: "RENEWAL",
      group: "F",
      publicOptionId: optionPublicId({ id: productId }),
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.option.priceToman).toBe(480_000);
  });

  // OPT-25 --------------------------------------------------------------------
  it("OPT-25: the re-check predicate rejects a Product from a DIFFERENT panel", async () => {
    // WHY THIS IS ASSERTED ON THE PREDICATE AND NOT THROUGH THE LISTING. The
    // listing query already filters `panelId` to the service's panel, so a
    // foreign-panel product can never appear there and a listing-level test
    // would pass even if the predicate stopped checking.
    //
    // The predicate is not redundant, because the BOT does not reach it through
    // that query: `payRenewalDraftWithWallet` loads the product by the id held
    // in the user's session draft and then calls this predicate as the ONLY
    // panel check before money moves. A draft that outlived a product being
    // moved to another panel is exactly the case it exists for — and provisioning
    // against the wrong panel is discovered after the charge.
    const svc = await makeService(ownerId, marzbanPanelId, "cross-panel-svc");
    const foreignId = await makeProduct("cross-panel-prod", { panelId: otherPanelId });
    const foreign = await withRelations(foreignId);
    const fresh = await prisma.service.findUniqueOrThrow({ where: { id: svc.id } });

    expect(isRenewalPlanValid(foreign, fresh, "F")).toBe(false);
    expect(isExtraVolumePackageValid(foreign, fresh, "F")).toBe(false);
    expect(isExtraTimePackageValid(foreign, fresh, "F")).toBe(false);

    // The same product on the service's OWN panel passes, so the assertion above
    // is really about the panel and not about some other broken field.
    const sameId = await makeProduct("cross-panel-ok");
    const same = await withRelations(sameId);
    expect(isRenewalPlanValid(same, fresh, "F")).toBe(true);
  });

  // OPT-26 --------------------------------------------------------------------
  it("OPT-26: the re-check predicate rejects a panel that cannot do the operation", async () => {
    // Same reasoning as OPT-25: this is the bot's pre-payment capability gate,
    // reached with a product loaded by id rather than through the filtered
    // listing query.
    //
    // The incapable panel is an XUI panel naming a variant this codebase has no
    // adapter for, which resolves to ZERO capabilities. Both shipped adapters
    // implement all three operations, so an unsupported variant is the real
    // shape of "this panel cannot do that" in this schema.
    const oddPanelId = await makePanel("cap-odd", {
      type: "XUI",
      apiVariant: "SOME_FORK",
      authMode: "SESSION_COOKIE",
      inboundIds: [1],
    });
    const username = `opt-${runTag}-cap-svc`;
    const svc = await makeService(ownerId, oddPanelId, "cap-svc", {
      panelType: "XUI",
      username,
      remoteMetadata: { email: username },
    });
    const productId = await makeProduct("cap-prod", { panelId: oddPanelId });
    const product = await withRelations(productId);
    const fresh = await prisma.service.findUniqueOrThrow({ where: { id: svc.id } });

    expect(isRenewalPlanValid(product, fresh, "F")).toBe(false);
    expect(isExtraVolumePackageValid(product, fresh, "F")).toBe(false);
    expect(isExtraTimePackageValid(product, fresh, "F")).toBe(false);

    // The SAME shapes on a supported variant pass, so the three refusals above
    // are about the capability and not about something incidental to the fixture.
    const okUsername = `opt-${runTag}-cap-ok-svc`;
    const okSvc = await makeService(ownerId, xuiPanelId, "cap-ok-svc", {
      panelType: "XUI",
      username: okUsername,
      remoteMetadata: { email: okUsername },
    });
    const okProductId = await makeProduct("cap-ok-prod", { panelId: xuiPanelId });
    const okProduct = await withRelations(okProductId);
    const okFresh = await prisma.service.findUniqueOrThrow({ where: { id: okSvc.id } });
    expect(isRenewalPlanValid(okProduct, okFresh, "F")).toBe(true);
    expect(isExtraVolumePackageValid(okProduct, okFresh, "F")).toBe(true);
    expect(isExtraTimePackageValid(okProduct, okFresh, "F")).toBe(true);
  });

  // OPT-24 --------------------------------------------------------------------
  it("OPT-24: every listed option passes the bot's own re-check predicate", async () => {
    // The strongest available parity statement: whatever the shared authority
    // is willing to SHOW, the bot's click-time predicate is willing to ACCEPT.
    // A divergence here is exactly the bug class where a Mini App user can
    // select something the bot would refuse at payment.
    const svc = await makeService(ownerId, marzbanPanelId, "recheck");
    await makeProduct("recheck-a", { priceToman: 90_000 });
    await makeProduct("recheck-b", { priceToman: 190_000, volumeGb: 5, durationDays: 7 });

    const predicates = {
      RENEWAL: isRenewalPlanValid,
      EXTRA_VOLUME: isExtraVolumePackageValid,
      EXTRA_TIME: isExtraTimePackageValid,
    } as const;

    const fresh = await prisma.service.findUniqueOrThrow({ where: { id: svc.id } });
    for (const operation of ALL_OPERATIONS) {
      const listed = await listServiceOperationOptions(prisma, {
        userId: ownerId,
        publicServiceId: servicePublicId(svc),
        operation,
        group: "F",
      });
      expect(listed.ok).toBe(true);
      if (!listed.ok) continue;
      expect(listed.options.length).toBeGreaterThan(0);

      for (const option of listed.options) {
        const resolved = await resolveServiceOperationOption(prisma, {
          userId: ownerId,
          publicServiceId: servicePublicId(svc),
          operation,
          group: "F",
          publicOptionId: option.optionId,
        });
        expect(resolved.ok).toBe(true);
        if (!resolved.ok) continue;
        expect(predicates[operation](resolved.product, fresh, "F")).toBe(true);
      }
    }
  });
});
