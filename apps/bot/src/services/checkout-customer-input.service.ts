import { Prisma, prisma, type CheckoutCustomerInput } from "@zedbot/database";
import { errorMessage } from "@zedbot/shared";

import { logger } from "../core/logger.js";
import {
  encodeValuesEncrypted,
  renderSafeSummary,
  validateCustomerInputSchema,
  validateFieldValue,
  type CustomerInputSchema,
} from "./customer-input-schema.service.js";
import { getSetting } from "./settings.service.js";

// =============================================================================
// Specialized-workflows phase: PRE-SETTLEMENT customer-input persistence.
//
// One CheckoutCustomerInput row per checkout (checkoutSessionId @unique)
// carries the frozen form schema and - after the buyer confirms the review
// page - the ENCRYPTED answers plus a masked safe summary. Lifecycle:
//
//   COLLECTING -> SUBMITTED -> CONSUMED            (happy path)
//              \-> ABANDONED -> REDACTED           (retention sweep)
//
// HARD INVARIANTS enforced here:
//   - Submission writes ONLY the CheckoutCustomerInput row. It never touches
//     Payment / Order / stock / wallet / commission rows - collecting info
//     must never move money or start fulfillment.
//   - Values are encrypted at rest (encodeValuesEncrypted / APP_SECRET);
//     only the masked renderedSafeSummary is ever displayable.
//   - Consumption is a checkout-scoped CAS on consumedByOtherProductOrderId,
//     so exactly one order can ever consume one submission and cross-checkout
//     consumption is impossible by construction.
//   - CONSUMED rows are NEVER redacted by the retention sweep (they are the
//     fulfillment record); only dead-end rows lose their encrypted payload.
//   - No secret value ever reaches a log line from this module.
// =============================================================================

/** Post-submit acknowledgement while the payment is still under review. */
export const CUSTOMER_INPUT_SAVED_NOTICE =
  "اطلاعات شما ثبت شد. انجام سفارش پس از تایید پرداخت آغاز می‌شود.";

export const CUSTOMER_INPUT_FORM_NOT_FOUND_TEXT = "فرم اطلاعات سفارش یافت نشد.";
export const CUSTOMER_INPUT_FORM_CLOSED_TEXT = "این فرم دیگر قابل ثبت نیست.";
export const CUSTOMER_INPUT_SCHEMA_BROKEN_TEXT =
  "ساختار فرم این سفارش نامعتبر است. لطفاً با پشتیبانی تماس بگیرید.";

/** Setting key: days a dead-end submission is kept before redaction. */
export const CUSTOMER_INPUT_RETENTION_DAYS_KEY = "customer_input_retention_days";
const DEFAULT_RETENTION_DAYS = 7;
const RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Loads (or creates) THE customer-input row of a checkout, owner-checked.
 * The schema passed by the caller is frozen onto the row at creation; an
 * existing row keeps its original snapshot (the form the buyer actually
 * saw). Returns null when the row belongs to another user - callers treat
 * that as access denied and leak nothing.
 */
export async function getOrCreateCheckoutInput(
  checkoutSessionId: string,
  userId: string,
  schema: CustomerInputSchema,
): Promise<CheckoutCustomerInput | null> {
  const existing = await prisma.checkoutCustomerInput.findUnique({
    where: { checkoutSessionId },
  });
  if (existing !== null) {
    return existing.userId === userId ? existing : null;
  }
  try {
    return await prisma.checkoutCustomerInput.create({
      data: {
        checkoutSessionId,
        userId,
        schemaSnapshot: schema as unknown as Prisma.InputJsonObject,
      },
    });
  } catch (err) {
    // P2002: a concurrent create won the unique race - re-read the winner.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const raced = await prisma.checkoutCustomerInput.findUnique({
        where: { checkoutSessionId },
      });
      return raced !== null && raced.userId === userId ? raced : null;
    }
    throw err;
  }
}

export type SubmitCheckoutInputOutcome =
  | { ok: true; already: boolean }
  | { ok: false; error: string; fieldKey?: string };

