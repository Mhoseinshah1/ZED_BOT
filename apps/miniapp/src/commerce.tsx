import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import type { ApiFailure } from "./api";
import {
  fetchAddonQuote,
  fetchAddons,
  fetchCatalog,
  fetchDelivery,
  fetchHistory,
  fetchOrderDetail,
  fetchPaymentStatus,
  fetchQuote,
  payWallet,
  qrImageUrl,
  type CatalogPanelDto,
  type CatalogProductDto,
  type QuoteDto,
} from "./commerce-api";
import { Card, FailureScreen, Row, Spinner } from "./components";
import { formatToman } from "./format";
import { COMMERCE_UI as C, ORDER_STATUS_TEXT, PAYMENT_STATUS_TEXT, lookup } from "./i18n";
import { useResource } from "./screens";

export interface CommerceFlags {
  commerce: boolean;
  checkout: boolean;
  walletPurchase: boolean;
  walletTopup: false;
  cardToCard: false;
  onlinePayments: false;
  serviceDelivery: boolean;
  serviceRenewal: boolean;
  extraVolume: boolean;
  extraTime: boolean;
  otherProducts: false;
}

export function flagsFromResponse(raw: Record<string, boolean> | undefined): CommerceFlags {
  const flags = raw ?? {};
  return {
    commerce: flags.miniapp_commerce_browse_enabled === true,
    checkout: flags.miniapp_commerce_checkout_enabled === true,
    walletPurchase: flags.miniapp_wallet_purchase_enabled === true,
    walletTopup: false,
    cardToCard: false,
    onlinePayments: false,
    serviceDelivery: flags.miniapp_commerce_browse_enabled === true,
    serviceRenewal: flags.miniapp_wallet_renewal_enabled === true,
    extraVolume: flags.miniapp_wallet_addons_enabled === true,
    extraTime: flags.miniapp_wallet_addons_enabled === true,
    otherProducts: false,
  };
}

function Failure({ failure, retry }: { failure: ApiFailure; retry?: () => void }) {
  return <FailureScreen failure={failure} onRetry={retry} />;
}

