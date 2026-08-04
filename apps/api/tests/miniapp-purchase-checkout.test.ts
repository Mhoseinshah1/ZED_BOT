import { CheckoutStatus, PanelStatus, prisma } from "@zedbot/database";
import {
  catalogPublicId,
  createPurchaseCheckout,
  loadMiniAppCatalog,
  resolvePurchasableProduct,
} from "@zedbot/service-renewal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// =============================================================================
// PU — the catalog a browser sees, and the new-subscription draft.
//
// THE USERNAME IS THE POINT. A new subscription is the only operation that
// creates a remote account, and the account's name is unique across the whole
// installation. These cases are mostly about that: that a draft cannot exist
// without an active hold on its name, that two buyers looking at the same screen
// cannot be sold one name, and that a failed hold leaves nothing behind.
//
// The panel probe is mocked — it is a genuine external boundary and the only
// remote call this path makes (read-only `getServiceAccount`). Everything else
// is real Prisma against real PostgreSQL.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

const runTag = `${Date.now() % 1_000_000_000}`;
// Service usernames are capped at 16 characters (SERVICE_USERNAME_MAX_LENGTH),
// so the fixture suffix has to be short enough to leave room for a readable
// prefix. Five digits is still unique per run in practice.
const nameTag = runTag.slice(-5);
let seq = 0;

let panelId = "";
let hiddenPanelId = "";
let categoryId = "";
let productId = "";
let hiddenProductId = "";

const userIds: string[] = [];
const productIds: string[] = [];
const categoryIds: string[] = [];
const panelIds: string[] = [];

/**
 * The panel probe, stubbed at the boundary.
 *
 * The adapter contract is: `ok: true` means an account with this name EXISTS
 * remotely, and `notFound: true` is the explicit "nothing there" answer that
 * makes a name available. Anything else is UNVERIFIABLE and refuses — the probe
 * never guesses that a name is free.
 *
 * A real panel call here would make the suite depend on a live server, which is
 * the one thing a uniqueness test must not do.
 */
const freeOnPanel = () =>
  ({
    getServiceAccount: async () => ({ ok: false as const, notFound: true as const }),
  }) as never;

/** A probe that reports the name already exists remotely. */
const takenOnPanel = () =>
  ({
    getServiceAccount: async () => ({ ok: true as const, account: { username: "someone-else" } }),
  }) as never;

async function makeUser() {
  const user = await prisma.user.create({
    data: {
      telegramId: BigInt(`5${runTag}${(seq += 1)}`),
      firstName: `pu-${seq}`,
      balanceToman: 1_000_000,
      group: "F",
    },
  });
  userIds.push(user.id);
  return user;
}

beforeAll(async () => {
  if (!hasDb) return;
  const panel = await prisma.panel.create({
    data: {
      type: "MARZBAN",
      name: `pu-${runTag}-tehran`,
      baseUrl: `https://pu-${runTag}.internal.example`,
      username: "panel-admin",
      passwordEncrypted: "encrypted-blob",
      status: PanelStatus.ACTIVE,
      isVisible: true,
      templateUsername: "template-user",
      displayOrder: 1,
    },
  });
  panelIds.push(panel.id);
  panelId = panel.id;

  const hidden = await prisma.panel.create({
    data: {
      type: "MARZBAN",
      name: `pu-${runTag}-hidden`,
      baseUrl: `https://pu-${runTag}-hidden.internal.example`,
      username: "panel-admin",
      passwordEncrypted: "encrypted-blob",
      status: PanelStatus.ACTIVE,
      isVisible: false,
      templateUsername: "template-user",
      displayOrder: 2,
    },
  });
  panelIds.push(hidden.id);
  hiddenPanelId = hidden.id;

  const category = await prisma.productCategory.create({
    data: { type: "SERVICE_PRODUCT", name: `pu-${runTag}-cat`, isActive: true, displayOrder: 1 },
  });
  categoryIds.push(category.id);
  categoryId = category.id;

  const product = await prisma.product.create({
    data: {
      type: "SERVICE_PRODUCT",
      name: `pu-${runTag}-plan`,
      categoryId,
      panelId,
      priceToman: 250_000,
      durationDays: 30,
      volumeGb: 50,
      isActive: true,
      displayGroups: ["ALL"],
      invoiceDescription: "one month, fifty gigabytes",
    },
  });
  productIds.push(product.id);
  productId = product.id;

  const hiddenProduct = await prisma.product.create({
    data: {
      type: "SERVICE_PRODUCT",
      name: `pu-${runTag}-hidden-plan`,
      categoryId,
      panelId: hiddenPanelId,
      priceToman: 100_000,
      durationDays: 30,
      volumeGb: 10,
      isActive: true,
      displayGroups: ["ALL"],
    },
  });
  productIds.push(hiddenProduct.id);
  hiddenProductId = hiddenProduct.id;
});

