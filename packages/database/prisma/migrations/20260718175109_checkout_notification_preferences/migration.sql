-- CreateTable
CREATE TABLE "CheckoutNotificationPreference" (
    "id" TEXT NOT NULL,
    "checkoutSessionId" TEXT NOT NULL,
    "abandonedReminderSuppressedAt" TIMESTAMP(3),
    "paymentRetrySuppressedAt" TIMESTAMP(3),
    "suppressedByNotificationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CheckoutNotificationPreference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CheckoutNotificationPreference_checkoutSessionId_key" ON "CheckoutNotificationPreference"("checkoutSessionId");
