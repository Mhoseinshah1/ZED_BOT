// =============================================================================
// Commerce screens (miniapp-commerce-parity, Phase 1 — functional, not the
// final visual design). Every amount, status and grant on these screens is a
// server value rendered verbatim; the client computes nothing financial.
// Machine codes render through the i18n tables; unknown codes fall back to
// the raw code (lookup()).
// =============================================================================
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import type { ApiFailure } from "./api";
import {
  confirmCheckout,
  createTopup,
  fetchAddonQuote,
  fetchAddons,
  fetchCardInfo,
  fetchCatalog,
  fetchDelivery,
  fetchHistory,
  fetchInputForm,
  fetchMethods,
  fetchOrderDetail,
  fetchOtherOrderDetail,
  fetchPaymentsList,
  fetchPaymentStatus,
  fetchQuote,
  initGateway,
  payWallet,
  qrImageUrl,
  reserveUsername,
  submitInputForm,
  submitReceipt,
  type CatalogCategoryDto,
  type CatalogPanelDto,
  type CatalogProductDto,
  type CheckoutDto,
  type QuoteDto,
} from "./commerce-api";
import { Card, FailureScreen, Row, Spinner } from "./components";
import { formatToman } from "./format";
import {
  CHECKOUT_STATUS_TEXT,
  COMMERCE_UI as C,
  lookup,
  METHOD_TYPE_TEXT,
  ORDER_STATUS_TEXT,
  OTHER_ORDER_STATUS_TEXT,
  PAYMENT_STATUS_TEXT,
} from "./i18n";
import { useResource } from "./screens";

export interface CommerceFlags {
  commerce: boolean;
  walletTopup: boolean;
  cardToCard: boolean;
  onlinePayments: boolean;
  serviceDelivery: boolean;
  serviceRenewal: boolean;
  extraVolume: boolean;
  extraTime: boolean;
  otherProducts: boolean;
}

export function flagsFromResponse(raw: Record<string, boolean> | undefined): CommerceFlags {
  // Fail closed for display exactly like the server does for mutations: a
  // malformed flags payload shows NO commerce surface.
  const flags = raw ?? {};
  return {
    commerce: flags.miniapp_commerce_enabled === true,
    walletTopup: flags.miniapp_wallet_topup_enabled === true,
    cardToCard: flags.miniapp_card_to_card_enabled === true,
    onlinePayments: flags.miniapp_online_payments_enabled === true,
    serviceDelivery: flags.miniapp_service_delivery_enabled === true,
    serviceRenewal: flags.miniapp_service_renewal_enabled === true,
    extraVolume: flags.miniapp_extra_volume_enabled === true,
    extraTime: flags.miniapp_extra_time_enabled === true,
    otherProducts: flags.miniapp_other_products_enabled === true,
  };
}

function Failure({ failure, onRetry }: { failure: ApiFailure; onRetry?: () => void }): ReactNode {
  return <FailureScreen failure={failure} onRetry={onRetry} />;
}

function CopyValue({ value }: { value: string }): ReactNode {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="button button--ghost"
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? C.copied : C.copy}
    </button>
  );
}

// --- purchase hub ---------------------------------------------------------------

export type BuyView =
  | { kind: "hub" }
  | { kind: "catalog"; mode: "service" | "other" | "pricing" }
  | { kind: "purchase"; product: CatalogProductDto; panel: CatalogPanelDto | null; other: boolean }
  | { kind: "checkout"; checkoutPublicId: string }
  | { kind: "payment"; paymentPublicId: string }
  | { kind: "pending-payments" }
  | { kind: "topup" };

