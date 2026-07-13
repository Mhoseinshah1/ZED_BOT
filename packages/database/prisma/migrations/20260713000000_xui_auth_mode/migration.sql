-- XUI authentication mode. Nullable: existing XUI panels keep working in
-- the default SESSION_COOKIE mode; Marzban panels ignore the column.
ALTER TABLE "Panel" ADD COLUMN "authMode" TEXT;
