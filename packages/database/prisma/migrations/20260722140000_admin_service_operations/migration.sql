-- Admin Service Operations (feat/admin-service-operations).
-- Fully additive: one new table (AdminServiceOperation) — the durable audit +
-- reconciliation authority for per-Service admin lifecycle actions and internal
-- notes. No existing table is altered; no Service/Order/Payment/Wallet row is
-- touched. Relations are nullable ON DELETE SET NULL so the audit row survives
-- Service/User/Admin removal. Snapshots are the SAFE shape only (no secret).
-- CreateTable
CREATE TABLE "AdminServiceOperation" (
    "id" TEXT NOT NULL,
    "serviceId" TEXT,
    "targetUserId" TEXT,
    "adminId" TEXT,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "requestedValue" BIGINT,
    "requestedUnit" TEXT,
    "notifyUser" BOOLEAN NOT NULL DEFAULT true,
    "idempotencyKey" TEXT NOT NULL,
    "sourceUpdateId" BIGINT,
    "confirmationNonceHash" TEXT,
    "beforeSnapshot" JSONB NOT NULL,
    "afterSnapshot" JSONB,
    "safeErrorCode" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "userNotifiedAt" TIMESTAMP(3),
    "reconciledAt" TIMESTAMP(3),
    "reconciledByAdminId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminServiceOperation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdminServiceOperation_idempotencyKey_key" ON "AdminServiceOperation"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "AdminServiceOperation_sourceUpdateId_key" ON "AdminServiceOperation"("sourceUpdateId");

-- CreateIndex
CREATE INDEX "AdminServiceOperation_serviceId_createdAt_idx" ON "AdminServiceOperation"("serviceId", "createdAt");

-- CreateIndex
CREATE INDEX "AdminServiceOperation_adminId_createdAt_idx" ON "AdminServiceOperation"("adminId", "createdAt");

-- CreateIndex
CREATE INDEX "AdminServiceOperation_status_createdAt_idx" ON "AdminServiceOperation"("status", "createdAt");

-- CreateIndex
CREATE INDEX "AdminServiceOperation_type_createdAt_idx" ON "AdminServiceOperation"("type", "createdAt");

-- AddForeignKey
ALTER TABLE "AdminServiceOperation" ADD CONSTRAINT "AdminServiceOperation_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminServiceOperation" ADD CONSTRAINT "AdminServiceOperation_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminServiceOperation" ADD CONSTRAINT "AdminServiceOperation_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "Admin"("id") ON DELETE SET NULL ON UPDATE CASCADE;