function Copy({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return <button type="button" className="button button--ghost" onClick={() => {
    void navigator.clipboard?.writeText(value).then(() => setCopied(true));
  }}>{copied ? C.copied : C.copy}</button>;
}

export type BuyView =
  | { kind: "hub" }
  | { kind: "catalog"; mode: "service" | "pricing" }
  | { kind: "purchase"; product: CatalogProductDto; panel: CatalogPanelDto }
  | { kind: "payment"; paymentPublicId: string };

export function BuyScreen(props: {
  flags: CommerceFlags;
  view: BuyView;
  onView: (view: BuyView) => void;
  onOrders: () => void;
}): ReactNode {
  if (!props.flags.commerce) return <Card title={C.buyTitle}><p className="empty">{C.notEligible}</p></Card>;
  if (props.view.kind === "hub") return <Card title={C.buyTitle}><div className="actions">
    <button type="button" className="button" disabled={!props.flags.checkout} onClick={() => props.onView({ kind: "catalog", mode: "service" })}>{C.buySubscription}</button>
    <button type="button" className="button button--ghost" onClick={() => props.onView({ kind: "catalog", mode: "pricing" })}>{C.pricing}</button>
    <button type="button" className="button button--ghost" onClick={props.onOrders}>{C.recentOrders}</button>
  </div></Card>;
  if (props.view.kind === "catalog") return <Catalog mode={props.view.mode} checkoutEnabled={props.flags.checkout} back={() => props.onView({ kind: "hub" })} select={(product, panel) => props.onView({ kind: "purchase", product, panel })} />;
  if (props.view.kind === "purchase") return <Purchase product={props.view.product} panel={props.view.panel} checkoutEnabled={props.flags.checkout} walletPurchaseEnabled={props.flags.walletPurchase} back={() => props.onView({ kind: "catalog", mode: "service" })} paid={paymentPublicId => props.onView({ kind: "payment", paymentPublicId })} />;
  return <PaymentStatus paymentPublicId={props.view.paymentPublicId} back={() => props.onView({ kind: "hub" })} />;
}

function Catalog(props: { mode: "service" | "pricing"; checkoutEnabled: boolean; back: () => void; select: (product: CatalogProductDto, panel: CatalogPanelDto) => void }) {
  const { state, reload } = useResource(useCallback(() => fetchCatalog(), []));
  if (state.phase === "loading") return <Spinner />;
  if (state.phase === "failed") return <Failure failure={state.failure} retry={reload} />;
  return <div className="stack"><button type="button" className="button button--ghost" onClick={props.back}>{C.back}</button>
    {state.data.servicePanels.map(panel => <Card key={panel.publicId} title={panel.name}>
      {panel.categories.map(category => <section key={category.publicId}><h3>{category.name}</h3>
        {category.products.map(product => <button key={product.publicId} type="button" className="txn" disabled={props.mode === "pricing" || !props.checkoutEnabled} onClick={() => props.select(product, panel)}>
          <span>{product.name}</span><strong>{formatToman(product.priceToman)}</strong>
        </button>)}
      </section>)}
    </Card>)}
  </div>;
}

function AuthoritativeQuote(props: { quote: QuoteDto; busy: boolean; walletCapabilityEnabled?: boolean; pay: () => void }) {
  return <Card title={C.preInvoice}>
    <Row label={C.chooseProduct} value={props.quote.productName} />
    {props.quote.username !== null ? <Row label={C.usernameStep} value={props.quote.username} /> : null}
    <Row label={C.originalPrice} value={formatToman(props.quote.originalPriceToman)} />
    {props.quote.discountAmountToman > 0 ? <Row label={C.discountAmount} value={formatToman(props.quote.discountAmountToman)} /> : null}
    <Row label={C.finalPrice} value={<strong>{formatToman(props.quote.finalPriceToman)}</strong>} />
    <button type="button" className="button" disabled={props.busy || props.walletCapabilityEnabled === false || !props.quote.walletPayEnabled} onClick={props.pay}>{C.payWithWallet}</button>
  </Card>;
}

function Purchase(props: { product: CatalogProductDto; panel: CatalogPanelDto; checkoutEnabled: boolean; walletPurchaseEnabled: boolean; back: () => void; paid: (id: string) => void }) {
  const [mode, setMode] = useState<"RANDOM" | "CUSTOM">("RANDOM");
  const [username, setUsername] = useState("");
  const [discount, setDiscount] = useState("");
  const [quote, setQuote] = useState<QuoteDto | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);

  const makeQuote = async () => {
    if (locked.current) return;
    locked.current = true; setBusy(true); setFailure(null);
    const result = await fetchQuote({ kind: "SERVICE", productPublicId: props.product.publicId, usernameMode: mode, ...(mode === "CUSTOM" ? { username } : {}), ...(discount.trim() !== "" ? { discountCode: discount.trim() } : {}) });
    locked.current = false; setBusy(false);
    if (!result.ok) setFailure(result); else setQuote(result.quote);
  };
  const pay = async () => {
    if (quote === null || locked.current) return;
    locked.current = true; setBusy(true); setFailure(null);
    const result = await payWallet(quote.draftToken);
    locked.current = false; setBusy(false);
    if (!result.ok) setFailure(result); else if (result.paymentPublicId !== null) props.paid(result.paymentPublicId);
  };
  return <div className="stack"><button type="button" className="button button--ghost" onClick={props.back}>{C.back}</button>
    {quote === null ? <Card title={C.usernameStep}>
      <Row label={C.chooseProduct} value={props.product.name} /><Row label={C.finalPrice} value={formatToman(props.product.priceToman)} />
      <select className="form__input" value={mode} onChange={event => setMode(event.target.value as "RANDOM" | "CUSTOM")}><option value="RANDOM">{C.usernameRandom}</option><option value="CUSTOM">{C.usernameCustom}</option></select>
      {mode === "CUSTOM" ? <input className="form__input" dir="ltr" value={username} onChange={event => setUsername(event.target.value)} /> : null}
      <input className="form__input" dir="ltr" value={discount} placeholder={C.discountLabel} onChange={event => setDiscount(event.target.value)} />
      <button type="button" className="button" disabled={!props.checkoutEnabled || busy || (mode === "CUSTOM" && username.trim() === "")} onClick={() => void makeQuote()}>{C.preInvoice}</button>
    </Card> : <AuthoritativeQuote quote={quote} busy={busy} walletCapabilityEnabled={props.walletPurchaseEnabled} pay={() => void pay()} />}
    {failure !== null ? <Failure failure={failure} retry={() => setFailure(null)} /> : null}
  </div>;
}

