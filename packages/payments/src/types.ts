/**
 * Provider-neutral payment gateway contract. This package is provider-pure:
 * it never touches the database - callers persist results on Payment rows.
 */

/** Normalized provider outcome recorded on Payment.providerStatus. */
export type NormalizedPaymentStatus =
  | "PENDING"
  | "PROCESSING"
  | "SUCCESS"
  | "FAILED"
  | "EXPIRED"
  | "CANCELLED";

export interface CreatePaymentInput {
  /** Our Payment row id - becomes the provider-side order reference. */
  paymentId: string;
  amountToman: number;
  description: string;
  /** Absolute callback/IPN URL when the provider needs one. */
  callbackUrl?: string;
}

export interface CreatePaymentResult {
  ok: boolean;
  /** Provider handle issued at creation (Zarinpal authority / NOWPayments invoice id / Stars payload). */
  authority?: string;
  /** Provider-side payment/invoice reference when distinct from authority. */
  externalReference?: string;
  /** URL the user opens to pay (absent for Telegram Stars). */
  redirectUrl?: string;
  /** Telegram Stars only: parameters for bot.api.sendInvoice. */
  telegramInvoice?: TelegramInvoiceSpec;
  /** Safe short message (never credentials/raw provider bodies). */
  errorMessage?: string;
}

export interface TelegramInvoiceSpec {
  title: string;
  description: string;
  /** Invoice payload carrying our payment id (validated on pre_checkout). */
  payload: string;
  currency: "XTR";
  /** Integer Stars amount. */
  stars: number;
}

export interface VerifyPaymentInput {
  authority: string;
  amountToman: number;
}

export interface VerifyPaymentResult {
  ok: boolean;
  status: NormalizedPaymentStatus;
  /** Final settlement reference (Zarinpal ref_id etc.). */
  transactionId?: string;
  /** true when verification could not be completed (timeout/transport) - never treat as failed. */
  uncertain?: boolean;
  errorMessage?: string;
}

export interface CallbackEvent {
  /** Our payment id when resolvable from the event. */
  paymentId?: string;
  authority?: string;
  externalReference?: string;
  status: NormalizedPaymentStatus | "UNKNOWN";
  transactionId?: string;
  /** Sanitized payload safe for Payment.callbackPayload (no secrets/signatures). */
  sanitizedPayload: Record<string, unknown>;
}

export interface HandleCallbackInput {
  /** Raw body string (webhooks) or query params (redirects). */
  rawBody?: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
}

export type HandleCallbackResult =
  | { ok: true; event: CallbackEvent }
  | { ok: false; reason: "invalid-signature" | "malformed" | "unsupported"; errorMessage: string };

/**
 * Contract every online payment provider (Zarinpal, NOWPayments, Telegram
 * Stars, ...) implements. Methods never throw for expected provider/API
 * failures and never include credentials in results or messages.
 */
export interface PaymentGateway {
  readonly name: string;
  /** true when env/config credentials are complete for real calls. */
  isAvailable(): boolean;
  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult>;
  verifyPayment(input: VerifyPaymentInput): Promise<VerifyPaymentResult>;
  handleCallback(input: HandleCallbackInput): HandleCallbackResult | Promise<HandleCallbackResult>;
  getPaymentStatus(input: VerifyPaymentInput): Promise<VerifyPaymentResult>;
  // refund() deliberately absent: Zarinpal v4 and Telegram Stars offer no
  // general-purpose merchant refund API surface we can support uniformly;
  // NOWPayments refunds are a manual dashboard operation.
}
