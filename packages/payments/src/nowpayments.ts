import { createHmac, timingSafeEqual } from "node:crypto";

import { paymentHttpTimeoutMs, readJsonSafely, safeErrorText } from "./http.js";
import type {
  CreatePaymentInput,
  CreatePaymentResult,
  HandleCallbackInput,
  HandleCallbackResult,
  NormalizedPaymentStatus,
  PaymentGateway,
  VerifyPaymentInput,
  VerifyPaymentResult,
} from "./types.js";

/** NOWPayments REST hosts (v1). */
const NOWPAYMENTS_PRODUCTION_HOST = "https://api.nowpayments.io/v1";
const NOWPAYMENTS_SANDBOX_HOST = "https://api-sandbox.nowpayments.io/v1";

export interface NowPaymentsConfig {
  /** API key sent as x-api-key. Required for real calls. */
  apiKey?: string;
  /** IPN HMAC secret used to verify webhook signatures. */
  ipnSecret?: string;
  /** Default absolute IPN callback URL. */
  callbackUrl?: string;
  /** true routes all calls to the NOWPayments sandbox host. */
  sandbox: boolean;
  /** Fiat currency invoices are priced in (NOWPayments price_currency). */
  priceCurrency: string;
  /** Operator-set conversion rate: toman per 1 unit of priceCurrency. */
  tomanPerUnit: number;
  /** Optional invoice success/cancel redirect URLs. */
  successUrl?: string;
  cancelUrl?: string;
  /**
   * Overrides the API host entirely, including the /v1 prefix (takes
   * precedence over `sandbox`). Test/mock hook - production deployments
   * leave this unset.
   */
  baseUrl?: string;
}

/**
 * Reads NOWPayments configuration from the environment: NOWPAYMENTS_API_KEY,
 * NOWPAYMENTS_IPN_SECRET, NOWPAYMENTS_CALLBACK_URL, NOWPAYMENTS_SANDBOX,
 * NOWPAYMENTS_PRICE_CURRENCY (default "usd"), NOWPAYMENTS_TOMAN_PER_UNIT
 * (integer > 0), NOWPAYMENTS_SUCCESS_URL, NOWPAYMENTS_CANCEL_URL,
 * NOWPAYMENTS_BASE_URL (host override, primarily for tests against mocks).
 * Missing or invalid values never throw - the gateway reports
 * isAvailable()=false.
 */
export function nowpaymentsConfigFromEnv(): NowPaymentsConfig {
  const read = (name: string): string | undefined => {
    const value = (process.env[name] ?? "").trim();
    return value === "" ? undefined : value;
  };
  const tomanPerUnitRaw = Number.parseInt(read("NOWPAYMENTS_TOMAN_PER_UNIT") ?? "", 10);
  return {
    apiKey: read("NOWPAYMENTS_API_KEY"),
    ipnSecret: read("NOWPAYMENTS_IPN_SECRET"),
    callbackUrl: read("NOWPAYMENTS_CALLBACK_URL"),
    sandbox: read("NOWPAYMENTS_SANDBOX") === "true",
    priceCurrency: read("NOWPAYMENTS_PRICE_CURRENCY") ?? "usd",
    tomanPerUnit: Number.isFinite(tomanPerUnitRaw) && tomanPerUnitRaw > 0 ? tomanPerUnitRaw : 0,
    successUrl: read("NOWPAYMENTS_SUCCESS_URL"),
    cancelUrl: read("NOWPAYMENTS_CANCEL_URL"),
    baseUrl: read("NOWPAYMENTS_BASE_URL"),
  };
}

