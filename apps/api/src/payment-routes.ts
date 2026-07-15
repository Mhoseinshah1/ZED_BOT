import { PaymentGatewayType, PaymentStatus, Prisma, prisma } from "@zedbot/database";
import {
  NowPaymentsGateway,
  nowpaymentsConfigFromEnv,
  ZarinpalGateway,
  zarinpalConfigFromEnv,
  type NormalizedPaymentStatus,
} from "@zedbot/payments";
import { createLogger, optionalEnv } from "@zedbot/shared";
import type { FastifyInstance, FastifyReply } from "fastify";

const logger = createLogger("api");

/**
 * Payment provider callback/webhook routes. These endpoints VERIFY provider
 * events and RECORD them on the Payment row (providerStatus, verifiedAt,
 * references, sanitized payload) - money settlement happens separately in
 * the bot. No credentials, signatures or authorities are ever logged.
 */

/** Payment.status a recorded provider event moves a PENDING/PROCESSING row to. */
const STATUS_TRANSITIONS: Record<NormalizedPaymentStatus, PaymentStatus | null> = {
  PENDING: null,
  PROCESSING: PaymentStatus.PROCESSING,
  // SUCCESS never touches Payment.status here: the bot settlement transaction
  // moves the row to APPROVED when the money actually moves.
  SUCCESS: null,
  FAILED: PaymentStatus.FAILED,
  EXPIRED: PaymentStatus.EXPIRED,
  CANCELLED: PaymentStatus.CANCELLED,
};

interface ProviderOutcomeEvent {
  status: NormalizedPaymentStatus;
  transactionId?: string;
  externalReference?: string;
  sanitizedPayload: Record<string, unknown>;
}

/** Drops undefined values so the payload is a clean Prisma JSON value. */
function toJsonValue(payload: Record<string, unknown>): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(payload)) as Prisma.InputJsonValue;
}

type RecordOutcome = "recorded" | "ignored" | "not-found";

/**
 * Records one verified provider event on its Payment row.
 *
 * Rules:
 *  - lookup by id or unique authority; the row must carry the matching
 *    provider (mismatches are reported as not-found, never detailed).
 *  - never downgrade: once providerStatus is SUCCESS, non-SUCCESS replays
 *    are ignored; duplicate SUCCESS events are idempotent no-ops.
 *  - verifiedAt is set once, on the first SUCCESS.
 *  - Payment.status only ever moves from PENDING/PROCESSING (CAS updateMany)
 *    so APPROVED/REJECTED rows are never touched; rows already past
 *    expiresAt still get providerStatus recorded for manual review but keep
 *    their status untouched.
 */
async function recordProviderOutcome(
  lookup: { paymentId?: string; authority?: string; provider: PaymentGatewayType },
  event: ProviderOutcomeEvent,
): Promise<RecordOutcome> {
  const payment =
    lookup.paymentId !== undefined
      ? await prisma.payment.findUnique({ where: { id: lookup.paymentId } })
      : lookup.authority !== undefined
        ? await prisma.payment.findUnique({ where: { authority: lookup.authority } })
        : null;
  if (payment === null || payment.provider !== lookup.provider) {
    return "not-found";
  }
  if (payment.providerStatus === "SUCCESS" && event.status !== "SUCCESS") {
    return "ignored";
  }
  const now = new Date();
  try {
    await prisma.payment.update({
      where: { id: payment.id },
      data: {
        providerStatus: event.status,
        callbackPayload: toJsonValue(event.sanitizedPayload),
        ...(event.status === "SUCCESS" && payment.verifiedAt === null ? { verifiedAt: now } : {}),
        ...(event.transactionId !== undefined
          ? { externalTransactionId: event.transactionId }
          : {}),
        ...(payment.externalReference === null && event.externalReference !== undefined
          ? { externalReference: event.externalReference }
          : {}),
      },
    });
  } catch (err) {
    // (provider, externalTransactionId) is unique: the same external charge
    // can never be attached to a SECOND local payment. A replayed/forged
    // event reusing another payment's transaction id is refused entirely -
    // no SUCCESS is recorded on this row and nothing is downgraded.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      logger.warn("provider event refused - transaction id already attached elsewhere", {
        paymentId: payment.id,
        provider: payment.provider,
      });
      return "ignored";
    }
    throw err;
  }
  const isExpired = payment.expiresAt !== null && payment.expiresAt.getTime() < now.getTime();
  const nextStatus = STATUS_TRANSITIONS[event.status];
  if (!isExpired && nextStatus !== null) {
    await prisma.payment.updateMany({
      where: {
        id: payment.id,
        status: { in: [PaymentStatus.PENDING, PaymentStatus.PROCESSING] },
      },
      data: { status: nextStatus },
    });
  }
  return "recorded";
}

