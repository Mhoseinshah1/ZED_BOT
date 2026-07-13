import { NowPaymentsGateway, nowpaymentsConfigFromEnv } from "./nowpayments.js";
import { TelegramStarsGateway, telegramStarsConfigFromEnv } from "./telegram-stars.js";
import type { PaymentGateway } from "./types.js";
import { ZarinpalGateway, zarinpalConfigFromEnv } from "./zarinpal.js";

/** Online providers this package implements (matches PaymentGatewayType values). */
export type SupportedProvider = "ZARINPAL" | "NOWPAYMENTS" | "TELEGRAM_STARS";

/** All online providers, in display order. */
export const SUPPORTED_ONLINE_PROVIDERS: readonly SupportedProvider[] = [
  "ZARINPAL",
  "NOWPAYMENTS",
  "TELEGRAM_STARS",
];

/**
 * Registry of online payment gateways keyed by provider name. Holds whatever
 * gateways the caller wires in - configuration completeness is reported per
 * gateway through isAvailable(), never thrown.
 */
export class PaymentGatewayManager {
  constructor(private readonly gateways: Partial<Record<SupportedProvider, PaymentGateway>>) {}

  /** Gateway for a provider name; unknown/unsupported/unwired names are null. */
  get(provider: string): PaymentGateway | null {
    if (!SUPPORTED_ONLINE_PROVIDERS.includes(provider as SupportedProvider)) {
      return null;
    }
    return this.gateways[provider as SupportedProvider] ?? null;
  }

  /** Providers whose gateway is wired AND fully configured for real calls. */
  available(): SupportedProvider[] {
    return SUPPORTED_ONLINE_PROVIDERS.filter((provider) => {
      const gateway = this.gateways[provider];
      return gateway !== undefined && gateway.isAvailable();
    });
  }
}

/**
 * Builds the default manager with all three gateways configured from env.
 * The Stars rate is not an env var - pass the current StarsPricingSetting
 * rate (toman per star) when known.
 */
export function buildDefaultManager(options?: {
  starsTomanPerStar?: number | null;
}): PaymentGatewayManager {
  return new PaymentGatewayManager({
    ZARINPAL: new ZarinpalGateway(zarinpalConfigFromEnv()),
    NOWPAYMENTS: new NowPaymentsGateway(nowpaymentsConfigFromEnv()),
    TELEGRAM_STARS: new TelegramStarsGateway({
      ...telegramStarsConfigFromEnv(),
      tomanPerStar: options?.starsTomanPerStar ?? undefined,
    }),
  });
}
