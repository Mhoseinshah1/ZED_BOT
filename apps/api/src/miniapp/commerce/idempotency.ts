// =============================================================================
// Payload-bound client idempotency for commerce mutations (§11/§19).
//
// Reuses the existing MiniAppRequestIdempotency model (one row per
// user + clientRequestId, SHA-256 payload fingerprint). Commerce operations
// store their results in the resultCheckoutSessionId / resultPaymentId
// columns and leave the non-null support pair empty.
//
// Semantics, identical to the Support Center's:
//   - same key + same fingerprint  → replay: return the ORIGINAL result;
//   - same key + different payload → conflict: refused, nothing executed;
//   - new key                      → execute, then record (a concurrent
//     duplicate loses the unique race and converges on the winner's result).
//
// This is the REQUEST-level guarantee. The money-level guarantee stays where
// it always was — Payment.idempotencyKey, the checkout settlement CAS and the
// order unique — so even a lost idempotency row cannot double-move money.
// =============================================================================
import { createHash } from "node:crypto";

import { Prisma, prisma } from "@zedbot/database";

export const COMMERCE_OPERATIONS = [
  "commerce-checkout-confirm",
  "commerce-wallet-pay",
] as const;
export type CommerceOperation = (typeof COMMERCE_OPERATIONS)[number];

/** Same shape the Mini App client has always minted for support mutations. */
const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

export function isValidClientRequestId(value: unknown): value is string {
  return typeof value === "string" && CLIENT_REQUEST_ID_PATTERN.test(value);
}

export function commerceFingerprint(parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(String(part.length));
    hash.update(".");
    hash.update(part, "utf8");
  }
  return hash.digest("hex");
}

export interface CommerceIdempotencyResult {
  resultCheckoutSessionId: string | null;
  resultPaymentId: string | null;
}

export type RunIdempotentOutcome<T> =
  | { kind: "executed"; value: T }
  | { kind: "replayed"; stored: CommerceIdempotencyResult }
  | { kind: "conflict" };

/**
 * Runs `execute` exactly once per (user, clientRequestId, payload).
 *
 * `execute` returns the result refs to store. It runs BEFORE the idempotency
 * row is written: if the process dies in between, the retry re-executes
 * against the domain layer's own idempotency (draft nonce / unique keys),
 * which converges on the same financial outcome — never a second one.
 */
export async function runIdempotentCommerce<T extends CommerceIdempotencyResult>(
  args: {
    userId: string;
    clientRequestId: string;
    operation: CommerceOperation;
    fingerprint: string;
  },
  execute: () => Promise<T>,
): Promise<RunIdempotentOutcome<T>> {
  const existing = await prisma.miniAppRequestIdempotency.findUnique({
    where: {
      userId_clientRequestId: {
        userId: args.userId,
        clientRequestId: args.clientRequestId,
      },
    },
  });
  if (existing !== null) {
    if (existing.fingerprint !== args.fingerprint || existing.operation !== args.operation) {
      return { kind: "conflict" };
    }
    return {
      kind: "replayed",
      stored: {
        resultCheckoutSessionId: existing.resultCheckoutSessionId,
        resultPaymentId: existing.resultPaymentId,
      },
    };
  }

  const value = await execute();

  try {
    await prisma.miniAppRequestIdempotency.create({
      data: {
        userId: args.userId,
        clientRequestId: args.clientRequestId,
        operation: args.operation,
        fingerprint: args.fingerprint,
        resultTicketId: "",
        resultMessageId: "",
        resultCheckoutSessionId: value.resultCheckoutSessionId,
        resultPaymentId: value.resultPaymentId,
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      // A concurrent duplicate recorded first. The domain layer already made
      // the two executions converge; surface the winner's stored result.
      const winner = await prisma.miniAppRequestIdempotency.findUnique({
        where: {
          userId_clientRequestId: {
            userId: args.userId,
            clientRequestId: args.clientRequestId,
          },
        },
      });
      if (winner !== null && winner.fingerprint === args.fingerprint) {
        return {
          kind: "replayed",
          stored: {
            resultCheckoutSessionId: winner.resultCheckoutSessionId,
            resultPaymentId: winner.resultPaymentId,
          },
        };
      }
      return { kind: "conflict" };
    }
    throw err;
  }
  return { kind: "executed", value };
}
