import { PanelStatus, prisma, ServiceStatus } from "@zedbot/database";
import { buildOperationSnapshot, type ServiceOperation } from "@zedbot/service-renewal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildExtraTimeSnapshot } from "../src/services/extra-time.service.js";
import { buildExtraVolumeSnapshot } from "../src/services/extra-volume.service.js";
import { buildRenewalSnapshot } from "../src/services/renewal-checkout.service.js";

// =============================================================================
// SNAP — the Mini App's frozen checkout snapshot equals the bot's.
//
// WHY THIS TEST IS IN THE BOT SUITE. It compares the shared builder in
// @zedbot/service-renewal against the bot's own three builders. Only the bot can
// import both; `apps/api` must never import a bot module, and asserting parity
// from a copied field list would prove nothing about the copy being right.
//
// WHY IT MATTERS. Every Order column downstream is read out of this object BY
// KEY — durationDaysSnapshot, volumeGbSnapshot, panelNameSnapshot,
// productPriceSnapshot, categorySnapshot and the rest. A key the Mini App
// omitted would produce a paid order that reports differently from an identical
// one placed through Telegram: same money, different row, and a financial report
// that disagrees with itself depending on which door the customer used.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

const runTag = `${Date.now() % 1_000_000_000}`;
const cleanup = { services: [] as string[], products: [] as string[], categories: [] as string[], panels: [] as string[], users: [] as string[] };

let userId = "";
let panelId = "";
let categoryId = "";

beforeAll(async () => {
  if (!hasDb) return;
  const user = await prisma.user.create({
    data: { telegramId: BigInt(`7${runTag}1`), firstName: `snap-${runTag}`, balanceToman: 0 },
  });
  cleanup.users.push(user.id);
  userId = user.id;

  const panel = await prisma.panel.create({
    data: {
      type: "MARZBAN",
      name: `snap-${runTag}`,
      baseUrl: `https://snap-${runTag}.internal.example`,
      username: "panel-admin",
      passwordEncrypted: "encrypted-blob",
      status: PanelStatus.ACTIVE,
      templateUsername: "template-user",
    },
  });
  cleanup.panels.push(panel.id);
  panelId = panel.id;

  const category = await prisma.productCategory.create({
    data: { type: "SERVICE_PRODUCT", name: `snap-${runTag}-cat`, isActive: true, displayOrder: 1 },
  });
  cleanup.categories.push(category.id);
  categoryId = category.id;
});

afterAll(async () => {
  if (!hasDb) return;
  await prisma.service.deleteMany({ where: { id: { in: cleanup.services } } });
  await prisma.product.deleteMany({ where: { id: { in: cleanup.products } } });
  await prisma.productCategory.deleteMany({ where: { id: { in: cleanup.categories } } });
  await prisma.panel.deleteMany({ where: { id: { in: cleanup.panels } } });
  await prisma.user.deleteMany({ where: { id: { in: cleanup.users } } });
});

describe.skipIf(!hasDb)("mini app checkout snapshot parity", () => {
  it("SNAP-1: the shared snapshot is byte-identical to the bot's, per operation", async () => {
    const product = await prisma.product.create({
      data: {
        type: "SERVICE_PRODUCT",
        name: `snap-${runTag}-product`,
        categoryId,
        panelId,
        priceToman: 200_000,
        durationDays: 30,
        volumeGb: 40,
        isActive: true,
        displayGroups: ["ALL"],
        invoiceDescription: "an invoice line",
      },
    });
    cleanup.products.push(product.id);
    const withRelations = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
      include: { category: true, panel: true },
    });

    const service = await prisma.service.create({
      data: {
        userId,
        panelId,
        panelType: "MARZBAN",
        username: `snap-${runTag}-svc`,
        status: ServiceStatus.ACTIVE,
        volumeBytes: 2_000_000n,
        usedBytes: 5_000n,
        remainingBytes: 1_995_000n,
        durationDays: 30,
        expiresAt: new Date(Date.now() + 30 * 86_400_000),
      },
    });
    cleanup.services.push(service.id);

    const pricing = {
      originalPriceToman: 200_000,
      discountCode: "SNAPCODE",
      discountCodeId: "a-discount-row-id",
      discountAmountToman: 20_000,
      finalPriceToman: 180_000,
    };
    // The bot's builders take its own draft shape. Only the ids and the priced
    // fields reach the output, so this draft is faithful to a real one.
    const draft = {
      serviceId: service.id,
      productId: product.id,
      panelId,
      categoryId,
      discountCode: pricing.discountCode,
      discountCodeId: pricing.discountCodeId,
      originalPriceToman: pricing.originalPriceToman,
      discountAmountToman: pricing.discountAmountToman,
      finalPriceToman: pricing.finalPriceToman,
    };

    const cases: Array<[ServiceOperation, unknown]> = [
      ["RENEWAL", buildRenewalSnapshot(withRelations, service, draft)],
      ["EXTRA_VOLUME", buildExtraVolumeSnapshot(withRelations, service, draft)],
      ["EXTRA_TIME", buildExtraTimeSnapshot(withRelations, service, draft)],
    ];
    for (const [operation, botSnapshot] of cases) {
      expect(buildOperationSnapshot(withRelations, service, operation, pricing)).toEqual(
        botSnapshot,
      );
    }
  });
});
