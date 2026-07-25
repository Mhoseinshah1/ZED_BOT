-- Service-checkout username selection + optional subscription note
-- (feat/service-checkout-username-note). FULLY ADDITIVE and forward-only. Adds:
--   * two enums (ServiceUsernameMode, ServiceUsernameReservationStatus)
--   * two nullable columns on existing tables — Order.serviceNoteSnapshot and
--     Service.userNote — so every existing row and all legacy behaviour is
--     unchanged (both default to NULL = "no buyer note / legacy order")
--   * one new table, ServiceUsernameReservation, the DURABLE authority for
--     buyer-selected remote usernames.
-- NO existing column is altered or dropped, NO existing username is rewritten,
-- and NO existing financial/checkout/order/service data is destroyed.
--
-- The `(panelId, activeUsernameKey)` UNIQUE index is a FILTERED uniqueness: the
-- app keeps activeUsernameKey = normalizedUsername while a reservation is
-- HELD/BOUND/CONSUMED and NULLs it on RELEASED/EXPIRED. Because Postgres treats
-- NULLs as distinct in a unique index, released usernames free their slot for
-- re-use while two live holders of the same (panel, username) are forbidden — a
-- check-then-insert race surfaces as P2002 and is resolved by re-reading the
-- winner. The DB is the single reservation authority (never an in-memory Set,
-- Redis-only lock, or Telegram-session flag).

-- CreateEnum
CREATE TYPE "ServiceUsernameMode" AS ENUM ('CUSTOM', 'RANDOM');

-- CreateEnum
CREATE TYPE "ServiceUsernameReservationStatus" AS ENUM ('HELD', 'BOUND', 'CONSUMED', 'RELEASED', 'EXPIRED');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "serviceNoteSnapshot" TEXT;

-- AlterTable
ALTER TABLE "Service" ADD COLUMN     "userNote" TEXT;

-- CreateTable
CREATE TABLE "ServiceUsernameReservation" (
    "id" TEXT NOT NULL,
    "panelId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "normalizedUsername" TEXT NOT NULL,
    "activeUsernameKey" TEXT,
    "mode" "ServiceUsernameMode" NOT NULL,
    "status" "ServiceUsernameReservationStatus" NOT NULL DEFAULT 'HELD',
    "draftNonce" TEXT,
    "checkoutSessionId" TEXT,
    "orderId" TEXT,
    "serviceId" TEXT,
    "expiresAt" TIMESTAMP(3),
    "boundAt" TIMESTAMP(3),
    "consumedAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceUsernameReservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ServiceUsernameReservation_serviceId_key" ON "ServiceUsernameReservation"("serviceId");

-- CreateIndex
CREATE INDEX "ServiceUsernameReservation_userId_idx" ON "ServiceUsernameReservation"("userId");

-- CreateIndex
CREATE INDEX "ServiceUsernameReservation_panelId_idx" ON "ServiceUsernameReservation"("panelId");

-- CreateIndex
CREATE INDEX "ServiceUsernameReservation_status_idx" ON "ServiceUsernameReservation"("status");

-- CreateIndex
CREATE INDEX "ServiceUsernameReservation_normalizedUsername_idx" ON "ServiceUsernameReservation"("normalizedUsername");

-- CreateIndex
CREATE INDEX "ServiceUsernameReservation_checkoutSessionId_idx" ON "ServiceUsernameReservation"("checkoutSessionId");

-- CreateIndex
CREATE INDEX "ServiceUsernameReservation_orderId_idx" ON "ServiceUsernameReservation"("orderId");

-- CreateIndex
CREATE INDEX "ServiceUsernameReservation_expiresAt_idx" ON "ServiceUsernameReservation"("expiresAt");

-- CreateIndex
CREATE INDEX "ServiceUsernameReservation_userId_draftNonce_idx" ON "ServiceUsernameReservation"("userId", "draftNonce");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceUsernameReservation_panelId_activeUsernameKey_key" ON "ServiceUsernameReservation"("panelId", "activeUsernameKey");

-- AddForeignKey
ALTER TABLE "ServiceUsernameReservation" ADD CONSTRAINT "ServiceUsernameReservation_panelId_fkey" FOREIGN KEY ("panelId") REFERENCES "Panel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceUsernameReservation" ADD CONSTRAINT "ServiceUsernameReservation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceUsernameReservation" ADD CONSTRAINT "ServiceUsernameReservation_checkoutSessionId_fkey" FOREIGN KEY ("checkoutSessionId") REFERENCES "CheckoutSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceUsernameReservation" ADD CONSTRAINT "ServiceUsernameReservation_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceUsernameReservation" ADD CONSTRAINT "ServiceUsernameReservation_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE SET NULL ON UPDATE CASCADE;