export function BuyScreen(props: { flags: CommerceFlags; view: BuyView; onView: (view: BuyView) => void; onOrders: () => void }): ReactNode {
  const { flags, view, onView } = props;
  if (!flags.commerce) {
    return (
      <Card title={C.buyTitle}>
        <p className="empty">{C.notEligible}</p>
      </Card>
    );
  }
  switch (view.kind) {
    case "hub":
      return (
        <div className="stack">
          <Card title={C.buyTitle}>
            <div className="actions">
              <button type="button" className="button" onClick={() => onView({ kind: "catalog", mode: "service" })}>
                {C.buySubscription}
              </button>
              {flags.otherProducts ? (
                <button type="button" className="button" onClick={() => onView({ kind: "catalog", mode: "other" })}>
                  {C.otherProducts}
                </button>
              ) : null}
              <button type="button" className="button button--ghost" onClick={() => onView({ kind: "catalog", mode: "pricing" })}>
                {C.pricing}
              </button>
              <button type="button" className="button button--ghost" onClick={() => onView({ kind: "pending-payments" })}>
                {C.pendingPayments}
              </button>
              <button type="button" className="button button--ghost" onClick={props.onOrders}>
                {C.recentOrders}
              </button>
            </div>
          </Card>
        </div>
      );
    case "catalog":
      return (
        <CatalogScreen
          mode={view.mode}
          onBack={() => onView({ kind: "hub" })}
          onSelect={(product, panel, other) =>
            view.mode === "pricing" ? undefined : onView({ kind: "purchase", product, panel, other })
          }
        />
      );
    case "purchase":
      return (
        <PurchaseWizard
          product={view.product}
          panel={view.panel}
          other={view.other}
          onBack={() => onView({ kind: "catalog", mode: view.other ? "other" : "service" })}
          onCheckout={(publicId) => onView({ kind: "checkout", checkoutPublicId: publicId })}
          onPayment={(publicId) => onView({ kind: "payment", paymentPublicId: publicId })}
        />
      );
    case "checkout":
      return (
        <CheckoutScreen
          flags={flags}
          checkoutPublicId={view.checkoutPublicId}
          onPayment={(publicId) => onView({ kind: "payment", paymentPublicId: publicId })}
          onBack={() => onView({ kind: "hub" })}
        />
      );
    case "payment":
      return <PaymentStatusScreen paymentPublicId={view.paymentPublicId} onBack={() => onView({ kind: "hub" })} />;
    case "pending-payments":
      return <PendingPaymentsScreen onOpen={(publicId) => onView({ kind: "payment", paymentPublicId: publicId })} onBack={() => onView({ kind: "hub" })} />;
    case "topup":
      return <TopupScreen onCheckout={(publicId) => onView({ kind: "checkout", checkoutPublicId: publicId })} onBack={() => onView({ kind: "hub" })} />;
    default:
      return null;
  }
}

// --- catalog ----------------------------------------------------------------------