/**
 * Final submission of the whole answer set. In-progress answers live ONLY in
 * the Telegram session draft - nothing is persisted per field; this is the
 * single persistence point. Every field is re-validated server-side against
 * the row's frozen schemaSnapshot (Persian errors), values are encrypted and
 * only the masked summary is stored in plaintext. The COLLECTING->SUBMITTED
 * transition is a CAS, so repeated confirms converge to {ok, already:true}.
 *
 * This function writes exactly one CheckoutCustomerInput row and NOTHING
 * else - no Payment, Order, stock, wallet or commission row is ever touched.
 */
export async function submitCheckoutInput(
  checkoutSessionId: string,
  userId: string,
  values: Record<string, string>,
): Promise<SubmitCheckoutInputOutcome> {
  const record = await prisma.checkoutCustomerInput.findUnique({
    where: { checkoutSessionId },
  });
  if (record === null || record.userId !== userId) {
    return { ok: false, error: CUSTOMER_INPUT_FORM_NOT_FOUND_TEXT };
  }
  if (record.status === "SUBMITTED" || record.status === "CONSUMED") {
    return { ok: true, already: true };
  }
  if (record.status !== "COLLECTING") {
    return { ok: false, error: CUSTOMER_INPUT_FORM_CLOSED_TEXT };
  }

  const parsed = validateCustomerInputSchema(record.schemaSnapshot);
  if (!parsed.ok) {
    return { ok: false, error: CUSTOMER_INPUT_SCHEMA_BROKEN_TEXT };
  }
  const schema = parsed.schema;

  // Server-side validation of EVERY field; only schema keys are stored, so
  // stray session keys can never smuggle extra data into the payload.
  const normalized: Record<string, string> = {};
  const fields = [...schema.fields].sort((a, b) => a.order - b.order);
  for (const field of fields) {
    const validation = validateFieldValue(field, values[field.key] ?? "");
    if (!validation.ok) {
      return { ok: false, error: validation.error, fieldKey: field.key };
    }
    normalized[field.key] = validation.value;
  }

  const valuesEncrypted = encodeValuesEncrypted(normalized);
  const renderedSafeSummary = renderSafeSummary(schema, normalized);

  const updated = await prisma.checkoutCustomerInput.updateMany({
    where: { checkoutSessionId, userId, status: "COLLECTING" },
    data: {
      status: "SUBMITTED",
      submittedAt: new Date(),
      valuesEncrypted,
      renderedSafeSummary,
    },
  });
  if (updated.count === 1) {
    return { ok: true, already: false };
  }
  // CAS lost: converge on the winner's state (double-tap of the confirm
  // button lands here and must look like a success).
  const raced = await prisma.checkoutCustomerInput.findUnique({
    where: { checkoutSessionId },
  });
  if (
    raced !== null &&
    raced.userId === userId &&
    (raced.status === "SUBMITTED" || raced.status === "CONSUMED")
  ) {
    return { ok: true, already: true };
  }
  return { ok: false, error: CUSTOMER_INPUT_FORM_CLOSED_TEXT };
}

/** Payload handed to fulfillment when an order consumes a submission. */
export interface ConsumedCheckoutInputPayload {
  valuesEncrypted: string | null;
  renderedSafeSummary: string | null;
  schemaSnapshot: unknown;
  alreadyConsumedByThisOrder: boolean;
}

/**
 * EXACTLY-ONCE consumption API for the fulfillment pipeline (settlement /
 * approval side). CAS-claims the checkout's SUBMITTED, unconsumed row for
 * `otherProductOrderId`:
 *
 *   - fresh claim                          -> payload, alreadyConsumed false
 *   - already consumed by THIS order       -> payload, alreadyConsumed true
 *     (idempotent retries of the same fulfillment)
 *   - consumed by ANOTHER order / not yet
 *     submitted / no row                   -> null
 *
 * The claim query is checkout-scoped, so consuming another checkout's input
 * is impossible by construction, and consumedByOtherProductOrderId's unique
 * constraint keeps one order from ever consuming two submissions.
 */
