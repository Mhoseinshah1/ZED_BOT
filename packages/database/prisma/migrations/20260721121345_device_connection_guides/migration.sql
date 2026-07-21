-- CreateTable
CREATE TABLE "ConnectionGuideApp" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "iconEmoji" TEXT NOT NULL,
    "primaryDownloadUrl" TEXT NOT NULL,
    "alternateDownloadUrl" TEXT,
    "supportsSubscription" BOOLEAN NOT NULL DEFAULT true,
    "supportsQr" BOOLEAN NOT NULL DEFAULT true,
    "supportsIndividualConfigs" BOOLEAN NOT NULL DEFAULT true,
    "instructions" TEXT NOT NULL,
    "troubleshooting" TEXT NOT NULL DEFAULT '',
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedByAdminId" TEXT,

    CONSTRAINT "ConnectionGuideApp_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ConnectionGuideApp_slug_key" ON "ConnectionGuideApp"("slug");

-- CreateIndex
CREATE INDEX "ConnectionGuideApp_platform_isActive_sortOrder_idx" ON "ConnectionGuideApp"("platform", "isActive", "sortOrder");

-- CreateIndex
CREATE INDEX "ConnectionGuideApp_isActive_idx" ON "ConnectionGuideApp"("isActive");

-- CreateIndex
CREATE INDEX "ConnectionGuideApp_archivedAt_idx" ON "ConnectionGuideApp"("archivedAt");