function ProductRow(props: { product: CatalogProductDto; onSelect?: () => void }): ReactNode {
  const { product } = props;
  const meta = [
    product.volumeGb !== null ? `${product.volumeGb} ${C.gb}` : null,
    product.durationDays !== null ? `${product.durationDays} ${C.days}` : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
  return (
    <button type="button" className="txn" onClick={props.onSelect} disabled={props.onSelect === undefined}>
      <span>
        {product.name}
        {meta !== "" ? <small> {meta}</small> : null}
      </span>
      <strong>{formatToman(product.priceToman)}</strong>
    </button>
  );
}

function CatalogScreen(props: {
  mode: "service" | "other" | "pricing";
  onBack: () => void;
  onSelect: (product: CatalogProductDto, panel: CatalogPanelDto | null, other: boolean) => void;
}): ReactNode {
  const load = useCallback(() => fetchCatalog(), []);
  const { state, reload } = useResource(load);
  if (state.phase === "loading") return <Spinner />;
  if (state.phase === "failed") return <Failure failure={state.failure} onRetry={reload} />;
  const catalog = state.data;
  const showService = props.mode !== "other";
  const showOther = props.mode !== "service" && catalog.otherProductCategories.length > 0;
  const selectable = props.mode !== "pricing";
  return (
    <div className="stack">
      <button type="button" className="button button--ghost" onClick={props.onBack}>
        {C.back}
      </button>
      {showService
        ? catalog.servicePanels.map((panel: CatalogPanelDto) => (
            <Card key={panel.publicId} title={panel.name}>
              {panel.categories.map((category: CatalogCategoryDto) => (
                <div key={category.publicId}>
                  <p className="row__key">{category.name}</p>
                  {category.products.map((product: CatalogProductDto) => (
                    <ProductRow
                      key={product.publicId}
                      product={product}
                      onSelect={selectable ? () => props.onSelect(product, panel, false) : undefined}
                    />
                  ))}
                </div>
              ))}
            </Card>
          ))
        : null}
      {showOther
        ? catalog.otherProductCategories.map((category: CatalogCategoryDto) => (
            <Card key={category.publicId} title={category.name}>
              {category.products.map((product: CatalogProductDto) => (
                <ProductRow
                  key={product.publicId}
                  product={product}
                  onSelect={selectable ? () => props.onSelect(product, null, true) : undefined}
                />
              ))}
            </Card>
          ))
        : null}
      {!showService && !showOther ? <p className="empty">{C.emptyList}</p> : null}
    </div>
  );
}

// --- purchase wizard ---------------------------------------------------------------

function QuoteCard(props: {
  quote: QuoteDto;
  busy: boolean;
  onWallet: () => void;
  onContinue: () => void;
}): ReactNode {
  const { quote } = props;
  return (
    <Card title={C.preInvoice}>
      <Row label={C.chooseProduct} value={quote.productName} />
      {quote.username !== null ? <Row label={C.usernameStep} value={quote.username} /> : null}
      <Row label={C.originalPrice} value={formatToman(quote.originalPriceToman)} />
      {quote.discountAmountToman > 0 ? (
        <Row label={C.discountAmount} value={formatToman(quote.discountAmountToman)} />
      ) : null}
      <Row label={C.finalPrice} value={<strong>{formatToman(quote.finalPriceToman)}</strong>} />
      <div className="actions">
        {quote.walletPayEnabled ? (
          <button type="button" className="button" disabled={props.busy} onClick={props.onWallet}>
            {C.payWithWallet}
          </button>
        ) : null}
        <button type="button" className="button button--ghost" disabled={props.busy} onClick={props.onContinue}>
          {C.goToPayment}
        </button>
      </div>
    </Card>
  );
}

function PurchaseWizard(props: {
  product: CatalogProductDto;
  panel: CatalogPanelDto | null;
  other: boolean;
  onBack: () => void;
  onCheckout: (checkoutPublicId: string) => void;
  onPayment: (paymentPublicId: string) => void;
}): ReactNode {
  const [username, setUsername] = useState("");
  const [draftNonce, setDraftNonce] = useState<string | null>(null);
  const [reservedName, setReservedName] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [discount, setDiscount] = useState("");
  const [appliedDiscount, setAppliedDiscount] = useState<string | undefined>(undefined);
  const [quote, setQuote] = useState<QuoteDto | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const needsUsername = !props.other && props.panel !== null;

  const runQuote = useCallback(
    async (nonce: string | null, code: string | undefined) => {
      setBusy(true);
      setFailure(null);
      const result = await fetchQuote({
        kind: props.other ? "OTHER" : "SERVICE",
        productPublicId: props.product.publicId,
        ...(nonce !== null ? { draftNonce: nonce } : {}),
        ...(note.trim() !== "" ? { note: note.trim() } : {}),
        ...(code !== undefined ? { discountCode: code } : {}),
      });
      setBusy(false);
      if (!result.ok) {
        setFailure(result);
        return;
      }
      setQuote(result.quote);
    },
    [note, props.other, props.product.publicId],
  );

  const reserve = useCallback(
    async (mode: "CUSTOM" | "RANDOM") => {
      if (props.panel === null) return;
      setBusy(true);
      setFailure(null);
      const result = await reserveUsername({
        panelPublicId: props.panel.publicId,
        mode,
        ...(mode === "CUSTOM" ? { username } : {}),
      });
      setBusy(false);
      if (!result.ok) {
        setFailure(result);
        return;
      }
      setDraftNonce(result.draftNonce);
      setReservedName(result.username);
      await runQuote(result.draftNonce, appliedDiscount);
    },
    [appliedDiscount, props.panel, runQuote, username],
  );

  useEffect(() => {
    if (!needsUsername && quote === null && !busy && failure === null) {
      void runQuote(null, appliedDiscount);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsUsername]);

  if (failure !== null && quote === null) {
    return <Failure failure={failure} onRetry={() => setFailure(null)} />;
  }

  return (
    <div className="stack">
      <button type="button" className="button button--ghost" onClick={props.onBack}>
        {C.back}
      </button>
      {needsUsername && quote === null ? (
        <Card title={C.usernameStep}>
          <input
            className="form__input"
            dir="ltr"
            value={username}
            placeholder={C.usernamePlaceholder}
            onChange={(event) => setUsername(event.target.value)}
          />
          <div className="actions">
            <button type="button" className="button" disabled={busy || username.trim() === ""} onClick={() => void reserve("CUSTOM")}>
              {C.usernameCustom}
            </button>
            <button type="button" className="button button--ghost" disabled={busy} onClick={() => void reserve("RANDOM")}>
              {C.usernameRandom}
            </button>
          </div>
          {failure !== null ? <p className="notice">{failure.code}</p> : null}
        </Card>
      ) : null}
      {quote !== null ? (
        <>
          <Card title={C.discountLabel}>
            <input
              className="form__input"
              dir="ltr"
              value={discount}
              placeholder={C.discountLabel}
              onChange={(event) => setDiscount(event.target.value)}
            />
            <div className="actions">
              <button
                type="button"
                className="button button--ghost"
                disabled={busy || discount.trim() === ""}
                onClick={() => {
                  setAppliedDiscount(discount.trim());
                  void runQuote(draftNonce, discount.trim());
                }}
              >
                {C.applyDiscount}
              </button>
              {appliedDiscount !== undefined ? (
                <button
                  type="button"
                  className="button button--ghost"
                  disabled={busy}
                  onClick={() => {
                    setAppliedDiscount(undefined);
                    setDiscount("");
                    void runQuote(draftNonce, undefined);
                  }}
                >
                  {C.clearDiscount}
                </button>
              ) : null}
            </div>
            {failure !== null ? <p className="notice">{failure.code}</p> : null}
            {reservedName !== null ? <Row label={C.usernameStep} value={reservedName} /> : null}
          </Card>
          <QuoteCard
            quote={quote}
            busy={busy}
            onWallet={() => {
              setBusy(true);
              void payWallet(quote.draftToken).then((result) => {
                setBusy(false);
                if (!result.ok) {
                  if (result.code === "NEEDS_CUSTOMER_INPUT") {
                    const body = result as ApiFailure & { checkout?: CheckoutDto };
                    if (body.checkout !== undefined) {
                      props.onCheckout(body.checkout.publicId);
                      return;
                    }
                  }
                  setFailure(result);
                  return;
                }
                if (result.paymentPublicId !== null) {
                  props.onPayment(result.paymentPublicId);
                }
              });
            }}
            onContinue={() => {
              setBusy(true);
              void confirmCheckout(quote.draftToken).then((result) => {
                setBusy(false);
                if (!result.ok) {
                  setFailure(result);
                  return;
                }
                props.onCheckout(result.checkout.publicId);
              });
            }}
          />
        </>
      ) : null}
    </div>
  );
}

// --- checkout + payment methods ----------------------------------------------------

function CheckoutScreen(props: {
  flags: CommerceFlags;
  checkoutPublicId: string;
  onPayment: (paymentPublicId: string) => void;
  onBack: () => void;
}): ReactNode {
  const load = useCallback(async () => {
    const checkout = await import("./commerce-api").then((m) => m.fetchCheckout(props.checkoutPublicId));
    if (!checkout.ok) return checkout;
    const methods = await fetchMethods(props.checkoutPublicId);
    if (!methods.ok) return methods;
    return { ok: true as const, checkout: checkout.checkout, methods: methods.methods };
  }, [props.checkoutPublicId]);
  const { state, reload } = useResource(load);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const [card, setCard] = useState<Awaited<ReturnType<typeof fetchCardInfo>> | null>(null);
  const [receiptText, setReceiptText] = useState("");
  const [fileBase64, setFileBase64] = useState<string | null>(null);
  const [inputDone, setInputDone] = useState(false);

  if (state.phase === "loading") return <Spinner />;
  if (state.phase === "failed") return <Failure failure={state.failure} onRetry={reload} />;
  const { checkout, methods } = state.data;

  if (checkout.needsCustomerInputBeforePayment && !inputDone) {
    return (
      <InputFormScreen
        checkoutPublicId={props.checkoutPublicId}
        onDone={() => {
          setInputDone(true);
          reload();
        }}
        onBack={props.onBack}
      />
    );
  }

  return (
    <div className="stack">
      <button type="button" className="button button--ghost" onClick={props.onBack}>
        {C.back}
      </button>
      <Card title={C.preInvoice}>
        {checkout.productName !== null ? <Row label={C.chooseProduct} value={checkout.productName} /> : null}
        <Row label={C.finalPrice} value={<strong>{formatToman(checkout.finalPriceToman)}</strong>} />
        <Row label={C.paymentStatusTitle} value={lookup(CHECKOUT_STATUS_TEXT, checkout.status)} />
      </Card>
      {card !== null && card.ok ? (
        <Card title={C.cardToCardTitle}>
          <Row label={C.cardNumber} value={<span dir="ltr">{card.cardNumber}</span>} />
          {card.ownerName !== null ? <Row label={C.cardOwner} value={card.ownerName} /> : null}
          <Row label={C.transferAmount} value={<strong>{formatToman(card.amountToman)}</strong>} />
          <CopyValue value={card.cardNumber} />
          <p className="notice">{C.receiptHint}</p>
          <input
            type="file"
            accept="image/jpeg,image/png,application/pdf"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file === undefined) {
                setFileBase64(null);
                return;
              }
              const reader = new FileReader();
              reader.onload = () => {
                const result = typeof reader.result === "string" ? reader.result : "";
                setFileBase64(result.split(",")[1] ?? null);
              };
              reader.readAsDataURL(file);
            }}
          />
          <input
            className="form__input"
            value={receiptText}
            placeholder={C.receiptTextPlaceholder}
            onChange={(event) => setReceiptText(event.target.value)}
          />
          <button
            type="button"
            className="button"
            disabled={busy || (fileBase64 === null && receiptText.trim() === "")}
            onClick={() => {
              setBusy(true);
              setFailure(null);
              void submitReceipt(props.checkoutPublicId, {
                gatewayPublicId: card.gatewayPublicId,
                cardRef: card.cardRef,
                ...(fileBase64 !== null ? { fileBase64 } : {}),
                ...(receiptText.trim() !== "" ? { text: receiptText.trim() } : {}),
              }).then((result) => {
                setBusy(false);
                if (!result.ok) {
                  setFailure(result);
                  return;
                }
                props.onPayment(result.paymentPublicId);
              });
            }}
          >
            {C.submitReceipt}
          </button>
          {failure !== null ? <p className="notice">{failure.code}</p> : null}
        </Card>
      ) : (
        <Card title={C.paymentMethods}>
          {methods.length === 0 ? <p className="empty">{C.emptyList}</p> : null}
          <div className="actions">
            {methods.map((method: import("./commerce-api").PaymentMethodDto) => (
              <button
                key={method.publicId}
                type="button"
                className="button"
                disabled={busy}
                onClick={() => {
                  setFailure(null);
                  if (method.type === "CARD_TO_CARD") {
                    setBusy(true);
                    void fetchCardInfo(props.checkoutPublicId).then((result) => {
                      setBusy(false);
                      if (!result.ok) {
                        setFailure(result);
                        return;
                      }
                      setCard(result);
                    });
                    return;
                  }
                  setBusy(true);
                  void initGateway(props.checkoutPublicId, method.publicId).then((result) => {
                    setBusy(false);
                    if (!result.ok) {
                      setFailure(result);
                      return;
                    }
                    const target = result.redirectUrl ?? result.starsInvoiceLink;
                    if (target !== null) {
                      window.open(target, "_blank", "noopener");
                    }
                    props.onPayment(result.paymentPublicId);
                  });
                }}
              >
                {lookup(METHOD_TYPE_TEXT, method.type)} — {method.name}
              </button>
            ))}
          </div>
          {failure !== null ? <p className="notice">{failure.code}</p> : null}
        </Card>
      )}
    </div>
  );
}