export async function consumeCheckoutInputForOrder(
  checkoutSessionId: string,
  otherProductOrderId: string,
): Promise<ConsumedCheckoutInputPayload | null> {
  const claimed = await prisma.checkoutCustomerInput.updateMany({
    where: {
      checkoutSessionId,
      status: "SUBMITTED",
      consumedByOtherProductOrderId: null,
    },
    data: {
      status: "CONSUMED",
      consumedByOtherProductOrderId: otherProductOrderId,
      consumedAt: new Date(),
    },
  });
  const row = await prisma.checkoutCustomerInput.findUnique({
    where: { checkoutSessionId },
  });
  if (row === null) {
    return null;
  }
  if (claimed.count === 1) {
    return {
      valuesEncrypted: row.valuesEncrypted,
      renderedSafeSummary: row.renderedSafeSummary,
      schemaSnapshot: row.schemaSnapshot,
      alreadyConsumedByThisOrder: false,
    };
  }
  if (row.status === "CONSUMED" && row.consumedByOtherProductOrderId === otherProductOrderId) {
    return {
      valuesEncrypted: row.valuesEncrypted,
      renderedSafeSummary: row.renderedSafeSummary,
      schemaSnapshot: row.schemaSnapshot,
      alreadyConsumedByThisOrder: true,
    };
  }
  // Consumed by a different order, or never submitted - nothing to hand out.
  return null;
}

/**
 * Marks a checkout's input ABANDONED (dead checkout: receipt rejected,
 * checkout cancelled, ...). CONSUMED rows are untouched - they belong to a
 * fulfilled order. Exported for the fulfillment/receipt-rejection side; not
 * wired anywhere yet. Returns true when a row actually transitioned.
 */
export async function abandonCheckoutInput(checkoutSessionId: string): Promise<boolean> {
  const updated = await prisma.checkoutCustomerInput.updateMany({
    where: { checkoutSessionId, status: { in: ["COLLECTING", "SUBMITTED"] } },
    data: { status: "ABANDONED" },
  });
  return updated.count === 1;
}

async function retentionDays(): Promise<number> {
  const raw = await getSetting(CUSTOMER_INPUT_RETENTION_DAYS_KEY, "");
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_RETENTION_DAYS;
  }
  return parsed;
}

/**
 * Retention sweep: securely redacts dead-end rows older than the configured
 * retention window (Setting "customer_input_retention_days", default 7 days):
 *
 *   - ABANDONED rows, and
 *   - SUBMITTED rows whose checkout ended EXPIRED / CANCELLED /
 *     FAILED_REFUNDED (the submission can never be consumed anymore).
 *
 * Redaction clears BOTH valuesEncrypted and renderedSafeSummary and stamps
 * REDACTED + redactedAt. CONSUMED rows are NEVER redacted here.
 */
export async function runCheckoutInputRetentionSweep(): Promise<{ redactedCount: number }> {
  const days = await retentionDays();
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const updated = await prisma.checkoutCustomerInput.updateMany({
    where: {
      updatedAt: { lt: cutoff },
      OR: [
        { status: "ABANDONED" },
        {
          status: "SUBMITTED",
          checkoutSession: {
            status: { in: ["EXPIRED", "CANCELLED", "FAILED_REFUNDED"] },
          },
        },
      ],
    },
    data: {
      status: "REDACTED",
      valuesEncrypted: null,
      renderedSafeSummary: null,
      redactedAt: new Date(),
    },
  });
  return { redactedCount: updated.count };
}

/**
 * Hourly retention loop. Same never-throws contract as the other background
 * loops (startFreeTrialLoop): failures are logged and the next tick still
 * runs; the unref'd timer never keeps the process alive.
 */
export function startCheckoutInputRetentionLoop(): void {
  const tick = (): void => {
    void runCheckoutInputRetentionSweep()
      .then(({ redactedCount }) => {
        if (redactedCount > 0) {
          logger.info("customer-input retention sweep redacted rows", { redactedCount });
        }
      })
      .catch((err: unknown) => {
        logger.error("customer-input retention sweep rejected", {
          error: errorMessage(err),
        });
      });
  };
  setInterval(tick, RETENTION_SWEEP_INTERVAL_MS).unref();
}
