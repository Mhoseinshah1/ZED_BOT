import { useCallback, useEffect, useState, type ReactNode } from "react";

import {
  fetchDashboard,
  fetchService,
  fetchServices,
  fetchTransactions,
  logout,
  type ApiFailure,
  type DashboardDto,
  type ServiceDetailDto,
  type ServiceSummaryDto,
  type TransactionDto,
  type UserDto,
} from "./api";
import {
  Card,
  FailureScreen,
  Row,
  ServiceCard,
  Spinner,
  Stat,
  StatusBadge,
  UsageBar,
} from "./components";
import {
  daysUntil,
  displayName,
  formatBytes,
  formatDate,
  formatSignedToman,
  formatToman,
} from "./format";
import { lookup, SERVICE_SOURCE_TEXT, UI, USER_GROUP_TEXT, WALLET_TYPE_TEXT } from "./i18n";

// =============================================================================
// Screens.
//
// Read-only, all of them. There is no form, no mutation and no button that
// changes anything a user owns - the only action in the whole app is signing
// out, which destroys a cookie. Purchases, renewals, payments and support all
// stay in the bot, and the notice at the bottom of the dashboard says so rather
// than leaving the user hunting for a button that does not exist.
//
// Every screen handles three states explicitly: loading, failed, loaded. A
// screen that renders "0 services" while a request is still in flight tells the
// user something false, so the loading state is never skipped.
// =============================================================================

type LoadState<T> =
  | { phase: "loading" }
  | { phase: "failed"; failure: ApiFailure }
  | { phase: "loaded"; data: T };

/**
 * Runs a fetch on mount and re-runs it on demand.
 *
 * `load` must be stable (a module-level function or a `useCallback`), because
 * it is a dependency of the effect: a function rebuilt on every render would
 * refetch on every render.
 */
