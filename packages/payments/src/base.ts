/**
 * Contract every payment gateway integration will implement. Placeholder for
 * now - the method surface (create invoice, verify callback, refund, ...)
 * lands with the first concrete gateway.
 */
export interface PaymentGateway {
  /** Unique gateway identifier, e.g. "zarinpal". */
  readonly name: string;
}
