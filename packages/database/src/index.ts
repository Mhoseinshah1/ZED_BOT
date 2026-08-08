export { prisma, connectDatabase, disconnectDatabase } from "./client.js";

// Re-export the full generated client surface (model types, enums, Prisma
// namespace) so consumers never import from @prisma/client directly.
export * from "@prisma/client";
export {
  INITIAL_BUTTON_TEXTS,
  INITIAL_MESSAGE_TEMPLATES,
  type ButtonTextSeed,
  type MessageTemplateSeed,
} from "./seed-data.js";
export {
  REFERRAL_AFFILIATE_MIGRATION_NAME,
  REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_ORIGINAL,
  REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_PR110,
  REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_ORIGINAL_LF,
  REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_ORIGINAL_CRLF,
  REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_PR110_LF,
  REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_PR110_CRLF,
  REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_ALLOWLIST,
  REFERRAL_AFFILIATE_CURRENT_ONDISK_VARIANT,
  classifyReferralMigrationChecksum,
  prismaMigrationChecksum,
  readPrismaMigrationChecksum,
  type ReferralMigrationChecksumVariant,
  type ReferralMigrationChecksumClass,
} from "./migration-checksum.js";
export {
  readLatestMigrationAttempt,
  readLatestSuccessfulMigrationAttempt,
  readAllMigrationAttempts,
  countCurrentlyFailedOrStuckMigrations,
  classifyMigrationAttempt,
  readMigrationAttemptState,
  type MigrationAttempt,
  type MigrationAttemptStatus,
  type MigrationAttemptState,
} from "./migration-attempts.js";
export {
  evaluateMigrationDeploymentState,
  type MigrationDeploymentState,
  type MigrationDeploymentEntry,
} from "./migration-deployment.js";
export {
  ROLLBACK_COMPATIBILITY_FORMAT_VERSION,
  evaluateRollbackCompatibility,
  evaluateUpdateCompatibility,
  parseRollbackCompatibilityManifest,
  type CompatibilityDecision,
  type MigrationSnapshot,
  type RollbackCompatibilityManifest,
} from "./deployment-rollback.js";
export {
  resolveMigrationsDir,
  checkReferralSchemaPostconditions,
  verifyReferralOrderIdUniqueIndex,
  checkOrdinaryMigrationsImmutable,
  evaluateReferralMigrationLineage,
  type ReferralMigrationLineageStatus,
  type ReferralMigrationLineage,
  type ReferralSchemaPostcondition,
  type ReferralSchemaPostconditionsResult,
  type ReferralUniqueIndexVerification,
  type OrdinaryMigrationsIntegrity,
} from "./migration-lineage.js";

export {
  applyLowBalanceObservation,
  hasNotificationForCycle,
  type LowBalanceNotificationDraft,
  type LowBalanceObservationInput,
  type LowBalanceObservationOutcome,
  type TomanAmount,
} from "./low-balance-core.js";
