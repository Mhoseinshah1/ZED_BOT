-- Representative Program (feat/representative-program).
-- FULLY ADDITIVE. Five new tables + two additive nullable-with-default columns
-- on existing tables. NO existing financial table (CheckoutSession, Payment,
-- Order, WalletTransaction, DiscountCodeUsage, ...) is altered or dropped, and
-- no data is destroyed. Representative pricing only changes the FINAL product
-- price of a normal checkout; these tables hold NO money, NO wallet balance, NO
-- commission, NO debt and NO second ledger (§6). Statuses/modes are text
-- columns validated by the @zedbot/shared contract (never a Persian label).
--
-- Two additive columns on existing tables (both default false, so existing rows
-- and all retail behaviour are unchanged):
--   * Product.representativeEligible          — opt-in per product (§8)
--   * DiscountCode.allowRepresentativeStacking — opt-in stacking on rep price (§7)

-- AlterTable
ALTER TABLE "DiscountCode" ADD COLUMN     "allowRepresentativeStacking" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "representativeEligible" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "RepresentativeApplication" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "fullName" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "province" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "salesChannel" TEXT NOT NULL,
    "expectedMonthlyCustomers" INTEGER NOT NULL,
    "experience" TEXT,
    "explanation" TEXT NOT NULL,
    "reviewedByAdminId" TEXT,
    "decisionReason" TEXT,
    "submittedAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "sourceUpdateId" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RepresentativeApplication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Representative" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "approvedApplicationId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "tierId" TEXT,
    "checkoutEnabled" BOOLEAN NOT NULL DEFAULT true,
    "approvedByAdminId" TEXT,
    "suspendedByAdminId" TEXT,
    "terminatedByAdminId" TEXT,
    "statusReason" TEXT,
    "approvedAt" TIMESTAMP(3),
    "suspendedAt" TIMESTAMP(3),
    "terminatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Representative_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RepresentativeTier" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "archivedAt" TIMESTAMP(3),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdByAdminId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RepresentativeTier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RepresentativeProductPrice" (
    "id" TEXT NOT NULL,
    "tierId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "priceMode" TEXT NOT NULL,
    "fixedPriceToman" INTEGER,
    "percentValue" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "archivedAt" TIMESTAMP(3),
    "createdByAdminId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RepresentativeProductPrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RepresentativePurchase" (
    "id" TEXT NOT NULL,
    "representativeId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tierId" TEXT,
    "productId" TEXT NOT NULL,
    "checkoutSessionId" TEXT NOT NULL,
    "paymentId" TEXT,
    "orderId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "pricingMode" TEXT NOT NULL DEFAULT 'REPRESENTATIVE',
    "priceMode" TEXT NOT NULL,
    "retailPriceToman" INTEGER NOT NULL,
    "basePriceToman" INTEGER NOT NULL,
    "discountAmountToman" INTEGER NOT NULL DEFAULT 0,
    "finalPriceToman" INTEGER NOT NULL,
    "tierFingerprint" TEXT NOT NULL,
    "priceFingerprint" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RepresentativePurchase_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RepresentativeApplication_sourceUpdateId_key" ON "RepresentativeApplication"("sourceUpdateId");

-- CreateIndex
CREATE INDEX "RepresentativeApplication_userId_status_idx" ON "RepresentativeApplication"("userId", "status");

-- CreateIndex
CREATE INDEX "RepresentativeApplication_status_createdAt_idx" ON "RepresentativeApplication"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Representative_userId_key" ON "Representative"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Representative_approvedApplicationId_key" ON "Representative"("approvedApplicationId");

-- CreateIndex
CREATE INDEX "Representative_status_idx" ON "Representative"("status");

-- CreateIndex
CREATE INDEX "Representative_tierId_idx" ON "Representative"("tierId");

-- CreateIndex
CREATE UNIQUE INDEX "RepresentativeTier_slug_key" ON "RepresentativeTier"("slug");

-- CreateIndex
CREATE INDEX "RepresentativeTier_isActive_sortOrder_idx" ON "RepresentativeTier"("isActive", "sortOrder");

-- CreateIndex
CREATE INDEX "RepresentativeProductPrice_productId_idx" ON "RepresentativeProductPrice"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "RepresentativeProductPrice_tierId_productId_key" ON "RepresentativeProductPrice"("tierId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "RepresentativePurchase_checkoutSessionId_key" ON "RepresentativePurchase"("checkoutSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "RepresentativePurchase_paymentId_key" ON "RepresentativePurchase"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "RepresentativePurchase_orderId_key" ON "RepresentativePurchase"("orderId");

-- CreateIndex
CREATE INDEX "RepresentativePurchase_representativeId_createdAt_idx" ON "RepresentativePurchase"("representativeId", "createdAt");

-- CreateIndex
CREATE INDEX "RepresentativePurchase_userId_createdAt_idx" ON "RepresentativePurchase"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "RepresentativePurchase_status_createdAt_idx" ON "RepresentativePurchase"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "RepresentativeApplication" ADD CONSTRAINT "RepresentativeApplication_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Representative" ADD CONSTRAINT "Representative_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Representative" ADD CONSTRAINT "Representative_approvedApplicationId_fkey" FOREIGN KEY ("approvedApplicationId") REFERENCES "RepresentativeApplication"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Representative" ADD CONSTRAINT "Representative_tierId_fkey" FOREIGN KEY ("tierId") REFERENCES "RepresentativeTier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepresentativeProductPrice" ADD CONSTRAINT "RepresentativeProductPrice_tierId_fkey" FOREIGN KEY ("tierId") REFERENCES "RepresentativeTier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepresentativeProductPrice" ADD CONSTRAINT "RepresentativeProductPrice_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepresentativePurchase" ADD CONSTRAINT "RepresentativePurchase_representativeId_fkey" FOREIGN KEY ("representativeId") REFERENCES "Representative"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepresentativePurchase" ADD CONSTRAINT "RepresentativePurchase_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepresentativePurchase" ADD CONSTRAINT "RepresentativePurchase_tierId_fkey" FOREIGN KEY ("tierId") REFERENCES "RepresentativeTier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepresentativePurchase" ADD CONSTRAINT "RepresentativePurchase_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Partial unique guard (§9, §25): at most ONE OPEN application (DRAFT or
-- PENDING_REVIEW) per user, enforced by the database. Terminal applications
-- (APPROVED / REJECTED / WITHDRAWN) never block a fresh application, so a
-- rejected/withdrawn applicant may re-apply while approved history is retained.
-- Mirrors the FreeTrialClaim live-claim guard. Prisma does not model partial
-- indexes in schema.prisma, so this is declared here; the repo applies
-- migrations with `migrate deploy` (never `migrate dev`), so it is not dropped.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "RepresentativeApplication_userId_open_key"
    ON "RepresentativeApplication"("userId")
    WHERE "status" IN ('DRAFT', 'PENDING_REVIEW');
