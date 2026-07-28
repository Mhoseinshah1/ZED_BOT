// =============================================================================
// Commerce API client (miniapp-commerce-parity). Same rules as api.ts: thin
// fetch wrappers, DTO types mirroring the server allowlists, no computation —
// every amount, discount, grant and status on these DTOs was decided
// server-side and is rendered verbatim through i18n.
// =============================================================================
import { newClientRequestId, request, type ApiResult } from "./api";

export interface CommerceFlagsDto {
  flags: Record<string, boolean>;
}

export interface CatalogProductDto {
  publicId: string;
  name: string;
  priceToman: number;
  volumeGb: number | null;
  durationDays: number | null;
  serviceLocation: string | null;
}

export interface CatalogCategoryDto {
  publicId: string;
  name: string;
  products: CatalogProductDto[];
}

export interface CatalogPanelDto {
  publicId: string;
  name: string;
  categories: CatalogCategoryDto[];
}

export interface CatalogDto {
  servicePanels: CatalogPanelDto[];
  otherProductCategories: CatalogCategoryDto[];
}

export interface QuoteDto {
  kind: string;
  productPublicId: string;
  productName: string;
  panelName: string | null;
  username: string | null;
  note: string | null;
  originalPriceToman: number;
  discountAmountToman: number;
  finalPriceToman: number;
  discountCode: string | null;
  discountStackingRejected: boolean;
  needsCustomerInputBeforePayment: boolean;
  walletPayEnabled: boolean;
  draftToken: string;
}

export interface CheckoutDto {
  publicId: string;
  status: string;
  purpose: string;
  orderType: string | null;
  productName: string | null;
  panelName: string | null;
  username: string | null;
  originalPriceToman: number;
  discountAmountToman: number;
  finalPriceToman: number;
  discountCode: string | null;
  needsCustomerInputBeforePayment: boolean;
  expiresAt: string;
  createdAt: string;
}

export interface PaymentMethodDto {
  publicId: string;
  type: "CARD_TO_CARD" | "ZARINPAL" | "NOWPAYMENTS" | "TELEGRAM_STARS";
  name: string;
}

export interface CardInfoDto {
  gatewayPublicId: string;
  cardRef: string;
  cardNumber: string;
  ownerName: string | null;
  amountToman: number;
  checkoutExpiresAt: string;
}

export interface PaymentStatusDto {
  payment: {
    publicId: string;
    status: string;
    settlementStatus: string;
    purpose: string;
    amountToman: number;
    createdAt: string;
    expiresAt: string | null;
  };
  checkout: CheckoutDto | null;
  orderPublicId: string | null;
  orderStatus: string | null;
  servicePublicId: string | null;
}

export interface HistoryItemDto {
  itemType: "ORDER" | "PAYMENT";
  publicId: string;
  orderType?: string;
  purpose?: string;
  status: string;
  amountToman: number;
  createdAt: string;
}

export interface HistoryPageDto {
  page: number;
  pages: number;
  total: number;
  items: HistoryItemDto[];
}

export interface PaymentsPageDto {
  page: number;
  pages: number;
  total: number;
  payments: Array<{
    publicId: string;
    purpose: string;
    status: string;
    settlementStatus: string;
    amountToman: number;
    createdAt: string;
  }>;
}

export interface OrderDetailDto {
  order: {
    publicId: string;
    orderType: string;
    status: string;
    productName: string | null;
    amountToman: number;
    createdAt: string;
    paidAt: string | null;
    completedAt: string | null;
    failureVisible: boolean;
    reconciliationPending: boolean;
    paymentPublicId: string | null;
    servicePublicId: string | null;
    checkoutPublicId: string | null;
    isOtherProduct: boolean;
  };
}

export interface OtherOrderDetailDto {
  order: {
    publicId: string;
    status: string;
    displayStatus: string;
    productName: string | null;
    createdAt: string;
    checkoutPublicId: string | null;
    deliveredText: string | null;
    deliveredStock: string | null;
    awaitingStock: boolean;
  };
}

export interface DeliveryDto {
  delivery: {
    servicePublicId: string;
    username: string;
    status: string;
    subscriptionUrl: string | null;
    configLinks: string[];
  };
}

export interface AddonsDto {
  walletPayEnabled: boolean;
  addons: Record<
    "RENEWAL" | "EXTRA_VOLUME" | "EXTRA_TIME",
    { enabled: boolean; eligible: boolean; plans: CatalogProductDto[] }
  >;
}

export interface AddonQuoteDto {
  quote: {
    kind: string;
    servicePublicId: string;
    productPublicId: string;
    productName: string;
    username: string;
    originalPriceToman: number;
    discountAmountToman: number;
    finalPriceToman: number;
    discountCode: string | null;
    walletPayEnabled: boolean;
    draftToken: string;
  };
}

export interface InputFormDto {
  input: {
    checkoutPublicId: string;
    status: string;
    fields: Array<{
      key: string;
      label: string;
      required: boolean;
      type: string;
      minLength: number | null;
      maxLength: number | null;
      options: string[] | null;
    }>;
    maskedSummary: string | null;
  };
}

export function fetchCommerceFlags(): Promise<ApiResult<CommerceFlagsDto>> {
  return request("/commerce/flags");
}

export function fetchCatalog(): Promise<ApiResult<CatalogDto>> {
  return request("/commerce/catalog");
}

export function reserveUsername(body: {
  panelPublicId: string;
  mode: "CUSTOM" | "RANDOM";
  username?: string;
}): Promise<ApiResult<{ draftNonce: string; username: string; mode: string }>> {
  return request("/commerce/username", { method: "POST", body });
}