/** Coerces Fastify's parsed query into the string map the adapters expect. */
function queryToStrings(query: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof query === "object" && query !== null) {
    for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
      if (typeof value === "string") {
        out[key] = value;
      } else if (Array.isArray(value) && typeof value[0] === "string") {
        out[key] = value[0];
      }
    }
  }
  return out;
}

/** Tiny self-contained RTL page shown after a gateway redirect. */
function paymentPage(message: string): string {
  const username = optionalEnv("TELEGRAM_BOT_USERNAME");
  const botLink =
    username === ""
      ? ""
      : `<p><a href="https://t.me/${username}">بازگشت به ربات</a></p>`;
  return (
    '<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1"><title>ZED BOT</title>' +
    "<style>body{font-family:Tahoma,sans-serif;background:#f5f5f5;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}" +
    "main{background:#fff;padding:2rem 2.5rem;border-radius:12px;box-shadow:0 1px 4px rgba(0,0,0,.12);text-align:center}</style>" +
    `</head><body><main><p>${message}</p>${botLink}</main></body></html>`
  );
}

function sendHtml(reply: FastifyReply, code: number, message: string): FastifyReply {
  return reply.code(code).type("text/html; charset=utf-8").send(paymentPage(message));
}

const PENDING_TEXT = "پرداخت شما در انتظار تایید است.";

/**
 * Encapsulated Fastify plugin: registering it via app.register() scopes the
 * raw-string JSON parser (needed for IPN signature verification) to these
 * routes only - the rest of the app keeps normal JSON parsing. Gateways are
 * constructed from env at registration; missing env vars never crash boot,
 * the routes just answer safely (generic page / 401).
 */