afterAll(async () => {
  if (!hasDb) return;
  await prisma.serviceUsernameReservation.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.checkoutSession.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.product.deleteMany({ where: { id: { in: productIds } } });
  await prisma.productCategory.deleteMany({ where: { id: { in: categoryIds } } });
  await prisma.panel.deleteMany({ where: { id: { in: panelIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
});

describe.skipIf(!hasDb)("mini app catalog and new-subscription checkout", () => {
  // --- the catalog -----------------------------------------------------------

  // PU-1 ----------------------------------------------------------------------
  it("PU-1: the catalog shows visible products, grouped by location", async () => {
    const catalog = await loadMiniAppCatalog(prisma, "F");
    const location = catalog.locations.find((l) => l.locationId === catalogPublicId({ id: panelId }));
    expect(location).toBeDefined();
    expect(location?.label).toBe(`pu-${runTag}-tehran`);
    expect(location?.fromPriceToman).toBe(250_000);
    const product = location?.categories.flatMap((c) => c.products).find(
      (p) => p.productId === catalogPublicId({ id: productId }),
    );
    expect(product).toMatchObject({
      label: `pu-${runTag}-plan`,
      priceToman: 250_000,
      durationDays: 30,
      trafficGb: 50,
      currency: "IRT",
    });
  });

  // PU-2 ----------------------------------------------------------------------
  it("PU-2: a hidden panel and its products never appear", async () => {
    const catalog = await loadMiniAppCatalog(prisma, "F");
    const ids = catalog.locations.map((l) => l.locationId);
    expect(ids).not.toContain(catalogPublicId({ id: hiddenPanelId }));
    const allProducts = catalog.locations.flatMap((l) =>
      l.categories.flatMap((c) => c.products.map((p) => p.productId)),
    );
    expect(allProducts).not.toContain(catalogPublicId({ id: hiddenProductId }));
  });

  // PU-3 ----------------------------------------------------------------------
  it("PU-3: the catalog carries no uuid, panel address or credential", async () => {
    const catalog = await loadMiniAppCatalog(prisma, "F");
    const encoded = JSON.stringify(catalog);
    for (const secret of [panelId, productId, categoryId, hiddenPanelId]) {
      expect(encoded).not.toContain(secret);
    }
    const panel = await prisma.panel.findUniqueOrThrow({ where: { id: panelId } });
    expect(encoded).not.toContain(panel.baseUrl);
    expect(encoded).not.toContain("encrypted-blob");
    expect(encoded).not.toContain("template-user");
  });

  // PU-4 ----------------------------------------------------------------------
  it("PU-4: a group that cannot see a product gets an empty catalog", async () => {
    await prisma.product.update({
      where: { id: productId },
      data: { displayGroups: ["N2"] },
    });
    try {
      const forF = await loadMiniAppCatalog(prisma, "F");
      // The location is dropped entirely rather than shown empty — a location
      // that leads to a blank screen is worse than no location.
      expect(forF.locations.map((l) => l.locationId)).not.toContain(
        catalogPublicId({ id: panelId }),
      );
      const forN2 = await loadMiniAppCatalog(prisma, "N2");
      expect(forN2.locations.map((l) => l.locationId)).toContain(catalogPublicId({ id: panelId }));
    } finally {
      await prisma.product.update({
        where: { id: productId },
        data: { displayGroups: ["ALL"] },
      });
    }
  });

  // PU-5 ----------------------------------------------------------------------
  it("PU-5: malformed, unknown and hidden product ids are one answer", async () => {
    for (const bad of [
      "",
      "zz",
      "0123456789abcdef",
      "../../x",
      "deadbeef",
      catalogPublicId({ id: hiddenProductId }),
    ]) {
      const result = await resolvePurchasableProduct(prisma, "F", bad);
      expect(result).toEqual({ ok: false, code: "PRODUCT_UNAVAILABLE" });
    }
    const good = await resolvePurchasableProduct(prisma, "F", catalogPublicId({ id: productId }));
    expect(good.ok).toBe(true);
  });

  // --- the new-subscription draft -------------------------------------------

  // PU-6 ----------------------------------------------------------------------
  it("PU-6: a random-username draft reserves the name and binds it to the checkout", async () => {
    const user = await makeUser();
    const created = await createPurchaseCheckout(prisma, {
      userId: user.id,
      group: "F",
      publicProductId: catalogPublicId({ id: productId }),
      usernameMode: "RANDOM",
      draftNonce: `pu-nonce-${(seq += 1)}`,
      buildAdapter: freeOnPanel,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(created.draft.finalPriceToman).toBe(250_000);
    expect(created.draft.username.length).toBeGreaterThan(0);
    expect(created.draft.usernameMode).toBe("RANDOM");

    // The hold exists, is BOUND to THIS checkout, and names this panel.
    const reservation = await prisma.serviceUsernameReservation.findFirstOrThrow({
      where: { userId: user.id, normalizedUsername: created.draft.username },
    });
    expect(reservation.status).toBe("BOUND");
    expect(reservation.checkoutSessionId).toBe(created.checkout.id);
    expect(reservation.panelId).toBe(panelId);

    // The snapshot froze the selection, so settlement claims the exact hold.
    const snapshot = created.checkout.productSnapshot as Record<string, unknown>;
    expect(snapshot.serviceUsername).toBe(created.draft.username);
    expect(snapshot.serviceUsernameReservationId).toBe(reservation.id);
    expect(snapshot.serviceUsernameSelectionSource).toBe("USER_RANDOM");
    // The naming strategy is captured NOW so a later panel edit cannot rename a
    // paid entitlement.
    expect(snapshot).toHaveProperty("namingStrategy");
  });

  // PU-7 ----------------------------------------------------------------------
  it("PU-7: a custom username is honoured and normalised", async () => {
    const user = await makeUser();
    const wanted = `puCustom${nameTag}`.toLowerCase();
    const created = await createPurchaseCheckout(prisma, {
      userId: user.id,
      group: "F",
      publicProductId: catalogPublicId({ id: productId }),
      usernameMode: "CUSTOM",
      requestedUsername: wanted.toUpperCase(),
      draftNonce: `pu-nonce-${(seq += 1)}`,
      buildAdapter: freeOnPanel,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.draft.username).toBe(wanted);
    expect(created.draft.usernameMode).toBe("CUSTOM");
  });

  // PU-8 ----------------------------------------------------------------------
  it("PU-8: a name already held by another buyer is refused, with a reason", async () => {
    const first = await makeUser();
    const second = await makeUser();
    const wanted = `pushared${nameTag}`.toLowerCase();

    const a = await createPurchaseCheckout(prisma, {
      userId: first.id,
      group: "F",
      publicProductId: catalogPublicId({ id: productId }),
      usernameMode: "CUSTOM",
      requestedUsername: wanted,
      draftNonce: `pu-nonce-${(seq += 1)}`,
      buildAdapter: freeOnPanel,
    });
    expect(a.ok).toBe(true);

    const b = await createPurchaseCheckout(prisma, {
      userId: second.id,
      group: "F",
      publicProductId: catalogPublicId({ id: productId }),
      usernameMode: "CUSTOM",
      requestedUsername: wanted,
      draftNonce: `pu-nonce-${(seq += 1)}`,
      buildAdapter: freeOnPanel,
    });
    expect(b.ok).toBe(false);
    if (b.ok) return;
    // Unlike a service or option refusal, the buyer typed this and has to be
    // told to pick another. The reason names no other user and no other row.
    expect(b.code).toBe("OPTION_UNAVAILABLE");
    expect(b.usernameOutcome).toBe("RESERVED");
    // And nothing was left behind for the loser.
    expect(
      await prisma.checkoutSession.count({ where: { userId: second.id } }),
    ).toBe(0);
  });

  // PU-9 ----------------------------------------------------------------------
  it("PU-9: a name that already exists on the panel is refused", async () => {
    const user = await makeUser();
    const result = await createPurchaseCheckout(prisma, {
      userId: user.id,
      group: "F",
      publicProductId: catalogPublicId({ id: productId }),
      usernameMode: "CUSTOM",
      requestedUsername: `puremote${nameTag}`.toLowerCase(),
      draftNonce: `pu-nonce-${(seq += 1)}`,
      buildAdapter: takenOnPanel,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.usernameOutcome).toBe("TAKEN_REMOTE");
    expect(await prisma.checkoutSession.count({ where: { userId: user.id } })).toBe(0);
  });

  // PU-10 ---------------------------------------------------------------------
  it("PU-10: concurrent drafts for one name yield exactly one holder", async () => {
    const wanted = `purace${nameTag}`.toLowerCase();
    const buyers = await Promise.all([makeUser(), makeUser(), makeUser(), makeUser()]);

    // Four buyers, one name, genuinely in parallel. The global
    // (activeUsernameKey) unique index is what decides, not application timing.
    const results = await Promise.all(
      buyers.map((buyer, index) =>
        createPurchaseCheckout(prisma, {
          userId: buyer.id,
          group: "F",
          publicProductId: catalogPublicId({ id: productId }),
          usernameMode: "CUSTOM",
          requestedUsername: wanted,
          draftNonce: `pu-race-${runTag}-${index}`,
          buildAdapter: freeOnPanel,
        }),
      ),
    );
    const winners = results.filter((r) => r.ok);
    expect(winners).toHaveLength(1);

    const active = await prisma.serviceUsernameReservation.count({
      where: { normalizedUsername: wanted, status: { in: ["HELD", "BOUND", "CONSUMED"] } },
    });
    expect(active).toBe(1);
  });

  // PU-11 ---------------------------------------------------------------------
  it("PU-11: a repeated draft for one product supersedes the older one", async () => {
    const user = await makeUser();
    const nonce = `pu-nonce-${(seq += 1)}`;
    const first = await createPurchaseCheckout(prisma, {
      userId: user.id,
      group: "F",
      publicProductId: catalogPublicId({ id: productId }),
      usernameMode: "RANDOM",
      draftNonce: nonce,
      buildAdapter: freeOnPanel,
    });
    expect(first.ok).toBe(true);
    const second = await createPurchaseCheckout(prisma, {
      userId: user.id,
      group: "F",
      publicProductId: catalogPublicId({ id: productId }),
      usernameMode: "RANDOM",
      draftNonce: nonce,
      buildAdapter: freeOnPanel,
    });
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    // Two payable drafts for one product is two ways to be charged for it.
    const older = await prisma.checkoutSession.findUniqueOrThrow({
      where: { id: first.checkout.id },
    });
    expect(older.status).toBe(CheckoutStatus.CANCELLED);
  });

  // PU-11A --------------------------------------------------------------------
  it("PU-11A: concurrent drafts leave exactly one payable checkout", async () => {
    const user = await makeUser();

    // Separate nonces force separate reservations and exercise the checkout
    // transition itself. The database advisory lock, not an in-process mutex,
    // must serialize these calls even when they use different pool sessions.
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        createPurchaseCheckout(prisma, {
          userId: user.id,
          group: "F",
          publicProductId: catalogPublicId({ id: productId }),
          usernameMode: "RANDOM",
          draftNonce: `pu-same-buyer-race-${runTag}-${index}`,
          buildAdapter: freeOnPanel,
        }),
      ),
    );

    expect(results.every((result) => result.ok)).toBe(true);
    expect(
      await prisma.checkoutSession.count({
        where: { userId: user.id, productId, status: CheckoutStatus.PENDING },
      }),
    ).toBe(1);
    expect(
      await prisma.checkoutSession.count({
        where: { userId: user.id, productId, status: CheckoutStatus.CANCELLED },
      }),
    ).toBe(5);
  });

  // PU-12 ---------------------------------------------------------------------
  it("PU-12: the draft DTO exposes no uuid", async () => {
    const user = await makeUser();
    const created = await createPurchaseCheckout(prisma, {
      userId: user.id,
      group: "F",
      publicProductId: catalogPublicId({ id: productId }),
      usernameMode: "RANDOM",
      draftNonce: `pu-nonce-${(seq += 1)}`,
      buildAdapter: freeOnPanel,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const encoded = JSON.stringify(created.draft);
    for (const secret of [created.checkout.id, productId, panelId, categoryId, user.id]) {
      expect(encoded).not.toContain(secret);
    }
  });
});
