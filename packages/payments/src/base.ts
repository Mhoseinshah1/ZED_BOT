/**
 * Payment gateway implementation will be added in a later phase.
 *
 * This package intentionally contains no gateway logic yet - only this empty
 * placeholder interface. The method surface (create invoice, verify
 * callback, refund, ...) lands with the first concrete gateway.
 */
export interface PaymentGateway {
  /** Unique gateway identifier. */
  readonly name: string;
}
