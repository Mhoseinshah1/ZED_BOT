-- Product-level XUI inbound selection: the product's chosen subset of the
-- panel's allowed inbound ids. Nullable: existing products inherit the
-- panel's full allowlist unchanged.
ALTER TABLE "Product" ADD COLUMN "inboundIds" JSONB;