// --- payment status polling ---------------------------------------------------------

function PaymentStatusScreen(props: { paymentPublicId: string; onBack: () => void }): ReactNode {
  const [tick, setTick] = useState(0);
  const load = useCallback(
    () => fetchPaymentStatus(props.paymentPublicId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.paymentPublicId, tick],
  );
  const { state, reload } = useResource(load);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (state.phase !== "loaded") return undefined;
    const status = state.data.payment.status;
    const terminal = ["APPROVED", "REJECTED", "FAILED", "EXPIRED", "CANCELLED"].includes(status);
    if (!terminal) {
      timer.current = setTimeout(() => setTick((value) => value + 1), 5000);
    }
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, [state]);

  if (state.phase === "loading") return <Spinner />;
  if (state.phase === "failed") return <Failure failure={state.failure} onRetry={reload} />;
  const { payment, orderPublicId, orderStatus, servicePublicId } = state.data;
  return (
    <div className="stack">
      <button type="button" className="button button--ghost" onClick={props.onBack}>
        {C.back}
      </button>
      <Card title={C.paymentStatusTitle}>
        <Row label={C.paymentStatusTitle} value={lookup(PAYMENT_STATUS_TEXT, payment.status)} />
        <Row label={C.finalPrice} value={formatToman(payment.amountToman)} />
        {orderStatus !== null ? <Row label={C.orderLink} value={lookup(ORDER_STATUS_TEXT, orderStatus)} /> : null}
        {payment.status === "APPROVED" ? <p className="notice">{C.provisioningNote}</p> : null}
        {payment.status === "PENDING_REVIEW" ? <p className="notice">{C.pendingReviewNote}</p> : null}
        <div className="actions">
          <button type="button" className="button button--ghost" onClick={reload}>
            {C.checkStatus}
          </button>
        </div>
        {servicePublicId !== null ? <Row label={C.serviceLink} value={<span dir="ltr">{servicePublicId}</span>} /> : null}
        {orderPublicId !== null ? <Row label={C.orderLink} value={<span dir="ltr">{orderPublicId}</span>} /> : null}
      </Card>
    </div>
  );
}