function PaymentStatus(props: { paymentPublicId: string; back: () => void }) {
  const [tick, setTick] = useState(0);
  const { state, reload } = useResource(useCallback(() => fetchPaymentStatus(props.paymentPublicId), [props.paymentPublicId, tick]));
  useEffect(() => {
    if (state.phase !== "loaded" || ["APPROVED", "REJECTED", "FAILED", "EXPIRED", "CANCELLED"].includes(state.data.payment.status)) return;
    const timer = setTimeout(() => setTick(value => value + 1), 5000);
    return () => clearTimeout(timer);
  }, [state]);
  if (state.phase === "loading") return <Spinner />;
  if (state.phase === "failed") return <Failure failure={state.failure} retry={reload} />;
  return <div className="stack"><button type="button" className="button button--ghost" onClick={props.back}>{C.back}</button><Card title={C.paymentStatusTitle}>
    <Row label={C.paymentStatusTitle} value={lookup(PAYMENT_STATUS_TEXT, state.data.payment.status)} />
    <Row label={C.finalPrice} value={formatToman(state.data.payment.amountToman)} />
    {state.data.orderStatus !== null ? <Row label={C.orderLink} value={lookup(ORDER_STATUS_TEXT, state.data.orderStatus)} /> : null}
    {state.data.orderStatus === "PAID" || state.data.orderStatus === "PROVISIONING" ? <p className="notice">{C.provisioningNote}</p> : null}
    {state.data.orderStatus === "PROVISIONING" ? <p className="notice">{C.reconciliationPending}</p> : null}
  </Card></div>;
}

export type OrdersView = { kind: "list" } | { kind: "order"; publicId: string } | { kind: "payment"; publicId: string };

export function OrdersScreen(props: { view: OrdersView; onView: (view: OrdersView) => void }) {
  if (props.view.kind === "order") return <OrderDetail id={props.view.publicId} back={() => props.onView({ kind: "list" })} payment={id => props.onView({ kind: "payment", publicId: id })} />;
  if (props.view.kind === "payment") return <PaymentStatus paymentPublicId={props.view.publicId} back={() => props.onView({ kind: "list" })} />;
  return <History open={id => props.onView({ kind: "order", publicId: id })} />;
}

function History({ open }: { open: (id: string) => void }) {
  const [page, setPage] = useState(1);
  const { state, reload } = useResource(useCallback(() => fetchHistory(page), [page]));
  if (state.phase === "loading") return <Spinner />;
  if (state.phase === "failed") return <Failure failure={state.failure} retry={reload} />;
  return <Card title={C.historyTitle}>{state.data.items.map(item => <button key={item.publicId} type="button" className="txn" onClick={() => open(item.publicId)}><span>{lookup(ORDER_STATUS_TEXT, item.status)}</span><strong>{formatToman(item.amountToman)}</strong></button>)}
    <div className="actions"><button type="button" className="button button--ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>{C.prev}</button><button type="button" className="button button--ghost" disabled={page >= state.data.pages} onClick={() => setPage(page + 1)}>{C.next}</button></div>
  </Card>;
}

