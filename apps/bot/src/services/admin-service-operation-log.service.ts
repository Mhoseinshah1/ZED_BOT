import {
  adminServiceRequestedValueBucket,
  type AdminServiceErrorCode,
  type AdminServiceOperationStatus,
  type AdminServiceOperationType,
  type AdminServiceRequestedUnit,
} from "@zedbot/shared";

import { OPS_EVENTS, writeSystemLog } from "./system-log.service.js";

// =============================================================================
// Admin Service Operations — privacy-safe audit logging (§21).
//
// The durable audit authority is the AdminServiceOperation row itself; this
// helper only emits the OPERATIONAL log line (SystemLog + the AUDIT Telegram
// topic). It carries ONLY safe fields — our own DB ids, the operation type /
// status, a bounded requested-value BUCKET (never the exact amount, which could
// correlate a specific grant), the panel TYPE and a safe error CODE. It NEVER
// carries: a subscription URL / config link / QR, Panel URL / credentials /
// token, a raw Panel response or thrown error, the free-text note or the
// mutation reason, or a user-notification body. writeSystemLog itself never
// throws and sanitizes metadata as a last line of defense.
// =============================================================================

export interface AdminServiceOperationLogArgs {
  operationId: string;
  type: AdminServiceOperationType;
  status: AdminServiceOperationStatus;
  serviceId: string | null;
  adminId: string;
  panelType: string | null;
  requestedUnit: AdminServiceRequestedUnit | null;
  /** The requested COUNT in `requestedUnit` (GiB or days) — bucketed, never raw. */
  requestedValue: bigint | number | null;
  safeErrorCode?: AdminServiceErrorCode | null;
}

/**
 * Emits one safe ops/audit line for an admin Service operation. SUCCEEDED/
 * RECONCILED map to SERVICE_OP_COMPLETED; every other status to
 * SERVICE_OP_FAILED (so an UNCERTAIN / RECONCILIATION_REQUIRED / FAILED /
 * CANCELLED operation is visible on the ops side). Routed to the AUDIT topic —
 * these are admin actions, not customer self-service.
 */
export async function logAdminServiceOperation(args: AdminServiceOperationLogArgs): Promise<void> {
  const succeeded = args.status === "SUCCEEDED" || args.status === "RECONCILED";
  await writeSystemLog({
    level: succeeded ? "INFO" : "WARN",
    eventType: succeeded ? OPS_EVENTS.SERVICE_OP_COMPLETED : OPS_EVENTS.SERVICE_OP_FAILED,
    message: `admin service operation ${args.type} → ${args.status}`,
    topicKey: "AUDIT",
    adminId: args.adminId,
    ...(args.serviceId === null ? {} : { serviceId: args.serviceId }),
    metadata: {
      operationId: args.operationId,
      operationType: args.type,
      status: args.status,
      panelType: args.panelType ?? "unknown",
      // Coarse, non-reversible bucket — never the exact granted amount.
      requestedValueBucket: adminServiceRequestedValueBucket(
        args.requestedUnit,
        args.requestedValue,
      ),
      ...(args.safeErrorCode === undefined || args.safeErrorCode === null
        ? {}
        : { safeErrorCode: args.safeErrorCode }),
    },
  });
}