function PendingPaymentsScreen(props: { onOpen: (publicId: string) => void; onBack: () => void }): ReactNode {
  const load = useCallback(() => fetchPaymentsList(1), []);
  const { state, reload } = useResource(load);
  if (state.phase === "loading") return <Spinner />;
  if (state.phase === "failed") return <Failure failure={state.failure} onRetry={reload} />;
  const pending = state.data.payments.filter((payment) =>
    ["PENDING", "PENDING_REVIEW", "PROCESSING"].includes(payment.status),
  );
  return (
    <div className="stack">
      <button type="button" className="button button--ghost" onClick={props.onBack}>
        {C.back}
      </button>
      <Card title={C.pendingPayments}>
        {pending.length === 0 ? <p className="empty">{C.emptyList}</p> : null}
        {pending.map((payment) => (
          <button key={payment.publicId} type="button" className="txn" onClick={() => props.onOpen(payment.publicId)}>
            <span>{lookup(PAYMENT_STATUS_TEXT, payment.status)}</span>
            <strong>{formatToman(payment.amountToman)}</strong>
          </button>
        ))}
      </Card>
    </div>
  );
}

// --- top-up -----------------------------------------------------------------------

export function TopupScreen(props: { onCheckout: (checkoutPublicId: string) => void; onBack: () => void }): ReactNode {
  const [amount, setAmount] = useState("");
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const parsed = Number.parseInt(amount.replace(/[^0-9]/g, ""), 10);
  return (
    <div className="stack">
      <button type="button" className="button button--ghost" onClick={props.onBack}>
        {C.back}
      </button>
      <Card title={C.topupTitle}>
        <input
          className="form__input"
          dir="ltr"
          inputMode="numeric"
          value={amount}
          placeholder={C.topupAmount}
          onChange={(event) => setAmount(event.target.value)}
        />
        <button
          type="button"
          className="button"
          disabled={busy || !Number.isInteger(parsed) || parsed <= 0}
          onClick={() => {
            setBusy(true);
            setFailure(null);
            void createTopup(parsed).then((result) => {
              setBusy(false);
              if (!result.ok) {
                setFailure(result);
                return;
              }
              props.onCheckout(result.checkout.publicId);
            });
          }}
        >
          {C.topupCreate}
        </button>
        {failure !== null ? <p className="notice">{failure.code}</p> : null}
      </Card>
    </div>
  );
}