/** Recursively sorts object keys (arrays keep their order). */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (typeof value === "object" && value !== null) {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = sortKeysDeep(source[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Verifies a NOWPayments IPN signature: HMAC-SHA512 hex of the raw body
 * re-serialized with recursively sorted keys, compared timing-safely.
 * Malformed bodies or empty inputs verify as false - never throws.
 */
export function verifyIpnSignature(rawBody: string, signature: string, ipnSecret: string): boolean {
  if (rawBody === "" || signature === "" || ipnSecret === "") {
    return false;
  }
  let canonical: string;
  try {
    canonical = JSON.stringify(sortKeysDeep(JSON.parse(rawBody)));
  } catch {
    return false;
  }
  const expected = createHmac("sha512", ipnSecret).update(canonical).digest("hex");
  const expectedBuffer = Buffer.from(expected, "utf8");
  const actualBuffer = Buffer.from(signature, "utf8");
  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, actualBuffer);
}

/** Maps a NOWPayments payment_status string to our normalized status. */
function normalizeNowPaymentsStatus(status: string): NormalizedPaymentStatus | "UNKNOWN" {
  switch (status) {
    case "finished":
    case "confirmed":
      return "SUCCESS";
    case "waiting":
    case "confirming":
    case "sending":
    case "partially_paid":
      return "PROCESSING";
    case "expired":
      return "EXPIRED";
    case "failed":
    case "refunded":
      return "FAILED";
    default:
      return "UNKNOWN";
  }
}

/**
 * NOWPayments crypto gateway using the official invoice API. Payments are
 * created as hosted invoices; final status is driven exclusively by signed
 * IPN webhooks - there is no reliable poll by invoice id, so verifyPayment
 * reports uncertain instead of guessing undocumented endpoints.
 */
export class NowPaymentsGateway implements PaymentGateway {
  readonly name = "NOWPAYMENTS";

  constructor(private readonly config: NowPaymentsConfig) {}

  private get host(): string {
    if (this.config.baseUrl !== undefined && this.config.baseUrl !== "") {
      return this.config.baseUrl;
    }
    return this.config.sandbox ? NOWPAYMENTS_SANDBOX_HOST : NOWPAYMENTS_PRODUCTION_HOST;
  }

  isAvailable(): boolean {
    return (
      (this.config.apiKey ?? "") !== "" &&
      (this.config.ipnSecret ?? "") !== "" &&
      (this.config.callbackUrl ?? "") !== "" &&
      this.config.tomanPerUnit > 0
    );
  }

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    const callbackUrl = input.callbackUrl ?? this.config.callbackUrl ?? "";
    if ((this.config.apiKey ?? "") === "" || callbackUrl === "" || this.config.tomanPerUnit <= 0) {
      return { ok: false, errorMessage: "NOWPayments gateway is not configured." };
    }
    const priceAmount = Math.round((input.amountToman / this.config.tomanPerUnit) * 100) / 100;
    try {
      const response = await fetch(`${this.host}/invoice`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.config.apiKey ?? "",
        },
        body: JSON.stringify({
          price_amount: priceAmount,
          price_currency: this.config.priceCurrency,
          order_id: input.paymentId,
          order_description: input.description,
          ipn_callback_url: callbackUrl,
          ...(this.config.successUrl !== undefined ? { success_url: this.config.successUrl } : {}),
          ...(this.config.cancelUrl !== undefined ? { cancel_url: this.config.cancelUrl } : {}),
        }),
        signal: AbortSignal.timeout(paymentHttpTimeoutMs()),
      });
      const parsed = await readJsonSafely(response);
      // Error bodies are never surfaced - only the HTTP status (the api key
      // must never leak through echoed request details).
      if (!response.ok || !parsed.ok) {
        return { ok: false, errorMessage: `NOWPayments invoice failed (HTTP ${response.status}).` };
      }
      const invoice = parsed.data as { id?: number | string; invoice_url?: string };
      if (invoice.id === undefined || typeof invoice.invoice_url !== "string") {
        return { ok: false, errorMessage: "NOWPayments returned a malformed invoice response." };
      }
      return {
        ok: true,
        authority: String(invoice.id),
        externalReference: String(invoice.id),
        redirectUrl: invoice.invoice_url,
      };
    } catch (err) {
      return { ok: false, errorMessage: `NOWPayments invoice failed: ${safeErrorText(err)}` };
    }
  }

  /**
   * Verifies and parses one IPN webhook. The signature check runs on the RAW
   * body; the sanitized payload keeps only whitelisted business fields -
   * never the signature or any header.
   */
  handleCallback(input: HandleCallbackInput): HandleCallbackResult {
    const rawBody = input.rawBody ?? "";
    let signature = "";
    for (const [name, value] of Object.entries(input.headers ?? {})) {
      if (name.toLowerCase() === "x-nowpayments-ipn-signature") {
        signature = value;
        break;
      }
    }
    if (!verifyIpnSignature(rawBody, signature, this.config.ipnSecret ?? "")) {
      return {
        ok: false,
        reason: "invalid-signature",
        errorMessage: "NOWPayments IPN signature is missing or invalid.",
      };
    }
    let body: Record<string, unknown>;
    try {
      const parsed = JSON.parse(rawBody) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("not an object");
      }
      body = parsed as Record<string, unknown>;
    } catch {
      return { ok: false, reason: "malformed", errorMessage: "NOWPayments IPN body is not a JSON object." };
    }
    const paymentStatus = typeof body.payment_status === "string" ? body.payment_status : "";
    const orderId = typeof body.order_id === "string" ? body.order_id : undefined;
    const invoiceId = body.invoice_id;
    const paymentId = body.payment_id;
    const reference = invoiceId ?? paymentId;
    return {
      ok: true,
      event: {
        paymentId: orderId,
        externalReference: reference === undefined || reference === null ? undefined : String(reference),
        transactionId: paymentId === undefined || paymentId === null ? undefined : String(paymentId),
        status: normalizeNowPaymentsStatus(paymentStatus),
        sanitizedPayload: {
          payment_status: body.payment_status,
          payment_id: body.payment_id,
          invoice_id: body.invoice_id,
          order_id: body.order_id,
          price_amount: body.price_amount,
          pay_currency: body.pay_currency,
          actually_paid: body.actually_paid,
        },
      },
    };
  }

  /**
   * The authority is the INVOICE id, but the documented status endpoint
   * (GET /payment/{payment_id}) requires the payment id which only exists
   * once the user pays and the IPN delivers it. Status therefore cannot be
   * polled by invoice id - IPN webhooks are the source of truth.
   */
  async verifyPayment(_input: VerifyPaymentInput): Promise<VerifyPaymentResult> {
    return {
      ok: false,
      status: "PENDING",
      uncertain: true,
      errorMessage: "NOWPayments status is driven by IPN webhooks.",
    };
  }

  async getPaymentStatus(input: VerifyPaymentInput): Promise<VerifyPaymentResult> {
    return this.verifyPayment(input);
  }
}
