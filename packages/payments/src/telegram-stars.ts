import type {
  CreatePaymentInput,
  CreatePaymentResult,
  HandleCallbackInput,
  HandleCallbackResult,
  PaymentGateway,
  VerifyPaymentInput,
  VerifyPaymentResult,
} from "./types.js";

/** Invoice payload prefix carrying our payment id through Telegram. */
export const STARS_PAYLOAD_PREFIX = "zedbot:pay:";

/** Telegram invoice titles are capped at 32 characters. */
const STARS_TITLE_MAX_LENGTH = 32;

/** The ONLY period Telegram supports for bot Star subscriptions (30 days). */
export const STARS_SUBSCRIPTION_PERIOD_SECONDS = 2592000;
/** Telegram Star subscription amount bounds (inclusive). */
export const STARS_SUBSCRIPTION_MIN_AMOUNT = 1;
export const STARS_SUBSCRIPTION_MAX_AMOUNT = 10000;

/** The exact `createInvoiceLink` parameters for a recurring Stars subscription. */
export interface StarsSubscriptionInvoiceParams {
  title: string;
  description: string;
  /** `zedbot:sub:<publicPayloadId>` — built by the caller (from @zedbot/shared). */
  payload: string;
  currency: "XTR";
  /** Exactly 2592000 — the only period Telegram supports. */
  subscriptionPeriod: number;
  /** Exactly ONE labeled price of `starsAmount` Stars. */
  prices: { label: string; amount: number }[];
}

export interface BuildStarsSubscriptionInvoiceInput {
  title: string;
  description: string;
  payload: string;
  starsAmount: number;
  /** Optional label for the single price line (defaults to the title). */
  priceLabel?: string;
}

export type BuildStarsSubscriptionInvoiceResult =
  | { ok: true; params: StarsSubscriptionInvoiceParams }
  | { ok: false; errorMessage: string };

/**
 * Builds the `createInvoiceLink` parameters for a recurring Stars subscription.
 * Pure and dependency-free: `currency = XTR`, `subscription_period = 2592000`,
 * exactly ONE labeled price, amount in [1, 10000]. This is the ONLY subscription
 * invoice path — the one-time `createPayment`/`sendInvoice` flow below is
 * untouched. NO tips, NO name/email/phone/shipping requests.
 */
export function buildStarsSubscriptionInvoice(
  input: BuildStarsSubscriptionInvoiceInput,
): BuildStarsSubscriptionInvoiceResult {
  if (
    !Number.isInteger(input.starsAmount) ||
    input.starsAmount < STARS_SUBSCRIPTION_MIN_AMOUNT ||
    input.starsAmount > STARS_SUBSCRIPTION_MAX_AMOUNT
  ) {
    return { ok: false, errorMessage: "Stars subscription amount is out of range (1..10000)." };
  }
  if (!input.payload.startsWith("zedbot:sub:")) {
    return { ok: false, errorMessage: "Subscription invoice payload must use the zedbot:sub: scheme." };
  }
  const title = input.title.trim().slice(0, STARS_TITLE_MAX_LENGTH);
  return {
    ok: true,
    params: {
      title,
      description: input.description,
      payload: input.payload,
      currency: "XTR",
      subscriptionPeriod: STARS_SUBSCRIPTION_PERIOD_SECONDS,
      prices: [{ label: (input.priceLabel ?? title).slice(0, STARS_TITLE_MAX_LENGTH), amount: input.starsAmount }],
    },
  };
}

export interface TelegramStarsConfig {
  /** Operator switch (TELEGRAM_STARS_ENABLED === "true"). */
  enabled: boolean;
  /**
   * Toman value of one Star. Comes from the bot's StarsPricingSetting, not
   * from env - the caller passes it through the constructor.
   */
  tomanPerStar?: number;
}

/**
 * Reads the Telegram Stars switch from the environment
 * (TELEGRAM_STARS_ENABLED). The rate is caller-provided - see
 * TelegramStarsConfig.tomanPerStar.
 */
export function telegramStarsConfigFromEnv(): Pick<TelegramStarsConfig, "enabled"> {
  return { enabled: (process.env.TELEGRAM_STARS_ENABLED ?? "").trim() === "true" };
}

/** Extracts our payment id from a Stars invoice payload, or null. */
export function parseStarsPayload(payload: string): string | null {
  if (!payload.startsWith(STARS_PAYLOAD_PREFIX)) {
    return null;
  }
  const paymentId = payload.slice(STARS_PAYLOAD_PREFIX.length);
  return paymentId === "" ? null : paymentId;
}

/**
 * Telegram Stars (XTR) gateway. There is no HTTP API here: createPayment
 * only computes the sendInvoice parameters, payment events arrive as bot
 * updates (pre_checkout_query / successful_payment) which the bot feeds
 * through handleCallback as query-shaped fields.
 */
export class TelegramStarsGateway implements PaymentGateway {
  readonly name = "TELEGRAM_STARS";

  constructor(private readonly config: TelegramStarsConfig) {}

  isAvailable(): boolean {
    return this.config.enabled && (this.config.tomanPerStar ?? 0) > 0;
  }

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    const tomanPerStar = this.config.tomanPerStar ?? 0;
    if (tomanPerStar <= 0) {
      return { ok: false, errorMessage: "Telegram Stars rate is not configured." };
    }
    const stars = Math.max(1, Math.ceil(input.amountToman / tomanPerStar));
    const payload = `${STARS_PAYLOAD_PREFIX}${input.paymentId}`;
    const title = input.description.trim().slice(0, STARS_TITLE_MAX_LENGTH);
    return {
      ok: true,
      authority: payload,
      telegramInvoice: {
        title,
        description: input.description,
        payload,
        currency: "XTR",
        stars,
      },
    };
  }

  /**
   * Normalizes a bot payment update passed as query fields: {payload,
   * telegram_payment_charge_id?, total_amount?, currency?}. A charge id means
   * the payment settled (successful_payment); without one the event is the
   * pre_checkout stage and stays PROCESSING.
   */
  handleCallback(input: HandleCallbackInput): HandleCallbackResult {
    const payload = input.query?.payload ?? "";
    const paymentId = parseStarsPayload(payload);
    if (paymentId === null) {
      return {
        ok: false,
        reason: "malformed",
        errorMessage: "Telegram Stars payload does not carry a payment id.",
      };
    }
    const currency = input.query?.currency;
    if (currency !== undefined && currency !== "XTR") {
      return {
        ok: false,
        reason: "malformed",
        errorMessage: "Telegram Stars event has an unexpected currency.",
      };
    }
    const chargeId = input.query?.telegram_payment_charge_id;
    return {
      ok: true,
      event: {
        paymentId,
        authority: payload,
        status: chargeId !== undefined && chargeId !== "" ? "SUCCESS" : "PROCESSING",
        transactionId: chargeId !== undefined && chargeId !== "" ? chargeId : undefined,
        sanitizedPayload: {
          payload,
          currency,
          total_amount: input.query?.total_amount,
          telegram_payment_charge_id: chargeId,
        },
      },
    };
  }

  /** The Bot API has no payment-status poll - bot updates are authoritative. */
  async verifyPayment(_input: VerifyPaymentInput): Promise<VerifyPaymentResult> {
    return {
      ok: false,
      status: "PENDING",
      uncertain: true,
      errorMessage: "Telegram Stars status is driven by bot payment updates.",
    };
  }

  async getPaymentStatus(input: VerifyPaymentInput): Promise<VerifyPaymentResult> {
    return this.verifyPayment(input);
  }
}