// --- orders / history ----------------------------------------------------------------

export type OrdersView =
  | { kind: "list" }
  | { kind: "order"; publicId: string }
  | { kind: "other-order"; publicId: string }
  | { kind: "payment"; publicId: string };

export function OrdersScreen(props: { view: OrdersView; onView: (view: OrdersView) => void }): ReactNode {
  const { view, onView } = props;
  if (view.kind === "order") {
    return <OrderDetailScreen publicId={view.publicId} onView={onView} />;
  }
  if (view.kind === "other-order") {
    return <OtherOrderDetailScreen publicId={view.publicId} onBack={() => onView({ kind: "list" })} />;
  }
  if (view.kind === "payment") {
    return <PaymentStatusScreen paymentPublicId={view.publicId} onBack={() => onView({ kind: "list" })} />;
  }
  return <HistoryList onView={onView} />;
}

function HistoryList(props: { onView: (view: OrdersView) => void }): ReactNode {
  const [page, setPage] = useState(1);
  const load = useCallback(() => fetchHistory(page), [page]);
  const { state, reload } = useResource(load);
  if (state.phase === "loading") return <Spinner />;
  if (state.phase === "failed") return <Failure failure={state.failure} onRetry={reload} />;
  const { items, pages } = state.data;
  return (
    <div className="stack">
      <Card title={C.historyTitle}>
        {items.length === 0 ? <p className="empty">{C.emptyList}</p> : null}
        {items.map((item) => (
          <button
            key={`${item.itemType}-${item.publicId}`}
            type="button"
            className="txn"
            onClick={() =>
              props.onView(
                item.itemType === "ORDER"
                  ? { kind: "order", publicId: item.publicId }
                  : { kind: "payment", publicId: item.publicId },
              )
            }
          >
            <span>
              {item.itemType === "ORDER"
                ? lookup(ORDER_STATUS_TEXT, item.status)
                : lookup(PAYMENT_STATUS_TEXT, item.status)}
            </span>
            <strong>{formatToman(item.amountToman)}</strong>
          </button>
        ))}
        {pages > 1 ? (
          <div className="actions">
            <button type="button" className="button button--ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              {C.prev}
            </button>
            <button type="button" className="button button--ghost" disabled={page >= pages} onClick={() => setPage(page + 1)}>
              {C.next}
            </button>
          </div>
        ) : null}
      </Card>
    </div>
  );
}

function OrderDetailScreen(props: { publicId: string; onView: (view: OrdersView) => void }): ReactNode {
  const load = useCallback(() => fetchOrderDetail(props.publicId), [props.publicId]);
  const { state, reload } = useResource(load);
  if (state.phase === "loading") return <Spinner />;
  if (state.phase === "failed") return <Failure failure={state.failure} onRetry={reload} />;
  const { order } = state.data;
  return (
    <div className="stack">
      <button type="button" className="button button--ghost" onClick={() => props.onView({ kind: "list" })}>
        {C.back}
      </button>
      <Card title={C.orderDetail}>
        {order.productName !== null ? <Row label={C.chooseProduct} value={order.productName} /> : null}
        <Row label={C.paymentStatusTitle} value={lookup(ORDER_STATUS_TEXT, order.status)} />
        <Row label={C.finalPrice} value={formatToman(order.amountToman)} />
        {order.reconciliationPending ? <p className="notice">{C.reconciliationPending}</p> : null}
        <div className="actions">
          {order.paymentPublicId !== null ? (
            <button type="button" className="button button--ghost" onClick={() => props.onView({ kind: "payment", publicId: order.paymentPublicId ?? "" })}>
              {C.paymentStatusTitle}
            </button>
          ) : null}
          {order.isOtherProduct ? (
            <button type="button" className="button button--ghost" onClick={() => props.onView({ kind: "other-order", publicId: order.publicId })}>
              {C.otherOrderDetail}
            </button>
          ) : null}
        </div>
      </Card>
    </div>
  );
}

