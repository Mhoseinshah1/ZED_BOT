import { paymentHttpTimeoutMs, readJsonSafely, safeErrorText } from "./http.js";
import type {
  CreatePaymentInput,
  CreatePaymentResult,
  HandleCallbackInput,
  HandleCallbackResult,
  PaymentGateway,
  VerifyPaymentInput,
  VerifyPaymentResult,
} from "./types.js";

/** Zarinpal v4 REST hosts. Sandbox mirrors the production route shapes. */
const ZARINPAL_PRODUCTION_HOST = "https://payment.zarinpal.com";
const ZARINPAL_SANDBOX_HOST = "https://sandbox.zarinpal.com";

export interface ZarinpalConfig {
  /** Merchant UUID issued by Zarinpal. Required for real calls. */
  merchantId?: string;
  /** true routes all calls to the Zarinpal sandbox host. */
  sandbox: boolean;
  /** Default absolute callback URL for payment redirects. */
  callbackUrl?: string;
}

/**
 * Reads Zarinpal configuration from the environment: ZARINPAL_MERCHANT_ID,
 * ZARINPAL_SANDBOX ("true" selects the sandbox host), ZARINPAL_CALLBACK_URL.
 * Missing values never throw - the gateway just reports isAvailable()=false.
 */
export function zarinpalConfigFromEnv(): ZarinpalConfig {
  const merchantId = (process.env.ZARINPAL_MERCHANT_ID ?? "").trim();
  const callbackUrl = (process.env.ZARINPAL_CALLBACK_URL ?? "").trim();
  return {
    merchantId: merchantId === "" ? undefined : merchantId,
    sandbox: (process.env.ZARINPAL_SANDBOX ?? "").trim() === "true",
    callbackUrl: callbackUrl === "" ? undefined : callbackUrl,
  };
}

/** Zarinpal v4 envelope: data is an object on success, [] on failure. */
interface ZarinpalEnvelope {
  data?: { code?: number; authority?: string; ref_id?: number | string } | unknown[];
  errors?: { code?: number } | unknown[];
}

/**
 * Extracts the numeric Zarinpal result code from a v4 response envelope.
 * Only the code is ever surfaced to callers - never message bodies, which
 * could echo request fields.
 */
function zarinpalCode(envelope: ZarinpalEnvelope): number | undefined {
  if (typeof envelope.data === "object" && envelope.data !== null && !Array.isArray(envelope.data)) {
    const code = envelope.data.code;
    if (typeof code === "number") {
      return code;
    }
  }
  if (
    typeof envelope.errors === "object" &&
    envelope.errors !== null &&
    !Array.isArray(envelope.errors)
  ) {
    const code = envelope.errors.code;
    if (typeof code === "number") {
      return code;
    }
  }
  return undefined;
}

/**
 * Zarinpal payment gateway using the official v4 REST API
 * (POST /pg/v4/payment/request.json, POST /pg/v4/payment/verify.json).
 * Amounts are in toman (currency "IRT"). The redirect callback alone NEVER
 * proves payment - verifyPayment is the only source of truth.
 */
export class ZarinpalGateway implements PaymentGateway {
  readonly name = "ZARINPAL";

  constructor(private readonly config: ZarinpalConfig) {}

  private get host(): string {
    return this.config.sandbox ? ZARINPAL_SANDBOX_HOST : ZARINPAL_PRODUCTION_HOST;
  }