export function fetchQuote(body: {
  kind: "SERVICE" | "OTHER";
  productPublicId: string;
  draftNonce?: string;
  note?: string;
  discountCode?: string;
}): Promise<ApiResult<{ quote: QuoteDto }>> {
  return request("/commerce/quote", { method: "POST", body });
}

export function confirmCheckout(
  draftToken: string,
): Promise<ApiResult<{ checkout: CheckoutDto }>> {
  return request("/commerce/checkout", {
    method: "POST",
    body: { draftToken, clientRequestId: newClientRequestId() },
  });
}

export function payWallet(
  draftToken: string,
): Promise<
  ApiResult<{
    checkout: CheckoutDto;
    paymentPublicId: string | null;
    orderPublicId: string | null;
  }>
> {
  return request("/commerce/pay/wallet", {
    method: "POST",
    body: { draftToken, clientRequestId: newClientRequestId() },
  });
}

export function fetchCheckout(
  publicId: string,
): Promise<ApiResult<{ checkout: CheckoutDto }>> {
  return request(`/commerce/checkouts/${encodeURIComponent(publicId)}`);
}

export function fetchMethods(
  checkoutPublicId: string,
): Promise<ApiResult<{ methods: PaymentMethodDto[] }>> {
  return request(`/commerce/checkouts/${encodeURIComponent(checkoutPublicId)}/methods`);
}

export function fetchCardInfo(
  checkoutPublicId: string,
): Promise<ApiResult<CardInfoDto>> {
  return request(`/commerce/checkouts/${encodeURIComponent(checkoutPublicId)}/pay/card`, {
    method: "POST",
    body: { clientRequestId: newClientRequestId() },
  });
}

export function submitReceipt(
  checkoutPublicId: string,
  body: { gatewayPublicId: string; cardRef?: string; fileBase64?: string; text?: string },
): Promise<ApiResult<{ paymentPublicId: string; status: string }>> {
  return request(`/commerce/checkouts/${encodeURIComponent(checkoutPublicId)}/receipt`, {
    method: "POST",
    body: { ...body, clientRequestId: newClientRequestId() },
  });
}

export function initGateway(
  checkoutPublicId: string,
  gatewayPublicId: string,
): Promise<
  ApiResult<{
    paymentPublicId: string;
    redirectUrl: string | null;
    starsInvoiceLink: string | null;
  }>
> {
  return request(`/commerce/checkouts/${encodeURIComponent(checkoutPublicId)}/pay/gateway`, {
    method: "POST",
    body: { gatewayPublicId, clientRequestId: newClientRequestId() },
  });
}

export function fetchPaymentStatus(
  paymentPublicId: string,
): Promise<ApiResult<PaymentStatusDto>> {
  return request(`/commerce/payments/${encodeURIComponent(paymentPublicId)}`);
}

export function createTopup(
  amountToman: number,
): Promise<ApiResult<{ checkout: CheckoutDto }>> {
  return request("/commerce/topup", {
    method: "POST",
    body: { amountToman, clientRequestId: newClientRequestId() },
  });
}

export function fetchHistory(page: number): Promise<ApiResult<HistoryPageDto>> {
  return request(`/commerce/history?page=${page}`);
}

export function fetchPaymentsList(page: number): Promise<ApiResult<PaymentsPageDto>> {
  return request(`/commerce/payments?page=${page}`);
}

export function fetchOrderDetail(publicId: string): Promise<ApiResult<OrderDetailDto>> {
  return request(`/commerce/orders/${encodeURIComponent(publicId)}`);
}

export function fetchOtherOrderDetail(
  publicId: string,
): Promise<ApiResult<OtherOrderDetailDto>> {
  return request(`/commerce/other-orders/${encodeURIComponent(publicId)}`);
}

export function fetchDelivery(servicePublicId: string): Promise<ApiResult<DeliveryDto>> {
  return request(`/commerce/services/${encodeURIComponent(servicePublicId)}/delivery`);
}

export function fetchAddons(servicePublicId: string): Promise<ApiResult<AddonsDto>> {
  return request(`/commerce/services/${encodeURIComponent(servicePublicId)}/addons`);
}

export function fetchAddonQuote(
  servicePublicId: string,
  body: {
    kind: "RENEWAL" | "EXTRA_VOLUME" | "EXTRA_TIME";
    productPublicId: string;
    discountCode?: string;
  },
): Promise<ApiResult<AddonQuoteDto>> {
  return request(`/commerce/services/${encodeURIComponent(servicePublicId)}/addon-quote`, {
    method: "POST",
    body,
  });
}

export function fetchInputForm(
  checkoutPublicId: string,
): Promise<ApiResult<InputFormDto>> {
  return request(`/commerce/checkouts/${encodeURIComponent(checkoutPublicId)}/input`);
}

export function submitInputForm(
  checkoutPublicId: string,
  values: Record<string, string>,
): Promise<ApiResult<{ status: string; maskedSummary: string | null }>> {
  return request(`/commerce/checkouts/${encodeURIComponent(checkoutPublicId)}/input`, {
    method: "POST",
    body: { values, clientRequestId: newClientRequestId() },
  });
}

/** QR image URL — same-origin, the session cookie rides along on the <img>. */
export function qrImageUrl(
  servicePublicId: string,
  target: "sub" | "config",
  index = 0,
): string {
  const base = `/api/miniapp/commerce/services/${encodeURIComponent(servicePublicId)}/qr`;
  return target === "sub" ? `${base}?target=sub` : `${base}?target=config&index=${index}`;
}