function OtherOrderDetailScreen(props: { publicId: string; onBack: () => void }): ReactNode {
  const load = useCallback(() => fetchOtherOrderDetail(props.publicId), [props.publicId]);
  const { state, reload } = useResource(load);
  if (state.phase === "loading") return <Spinner />;
  if (state.phase === "failed") return <Failure failure={state.failure} onRetry={reload} />;
  const { order } = state.data;
  return (
    <div className="stack">
      <button type="button" className="button button--ghost" onClick={props.onBack}>
        {C.back}
      </button>
      <Card title={C.otherOrderDetail}>
        {order.productName !== null ? <Row label={C.chooseProduct} value={order.productName} /> : null}
        <Row label={C.paymentStatusTitle} value={lookup(OTHER_ORDER_STATUS_TEXT, order.displayStatus)} />
        {order.deliveredText !== null ? (
          <div>
            <p className="row__key">{C.deliveredContent}</p>
            <p className="notice" dir="auto">
              {order.deliveredText}
            </p>
          </div>
        ) : null}
        {order.deliveredStock !== null ? (
          <div>
            <p className="row__key">{C.deliveredContent}</p>
            <p className="notice" dir="ltr">
              {order.deliveredStock}
            </p>
            <CopyValue value={order.deliveredStock} />
          </div>
        ) : null}
      </Card>
    </div>
  );
}

// --- customer input form ---------------------------------------------------------------

function InputFormScreen(props: { checkoutPublicId: string; onDone: () => void; onBack: () => void }): ReactNode {
  const load = useCallback(() => fetchInputForm(props.checkoutPublicId), [props.checkoutPublicId]);
  const { state, reload } = useResource(load);
  const [values, setValues] = useState<Record<string, string>>({});
  const [step, setStep] = useState(0);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  if (state.phase === "loading") return <Spinner />;
  if (state.phase === "failed") return <Failure failure={state.failure} onRetry={reload} />;
  const { input } = state.data;
  if (submitted || input.status === "SUBMITTED" || input.status === "CONSUMED") {
    return (
      <Card title={C.inputFormTitle}>
        <p className="notice">{C.inputSubmitted}</p>
        {input.maskedSummary !== null ? <p dir="auto">{input.maskedSummary}</p> : null}
        <button type="button" className="button" onClick={props.onDone}>
          {C.continueLabel}
        </button>
      </Card>
    );
  }
  const fields = input.fields;
  const reviewing = step >= fields.length;
  const field = reviewing ? null : fields[step];
  return (
    <div className="stack">
      <button type="button" className="button button--ghost" onClick={props.onBack}>
        {C.back}
      </button>
      <Card title={C.inputFormTitle}>
        {field !== null ? (
          <div className="form">
            <p className="row__key">
              {field.label} ({field.required ? C.inputRequired : C.inputOptional})
            </p>
            {field.options !== null && field.options.length > 0 ? (
              <select
                className="form__input"
                value={values[field.key] ?? ""}
                onChange={(event) => setValues({ ...values, [field.key]: event.target.value })}
              >
                <option value="" />
                {field.options.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className="form__input"
                dir="auto"
                value={values[field.key] ?? ""}
                onChange={(event) => setValues({ ...values, [field.key]: event.target.value })}
              />
            )}
            <div className="actions">
              <button type="button" className="button button--ghost" disabled={step === 0} onClick={() => setStep(step - 1)}>
                {C.inputBack}
              </button>
              {!field.required ? (
                <button
                  type="button"
                  className="button button--ghost"
                  onClick={() => {
                    const next = { ...values };
                    delete next[field.key];
                    setValues(next);
                    setStep(step + 1);
                  }}
                >
                  {C.inputSkip}
                </button>
              ) : null}
              <button
                type="button"
                className="button"
                disabled={field.required && (values[field.key] ?? "").trim() === ""}
                onClick={() => setStep(step + 1)}
              >
                {C.inputNext}
              </button>
            </div>
          </div>
        ) : (
          <div>
            <p className="row__key">{C.inputReview}</p>
            {fields.map((reviewField) => (
              <Row
                key={reviewField.key}
                label={reviewField.label}
                value={
                  (values[reviewField.key] ?? "") === ""
                    ? "—"
                    : "•".repeat(Math.min(8, (values[reviewField.key] ?? "").length))
                }
              />
            ))}
            <div className="actions">
              <button type="button" className="button button--ghost" onClick={() => setStep(0)}>
                {C.inputBack}
              </button>
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  setFailure(null);
                  void submitInputForm(props.checkoutPublicId, values).then((result) => {
                    setBusy(false);
                    if (!result.ok) {
                      setFailure(result);
                      return;
                    }
                    setSubmitted(true);
                  });
                }}
              >
                {C.inputSubmit}
              </button>
            </div>
            {failure !== null ? <p className="notice">{failure.code}</p> : null}
          </div>
        )}
      </Card>
    </div>
  );
}

// --- service detail extensions (delivery + add-ons) --------------------------------------