  isAvailable(): boolean {
    return (this.config.merchantId ?? "") !== "" && (this.config.callbackUrl ?? "") !== "";
  }

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    const callbackUrl = input.callbackUrl ?? this.config.callbackUrl ?? "";
    if ((this.config.merchantId ?? "") === "" || callbackUrl === "") {
      return { ok: false, errorMessage: "Zarinpal gateway is not configured." };
    }
    try {
      const response = await fetch(`${this.host}/pg/v4/payment/request.json`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          merchant_id: this.config.merchantId,
          amount: input.amountToman,
          currency: "IRT",
          description: input.description,
          callback_url: callbackUrl,
        }),
        signal: AbortSignal.timeout(paymentHttpTimeoutMs()),
      });
      const parsed = await readJsonSafely(response);
      if (!parsed.ok) {
        return { ok: false, errorMessage: "Zarinpal returned a malformed response." };
      }
      const envelope = parsed.data as ZarinpalEnvelope;
      const code = zarinpalCode(envelope);
      if (
        code === 100 &&
        typeof envelope.data === "object" &&
        envelope.data !== null &&
        !Array.isArray(envelope.data) &&
        typeof envelope.data.authority === "string" &&
        envelope.data.authority !== ""
      ) {
        const authority = envelope.data.authority;
        return { ok: true, authority, redirectUrl: `${this.host}/pg/StartPay/${authority}` };
      }
      return {
        ok: false,
        errorMessage:
          code === undefined
            ? `Zarinpal request failed (HTTP ${response.status}).`
            : `Zarinpal request failed with code ${code}.`,
      };
    } catch (err) {
      return { ok: false, errorMessage: `Zarinpal request failed: ${safeErrorText(err)}` };
    }
  }

  /**
   * Verifies one payment. Code 100 = verified now; code 101 = already
   * verified before (Zarinpal's built-in duplicate-verification protection) -
   * both are SUCCESS. Timeout/transport/malformed responses come back as
   * uncertain PENDING and must never be treated as failure.
   */
  async verifyPayment(input: VerifyPaymentInput): Promise<VerifyPaymentResult> {
    if ((this.config.merchantId ?? "") === "") {
      return {
        ok: false,
        status: "PENDING",
        uncertain: true,
        errorMessage: "Zarinpal gateway is not configured.",
      };
    }
    try {
      const response = await fetch(`${this.host}/pg/v4/payment/verify.json`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          merchant_id: this.config.merchantId,
          amount: input.amountToman,
          authority: input.authority,
        }),
        signal: AbortSignal.timeout(paymentHttpTimeoutMs()),
      });
      const parsed = await readJsonSafely(response);
      if (!parsed.ok) {
        return {
          ok: false,
          status: "PENDING",
          uncertain: true,
          errorMessage: "Zarinpal returned a malformed response.",
        };
      }
      const envelope = parsed.data as ZarinpalEnvelope;
      const code = zarinpalCode(envelope);
      if (code === 100 || code === 101) {
        const refId =
          typeof envelope.data === "object" &&
          envelope.data !== null &&
          !Array.isArray(envelope.data) &&
          envelope.data.ref_id !== undefined
            ? String(envelope.data.ref_id)
            : undefined;
        return { ok: true, status: "SUCCESS", transactionId: refId };
      }
      if (code !== undefined) {
        return {
          ok: false,
          status: "FAILED",
          errorMessage: `Zarinpal verification failed with code ${code}.`,
        };
      }
      return {
        ok: false,
        status: "PENDING",
        uncertain: true,
        errorMessage: `Zarinpal verification failed (HTTP ${response.status}).`,
      };
    } catch (err) {
      // Timeout AND transport failures are both uncertain: the verify call
      // may have reached Zarinpal, so the payment must never be failed here.
      return {
        ok: false,
        status: "PENDING",
        uncertain: true,
        errorMessage: `Zarinpal verification failed: ${safeErrorText(err)}`,
      };
    }
  }

  /**
   * Parses the redirect callback query (Authority, Status). Status "OK" only
   * means the user came back from the gateway - the event is PROCESSING and
   * verification is still required; the callback alone NEVER means success.
   */
  handleCallback(input: HandleCallbackInput): HandleCallbackResult {
    const authority = input.query?.Authority ?? "";
    const status = input.query?.Status ?? "";
    if (authority === "" || (status !== "OK" && status !== "NOK")) {
      return {
        ok: false,
        reason: "malformed",
        errorMessage: "Zarinpal callback is missing Authority/Status parameters.",
      };
    }
    return {
      ok: true,
      event: {
        authority,
        status: status === "OK" ? "PROCESSING" : "CANCELLED",
        sanitizedPayload: { Authority: authority, Status: status },
      },
    };
  }

  /** Alias of verifyPayment - verify is idempotent server-side via code 101. */
  async getPaymentStatus(input: VerifyPaymentInput): Promise<VerifyPaymentResult> {
    return this.verifyPayment(input);
  }
}
