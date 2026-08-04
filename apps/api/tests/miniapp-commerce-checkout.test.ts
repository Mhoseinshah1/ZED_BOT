import { CheckoutStatus, PanelStatus, prisma, ServiceStatus } from "@zedbot/database";
import {
  createOperationCheckout,
  checkoutPublicId,
  issueQuoteForCheckout,
  openQuote,
  optionPublicId,
  quoteFingerprint,
  sealQuote,
  servicePublicId,
  validateDiscountCode,
} from "@zedbot/service-renewal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// =============================================================================
// CO — checkout drafts, discounts and authoritative quotes.
//
// THE PROPERTY UNDER TEST IS "THE BROWSER CANNOT MOVE A NUMBER". Not that the
// numbers are right once — that a client holding a quote, a stale draft, a
// tampered token or an outdated price cannot make the server charge anything
// other than what the server itself computed and froze.
//
// Real rows, real Prisma, real AES. Without DATABASE_URL the suite skips itself.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

const runTag = `${Date.now() % 1_000_000_000}`;
let seq = 0;

let ownerId = "";
let panelId = "";
let categoryId = "";

const serviceIds: string[] = [];
const panelIds: string[] = [];
const userIds: string[] = [];
const productIds: string[] = [];
const categoryIds: string[] = [];
const discountIds: string[] = [];

async function makeUser(label: string): Promise<string> {
  const user = await prisma.user.create({
    data: {
      telegramId: BigInt(`8${runTag}${(seq += 1)}`),
      firstName: `co-${label}`,
      balanceToman: 5_000_000,
      group: "F",
    },
  });
  userIds.push(user.id);
  return user.id;
}

async function makePanel(label: string): Promise<string> {
  const panel = await prisma.panel.create({
    data: {
      type: "MARZBAN",
      name: `co-${runTag}-${label}`,
      baseUrl: `https://co-${label}-${runTag}.internal.example`,
      username: "panel-admin",
      passwordEncrypted: "encrypted-blob",
      status: PanelStatus.ACTIVE,
      templateUsername: "template-user",
    },
  });
  panelIds.push(panel.id);
  return panel.id;
}

async function makeProduct(label: string, overrides: Record<string, unknown> = {}) {
  const product = await prisma.product.create({
    data: {
      type: "SERVICE_PRODUCT",
      name: `co-${runTag}-${label}`,
      categoryId,
      panelId,
      priceToman: 200_000,
      durationDays: 30,
      volumeGb: 40,
      isActive: true,
      displayGroups: ["ALL"],
      ...overrides,
    },
  });
  productIds.push(product.id);
  return product;
}

async function makeService(label: string, overrides: Record<string, unknown> = {}) {
  const service = await prisma.service.create({
    data: {
      userId: ownerId,
      panelId,
      panelType: "MARZBAN",
      username: `co-${runTag}-${label}`,
      status: ServiceStatus.ACTIVE,
      volumeBytes: 2_000_000n,
      usedBytes: 0n,
      remainingBytes: 2_000_000n,
      durationDays: 30,
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
      ...overrides,
    },
  });
  serviceIds.push(service.id);
  return service;
}

async function makeDiscount(label: string, overrides: Record<string, unknown> = {}) {
  const code = await prisma.discountCode.create({
    data: {
      code: `CO${runTag}${label}`.toUpperCase().slice(0, 30),
      type: "PERCENT",
      value: 10,
      isActive: true,
      appliesTo: "BOTH",
      ...overrides,
    },
  });
  discountIds.push(code.id);
  return code;
}

beforeAll(async () => {
  if (!hasDb) return;
  process.env.APP_SECRET ??= `co-test-secret-${runTag}`;
  ownerId = await makeUser("owner");
  panelId = await makePanel("panel");
  const category = await prisma.productCategory.create({
    data: { type: "SERVICE_PRODUCT", name: `co-${runTag}-cat`, isActive: true, displayOrder: 1 },
  });
  categoryIds.push(category.id);
  categoryId = category.id;
});