export function DeliverySection(props: { servicePublicId: string }): ReactNode {
  const load = useCallback(() => fetchDelivery(props.servicePublicId), [props.servicePublicId]);
  const { state, reload } = useResource(load);
  if (state.phase === "loading") return <Spinner />;
  if (state.phase === "failed") {
    // A disabled switch simply hides the section; other failures offer retry.
    if (state.failure.code === "FEATURE_DISABLED") return null;
    return <Failure failure={state.failure} onRetry={reload} />;
  }
  const { delivery } = state.data;
  return (
    <Card title={C.deliveryTitle}>
      {delivery.subscriptionUrl !== null ? (
        <div>
          <p className="row__key">{C.subscriptionLink}</p>
          <p className="notice" dir="ltr">
            {delivery.subscriptionUrl}
          </p>
          <CopyValue value={delivery.subscriptionUrl} />
          <p className="row__key">{C.qrCode}</p>
          <img src={qrImageUrl(props.servicePublicId, "sub")} alt={C.qrCode} width={200} height={200} />
        </div>
      ) : null}
      {delivery.configLinks.length > 0 ? (
        <div>
          <p className="row__key">{C.configs}</p>
          {delivery.configLinks.map((link, index) => (
            <div key={link}>
              <p className="notice" dir="ltr">
                {link}
              </p>
              <CopyValue value={link} />
              <img src={qrImageUrl(props.servicePublicId, "config", index)} alt={C.qrCode} width={160} height={160} />
            </div>
          ))}
        </div>
      ) : null}
    </Card>
  );
}

export function AddonsSection(props: {
  servicePublicId: string;
  onPayment: (paymentPublicId: string) => void;
  onCheckout: (checkoutPublicId: string) => void;
}): ReactNode {
  const load = useCallback(() => fetchAddons(props.servicePublicId), [props.servicePublicId]);
  const { state, reload } = useResource(load);
  const [quote, setQuote] = useState<Awaited<ReturnType<typeof fetchAddonQuote>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);

  if (state.phase === "loading") return <Spinner />;
  if (state.phase === "failed") {
    if (state.failure.code === "FEATURE_DISABLED") return null;
    return <Failure failure={state.failure} onRetry={reload} />;
  }
  const { addons } = state.data;
  const sections: Array<{ kind: "RENEWAL" | "EXTRA_VOLUME" | "EXTRA_TIME"; title: string }> = [
    { kind: "RENEWAL", title: C.renew },
    { kind: "EXTRA_VOLUME", title: C.extraVolume },
    { kind: "EXTRA_TIME", title: C.extraTime },
  ];

  if (quote !== null && quote.ok) {
    const q = quote.quote;
    return (
      <Card title={C.preInvoice}>
        <Row label={C.chooseProduct} value={q.productName} />
        <Row label={C.finalPrice} value={<strong>{formatToman(q.finalPriceToman)}</strong>} />
        <div className="actions">
          {q.walletPayEnabled ? (
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void payWallet(q.draftToken).then((result) => {
                  setBusy(false);
                  if (!result.ok) {
                    setFailure(result);
                    return;
                  }
                  if (result.paymentPublicId !== null) props.onPayment(result.paymentPublicId);
                });
              }}
            >
              {C.payWithWallet}
            </button>
          ) : null}
          <button
            type="button"
            className="button button--ghost"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void confirmCheckout(q.draftToken).then((result) => {
                setBusy(false);
                if (!result.ok) {
                  setFailure(result);
                  return;
                }
                props.onCheckout(result.checkout.publicId);
              });
            }}
          >
            {C.goToPayment}
          </button>
          <button type="button" className="button button--ghost" onClick={() => setQuote(null)}>
            {C.back}
          </button>
        </div>
        {failure !== null ? <p className="notice">{failure.code}</p> : null}
      </Card>
    );
  }

  return (
    <Card title={C.addonsTitle}>
      {sections.map((section) => {
        const addon = addons[section.kind];
        if (!addon.enabled) return null;
        return (
          <div key={section.kind}>
            <p className="row__key">{section.title}</p>
            {!addon.eligible || addon.plans.length === 0 ? (
              <p className="empty">{C.notEligible}</p>
            ) : (
              addon.plans.map((plan) => (
                <ProductRow
                  key={plan.publicId}
                  product={plan}
                  onSelect={() => {
                    setBusy(true);
                    setFailure(null);
                    void fetchAddonQuote(props.servicePublicId, {
                      kind: section.kind,
                      productPublicId: plan.publicId,
                    }).then((result) => {
                      setBusy(false);
                      if (!result.ok) {
                        setFailure(result);
                        return;
                      }
                      setQuote(result);
                    });
                  }}
                />
              ))
            )}
          </div>
        );
      })}
      {busy ? <p className="notice">{C.loadingMore}</p> : null}
      {failure !== null ? <p className="notice">{failure.code}</p> : null}
    </Card>
  );
}
