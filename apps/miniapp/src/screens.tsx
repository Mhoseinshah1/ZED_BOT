import { useCallback, useEffect, useState, type ReactNode } from "react";

import {
  fetchDashboard,
  fetchMe,
  fetchService,
  fetchServices,
  fetchTransactions,
  logout,
  type ApiFailure,
  type DashboardDto,
  type ProfileDto,
  type ServiceDetailDto,
  type ServiceSummaryDto,
  type TransactionDto,
  type UserDto,
} from "./api";
import {
  BotActions,
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
  displayName,
  formatBytes,
  formatDate,
  formatNumber,
  formatSignedToman,
  formatToman,
} from "./format";
import { lookup, SERVICE_SOURCE_TEXT, UI, USER_GROUP_TEXT, WALLET_TYPE_TEXT } from "./i18n";

// =============================================================================
// Screens.
//
// Read-only, all of them. There is no form, no mutation and no request that
// changes anything a user owns: purchases, renewals, payments and support all
// stay in the bot, where the business logic, the notifications and the audit
// trail already are.
//
// Read-only is not the same as a dead end, though. The buttons a screen does
// carry are of exactly two kinds, and neither writes anything here:
//
//   - SIGNING OUT, which destroys a cookie; and
//   - BOT-RETURN ACTIONS (`BotActions`) — buy, charge the wallet, renew,
//     contact support — every one of which only OPENS THE CONFIGURED BOT.
//
// So a user looking at a service that expires in two days has somewhere to go,
// and the notice explaining that those flows live in the bot sits next to the
// button that takes them there rather than leaving them hunting for it.
//
// Every screen handles three states explicitly: loading, failed, loaded. A
// screen that renders "0 services" while a request is still in flight tells the
// user something false, so the loading state is never skipped.
// =============================================================================

export type LoadState<T> =
  | { phase: "loading" }
  | { phase: "failed"; failure: ApiFailure }
  | { phase: "loaded"; data: T };

/**
 * Runs a fetch on mount and re-runs it on demand.
 *
 * `load` must be stable (a module-level function or a `useCallback`), because
 * it is a dependency of the effect: a function rebuilt on every render would
 * refetch on every render.
 *
 * Exported so the Support Centre (`support.tsx`) loads its data the same way
 * rather than growing a second, subtly different hook — the cancellation rule
 * below is the kind of thing a copy gets wrong.
 */
export function useResource<T>(load: () => Promise<({ ok: true } & T) | ApiFailure>): {
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

/**
 * Where a logout lands when the host bridge has no `close`.
 *
 * Deliberately a dead end with one exit. The signed Telegram payload is still
 * in the WebView, so anything that authenticated on render would undo the
 * logout the moment it finished - the button below is the only path back in.
 */
export function SignedOutScreen(props: { onSignInAgain: () => void }): ReactNode {
  return (
    <div className="center">
      <h1 className="center__title">{UI.signedOutTitle}</h1>
      <p className="center__body">{UI.signedOutBody}</p>
      <button type="button" className="button" onClick={props.onSignInAgain}>
        {UI.signInAgain}
      </button>
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
            {/* Keyed by position: a ledger row carries no public id (its
                database uuid is deliberately not in the response), and this
                list is a fixed, newest-first slice that is replaced wholesale
                on every refresh. */}
            {data.wallet.recentTransactions.map((txn, index) => (
              <TransactionRow key={`${txn.createdAt}-${index}`} transaction={txn} />
            ))}
          </div>
        )}
      </Card>

      <p className="notice">{UI.readOnlyNotice}</p>
      <p className="notice">
        {UI.lastSynced}: {formatDate(data.dataFreshnessTimestamp)}
      </p>
      <BotActions />
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
      <BotActions actions={["buy", "renew"]} />
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
  // The SERVER's number, not a second computation. `remainingDays` has three
  // documented cases (null / 0 / rounded up) and the list, the detail and the
  // dashboard must all mean the same thing by them.
  const remainingDays = service.remainingDays;
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
                    remainingDays === null
                      ? ""
                      : remainingDays === 0
                        ? ` (${UI.expired})`
                        : ` (${remainingDays} ${UI.days})`
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
          {/* OUR row's freshness, not the panel's — the API cannot speak for a
              panel it never calls, and the label must not imply otherwise. */}
          <Row label={UI.lastSynced} value={formatDate(service.lastSyncedAt)} />
        </div>
      </Card>

      {/*
        No subscription link, no QR, no config list. Those ARE the service - the
        API does not send them, and the place to get them is the bot, where the
        existing delivery flow already handles them.
      */}
      <p className="notice">{UI.readOnlyNotice}</p>
      {/*
        This is the screen where a user learns their service expires in two
        days, so it is the screen that most needs a way to act on that. Renew
        and support only - buying another service and charging a wallet are not
        what this page is about, and padding it with unrelated buttons would
        make the two that matter harder to find.
      */}
      <BotActions actions={["renew", "support"]} />
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
            {/* Same as the dashboard: no public id on a ledger row. Pages are
                appended, never reordered or inserted into, so position is a
                stable key for the row's whole life on screen. */}
            {items.map((txn, index) => (
              <TransactionRow key={`${txn.createdAt}-${index}`} transaction={txn} />
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
      {/*
        A user reading their balance and finding it short needs the top-up flow,
        which lives in the bot. Support belongs here too: a wallet question is
        the second most common reason someone opens a ticket from this screen.
      */}
      <BotActions actions={["charge", "support"]} />
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
  // Counted by the SERVER under the same visibility rules as every other
  // service read, so a soft-deleted or terminally DELETED service is absent
  // here exactly as it is from the list. Failing to load them is not worth a
  // failure screen — the profile is still useful without two numbers.
  const { state: profile } = useResource<ProfileDto>(fetchMe);
  // `useResource` casts the body to the DTO without validating it, so a
  // response from an older API build — or one shaped differently than this
  // build expects — arrives here as the wrong shape rather than as a failure.
  // Two numbers are not worth crashing a screen over, so they render only when
  // they really are numbers.
  const maybe =
    profile.phase === "loaded"
      ? (profile.data.services as Partial<ProfileDto["services"]> | undefined)
      : undefined;
  const counts =
    typeof maybe?.active === "number" && typeof maybe.total === "number"
      ? { active: maybe.active, total: maybe.total }
      : null;
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
          {counts === null ? null : (
            <>
              <Row label={UI.activeServices} value={formatNumber(counts.active)} />
              <Row label={UI.totalServices} value={formatNumber(counts.total)} />
            </>
          )}
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
      {/*
        Support only. Someone on their own account page is looking at who they
        are, not shopping - and "contact support" is the one thing a profile
        screen genuinely leads to.
      */}
      <BotActions actions={["support"]} />
    </>
  );
}