export async function paymentRoutes(app: FastifyInstance): Promise<void> {
  const zarinpal = new ZarinpalGateway(zarinpalConfigFromEnv());
  const nowpayments = new NowPaymentsGateway(nowpaymentsConfigFromEnv());

  // Keep the RAW body: NOWPayments signs the exact bytes it sent.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
    done(null, body);
  });

  app.get("/payments/zarinpal/callback", async (request, reply) => {
    const parsed = zarinpal.handleCallback({ query: queryToStrings(request.query) });
    if (!parsed.ok) {
      return sendHtml(reply, 400, "درخواست نامعتبر است.");
    }
    if (!zarinpal.isAvailable()) {
      logger.error("zarinpal callback received but the gateway is not configured");
      return sendHtml(reply, 200, PENDING_TEXT);
    }
    const event = parsed.event;
    const authority = event.authority ?? "";
    const payment = await prisma.payment.findUnique({ where: { authority } });
    if (payment === null || payment.provider !== PaymentGatewayType.ZARINPAL) {
      return sendHtml(reply, 404, "پرداختی یافت نشد.");
    }
    const lookup = { paymentId: payment.id, provider: PaymentGatewayType.ZARINPAL };
    if (event.status === "CANCELLED") {
      await recordProviderOutcome(lookup, {
        status: "CANCELLED",
        sanitizedPayload: event.sanitizedPayload,
      });
      logger.info("zarinpal payment cancelled by user", { paymentId: payment.id });
      return sendHtml(reply, 200, "پرداخت لغو شد.");
    }
    // Status OK only means the user came back - verify is the source of truth.
    const verification = await zarinpal.verifyPayment({
      authority,
      amountToman: payment.payableAmountToman,
    });
    if (verification.ok && verification.status === "SUCCESS") {
      await recordProviderOutcome(lookup, {
        status: "SUCCESS",
        transactionId: verification.transactionId,
        sanitizedPayload: event.sanitizedPayload,
      });
      logger.info("zarinpal payment verified", { paymentId: payment.id });
      return sendHtml(reply, 200, "پرداخت شما با موفقیت تایید شد ✅ برای ادامه به ربات بازگردید.");
    }
    if (verification.uncertain === true) {
      // Timeout/transport: never fail the payment - it stays PENDING and is
      // resolved by a later verification.
      logger.warn("zarinpal verification uncertain, payment kept pending", {
        paymentId: payment.id,
        error: verification.errorMessage,
      });
      return sendHtml(reply, 200, PENDING_TEXT);
    }
    await recordProviderOutcome(lookup, {
      status: "FAILED",
      sanitizedPayload: event.sanitizedPayload,
    });
    logger.info("zarinpal payment verification failed", { paymentId: payment.id });
    return sendHtml(reply, 200, "پرداخت ناموفق بود.");
  });

  app.post("/payments/nowpayments/ipn", async (request, reply) => {
    const rawBody = typeof request.body === "string" ? request.body : "";
    const headers: Record<string, string> = {};
    const signatureHeader = request.headers["x-nowpayments-ipn-signature"];
    if (typeof signatureHeader === "string") {
      headers["x-nowpayments-ipn-signature"] = signatureHeader;
    } else if (Array.isArray(signatureHeader) && typeof signatureHeader[0] === "string") {
      headers["x-nowpayments-ipn-signature"] = signatureHeader[0];
    }
    const parsed = nowpayments.handleCallback({ rawBody, headers });
    if (!parsed.ok) {
      if (parsed.reason === "invalid-signature") {
        // Covers missing NOWPAYMENTS_IPN_SECRET too - unverifiable is unauthorized.
        logger.warn("nowpayments ipn rejected: missing or invalid signature");
        return reply.code(401).send({ ok: false });
      }
      logger.warn("nowpayments ipn rejected: malformed body");
      return reply.code(400).send({ ok: false });
    }
    const event = parsed.event;
    if (event.paymentId === undefined || event.paymentId === "") {
      logger.warn("nowpayments ipn without order_id");
      return reply.code(200).send({ ok: true });
    }
    const payment = await prisma.payment.findUnique({ where: { id: event.paymentId } });
    if (payment === null || payment.provider !== PaymentGatewayType.NOWPAYMENTS) {
      // 200 on purpose: a signed-but-unmatched IPN must not reveal which ids exist.
      logger.warn("nowpayments ipn for unknown payment", { orderId: event.paymentId });
      return reply.code(200).send({ ok: true });
    }
    if (
      event.externalReference !== undefined &&
      payment.externalReference !== null &&
      event.externalReference !== payment.externalReference
    ) {
      logger.warn("nowpayments ipn reference mismatch", { paymentId: payment.id });
      return reply.code(200).send({ ok: true });
    }
    if (event.status === "UNKNOWN") {
      // Unmapped provider status: keep Payment.status, store the payload for
      // manual review.
      await prisma.payment.update({
        where: { id: payment.id },
        data: { callbackPayload: toJsonValue(event.sanitizedPayload) },
      });
      logger.warn("nowpayments ipn with unmapped status recorded for review", {
        paymentId: payment.id,
      });
      return reply.code(200).send({ ok: true });
    }
    const outcome = await recordProviderOutcome(
      { paymentId: payment.id, provider: PaymentGatewayType.NOWPAYMENTS },
      {
        status: event.status,
        transactionId: event.transactionId,
        externalReference: event.externalReference,
        sanitizedPayload: event.sanitizedPayload,
      },
    );
    logger.info("nowpayments ipn processed", {
      paymentId: payment.id,
      providerStatus: event.status,
      outcome,
    });
    return reply.code(200).send({ ok: true });
  });
}