function OrderDetail(props: { id: string; back: () => void; payment: (id: string) => void }) {
  const { state, reload } = useResource(useCallback(() => fetchOrderDetail(props.id), [props.id]));
  if (state.phase === "loading") return <Spinner />;
  if (state.phase === "failed") return <Failure failure={state.failure} retry={reload} />;
  const order = state.data.order;
  return <div className="stack"><button type="button" className="button button--ghost" onClick={props.back}>{C.back}</button><Card title={C.orderDetail}>
    {order.productName !== null ? <Row label={C.chooseProduct} value={order.productName} /> : null}<Row label={C.paymentStatusTitle} value={lookup(ORDER_STATUS_TEXT, order.status)} /><Row label={C.finalPrice} value={formatToman(order.amountToman)} />
    {order.reconciliationPending ? <p className="notice">{C.reconciliationPending}</p> : null}
    {order.paymentPublicId !== null ? <button type="button" className="button button--ghost" onClick={() => props.payment(order.paymentPublicId!)}>{C.paymentStatusTitle}</button> : null}
  </Card></div>;
}

export function DeliverySection({ servicePublicId }: { servicePublicId: string }) {
  const { state, reload } = useResource(useCallback(() => fetchDelivery(servicePublicId), [servicePublicId]));
  if (state.phase === "loading") return <Spinner />;
  if (state.phase === "failed") return state.failure.code === "FEATURE_DISABLED" ? null : <Failure failure={state.failure} retry={reload} />;
  const delivery = state.data.delivery;
  return <Card title={C.deliveryTitle}><Row label={C.usernameStep} value={delivery.username} />
    {delivery.subscriptionUrl !== null ? <div><p dir="ltr">{delivery.subscriptionUrl}</p><Copy value={delivery.subscriptionUrl} /><img src={qrImageUrl(servicePublicId, "sub")} alt={C.qrCode} width={160} height={160} /></div> : null}
    {delivery.configLinks.map((link, index) => <div key={link}><p dir="ltr">{link}</p><Copy value={link} /><img src={qrImageUrl(servicePublicId, "config", index)} alt={C.qrCode} width={160} height={160} /></div>)}
  </Card>;
}

export function AddonsSection(props: { servicePublicId: string; checkoutEnabled: boolean; renewalEnabled: boolean; addonsEnabled: boolean; onPayment: (id: string) => void }) {
  const { state, reload } = useResource(useCallback(() => fetchAddons(props.servicePublicId), [props.servicePublicId]));
  const [quote, setQuote] = useState<Awaited<ReturnType<typeof fetchAddonQuote>> | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const locked = useRef(false);
  if (state.phase === "loading") return <Spinner />;
  if (state.phase === "failed") return state.failure.code === "FEATURE_DISABLED" ? null : <Failure failure={state.failure} retry={reload} />;
  if (quote?.ok) return <div className="stack"><AuthoritativeQuote quote={{ ...quote.quote, productName: quote.quote.productName, panelName: null, note: null, discountStackingRejected: false, needsCustomerInputBeforePayment: false }} busy={locked.current} walletCapabilityEnabled={quote.quote.kind === "RENEWAL" ? props.renewalEnabled : props.addonsEnabled} pay={() => {
    if (locked.current) return; locked.current = true;
    void payWallet(quote.quote.draftToken).then(result => { locked.current = false; if (!result.ok) setFailure(result); else if (result.paymentPublicId !== null) props.onPayment(result.paymentPublicId); });
  }} />{failure !== null ? <Failure failure={failure} /> : null}</div>;
  const labels: Record<string, string> = { RENEWAL: C.renew, EXTRA_VOLUME: C.extraVolume, EXTRA_TIME: C.extraTime };
  return <div className="stack">{Object.entries(state.data.addons).map(([kind, section]) => section.enabled && section.eligible ? <Card key={kind} title={labels[kind] ?? kind}>{section.plans.map(plan => <button key={plan.publicId} type="button" className="txn" disabled={!props.checkoutEnabled} onClick={() => { if (locked.current) return; locked.current = true; void fetchAddonQuote(props.servicePublicId, { kind: kind as "RENEWAL" | "EXTRA_VOLUME" | "EXTRA_TIME", productPublicId: plan.publicId }).then(result => { locked.current = false; if (!result.ok) setFailure(result); else setQuote(result); }); }}><span>{plan.name}</span><strong>{formatToman(plan.priceToman)}</strong></button>)}</Card> : null)}{failure !== null ? <Failure failure={failure} /> : null}</div>;
}
