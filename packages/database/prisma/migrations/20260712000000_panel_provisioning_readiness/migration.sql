-- Panel provisioning readiness + remote client identifiers.
-- All columns are nullable so existing rows keep working unchanged.

-- Panel: API variant + readiness snapshot from the authenticated panel test.
ALTER TABLE "Panel" ADD COLUMN "apiVariant" TEXT;
ALTER TABLE "Panel" ADD COLUMN "provisioningReady" BOOLEAN;
ALTER TABLE "Panel" ADD COLUMN "lastCapabilityCheckAt" TIMESTAMP(3);
ALTER TABLE "Panel" ADD COLUMN "capabilitySnapshot" JSONB;

-- Service: remote client identifiers for client-addressed panels (XUI).
ALTER TABLE "Service" ADD COLUMN "remoteClientId" TEXT;
ALTER TABLE "Service" ADD COLUMN "remoteInboundIds" JSONB;
ALTER TABLE "Service" ADD COLUMN "remoteMetadata" JSONB;