function useResource<T>(load: () => Promise<({ ok: true } & T) | ApiFailure>): {
  state: LoadState<T>;
  reload: () => void;
} {
  const [state, setState] = useState<LoadState<T>>({ phase: "loading" });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ phase: "loading" });
    void load().then((result) => {
      // A response that arrives after the component moved on must not write
      // into state: it would paint one screen's data under another's header.
      if (cancelled) {
        return;
      }
      setState(
        result.ok
          ? { phase: "loaded", data: result as unknown as T }
          : { phase: "failed", failure: result },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [load, nonce]);

  return { state, reload: useCallback(() => setNonce((n) => n + 1), []) };
}

// --- 1. splash ---------------------------------------------------------------

export function SplashScreen(): ReactNode {
  return <Spinner label={UI.loading} />;
}

// --- 2. outside Telegram -----------------------------------------------------

export function OutsideTelegramScreen(): ReactNode {
  return (
    <div className="center">
      <h1 className="center__title">{UI.outsideTelegram}</h1>
      <p className="center__body">{UI.outsideTelegramBody}</p>
    </div>
  );
}

// --- 3. dashboard ------------------------------------------------------------

export function DashboardScreen(props: { onOpenService: (id: string) => void }): ReactNode {
  const { state, reload } = useResource<DashboardDto>(fetchDashboard);
  if (state.phase === "loading") {
    return <SplashScreen />;
  }
  if (state.phase === "failed") {
    return <FailureScreen failure={state.failure} onRetry={reload} />;
  }
  const data = state.data;
  const active = data.services.byStatus.ACTIVE ?? 0;
  return (
    <>
      <Card>
        <div className="balance">
          <div className="balance__label">{UI.balance}</div>
          <div className="balance__value">{formatToman(data.wallet.balanceToman)}</div>
        </div>
      </Card>

      <div className="stats">
        <Stat value={data.services.total} label={UI.servicesTotal} />
        <Stat value={active} label={UI.servicesActive} />
        <Stat value={data.services.expiringWithin7Days} label={UI.expiringSoon} />
      </div>

      <h2 className="card__title">{UI.recentServices}</h2>
      {data.services.recent.length === 0 ? (
        <p className="empty">{UI.empty}</p>
      ) : (
        data.services.recent.map((service) => (
          <ServiceCard key={service.id} service={service} onOpen={props.onOpenService} />
        ))
      )}

      <Card title={UI.recentTransactions}>
        {data.wallet.recentTransactions.length === 0 ? (
          <p className="empty">{UI.empty}</p>
        ) : (
          <div className="list">
            {data.wallet.recentTransactions.map((txn) => (
              <TransactionRow key={txn.id} transaction={txn} />
            ))}
          </div>
        )}
      </Card>

      <p className="notice">{UI.readOnlyNotice}</p>
    </>
  );
}

// --- 4. services list --------------------------------------------------------

export function ServicesScreen(props: { onOpenService: (id: string) => void }): ReactNode {
  const [items, setItems] = useState<ServiceSummaryDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [loading, setLoading] = useState(true);

  const loadPage = useCallback(async (after: string | null, reset: boolean) => {
    setLoading(true);
    const result = await fetchServices(after);
    setLoading(false);
    if (!result.ok) {
      setFailure(result);
      return;
    }
    setFailure(null);
    // Appended, never merged by id: the keyset cursor guarantees the next page
    // starts strictly after the last row shown, so pages cannot overlap.
    setItems((previous) => (reset ? result.items : [...previous, ...result.items]));
    setCursor(result.nextCursor);
    setDone(result.nextCursor === null);
  }, []);

  useEffect(() => {
    void loadPage(null, true);
  }, [loadPage]);

  if (failure !== null && items.length === 0) {
    return <FailureScreen failure={failure} onRetry={() => void loadPage(null, true)} />;
  }
  if (loading && items.length === 0) {
    return <SplashScreen />;
  }
  return (
    <>
      {items.length === 0 ? (
        <p className="empty">{UI.empty}</p>
      ) : (
        items.map((service) => (
          <ServiceCard key={service.id} service={service} onOpen={props.onOpenService} />
        ))
      )}
      {!done ? (
        <button
          type="button"
          className="button button--ghost"
          disabled={loading}
          onClick={() => void loadPage(cursor, false)}
        >
          {loading ? UI.loading : UI.loadMore}
        </button>
      ) : null}
      <p className="notice">{UI.readOnlyNotice}</p>
    </>
  );
}

// --- 5. service detail -------------------------------------------------------

export function ServiceDetailScreen(props: { serviceId: string }): ReactNode {
  const load = useCallback(() => fetchService(props.serviceId), [props.serviceId]);
  const { state, reload } = useResource<{ service: ServiceDetailDto }>(load);
  if (state.phase === "loading") {
    return <SplashScreen />;
  }
  if (state.phase === "failed") {
    return <FailureScreen failure={state.failure} onRetry={reload} />;
  }
  const service = state.data.service;
  const remainingDays = daysUntil(service.expiresAt);
  return (
    <>
      <Card>
        <div className="row">
          <span className="row__value">{service.productName ?? service.username}</span>
          <StatusBadge status={service.status} />
        </div>
        <UsageBar used={service.usedBytes} total={service.volumeBytes} />
      </Card>

      <Card>
        <div className="rows">
          <Row label={UI.serviceUsername} value={service.username} />
          <Row label={UI.panel} value={service.panelName ?? "—"} />
          <Row label={UI.location} value={service.location} />
          <Row label={UI.origin} value={lookup(SERVICE_SOURCE_TEXT, service.source)} />
          <Row label={UI.volume} value={<UsageValue raw={service.volumeBytes} />} />
          <Row label={UI.remaining} value={<UsageValue raw={service.remainingBytes} />} />
          <Row
            label={UI.duration}
            value={
              service.durationDays === 0 ? UI.neverExpires : `${service.durationDays} ${UI.days}`
            }
          />
          <Row label={UI.startsAt} value={formatDate(service.startsAt)} />
          <Row
            label={UI.expiresAt}
            value={
              service.expiresAt === null
                ? UI.neverExpires
                : `${formatDate(service.expiresAt)}${
                    remainingDays !== null && remainingDays >= 0
                      ? ` (${remainingDays} ${UI.days})`
                      : ""
                  }`
            }
          />
          <Row
            label={UI.firstConnected}
            value={
              service.firstConnectedAt === null
                ? UI.notConnectedYet
                : formatDate(service.firstConnectedAt)
            }
          />
          <Row
            label={UI.lastConnected}
            value={
              service.lastConnectedAt === null
                ? UI.notConnectedYet
                : formatDate(service.lastConnectedAt)
            }
          />
          {service.userNote !== null && service.userNote !== "" ? (
            <Row label={UI.note} value={service.userNote} />
          ) : null}
          <Row label={UI.createdAt} value={formatDate(service.createdAt)} />
        </div>
      </Card>

      {/*
        No subscription link, no QR, no config list. Those ARE the service - the
        API does not send them, and the place to get them is the bot, where the
        existing delivery flow already handles them.
      */}
      <p className="notice">{UI.readOnlyNotice}</p>
    </>
  );
}

/** Zero means "no quota configured", which the product sells as unlimited. */
function UsageValue(props: { raw: string }): ReactNode {
  return <>{props.raw === "0" ? "نامحدود" : formatBytes(props.raw)}</>;
}

// --- 6. wallet ---------------------------------------------------------------

export function WalletScreen(): ReactNode {
  const [items, setItems] = useState<TransactionDto[]>([]);
  const [balance, setBalance] = useState<number | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [loading, setLoading] = useState(true);

  const loadPage = useCallback(async (after: string | null, reset: boolean) => {
    setLoading(true);
    const result = await fetchTransactions(after);
    setLoading(false);
    if (!result.ok) {
      setFailure(result);
      return;
    }
    setFailure(null);
    setBalance(result.balanceToman);
    setItems((previous) => (reset ? result.items : [...previous, ...result.items]));
    setCursor(result.nextCursor);
    setDone(result.nextCursor === null);
  }, []);

  useEffect(() => {
    void loadPage(null, true);
  }, [loadPage]);

  if (failure !== null && items.length === 0 && balance === null) {
    return <FailureScreen failure={failure} onRetry={() => void loadPage(null, true)} />;
  }
  if (loading && balance === null) {
    return <SplashScreen />;
  }
  return (
    <>
      <Card>
        <div className="balance">
          <div className="balance__label">{UI.balance}</div>
          <div className="balance__value">{formatToman(balance ?? 0)}</div>
        </div>
      </Card>
      <Card title={UI.recentTransactions}>
        {items.length === 0 ? (
          <p className="empty">{UI.empty}</p>
        ) : (
          <div className="list">
            {items.map((txn) => (
              <TransactionRow key={txn.id} transaction={txn} />
            ))}
          </div>
        )}
      </Card>
      {!done ? (
        <button
          type="button"
          className="button button--ghost"
          disabled={loading}
          onClick={() => void loadPage(cursor, false)}
        >
          {loading ? UI.loading : UI.loadMore}
        </button>
      ) : null}
      <p className="notice">{UI.readOnlyNotice}</p>
    </>
  );
}

function TransactionRow(props: { transaction: TransactionDto }): ReactNode {
  const { transaction } = props;
  const credit = transaction.amountToman >= 0;
  return (
    <div className="txn">
      <div>
        <div>{lookup(WALLET_TYPE_TEXT, transaction.type)}</div>
        <div className="txn__meta">{formatDate(transaction.createdAt)}</div>
      </div>
      <div className={`txn__amount ${credit ? "txn__amount--credit" : "txn__amount--debit"}`}>
        {formatSignedToman(transaction.amountToman)}
      </div>
    </div>
  );
}

// --- 7. profile --------------------------------------------------------------

export function ProfileScreen(props: { user: UserDto; onSignedOut: () => void }): ReactNode {
  const [busy, setBusy] = useState(false);
  const { user } = props;
  return (
    <>
      <Card>
        <div className="balance">
          <div className="balance__value">{displayName(user)}</div>
          <div className="balance__label">
            {user.username === null || user.username === "" ? UI.noUsername : `@${user.username}`}
          </div>
        </div>
      </Card>
      <Card>
        <div className="rows">
          <Row label={UI.accountGroup} value={lookup(USER_GROUP_TEXT, user.group)} />
          <Row label={UI.accountStatus} value={user.status === "ACTIVE" ? "فعال" : user.status} />
          <Row label={UI.balance} value={formatToman(user.balanceToman)} />
          <Row label={UI.joinedAt} value={formatDate(user.joinedAt)} />
        </div>
      </Card>
      <button
        type="button"
        className="button button--ghost"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          // The response is irrelevant: the server clears the cookie either
          // way, and the user asked to be signed out - so the UI obeys.
          void logout().finally(props.onSignedOut);
        }}
      >
        {UI.logout}
      </button>
      <p className="notice">{UI.readOnlyNotice}</p>
    </>
  );
}
