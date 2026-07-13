-- The exact XUI inbound set sold at checkout, snapshotted on the Order so
-- product/panel edits after payment never change a paid order's
-- entitlement. Nullable: legacy orders keep resolving from live config.
ALTER TABLE "Order" ADD COLUMN "inboundIdsSnapshot" JSONB;
