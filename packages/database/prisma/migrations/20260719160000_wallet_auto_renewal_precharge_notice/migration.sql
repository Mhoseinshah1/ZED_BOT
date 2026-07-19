-- Corrective Phase — Durable pre-charge notice before a wallet auto-renewal deduction.
--
-- Purely additive: two new enum values on AutomatedNotificationType (the durable
-- advance notice type, PAYMENT category) and two on NotificationInteractionType (the
-- view-settings and cancel actions; VIEW_WALLET is reused for the wallet button).
-- No columns, tables, indexes or data are changed. Existing rows are untouched and no
-- notification is created by this migration.

-- AlterEnum
ALTER TYPE "AutomatedNotificationType" ADD VALUE 'AUTO_RENEWAL_UPCOMING';

-- AlterEnum
ALTER TYPE "NotificationInteractionType" ADD VALUE 'VIEW_AUTO_RENEWAL';
ALTER TYPE "NotificationInteractionType" ADD VALUE 'CANCEL_AUTO_RENEWAL';
