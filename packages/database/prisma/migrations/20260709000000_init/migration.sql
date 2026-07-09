-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "AdminRole" AS ENUM ('OWNER', 'SELLER', 'SUPPORT', 'RECEIPT_REVIEWER');

-- CreateEnum
CREATE TYPE "UserGroup" AS ENUM ('F', 'N', 'N2');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'BLOCKED', 'DISABLED', 'DELETED');

-- CreateEnum
CREATE TYPE "KycStatus" AS ENUM ('NONE', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "WalletTransactionType" AS ENUM ('CHARGE', 'SPEND', 'REFUND', 'CASHBACK', 'COMMISSION', 'MANUAL_ADD', 'MANUAL_DEDUCT', 'DEBT_ADD', 'DEBT_PAYMENT', 'DISCOUNT', 'SYSTEM_ADJUSTMENT');

-- CreateEnum
CREATE TYPE "WalletTransactionSource" AS ENUM ('USER_PAYMENT', 'ORDER', 'ADMIN', 'REFERRAL', 'CASHBACK', 'SYSTEM', 'REPRESENTATIVE_DEBT');

-- CreateEnum
CREATE TYPE "PanelType" AS ENUM ('MARZBAN', 'XUI');

-- CreateEnum
CREATE TYPE "PanelStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'MAINTENANCE', 'FAILED');

-- CreateEnum
CREATE TYPE "ServiceLocation" AS ENUM ('MULTI_LOCATION', 'DEDICATED_LOCATION', 'TEST');

-- CreateEnum
CREATE TYPE "RenewalMethod" AS ENUM ('RESET_VOLUME_AND_TIME', 'ADD_TIME_AND_VOLUME_TO_NEXT_PERIOD', 'RESET_TIME_ADD_PREVIOUS_VOLUME', 'RESET_VOLUME_ADD_TIME', 'ADD_TIME_KEEP_REMAINING_VOLUME_AS_TOTAL');

-- CreateEnum
CREATE TYPE "UsernamePatternType" AS ENUM ('TELEGRAM_USERNAME_SEQUENCE', 'TELEGRAM_ID_RANDOM', 'CUSTOM', 'CUSTOM_RANDOM', 'CUSTOM_TEXT_RANDOM', 'CUSTOM_TEXT_SEQUENCE', 'TELEGRAM_ID_SEQUENCE', 'REPRESENTATIVE_TEXT_SEQUENCE');

-- CreateEnum
CREATE TYPE "ProductType" AS ENUM ('SERVICE_PRODUCT', 'OTHER_PRODUCT');

-- CreateEnum
CREATE TYPE "OtherProductDeliveryType" AS ENUM ('MANUAL_ADMIN', 'STOCK_ITEM');

-- CreateEnum
CREATE TYPE "TrafficResetCycle" AS ENUM ('NO_RESET', 'DAY', 'WEEK', 'MONTH', 'YEAR');

-- CreateEnum
CREATE TYPE "DiscountType" AS ENUM ('PERCENT', 'FIXED_AMOUNT');

-- CreateEnum
CREATE TYPE "DiscountAppliesTo" AS ENUM ('PURCHASE', 'RENEWAL', 'BOTH');

-- CreateEnum
CREATE TYPE "CheckoutStatus" AS ENUM ('PENDING', 'PAID', 'EXPIRED', 'CANCELLED', 'FAILED_REFUNDED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "CheckoutPurpose" AS ENUM ('WALLET_CHARGE', 'ORDER_PAYMENT', 'PAY_WITH_WALLET');

-- CreateEnum
CREATE TYPE "OrderType" AS ENUM ('SERVICE_PURCHASE', 'SERVICE_RENEWAL', 'EXTRA_VOLUME', 'EXTRA_TIME', 'LOCATION_CHANGE', 'OTHER_PRODUCT');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING_PAYMENT', 'WAITING_RECEIPT', 'PENDING_REVIEW', 'PAID', 'PROVISIONING', 'COMPLETED', 'FAILED', 'CANCELLED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "PaymentGatewayType" AS ENUM ('CARD_TO_CARD', 'PLISIO', 'NOWPAYMENTS', 'AGHAYEPARDAKHT', 'ZARINPAL', 'TELEGRAM_STARS', 'CUSTOM');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'FAILED', 'EXPIRED', 'DELETED');

-- CreateEnum
CREATE TYPE "PaymentPurpose" AS ENUM ('WALLET_CHARGE', 'ORDER_PAYMENT', 'PAY_WITH_WALLET');

-- CreateEnum
CREATE TYPE "StarsPricingMode" AS ENUM ('MANUAL_RATE', 'AUTO_RATE_API');

-- CreateEnum
CREATE TYPE "ServiceStatus" AS ENUM ('CREATING', 'ACTIVE', 'DISABLED', 'EXPIRED', 'LIMITED', 'DELETED', 'FAILED');

-- CreateEnum
CREATE TYPE "OtherProductOrderStatus" AS ENUM ('PAID', 'WAITING_USER_INFO', 'WAITING_ADMIN_DELIVERY', 'DELIVERED', 'CANCELLED', 'REFUNDED', 'DELIVERY_CANCELLED_REFUNDED', 'DELIVERY_REJECTED_NO_REFUND');

-- CreateEnum
CREATE TYPE "ReferralCommissionStatus" AS ENUM ('PENDING', 'PAID', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SupportMode" AS ENUM ('PRIVATE_CHAT', 'TICKET');

-- CreateEnum
CREATE TYPE "SupportTicketStatus" AS ENUM ('OPEN', 'ANSWERED', 'CLOSED');

-- CreateEnum
CREATE TYPE "SupportMessageSenderType" AS ENUM ('USER', 'ADMIN');

-- CreateEnum
CREATE TYPE "TutorialMediaType" AS ENUM ('PHOTO', 'VIDEO', 'DOCUMENT');

-- CreateEnum
CREATE TYPE "BroadcastType" AS ENUM ('SEND', 'FORWARD');

-- CreateEnum
CREATE TYPE "BroadcastStatus" AS ENUM ('DRAFT', 'CONFIRMING', 'RUNNING', 'CANCELLED', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "BroadcastRecipientStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "SystemLogLevel" AS ENUM ('INFO', 'WARN', 'ERROR');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('SYSTEM', 'USER', 'ADMIN', 'WORKER');

-- CreateEnum
CREATE TYPE "SettingType" AS ENUM ('STRING', 'NUMBER', 'BOOLEAN', 'JSON');

-- CreateTable
CREATE TABLE "Admin" (
    "id" TEXT NOT NULL,
    "telegramId" BIGINT NOT NULL,
    "username" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "role" "AdminRole" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "addedByAdminId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Admin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminPermission" (
    "id" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "permissionKey" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminPermission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "telegramId" BIGINT NOT NULL,
    "username" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "phoneNumber" TEXT,
    "languageCode" TEXT,
    "isBot" BOOLEAN NOT NULL DEFAULT false,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "group" "UserGroup" NOT NULL DEFAULT 'F',
    "adminNote" TEXT,
    "representativeSince" TIMESTAMP(3),
    "representativeRemovedAt" TIMESTAMP(3),
    "representativeDebtToman" INTEGER NOT NULL DEFAULT 0,
    "representativeDebtLocked" BOOLEAN NOT NULL DEFAULT false,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3),
    "blockedAt" TIMESTAMP(3),
    "blockedByAdminId" TEXT,
    "blockReason" TEXT,
    "disabledAt" TIMESTAMP(3),
    "disabledByAdminId" TEXT,
    "isPhoneVerified" BOOLEAN NOT NULL DEFAULT false,
    "phoneVerifiedAt" TIMESTAMP(3),
    "phoneVerifiedByAdminId" TEXT,
    "kycStatus" "KycStatus" NOT NULL DEFAULT 'NONE',
    "kycUpdatedAt" TIMESTAMP(3),
    "kycUpdatedByAdminId" TEXT,
    "termsAcceptedAt" TIMESTAMP(3),
    "forceJoinBypass" BOOLEAN NOT NULL DEFAULT false,
    "forceJoinBypassByAdminId" TEXT,
    "referrerId" TEXT,
    "referralCode" TEXT,
    "referralJoinedAt" TIMESTAMP(3),
    "referralGiftClaimedAt" TIMESTAMP(3),
    "totalReferralCount" INTEGER NOT NULL DEFAULT 0,
    "totalReferralPurchaseCount" INTEGER NOT NULL DEFAULT 0,
    "totalReferralPurchaseAmountToman" INTEGER NOT NULL DEFAULT 0,
    "totalReferralCommissionToman" INTEGER NOT NULL DEFAULT 0,
    "balanceToman" INTEGER NOT NULL DEFAULT 0,
    "totalChargedToman" INTEGER NOT NULL DEFAULT 0,
    "totalSpentToman" INTEGER NOT NULL DEFAULT 0,
    "totalDiscountToman" INTEGER NOT NULL DEFAULT 0,
    "totalRefundedToman" INTEGER NOT NULL DEFAULT 0,
    "totalManualAddedToman" INTEGER NOT NULL DEFAULT 0,
    "totalManualDeductedToman" INTEGER NOT NULL DEFAULT 0,
    "allowNegativeBalance" BOOLEAN NOT NULL DEFAULT false,
    "referralCount" INTEGER NOT NULL DEFAULT 0,
    "subServiceCount" INTEGER NOT NULL DEFAULT 0,
    "ordersCount" INTEGER NOT NULL DEFAULT 0,
    "paidOrdersCount" INTEGER NOT NULL DEFAULT 0,
    "totalPurchaseAmountToman" INTEGER NOT NULL DEFAULT 0,
    "discountPercent" INTEGER NOT NULL DEFAULT 0,
    "score" INTEGER NOT NULL DEFAULT 0,
    "testAccountLimitOverride" INTEGER,
    "testAccountsCreatedCount" INTEGER NOT NULL DEFAULT 0,
    "lastTestAccountCreatedAt" TIMESTAMP(3),
    "testLimitResetAt" TIMESTAMP(3),
    "cronNotificationsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "marketingMessagesEnabled" BOOLEAN NOT NULL DEFAULT true,
    "supportMessagesEnabled" BOOLEAN NOT NULL DEFAULT true,
    "paymentNotificationsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "serviceNotificationsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletTransaction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amountToman" INTEGER NOT NULL,
    "type" "WalletTransactionType" NOT NULL,
    "source" "WalletTransactionSource" NOT NULL,
    "reason" TEXT,
    "relatedOrderId" TEXT,
    "relatedPaymentId" TEXT,
    "adminId" TEXT,
    "balanceBeforeToman" INTEGER NOT NULL,
    "balanceAfterToman" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Panel" (
    "id" TEXT NOT NULL,
    "type" "PanelType" NOT NULL,
    "name" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "username" TEXT,
    "passwordEncrypted" TEXT,
    "tokenEncrypted" TEXT,
    "status" "PanelStatus" NOT NULL DEFAULT 'ACTIVE',
    "panelColor" TEXT,
    "isVisible" BOOLEAN NOT NULL DEFAULT true,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "visibleForGroups" JSONB,
    "renewalMethod" "RenewalMethod" NOT NULL DEFAULT 'RESET_VOLUME_AND_TIME',
    "showPanel" BOOLEAN NOT NULL DEFAULT true,
    "showFreeTest" BOOLEAN NOT NULL DEFAULT false,
    "renewalEnabled" BOOLEAN NOT NULL DEFAULT true,
    "customServiceForF" BOOLEAN NOT NULL DEFAULT false,
    "customServiceForN" BOOLEAN NOT NULL DEFAULT false,
    "customServiceForN2" BOOLEAN NOT NULL DEFAULT false,
    "panelUserLimitEnabled" BOOLEAN NOT NULL DEFAULT false,
    "userLimitEnabled" BOOLEAN NOT NULL DEFAULT false,
    "extraUserPurchaseEnabled" BOOLEAN NOT NULL DEFAULT false,
    "sendConfigEnabled" BOOLEAN NOT NULL DEFAULT true,
    "happLinkEnabled" BOOLEAN NOT NULL DEFAULT false,
    "configKeyboardEnabled" BOOLEAN NOT NULL DEFAULT false,
    "subscriptionLinkEnabled" BOOLEAN NOT NULL DEFAULT true,
    "firstConnectionEnabled" BOOLEAN NOT NULL DEFAULT false,
    "freeTestFirstConnectionEnabled" BOOLEAN NOT NULL DEFAULT false,
    "locationChangeEnabled" BOOLEAN NOT NULL DEFAULT false,
    "dedicatedSubscriptionLinkEnabled" BOOLEAN NOT NULL DEFAULT false,
    "userCanDisableService" BOOLEAN NOT NULL DEFAULT false,
    "userCanEnableService" BOOLEAN NOT NULL DEFAULT false,
    "pricePerExtraGbToman" INTEGER NOT NULL DEFAULT 0,
    "pricePerExtraDayToman" INTEGER NOT NULL DEFAULT 0,
    "locationChangePriceToman" INTEGER NOT NULL DEFAULT 0,
    "extraUserPriceToman" INTEGER NOT NULL DEFAULT 0,
    "customServicePricePerGbToman" INTEGER NOT NULL DEFAULT 0,
    "customServicePricePerDayToman" INTEGER NOT NULL DEFAULT 0,
    "customServiceMinGb" INTEGER,
    "customServiceMaxGb" INTEGER,
    "customServiceMinDays" INTEGER,
    "customServiceMaxDays" INTEGER,
    "testEnabled" BOOLEAN NOT NULL DEFAULT false,
    "testVolumeMb" INTEGER,
    "testDurationMinutes" INTEGER,
    "testProductName" TEXT,
    "testLocation" TEXT,
    "testMessageTemplate" TEXT,
    "testGuideAfterCreate" TEXT,
    "templateUsername" TEXT,
    "subscriptionDomain" TEXT,
    "usernamePatternType" "UsernamePatternType" NOT NULL DEFAULT 'TELEGRAM_ID_RANDOM',
    "usernameCustomText" TEXT,
    "usernameRandomLength" INTEGER,
    "usernameSequenceLastNumber" INTEGER NOT NULL DEFAULT 0,
    "representativeUsernamePrefix" TEXT,
    "representativeSequenceLastNumber" INTEGER NOT NULL DEFAULT 0,
    "inboundTemplateName" TEXT,
    "resetStrategy" TEXT,
    "inboundIds" JSONB,
    "protocolSettings" JSONB,
    "accountLimitEnabled" BOOLEAN NOT NULL DEFAULT false,
    "accountLimitCount" INTEGER,
    "createdAccountsCount" INTEGER NOT NULL DEFAULT 0,
    "activeAccountsCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Panel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserHiddenPanel" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "panelId" TEXT NOT NULL,
    "hiddenByAdminId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserHiddenPanel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductCategory" (
    "id" TEXT NOT NULL,
    "type" "ProductType" NOT NULL,
    "name" TEXT NOT NULL,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "type" "ProductType" NOT NULL,
    "categoryId" TEXT NOT NULL,
    "panelId" TEXT,
    "name" TEXT NOT NULL,
    "displayGroups" JSONB,
    "serviceLocation" "ServiceLocation",
    "volumeGb" INTEGER,
    "durationDays" INTEGER,
    "priceToman" INTEGER NOT NULL,
    "invoiceDescription" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "trafficResetCycle" "TrafficResetCycle",
    "allLocations" BOOLEAN NOT NULL DEFAULT false,
    "requiredUserInfoEnabled" BOOLEAN NOT NULL DEFAULT false,
    "requiredUserInfoPromptText" TEXT,
    "deliveryType" "OtherProductDeliveryType",
    "stockEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscountCode" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "type" "DiscountType" NOT NULL,
    "value" INTEGER NOT NULL,
    "totalUsageLimit" INTEGER,
    "totalUsedCount" INTEGER NOT NULL DEFAULT 0,
    "perUserUsageLimit" INTEGER,
    "allowedGroups" JSONB,
    "appliesTo" "DiscountAppliesTo" NOT NULL DEFAULT 'BOTH',
    "startsAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdByAdminId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscountCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscountCodeUsage" (
    "id" TEXT NOT NULL,
    "discountCodeId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "orderId" TEXT,
    "checkoutSessionId" TEXT,
    "amountToman" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DiscountCodeUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CheckoutSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "purpose" "CheckoutPurpose" NOT NULL,
    "productId" TEXT,
    "serviceId" TEXT,
    "orderType" "OrderType",
    "productSnapshot" JSONB,
    "originalPriceToman" INTEGER NOT NULL DEFAULT 0,
    "discountAmountToman" INTEGER NOT NULL DEFAULT 0,
    "finalPriceToman" INTEGER NOT NULL DEFAULT 0,
    "discountCodeId" TEXT,
    "status" "CheckoutStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CheckoutSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "checkoutSessionId" TEXT,
    "type" "OrderType" NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
    "productId" TEXT,
    "serviceId" TEXT,
    "paymentId" TEXT,
    "panelId" TEXT,
    "originalPriceToman" INTEGER NOT NULL DEFAULT 0,
    "discountAmountToman" INTEGER NOT NULL DEFAULT 0,
    "finalPriceToman" INTEGER NOT NULL DEFAULT 0,
    "discountCodeId" TEXT,
    "productNameSnapshot" TEXT,
    "productDescriptionSnapshot" TEXT,
    "productPriceSnapshot" INTEGER,
    "durationDaysSnapshot" INTEGER,
    "volumeGbSnapshot" INTEGER,
    "noteSnapshot" TEXT,
    "panelNameSnapshot" TEXT,
    "locationSnapshot" TEXT,
    "categorySnapshot" TEXT,
    "rating" INTEGER,
    "failureReason" TEXT,
    "adminNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "refundedAt" TIMESTAMP(3),

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentGateway" (
    "id" TEXT NOT NULL,
    "type" "PaymentGatewayType" NOT NULL,
    "name" TEXT NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "isHidden" BOOLEAN NOT NULL DEFAULT false,
    "configEncrypted" TEXT,
    "minAmountToman" INTEGER,
    "maxAmountToman" INTEGER,
    "activateAfterSuccessfulPaymentsCount" INTEGER NOT NULL DEFAULT 0,
    "allowedGroups" JSONB,
    "cashbackPercent" INTEGER NOT NULL DEFAULT 0,
    "supportUsername" TEXT,
    "instructionText" TEXT,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentGateway_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CardToCardAccount" (
    "id" TEXT NOT NULL,
    "gatewayId" TEXT NOT NULL,
    "cardNumberEncrypted" TEXT NOT NULL,
    "ownerName" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CardToCardAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "orderId" TEXT,
    "checkoutSessionId" TEXT,
    "gatewayId" TEXT,
    "purpose" "PaymentPurpose" NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "amountToman" INTEGER NOT NULL,
    "payableAmountToman" INTEGER NOT NULL,
    "externalTransactionId" TEXT,
    "callbackPayload" JSONB,
    "idempotencyKey" TEXT,
    "expiresAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "reviewedAt" TIMESTAMP(3),
    "reviewedByAdminId" TEXT,
    "rejectReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManualReceipt" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fileId" TEXT,
    "text" TEXT,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "reviewedByAdminId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "rejectReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManualReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserHiddenPaymentGateway" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "paymentGatewayId" TEXT NOT NULL,
    "hiddenByAdminId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserHiddenPaymentGateway_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StarsPricingSetting" (
    "id" TEXT NOT NULL,
    "pricingMode" "StarsPricingMode" NOT NULL DEFAULT 'MANUAL_RATE',
    "manualTomanPerStar" INTEGER,
    "currencyRateApiUrl" TEXT,
    "currencyRateApiTokenEncrypted" TEXT,
    "currencyCode" TEXT,
    "starsPriceFormula" TEXT,
    "minStars" INTEGER,
    "maxStars" INTEGER,
    "cashbackPercent" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StarsPricingSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Service" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "orderId" TEXT,
    "panelId" TEXT NOT NULL,
    "productId" TEXT,
    "panelType" "PanelType" NOT NULL,
    "username" TEXT NOT NULL,
    "note" TEXT,
    "status" "ServiceStatus" NOT NULL DEFAULT 'CREATING',
    "serviceLocation" "ServiceLocation" NOT NULL DEFAULT 'MULTI_LOCATION',
    "productNameSnapshot" TEXT,
    "panelNameSnapshot" TEXT,
    "volumeBytes" BIGINT NOT NULL DEFAULT 0,
    "usedBytes" BIGINT NOT NULL DEFAULT 0,
    "remainingBytes" BIGINT NOT NULL DEFAULT 0,
    "durationDays" INTEGER NOT NULL DEFAULT 0,
    "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "firstConnectedAt" TIMESTAMP(3),
    "lastConnectedAt" TIMESTAMP(3),
    "lastSubscriptionUpdateAt" TIMESTAMP(3),
    "subscriptionUrl" TEXT,
    "subscriptionToken" TEXT,
    "configLinks" JSONB,
    "qrCodeFileId" TEXT,
    "userAgent" TEXT,
    "rating" INTEGER,
    "transferredFromUserId" TEXT,
    "transferredAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "panelDeletedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Service_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceRating" (
    "id" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServiceRating_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceEventLog" (
    "id" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "panelId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServiceEventLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OtherProductOrder" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "status" "OtherProductOrderStatus" NOT NULL,
    "userProvidedInfoText" TEXT,
    "userProvidedFiles" JSONB,
    "adminDeliveryText" TEXT,
    "adminDeliveryFiles" JSONB,
    "deliveredByAdminId" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "adminRejectReason" TEXT,
    "adminCancelReason" TEXT,
    "userInfoReminderCount" INTEGER NOT NULL DEFAULT 0,
    "lastUserInfoReminderAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OtherProductOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Referral" (
    "id" TEXT NOT NULL,
    "referrerUserId" TEXT NOT NULL,
    "referredUserId" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "firstPurchaseAt" TIMESTAMP(3),
    "firstPurchaseOrderId" TEXT,
    "totalPurchaseAmountToman" INTEGER NOT NULL DEFAULT 0,
    "totalCommissionAmountToman" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Referral_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReferralCommission" (
    "id" TEXT NOT NULL,
    "referralId" TEXT NOT NULL,
    "referrerUserId" TEXT NOT NULL,
    "referredUserId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "amountToman" INTEGER NOT NULL,
    "percent" INTEGER NOT NULL,
    "status" "ReferralCommissionStatus" NOT NULL DEFAULT 'PENDING',
    "walletTransactionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMP(3),

    CONSTRAINT "ReferralCommission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestAccountHistory" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "panelId" TEXT NOT NULL,
    "serviceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TestAccountHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WheelSpinHistory" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "diceValue" INTEGER NOT NULL,
    "isWinner" BOOLEAN NOT NULL DEFAULT false,
    "prizeAmountToman" INTEGER NOT NULL DEFAULT 0,
    "walletTransactionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WheelSpinHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportTicket" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "SupportTicketStatus" NOT NULL DEFAULT 'OPEN',
    "subject" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "SupportTicket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportMessage" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "senderType" "SupportMessageSenderType" NOT NULL,
    "senderUserId" TEXT,
    "senderAdminId" TEXT,
    "text" TEXT,
    "fileId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TutorialCategory" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TutorialCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tutorial" (
    "id" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "caption" TEXT,
    "description" TEXT,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tutorial_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TutorialMedia" (
    "id" TEXT NOT NULL,
    "tutorialId" TEXT NOT NULL,
    "mediaType" "TutorialMediaType" NOT NULL,
    "telegramFileId" TEXT NOT NULL,
    "caption" TEXT,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TutorialMedia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageTemplate" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT,
    "defaultContent" TEXT NOT NULL,
    "currentContent" TEXT NOT NULL,
    "allowedVariables" JSONB,
    "isEditable" BOOLEAN NOT NULL DEFAULT true,
    "locale" TEXT NOT NULL DEFAULT 'fa',
    "updatedByAdminId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessageTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ButtonText" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "defaultText" TEXT NOT NULL,
    "currentText" TEXT NOT NULL,
    "isEditable" BOOLEAN NOT NULL DEFAULT true,
    "locale" TEXT NOT NULL DEFAULT 'fa',
    "updatedByAdminId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ButtonText_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Broadcast" (
    "id" TEXT NOT NULL,
    "type" "BroadcastType" NOT NULL,
    "status" "BroadcastStatus" NOT NULL DEFAULT 'DRAFT',
    "targetFilter" JSONB,
    "messageText" TEXT,
    "sourceChatId" BIGINT,
    "sourceMessageId" INTEGER,
    "pinMessage" BOOLEAN NOT NULL DEFAULT false,
    "totalTargets" INTEGER NOT NULL DEFAULT 0,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "pinFailedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "createdByAdminId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Broadcast_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BroadcastRecipient" (
    "id" TEXT NOT NULL,
    "broadcastId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "BroadcastRecipientStatus" NOT NULL DEFAULT 'PENDING',
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "pinStatus" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BroadcastRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LogTopic" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "telegramChatId" BIGINT,
    "topicId" INTEGER,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LogTopic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemLog" (
    "id" TEXT NOT NULL,
    "level" "SystemLogLevel" NOT NULL,
    "eventType" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "metadata" JSONB,
    "userId" TEXT,
    "adminId" TEXT,
    "orderId" TEXT,
    "paymentId" TEXT,
    "serviceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SystemLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorTelegramId" BIGINT,
    "actorType" "ActorType" NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "type" "SettingType" NOT NULL,
    "isPublic" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Admin_telegramId_key" ON "Admin"("telegramId");

-- CreateIndex
CREATE INDEX "Admin_role_idx" ON "Admin"("role");

-- CreateIndex
CREATE UNIQUE INDEX "AdminPermission_adminId_permissionKey_key" ON "AdminPermission"("adminId", "permissionKey");

-- CreateIndex
CREATE UNIQUE INDEX "User_telegramId_key" ON "User"("telegramId");

-- CreateIndex
CREATE UNIQUE INDEX "User_referralCode_key" ON "User"("referralCode");

-- CreateIndex
CREATE INDEX "User_status_idx" ON "User"("status");

-- CreateIndex
CREATE INDEX "User_group_idx" ON "User"("group");

-- CreateIndex
CREATE INDEX "User_referrerId_idx" ON "User"("referrerId");

-- CreateIndex
CREATE INDEX "User_createdAt_idx" ON "User"("createdAt");

-- CreateIndex
CREATE INDEX "WalletTransaction_userId_idx" ON "WalletTransaction"("userId");

-- CreateIndex
CREATE INDEX "WalletTransaction_type_idx" ON "WalletTransaction"("type");

-- CreateIndex
CREATE INDEX "WalletTransaction_relatedOrderId_idx" ON "WalletTransaction"("relatedOrderId");

-- CreateIndex
CREATE INDEX "WalletTransaction_relatedPaymentId_idx" ON "WalletTransaction"("relatedPaymentId");

-- CreateIndex
CREATE INDEX "WalletTransaction_createdAt_idx" ON "WalletTransaction"("createdAt");

-- CreateIndex
CREATE INDEX "Panel_status_idx" ON "Panel"("status");

-- CreateIndex
CREATE INDEX "Panel_type_idx" ON "Panel"("type");

-- CreateIndex
CREATE INDEX "UserHiddenPanel_panelId_idx" ON "UserHiddenPanel"("panelId");

-- CreateIndex
CREATE UNIQUE INDEX "UserHiddenPanel_userId_panelId_key" ON "UserHiddenPanel"("userId", "panelId");

-- CreateIndex
CREATE INDEX "ProductCategory_type_idx" ON "ProductCategory"("type");

-- CreateIndex
CREATE INDEX "Product_categoryId_idx" ON "Product"("categoryId");

-- CreateIndex
CREATE INDEX "Product_panelId_idx" ON "Product"("panelId");

-- CreateIndex
CREATE INDEX "Product_type_idx" ON "Product"("type");

-- CreateIndex
CREATE INDEX "Product_isActive_idx" ON "Product"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "DiscountCode_code_key" ON "DiscountCode"("code");

-- CreateIndex
CREATE INDEX "DiscountCode_isActive_idx" ON "DiscountCode"("isActive");

-- CreateIndex
CREATE INDEX "DiscountCode_expiresAt_idx" ON "DiscountCode"("expiresAt");

-- CreateIndex
CREATE INDEX "DiscountCodeUsage_discountCodeId_idx" ON "DiscountCodeUsage"("discountCodeId");

-- CreateIndex
CREATE INDEX "DiscountCodeUsage_userId_idx" ON "DiscountCodeUsage"("userId");

-- CreateIndex
CREATE INDEX "DiscountCodeUsage_orderId_idx" ON "DiscountCodeUsage"("orderId");

-- CreateIndex
CREATE INDEX "CheckoutSession_userId_idx" ON "CheckoutSession"("userId");

-- CreateIndex
CREATE INDEX "CheckoutSession_status_idx" ON "CheckoutSession"("status");

-- CreateIndex
CREATE INDEX "CheckoutSession_expiresAt_idx" ON "CheckoutSession"("expiresAt");

-- CreateIndex
CREATE INDEX "CheckoutSession_createdAt_idx" ON "CheckoutSession"("createdAt");

-- CreateIndex
CREATE INDEX "Order_userId_idx" ON "Order"("userId");

-- CreateIndex
CREATE INDEX "Order_status_idx" ON "Order"("status");

-- CreateIndex
CREATE INDEX "Order_type_idx" ON "Order"("type");

-- CreateIndex
CREATE INDEX "Order_productId_idx" ON "Order"("productId");

-- CreateIndex
CREATE INDEX "Order_serviceId_idx" ON "Order"("serviceId");

-- CreateIndex
CREATE INDEX "Order_paymentId_idx" ON "Order"("paymentId");

-- CreateIndex
CREATE INDEX "Order_panelId_idx" ON "Order"("panelId");

-- CreateIndex
CREATE INDEX "Order_checkoutSessionId_idx" ON "Order"("checkoutSessionId");

-- CreateIndex
CREATE INDEX "Order_createdAt_idx" ON "Order"("createdAt");

-- CreateIndex
CREATE INDEX "PaymentGateway_type_idx" ON "PaymentGateway"("type");

-- CreateIndex
CREATE INDEX "PaymentGateway_isEnabled_idx" ON "PaymentGateway"("isEnabled");

-- CreateIndex
CREATE INDEX "CardToCardAccount_gatewayId_idx" ON "CardToCardAccount"("gatewayId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_idempotencyKey_key" ON "Payment"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Payment_userId_idx" ON "Payment"("userId");

-- CreateIndex
CREATE INDEX "Payment_status_idx" ON "Payment"("status");

-- CreateIndex
CREATE INDEX "Payment_orderId_idx" ON "Payment"("orderId");

-- CreateIndex
CREATE INDEX "Payment_gatewayId_idx" ON "Payment"("gatewayId");

-- CreateIndex
CREATE INDEX "Payment_checkoutSessionId_idx" ON "Payment"("checkoutSessionId");

-- CreateIndex
CREATE INDEX "Payment_externalTransactionId_idx" ON "Payment"("externalTransactionId");

-- CreateIndex
CREATE INDEX "Payment_createdAt_idx" ON "Payment"("createdAt");

-- CreateIndex
CREATE INDEX "ManualReceipt_paymentId_idx" ON "ManualReceipt"("paymentId");

-- CreateIndex
CREATE INDEX "ManualReceipt_userId_idx" ON "ManualReceipt"("userId");

-- CreateIndex
CREATE INDEX "ManualReceipt_status_idx" ON "ManualReceipt"("status");

-- CreateIndex
CREATE INDEX "UserHiddenPaymentGateway_paymentGatewayId_idx" ON "UserHiddenPaymentGateway"("paymentGatewayId");

-- CreateIndex
CREATE UNIQUE INDEX "UserHiddenPaymentGateway_userId_paymentGatewayId_key" ON "UserHiddenPaymentGateway"("userId", "paymentGatewayId");

-- CreateIndex
CREATE UNIQUE INDEX "Service_username_key" ON "Service"("username");

-- CreateIndex
CREATE INDEX "Service_userId_idx" ON "Service"("userId");

-- CreateIndex
CREATE INDEX "Service_panelId_idx" ON "Service"("panelId");

-- CreateIndex
CREATE INDEX "Service_productId_idx" ON "Service"("productId");

-- CreateIndex
CREATE INDEX "Service_orderId_idx" ON "Service"("orderId");

-- CreateIndex
CREATE INDEX "Service_status_idx" ON "Service"("status");

-- CreateIndex
CREATE INDEX "Service_expiresAt_idx" ON "Service"("expiresAt");

-- CreateIndex
CREATE INDEX "Service_createdAt_idx" ON "Service"("createdAt");

-- CreateIndex
CREATE INDEX "ServiceRating_serviceId_idx" ON "ServiceRating"("serviceId");

-- CreateIndex
CREATE INDEX "ServiceRating_userId_idx" ON "ServiceRating"("userId");

-- CreateIndex
CREATE INDEX "ServiceEventLog_serviceId_idx" ON "ServiceEventLog"("serviceId");

-- CreateIndex
CREATE INDEX "ServiceEventLog_userId_idx" ON "ServiceEventLog"("userId");

-- CreateIndex
CREATE INDEX "ServiceEventLog_panelId_idx" ON "ServiceEventLog"("panelId");

-- CreateIndex
CREATE INDEX "ServiceEventLog_eventType_idx" ON "ServiceEventLog"("eventType");

-- CreateIndex
CREATE INDEX "ServiceEventLog_createdAt_idx" ON "ServiceEventLog"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "OtherProductOrder_orderId_key" ON "OtherProductOrder"("orderId");

-- CreateIndex
CREATE INDEX "OtherProductOrder_userId_idx" ON "OtherProductOrder"("userId");

-- CreateIndex
CREATE INDEX "OtherProductOrder_productId_idx" ON "OtherProductOrder"("productId");

-- CreateIndex
CREATE INDEX "OtherProductOrder_status_idx" ON "OtherProductOrder"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Referral_referredUserId_key" ON "Referral"("referredUserId");

-- CreateIndex
CREATE INDEX "Referral_referrerUserId_idx" ON "Referral"("referrerUserId");

-- CreateIndex
CREATE INDEX "ReferralCommission_referralId_idx" ON "ReferralCommission"("referralId");

-- CreateIndex
CREATE INDEX "ReferralCommission_referrerUserId_idx" ON "ReferralCommission"("referrerUserId");

-- CreateIndex
CREATE INDEX "ReferralCommission_referredUserId_idx" ON "ReferralCommission"("referredUserId");

-- CreateIndex
CREATE INDEX "ReferralCommission_orderId_idx" ON "ReferralCommission"("orderId");

-- CreateIndex
CREATE INDEX "ReferralCommission_status_idx" ON "ReferralCommission"("status");

-- CreateIndex
CREATE INDEX "TestAccountHistory_userId_idx" ON "TestAccountHistory"("userId");

-- CreateIndex
CREATE INDEX "TestAccountHistory_panelId_idx" ON "TestAccountHistory"("panelId");

-- CreateIndex
CREATE INDEX "TestAccountHistory_createdAt_idx" ON "TestAccountHistory"("createdAt");

-- CreateIndex
CREATE INDEX "WheelSpinHistory_userId_idx" ON "WheelSpinHistory"("userId");

-- CreateIndex
CREATE INDEX "WheelSpinHistory_createdAt_idx" ON "WheelSpinHistory"("createdAt");

-- CreateIndex
CREATE INDEX "SupportTicket_userId_idx" ON "SupportTicket"("userId");

-- CreateIndex
CREATE INDEX "SupportTicket_status_idx" ON "SupportTicket"("status");

-- CreateIndex
CREATE INDEX "SupportMessage_ticketId_idx" ON "SupportMessage"("ticketId");

-- CreateIndex
CREATE INDEX "SupportMessage_createdAt_idx" ON "SupportMessage"("createdAt");

-- CreateIndex
CREATE INDEX "Tutorial_categoryId_idx" ON "Tutorial"("categoryId");

-- CreateIndex
CREATE INDEX "TutorialMedia_tutorialId_idx" ON "TutorialMedia"("tutorialId");

-- CreateIndex
CREATE UNIQUE INDEX "MessageTemplate_key_key" ON "MessageTemplate"("key");

-- CreateIndex
CREATE UNIQUE INDEX "ButtonText_key_key" ON "ButtonText"("key");

-- CreateIndex
CREATE INDEX "Broadcast_status_idx" ON "Broadcast"("status");

-- CreateIndex
CREATE INDEX "Broadcast_createdAt_idx" ON "Broadcast"("createdAt");

-- CreateIndex
CREATE INDEX "BroadcastRecipient_status_idx" ON "BroadcastRecipient"("status");

-- CreateIndex
CREATE INDEX "BroadcastRecipient_userId_idx" ON "BroadcastRecipient"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "BroadcastRecipient_broadcastId_userId_key" ON "BroadcastRecipient"("broadcastId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "LogTopic_key_key" ON "LogTopic"("key");

-- CreateIndex
CREATE INDEX "SystemLog_level_idx" ON "SystemLog"("level");

-- CreateIndex
CREATE INDEX "SystemLog_eventType_idx" ON "SystemLog"("eventType");

-- CreateIndex
CREATE INDEX "SystemLog_userId_idx" ON "SystemLog"("userId");

-- CreateIndex
CREATE INDEX "SystemLog_createdAt_idx" ON "SystemLog"("createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_actorType_idx" ON "AuditLog"("actorType");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Setting_key_key" ON "Setting"("key");

-- AddForeignKey
ALTER TABLE "Admin" ADD CONSTRAINT "Admin_addedByAdminId_fkey" FOREIGN KEY ("addedByAdminId") REFERENCES "Admin"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminPermission" ADD CONSTRAINT "AdminPermission_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "Admin"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_referrerId_fkey" FOREIGN KEY ("referrerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletTransaction" ADD CONSTRAINT "WalletTransaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletTransaction" ADD CONSTRAINT "WalletTransaction_relatedOrderId_fkey" FOREIGN KEY ("relatedOrderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletTransaction" ADD CONSTRAINT "WalletTransaction_relatedPaymentId_fkey" FOREIGN KEY ("relatedPaymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserHiddenPanel" ADD CONSTRAINT "UserHiddenPanel_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserHiddenPanel" ADD CONSTRAINT "UserHiddenPanel_panelId_fkey" FOREIGN KEY ("panelId") REFERENCES "Panel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ProductCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_panelId_fkey" FOREIGN KEY ("panelId") REFERENCES "Panel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscountCodeUsage" ADD CONSTRAINT "DiscountCodeUsage_discountCodeId_fkey" FOREIGN KEY ("discountCodeId") REFERENCES "DiscountCode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscountCodeUsage" ADD CONSTRAINT "DiscountCodeUsage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscountCodeUsage" ADD CONSTRAINT "DiscountCodeUsage_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscountCodeUsage" ADD CONSTRAINT "DiscountCodeUsage_checkoutSessionId_fkey" FOREIGN KEY ("checkoutSessionId") REFERENCES "CheckoutSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckoutSession" ADD CONSTRAINT "CheckoutSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckoutSession" ADD CONSTRAINT "CheckoutSession_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckoutSession" ADD CONSTRAINT "CheckoutSession_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckoutSession" ADD CONSTRAINT "CheckoutSession_discountCodeId_fkey" FOREIGN KEY ("discountCodeId") REFERENCES "DiscountCode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_checkoutSessionId_fkey" FOREIGN KEY ("checkoutSessionId") REFERENCES "CheckoutSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_panelId_fkey" FOREIGN KEY ("panelId") REFERENCES "Panel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_discountCodeId_fkey" FOREIGN KEY ("discountCodeId") REFERENCES "DiscountCode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardToCardAccount" ADD CONSTRAINT "CardToCardAccount_gatewayId_fkey" FOREIGN KEY ("gatewayId") REFERENCES "PaymentGateway"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_checkoutSessionId_fkey" FOREIGN KEY ("checkoutSessionId") REFERENCES "CheckoutSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_gatewayId_fkey" FOREIGN KEY ("gatewayId") REFERENCES "PaymentGateway"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualReceipt" ADD CONSTRAINT "ManualReceipt_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualReceipt" ADD CONSTRAINT "ManualReceipt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserHiddenPaymentGateway" ADD CONSTRAINT "UserHiddenPaymentGateway_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserHiddenPaymentGateway" ADD CONSTRAINT "UserHiddenPaymentGateway_paymentGatewayId_fkey" FOREIGN KEY ("paymentGatewayId") REFERENCES "PaymentGateway"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Service" ADD CONSTRAINT "Service_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Service" ADD CONSTRAINT "Service_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Service" ADD CONSTRAINT "Service_panelId_fkey" FOREIGN KEY ("panelId") REFERENCES "Panel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Service" ADD CONSTRAINT "Service_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceRating" ADD CONSTRAINT "ServiceRating_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceRating" ADD CONSTRAINT "ServiceRating_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceEventLog" ADD CONSTRAINT "ServiceEventLog_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceEventLog" ADD CONSTRAINT "ServiceEventLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceEventLog" ADD CONSTRAINT "ServiceEventLog_panelId_fkey" FOREIGN KEY ("panelId") REFERENCES "Panel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OtherProductOrder" ADD CONSTRAINT "OtherProductOrder_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OtherProductOrder" ADD CONSTRAINT "OtherProductOrder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OtherProductOrder" ADD CONSTRAINT "OtherProductOrder_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_referrerUserId_fkey" FOREIGN KEY ("referrerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_referredUserId_fkey" FOREIGN KEY ("referredUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_firstPurchaseOrderId_fkey" FOREIGN KEY ("firstPurchaseOrderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralCommission" ADD CONSTRAINT "ReferralCommission_referralId_fkey" FOREIGN KEY ("referralId") REFERENCES "Referral"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralCommission" ADD CONSTRAINT "ReferralCommission_referrerUserId_fkey" FOREIGN KEY ("referrerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralCommission" ADD CONSTRAINT "ReferralCommission_referredUserId_fkey" FOREIGN KEY ("referredUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralCommission" ADD CONSTRAINT "ReferralCommission_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralCommission" ADD CONSTRAINT "ReferralCommission_walletTransactionId_fkey" FOREIGN KEY ("walletTransactionId") REFERENCES "WalletTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestAccountHistory" ADD CONSTRAINT "TestAccountHistory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestAccountHistory" ADD CONSTRAINT "TestAccountHistory_panelId_fkey" FOREIGN KEY ("panelId") REFERENCES "Panel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestAccountHistory" ADD CONSTRAINT "TestAccountHistory_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WheelSpinHistory" ADD CONSTRAINT "WheelSpinHistory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WheelSpinHistory" ADD CONSTRAINT "WheelSpinHistory_walletTransactionId_fkey" FOREIGN KEY ("walletTransactionId") REFERENCES "WalletTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportMessage" ADD CONSTRAINT "SupportMessage_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "SupportTicket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportMessage" ADD CONSTRAINT "SupportMessage_senderUserId_fkey" FOREIGN KEY ("senderUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportMessage" ADD CONSTRAINT "SupportMessage_senderAdminId_fkey" FOREIGN KEY ("senderAdminId") REFERENCES "Admin"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tutorial" ADD CONSTRAINT "Tutorial_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "TutorialCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TutorialMedia" ADD CONSTRAINT "TutorialMedia_tutorialId_fkey" FOREIGN KEY ("tutorialId") REFERENCES "Tutorial"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BroadcastRecipient" ADD CONSTRAINT "BroadcastRecipient_broadcastId_fkey" FOREIGN KEY ("broadcastId") REFERENCES "Broadcast"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BroadcastRecipient" ADD CONSTRAINT "BroadcastRecipient_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