afterAll(async () => {
  if (!hasDb) return;
  await prisma.discountCodeUsage.deleteMany({ where: { discountCodeId: { in: discountIds } } });
  await prisma.checkoutSession.deleteMany({ where: { userId: { in: userIds } } });
  if (discountIds.length > 0) {
    await prisma.discountCode.deleteMany({ where: { id: { in: discountIds } } });
  }
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

describe.skipIf(!hasDb)("commerce checkout, discount and quote", () => {
  // The snapshot-parity case lives in the BOT suite
  // (apps/bot/tests/miniapp-snapshot-parity.test.ts): it compares the shared
  // builder against the bot's own, and this package must never import the bot.

  // --- creating a draft ------------------------------------------------------

  // CO-2 ----------------------------------------------------------------------
  it("CO-2: a draft freezes the price and binds user, operation and service", async () => {
    const service = await makeService("draft");
    const product = await makeProduct("draft", { priceToman: 340_000 });
    const created = await createOperationCheckout(prisma, {
      userId: ownerId,
      group: "F",
      operation: "RENEWAL",
      publicServiceId: servicePublicId(service),
      publicOptionId: optionPublicId(product),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const row = await prisma.checkoutSession.findUniqueOrThrow({
      where: { id: created.checkout.id },
    });
    expect(row.userId).toBe(ownerId);
    expect(row.serviceId).toBe(service.id);
    expect(row.productId).toBe(product.id);
    expect(row.orderType).toBe("SERVICE_RENEWAL");
    expect(row.status).toBe(CheckoutStatus.PENDING);
    expect(row.finalPriceToman).toBe(340_000);
    expect(row.settledByPaymentId).toBeNull();
    expect(created.draft.finalPriceToman).toBe(340_000);
  });

  // CO-3 ----------------------------------------------------------------------
  it("CO-3: a draft for someone else's service is refused", async () => {
    const stranger = await makeUser("stranger");
    const service = await makeService("foreign-draft");
    const product = await makeProduct("foreign-draft");
    const created = await createOperationCheckout(prisma, {
      userId: stranger,
      group: "F",
      operation: "RENEWAL",
      publicServiceId: servicePublicId(service),
      publicOptionId: optionPublicId(product),
    });
    expect(created).toEqual({ ok: false, code: "SERVICE_NOT_FOUND" });
  });

  // CO-4 ----------------------------------------------------------------------
  it("CO-4: creating a draft cancels the user's older draft for that service", async () => {
    const service = await makeService("supersede");
    const product = await makeProduct("supersede");
    const first = await createOperationCheckout(prisma, {
      userId: ownerId,
      group: "F",
      operation: "RENEWAL",
      publicServiceId: servicePublicId(service),
      publicOptionId: optionPublicId(product),
    });
    expect(first.ok).toBe(true);
    const second = await createOperationCheckout(prisma, {
      userId: ownerId,
      group: "F",
      operation: "RENEWAL",
      publicServiceId: servicePublicId(service),
      publicOptionId: optionPublicId(product),
    });
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    // Two payable drafts for one service is two ways to be charged for it.
    const older = await prisma.checkoutSession.findUniqueOrThrow({
      where: { id: first.checkout.id },
    });
    expect(older.status).toBe(CheckoutStatus.CANCELLED);
  });

  // --- discounts -------------------------------------------------------------

  // CO-5 ----------------------------------------------------------------------
  it("CO-5: a valid discount lowers the frozen price and is recorded", async () => {
    const service = await makeService("disc-ok");
    const product = await makeProduct("disc-ok", { priceToman: 500_000 });
    const code = await makeDiscount("ok", { type: "PERCENT", value: 20 });
    const created = await createOperationCheckout(prisma, {
      userId: ownerId,
      group: "F",
      operation: "RENEWAL",
      publicServiceId: servicePublicId(service),
      publicOptionId: optionPublicId(product),
      discountCode: code.code,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.draft.originalPriceToman).toBe(500_000);
    expect(created.draft.discountAmountToman).toBe(100_000);
    expect(created.draft.finalPriceToman).toBe(400_000);

    const row = await prisma.checkoutSession.findUniqueOrThrow({
      where: { id: created.checkout.id },
    });
    expect(row.discountCodeId).toBe(code.id);
    expect(row.finalPriceToman).toBe(400_000);

    // Validating never consumes: the usage row belongs to settlement.
    expect(await prisma.discountCodeUsage.count({ where: { discountCodeId: code.id } })).toBe(0);
    const reread = await prisma.discountCode.findUniqueOrThrow({ where: { id: code.id } });
    expect(reread.totalUsedCount).toBe(0);
  });

  // CO-6 ----------------------------------------------------------------------
  it("CO-6: invalid, expired, exhausted and ineligible codes are each refused", async () => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: ownerId } });
    const price = 100_000;

    const expired = await makeDiscount("exp", {
      expiresAt: new Date(Date.now() - 60_000),
    });
    const exhausted = await makeDiscount("exh", {
      totalUsageLimit: 1,
      totalUsedCount: 1,
    });
    const notStarted = await makeDiscount("soon", {
      startsAt: new Date(Date.now() + 3_600_000),
    });
    const wrongGroup = await makeDiscount("grp", { allowedGroups: ["N2"] });
    const renewalOnly = await makeDiscount("ren", { appliesTo: "RENEWAL" });

    const cases: Array<[string, string, "PURCHASE" | "RENEWAL"]> = [
      ["NO-SUCH-CODE-AT-ALL", "UNKNOWN", "PURCHASE"],
      ["", "MALFORMED", "PURCHASE"],
      [expired.code, "EXPIRED", "PURCHASE"],
      [exhausted.code, "EXHAUSTED", "PURCHASE"],
      [notStarted.code, "NOT_STARTED", "PURCHASE"],
      [wrongGroup.code, "GROUP_NOT_ALLOWED", "PURCHASE"],
      [renewalOnly.code, "NOT_FOR_PURCHASE", "PURCHASE"],
    ];
    for (const [raw, reason, purpose] of cases) {
      const result = await validateDiscountCode(raw, user, price, purpose);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe(reason);
      }
    }
  });

  // CO-7 ----------------------------------------------------------------------
  it("CO-7: a per-user exhausted code is refused for that user only", async () => {
    const other = await makeUser("disc-other");
    const code = await makeDiscount("peruser", { perUserUsageLimit: 1 });
    const service = await makeService("peruser");
    const product = await makeProduct("peruser");
    const draft = await createOperationCheckout(prisma, {
      userId: ownerId,
      group: "F",
      operation: "RENEWAL",
      publicServiceId: servicePublicId(service),
      publicOptionId: optionPublicId(product),
    });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;

    // One recorded usage for the owner, none for the other user.
    await prisma.discountCodeUsage.create({
      data: {
        discountCodeId: code.id,
        userId: ownerId,
        checkoutSessionId: draft.checkout.id,
        amountToman: 1,
      },
    });

    const ownerUser = await prisma.user.findUniqueOrThrow({ where: { id: ownerId } });
    const otherUser = await prisma.user.findUniqueOrThrow({ where: { id: other } });
    const forOwner = await validateDiscountCode(code.code, ownerUser, 100_000);
    expect(forOwner.ok).toBe(false);
    if (!forOwner.ok) expect(forOwner.reason).toBe("USER_LIMIT_REACHED");
    expect((await validateDiscountCode(code.code, otherUser, 100_000)).ok).toBe(true);
  });

  // --- quotes ----------------------------------------------------------------

  // CO-8 ----------------------------------------------------------------------
  it("CO-8: a quote states every figure the review screen needs", async () => {
    const service = await makeService("quote");
    const product = await makeProduct("quote", { priceToman: 250_000, durationDays: 45 });
    const created = await createOperationCheckout(prisma, {
      userId: ownerId,
      group: "F",
      operation: "EXTRA_TIME",
      publicServiceId: servicePublicId(service),
      publicOptionId: optionPublicId(product),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const issued = await issueQuoteForCheckout(prisma, {
      userId: ownerId,
      group: "F",
      publicCheckoutId: checkoutPublicId(created.checkout),
      walletBalanceToman: 1_000_000,
    });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    const dto = issued.dto;

    expect(dto.finalPriceToman).toBe(250_000);
    // The server does the arithmetic. A client that subtracted for itself would
    // eventually disagree with the ledger.
    expect(dto.expectedBalanceAfterToman).toBe(750_000);
    expect(dto.affordable).toBe(true);
    expect(dto.grantedDurationDays).toBe(45);
    expect(dto.grantedTrafficGb).toBeNull();
    expect(dto.currentExpiresAt).toBe(service.expiresAt?.toISOString());
    // ADD_PURCHASED_DAYS_TO_CURRENT_EXPIRY, from the future expiry.
    const expected = new Date(service.expiresAt!.getTime() + 45 * 86_400_000).toISOString();
    expect(dto.expectedExpiresAt).toBe(expected);
    expect(new Date(dto.quoteExpiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  // CO-9 ----------------------------------------------------------------------
  it("CO-9: an unaffordable quote says so instead of clamping to zero", async () => {
    const service = await makeService("poor");
    const product = await makeProduct("poor", { priceToman: 900_000 });
    const created = await createOperationCheckout(prisma, {
      userId: ownerId,
      group: "F",
      operation: "RENEWAL",
      publicServiceId: servicePublicId(service),
      publicOptionId: optionPublicId(product),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const issued = await issueQuoteForCheckout(prisma, {
      userId: ownerId,
      group: "F",
      publicCheckoutId: checkoutPublicId(created.checkout),
      walletBalanceToman: 100_000,
    });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    expect(issued.dto.affordable).toBe(false);
    // Negative on purpose: a clamped zero reads as "you would have nothing
    // left", which is a different and reassuring lie.
    expect(issued.dto.expectedBalanceAfterToman).toBe(-800_000);
  });

  // CO-10 ---------------------------------------------------------------------
  it("CO-10: the quote is opaque — no uuid survives into the token or the DTO", async () => {
    const service = await makeService("opaque");
    const product = await makeProduct("opaque");
    const created = await createOperationCheckout(prisma, {
      userId: ownerId,
      group: "F",
      operation: "RENEWAL",
      publicServiceId: servicePublicId(service),
      publicOptionId: optionPublicId(product),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const issued = await issueQuoteForCheckout(prisma, {
      userId: ownerId,
      group: "F",
      publicCheckoutId: checkoutPublicId(created.checkout),
      walletBalanceToman: 500_000,
    });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;

    const encoded = JSON.stringify(issued.dto);
    for (const secret of [created.checkout.id, service.id, product.id, panelId, ownerId]) {
      expect(encoded).not.toContain(secret);
      // Also not recoverable from the sealed token: it is ciphertext, so even
      // base64 of the uuid must not appear.
      expect(issued.dto.quote).not.toContain(secret);
      expect(issued.dto.quote).not.toContain(Buffer.from(secret).toString("base64url"));
    }
  });

  // CO-11 ---------------------------------------------------------------------
  it("CO-11: a tampered quote does not open", async () => {
    const payload = {
      userId: ownerId,
      checkoutId: "00000000-0000-4000-8000-000000000000",
      operation: "RENEWAL" as const,
      finalPriceToman: 100_000,
      fingerprint: "abc",
      expiresAtMs: Date.now() + 60_000,
    };
    const token = sealQuote(payload);
    expect(openQuote(token).ok).toBe(true);

    // Flip one character of the ciphertext body.
    const dot = token.indexOf(".");
    const body = token.slice(dot + 1);
    const flipped = `${body[0] === "A" ? "B" : "A"}${body.slice(1)}`;
    expect(openQuote(`${token.slice(0, dot)}.${flipped}`)).toEqual({
      ok: false,
      reason: "BAD_SEAL",
    });

    for (const bad of ["", "not-a-quote", "q1.", "q2.abcdef", `${token}x`]) {
      expect(openQuote(bad).ok).toBe(false);
    }
  });

  // CO-12 ---------------------------------------------------------------------
  it("CO-12: an expired quote reports EXPIRED, and only after the seal verifies", async () => {
    const token = sealQuote({
      userId: ownerId,
      checkoutId: "00000000-0000-4000-8000-000000000000",
      operation: "RENEWAL",
      finalPriceToman: 1,
      fingerprint: "f",
      expiresAtMs: Date.now() + 1_000,
    });
    expect(openQuote(token, Date.now()).ok).toBe(true);
    expect(openQuote(token, Date.now() + 2_000)).toEqual({ ok: false, reason: "EXPIRED" });
    // A forged token must not be able to learn that its guessed expiry was
    // plausible, so a bad seal outranks an expiry check.
    expect(openQuote("q1.AAAAAAAAAAAAAAAAAAAAAAAA", Date.now() + 10_000_000).reason).not.toBe(
      "EXPIRED",
    );
  });

  // CO-13 ---------------------------------------------------------------------
  it("CO-13: the fingerprint changes when any priced input changes", async () => {
    const base = {
      productId: "p",
      productPriceToman: 100,
      productActive: true,
      categoryActive: true,
      panelId: "panel",
      panelStatus: "ACTIVE",
      discountCodeId: null,
      discountAmountToman: 0,
      finalPriceToman: 100,
      serviceId: "s",
      serviceStatus: "ACTIVE",
      serviceExpiresAtMs: 1_000,
      serviceVolumeBytes: "10",
    };
    const original = quoteFingerprint(base);
    // One mutation per priced input. Any that fails to move the digest is an
    // input the confirmation would not notice changing.
    const mutations: Array<Partial<typeof base>> = [
      { productPriceToman: 101 },
      { productActive: false },
      { categoryActive: false },
      { panelStatus: "INACTIVE" },
      { discountCodeId: "d" },
      { discountAmountToman: 1 },
      { finalPriceToman: 99 },
      { serviceStatus: "EXPIRED" },
      { serviceExpiresAtMs: 2_000 },
      { serviceVolumeBytes: "11" },
    ];
    for (const mutation of mutations) {
      expect(quoteFingerprint({ ...base, ...mutation })).not.toBe(original);
    }
  });

  // CO-14 ---------------------------------------------------------------------
  it("CO-14: a price change after the quote moves the fingerprint", async () => {
    const service = await makeService("reprice");
    const product = await makeProduct("reprice", { priceToman: 300_000 });
    const created = await createOperationCheckout(prisma, {
      userId: ownerId,
      group: "F",
      operation: "RENEWAL",
      publicServiceId: servicePublicId(service),
      publicOptionId: optionPublicId(product),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const before = await issueQuoteForCheckout(prisma, {
      userId: ownerId,
      group: "F",
      publicCheckoutId: checkoutPublicId(created.checkout),
      walletBalanceToman: 5_000_000,
    });
    expect(before.ok).toBe(true);

    await prisma.product.update({ where: { id: product.id }, data: { priceToman: 999_000 } });

    const after = await issueQuoteForCheckout(prisma, {
      userId: ownerId,
      group: "F",
      publicCheckoutId: checkoutPublicId(created.checkout),
      walletBalanceToman: 5_000_000,
    });
    expect(after.ok).toBe(true);
    if (!before.ok || !after.ok) return;

    // The DRAFT still carries the frozen amount — a reprice does not silently
    // change what an existing draft costs...
    expect(after.dto.finalPriceToman).toBe(300_000);
    // ...but the two quotes describe different worlds, and that difference is
    // what the confirmation refuses on.
    const first = openQuote(before.dto.quote);
    const second = openQuote(after.dto.quote);
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.payload.fingerprint).not.toBe(second.payload.fingerprint);
    }
  });

  // CO-15 ---------------------------------------------------------------------
  it("CO-15: a service change after the quote moves the fingerprint", async () => {
    const service = await makeService("svc-move");
    const product = await makeProduct("svc-move");
    const created = await createOperationCheckout(prisma, {
      userId: ownerId,
      group: "F",
      operation: "RENEWAL",
      publicServiceId: servicePublicId(service),
      publicOptionId: optionPublicId(product),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const before = await issueQuoteForCheckout(prisma, {
      userId: ownerId,
      group: "F",
      publicCheckoutId: checkoutPublicId(created.checkout),
      walletBalanceToman: 5_000_000,
    });

    await prisma.service.update({
      where: { id: service.id },
      data: { status: ServiceStatus.LIMITED },
    });

    const after = await issueQuoteForCheckout(prisma, {
      userId: ownerId,
      group: "F",
      publicCheckoutId: checkoutPublicId(created.checkout),
      walletBalanceToman: 5_000_000,
    });
    expect(before.ok && after.ok).toBe(true);
    if (!before.ok || !after.ok) return;
    const first = openQuote(before.dto.quote);
    const second = openQuote(after.dto.quote);
    if (first.ok && second.ok) {
      expect(first.payload.fingerprint).not.toBe(second.payload.fingerprint);
    }
  });

  // CO-16 ---------------------------------------------------------------------
  it("CO-16: a quote is bound to the user it was issued to", async () => {
    const service = await makeService("bind");
    const product = await makeProduct("bind");
    const created = await createOperationCheckout(prisma, {
      userId: ownerId,
      group: "F",
      operation: "RENEWAL",
      publicServiceId: servicePublicId(service),
      publicOptionId: optionPublicId(product),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const issued = await issueQuoteForCheckout(prisma, {
      userId: ownerId,
      group: "F",
      publicCheckoutId: checkoutPublicId(created.checkout),
      walletBalanceToman: 5_000_000,
    });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    const opened = openQuote(issued.dto.quote);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    // The owner is INSIDE the sealed payload, so a settlement path can compare
    // it against the session rather than trusting the caller's word.
    expect(opened.payload.userId).toBe(ownerId);
    expect(opened.payload.checkoutId).toBe(created.checkout.id);
    expect(opened.payload.finalPriceToman).toBe(created.checkout.finalPriceToman);
  });

  // CO-17 ---------------------------------------------------------------------
  it("CO-17: a foreign, cancelled or expired draft yields no quote", async () => {
    const stranger = await makeUser("quote-stranger");
    const service = await makeService("quote-gone");
    const product = await makeProduct("quote-gone");
    const created = await createOperationCheckout(prisma, {
      userId: ownerId,
      group: "F",
      operation: "RENEWAL",
      publicServiceId: servicePublicId(service),
      publicOptionId: optionPublicId(product),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const publicCheckoutId = checkoutPublicId(created.checkout);

    // Another user cannot quote it.
    expect(
      await issueQuoteForCheckout(prisma, {
        userId: stranger,
        group: "F",
        publicCheckoutId,
        walletBalanceToman: 5_000_000,
      }),
    ).toEqual({ ok: false, code: "CHECKOUT_UNAVAILABLE" });

    // An expired draft cannot be quoted, even by its owner.
    expect(
      await issueQuoteForCheckout(prisma, {
        userId: ownerId,
        group: "F",
        publicCheckoutId,
        walletBalanceToman: 5_000_000,
        nowMs: created.checkout.expiresAt.getTime() + 1,
      }),
    ).toEqual({ ok: false, code: "CHECKOUT_UNAVAILABLE" });

    // A cancelled draft cannot be quoted.
    await prisma.checkoutSession.update({
      where: { id: created.checkout.id },
      data: { status: CheckoutStatus.CANCELLED },
    });
    expect(
      await issueQuoteForCheckout(prisma, {
        userId: ownerId,
        group: "F",
        publicCheckoutId,
        walletBalanceToman: 5_000_000,
      }),
    ).toEqual({ ok: false, code: "CHECKOUT_UNAVAILABLE" });

    for (const bad of ["", "zz", "0123456789ab", "../../x"]) {
      expect(
        await issueQuoteForCheckout(prisma, {
          userId: ownerId,
          group: "F",
          publicCheckoutId: bad,
          walletBalanceToman: 1,
        }),
      ).toEqual({ ok: false, code: "CHECKOUT_UNAVAILABLE" });
    }
  });
});
