import { REFERRAL_JOB_NAMES, referralCorrelationHash } from "@zedbot/shared";
import { describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "referral-correlation-tests-secret-0123456789";

import { referralExecuteJobCorrelation } from "../src/services/referral-execute-consumer.js";

// =============================================================================
// §8 — the execute consumer must derive its log correlation token from the RAW
// validated job payload (orderId / commissionId), NOT the BullMQ-prefixed job id,
// so it equals the token producers emit for the same entity.
// =============================================================================

describe("referral execute correlation hash consistency (§8)", () => {
  const ORDER = "b1c2d3e4-0000-4000-8000-000000000001";
  const COMMISSION = "c9c8c7c6-0000-4000-8000-000000000002";

  it("credit: consumer token == producer token for the same raw orderId", () => {
    const producer = referralCorrelationHash(ORDER); // what enqueue / credit logs emit
    const consumer = referralExecuteJobCorrelation(REFERRAL_JOB_NAMES.CREDIT_REFERRAL_COMMISSION, { orderId: ORDER });
    expect(consumer).toBe(producer);
  });

  it("reversal: consumer token == producer token for the same raw orderId", () => {
    const producer = referralCorrelationHash(ORDER);
    const consumer = referralExecuteJobCorrelation(REFERRAL_JOB_NAMES.REVERSE_REFERRAL_COMMISSION, { orderId: ORDER });
    expect(consumer).toBe(producer);
  });

  it("debt recovery: correlates on the raw commissionId", () => {
    const consumer = referralExecuteJobCorrelation(REFERRAL_JOB_NAMES.RECOVER_REFERRAL_COMMISSION, {
      commissionId: COMMISSION,
    });
    expect(consumer).toBe(referralCorrelationHash(COMMISSION));
  });

  it("does NOT hash the BullMQ-prefixed job id (the old, mismatching behaviour)", () => {
    const fromRaw = referralExecuteJobCorrelation(REFERRAL_JOB_NAMES.CREDIT_REFERRAL_COMMISSION, { orderId: ORDER });
    expect(fromRaw).not.toBe(referralCorrelationHash(`ref-credit-${ORDER}`));
  });

  it("returns undefined for a missing / malformed payload (never throws)", () => {
    expect(referralExecuteJobCorrelation(REFERRAL_JOB_NAMES.CREDIT_REFERRAL_COMMISSION, undefined)).toBeUndefined();
    expect(referralExecuteJobCorrelation(REFERRAL_JOB_NAMES.CREDIT_REFERRAL_COMMISSION, {})).toBeUndefined();
    expect(referralExecuteJobCorrelation(REFERRAL_JOB_NAMES.CREDIT_REFERRAL_COMMISSION, { orderId: 123 })).toBeUndefined();
    expect(referralExecuteJobCorrelation(REFERRAL_JOB_NAMES.RECOVER_REFERRAL_COMMISSION, { commissionId: "" })).toBeUndefined();
  });

  it("the token is a non-reversible 10-hex correlation string", () => {
    const t = referralExecuteJobCorrelation(REFERRAL_JOB_NAMES.CREDIT_REFERRAL_COMMISSION, { orderId: ORDER });
    expect(t).toMatch(/^[0-9a-f]{10}$/);
  });
});
