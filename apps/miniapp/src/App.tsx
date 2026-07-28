import { useCallback, useEffect, useState, type ReactNode } from "react";

import { authenticate, type ApiFailure, type UserDto } from "./api";
import { fetchCommerceFlags } from "./commerce-api";
import {
  AddonsSection,
  BuyScreen,
  DeliverySection,
  flagsFromResponse,
  OrdersScreen,
  type BuyView,
  type CommerceFlags,
  type OrdersView,
} from "./commerce";
import { FailureScreen } from "./components";
import { COMMERCE_UI, UI } from "./i18n";
import {
  DashboardScreen,
  OutsideTelegramScreen,
  ProfileScreen,
  ServiceDetailScreen,
  ServicesScreen,
  SignedOutScreen,
  SplashScreen,
  WalletScreen,
} from "./screens";
import {
  SupportNewTicketScreen,
  SupportScreen,
  SupportTicketScreen,
  SupportTicketsScreen,
} from "./support";
import {
  closeMiniApp,
  isTelegramEnvironment,
  rawInitData,
  signalReady,
  subscribeToThemeChanges,
} from "./telegram";

// =============================================================================
// The shell: authentication, then a five-tab app.
//
// Sign-in happens ONCE, on mount. The raw `initData` is posted to the server,
// which verifies Telegram's HMAC and answers with an HttpOnly cookie; from then
// on the cookie is the credential and `initData` is not touched again. It is
// never stored, never put in a header, never logged.
//
// Navigation is component state, not a router. There are five tabs, a service
// detail view and the Support Centre's own three views - a routing library
// would be more code than the thing it routes, and a URL-driven router inside a
// Telegram WebView adds history semantics nobody asked for.
//
// FOUR TABS READ; ONE WRITES. Everything under dashboard, services, wallet and
// profile is a read. The Support Centre is the single write surface: it opens
// tickets and posts replies, and it is the only place in this app that does.
// That is why it lives in its own module rather than in `screens.tsx`.
//
// SIGNING OUT STAYS SIGNED OUT. The shell must never re-authenticate on its
// own after a logout: `initData` is still sitting in the WebView, so calling
// `signIn` again would silently mint a fresh cookie and the user would watch
// their own logout undo itself. A successful logout therefore closes the Mini
// App through the host bridge, or - when the host has no `close` - shows a
// signed-out screen whose "ورود مجدد" button is the ONLY thing that
// authenticates again.
// =============================================================================

type Tab = "dashboard" | "buy" | "services" | "orders" | "wallet" | "support" | "profile";

/**
 * Where the Support tab currently is.
 *
 * Held here rather than inside the tab so leaving the tab genuinely leaves:
 * switching away and back returns to the landing view, and a half-finished
 * draft is discarded rather than silently resurrected. Nothing about it
 * survives a reload either - there is no storage in this app.
 */
type SupportView =
  | { kind: "home" }
  | { kind: "list" }
  | { kind: "ticket"; ticketId: string }
  | { kind: "new" };

type Session =
  | { phase: "starting" }
  | { phase: "outside" }
  | { phase: "failed"; failure: ApiFailure }
  | { phase: "ready"; user: UserDto }
  /** Terminal until the user explicitly asks to sign in again. */
  | { phase: "signedOut" };

export function App(): ReactNode {
  const [session, setSession] = useState<Session>({ phase: "starting" });
  const [tab, setTab] = useState<Tab>("dashboard");
  const [openServiceId, setOpenServiceId] = useState<string | null>(null);
  const [supportView, setSupportView] = useState<SupportView>({ kind: "home" });
  // Commerce rollout flags — fetched once per session; everything commercial
  // stays hidden until the OWNER switches arrive as true (fail closed).
  const [commerceFlags, setCommerceFlags] = useState<CommerceFlags | null>(null);
  const [buyView, setBuyView] = useState<BuyView>({ kind: "hub" });
  const [ordersView, setOrdersView] = useState<OrdersView>({ kind: "list" });

  const signIn = useCallback(async () => {
    setSession({ phase: "starting" });
    if (!isTelegramEnvironment()) {
      // Outside a Telegram WebView there is no signed payload to present, and
      // no amount of retrying will produce one. Say so plainly instead of
      // showing an authentication error that looks like a bug.
      setSession({ phase: "outside" });
      return;
    }
    const result = await authenticate(rawInitData());
    setSession(
      result.ok ? { phase: "ready", user: result.user } : { phase: "failed", failure: result },
    );
    if (result.ok) {
      const flags = await fetchCommerceFlags();
      setCommerceFlags(flags.ok ? flagsFromResponse(flags.flags) : null);
    }
  }, []);

  useEffect(() => {
    signalReady();
    void signIn();
  }, [signIn]);

  // The host theme can change while the app is open; re-apply it whenever it
  // does, and detach on unmount.
  useEffect(() => subscribeToThemeChanges(), []);

  if (session.phase === "starting") {
    return <SplashScreen />;
  }
  if (session.phase === "outside") {
    return <OutsideTelegramScreen />;
  }
  if (session.phase === "failed") {
    return <FailureScreen failure={session.failure} onRetry={() => void signIn()} />;
  }
  if (session.phase === "signedOut") {
    // Reached only when the host could not close the app. Nothing here runs
    // automatically - `signIn` fires on the explicit button press and nowhere
    // else, so one logout produces one logout request and zero authentications.
    return <SignedOutScreen onSignInAgain={() => void signIn()} />;
  }

  const showingDetail = openServiceId !== null;
  // The Support tab's inner views get the same back affordance the service
  // detail has, for the same reason: a screen you can reach must be a screen
  // you can leave without hunting for the tab you came from.
  const showingSupportInner = !showingDetail && tab === "support" && supportView.kind !== "home";
  const goSupportHome = (): void => setSupportView({ kind: "home" });
  return (
    <div className="app">
      <header className="header">
        {showingDetail || showingSupportInner ? (
          <button
            type="button"
            className="header__back"
            onClick={showingDetail ? () => setOpenServiceId(null) : goSupportHome}
          >
            {`‹ ${UI.back}`}
          </button>
        ) : null}
        <h1 className="header__title">
          {showingDetail
            ? UI.navServices
            : showingSupportInner
              ? supportTitleFor(supportView)
              : titleFor(tab)}
        </h1>
      </header>

      <main className="app__content">
        {showingDetail ? (
          <>
            <ServiceDetailScreen serviceId={openServiceId} />
            {commerceFlags !== null && commerceFlags.commerce && openServiceId !== null ? (
              <>
                {commerceFlags.serviceDelivery ? (
                  <DeliverySection servicePublicId={openServiceId} />
                ) : null}
                <AddonsSection
                  servicePublicId={openServiceId}
                  onPayment={(publicId) => {
                    setOpenServiceId(null);
                    setTab("buy");
                    setBuyView({ kind: "payment", paymentPublicId: publicId });
                  }}
                  onCheckout={(publicId) => {
                    setOpenServiceId(null);
                    setTab("buy");
                    setBuyView({ kind: "checkout", checkoutPublicId: publicId });
                  }}
                />
              </>
            ) : null}
          </>
        ) : tab === "buy" && commerceFlags !== null ? (
          <BuyScreen
            flags={commerceFlags}
            view={buyView}
            onView={setBuyView}
            onOrders={() => {
              setOrdersView({ kind: "list" });
              setTab("orders");
            }}
          />
        ) : tab === "orders" && commerceFlags !== null ? (
          <OrdersScreen view={ordersView} onView={setOrdersView} />
        ) : tab === "dashboard" ? (
          <DashboardScreen onOpenService={setOpenServiceId} />
        ) : tab === "services" ? (
          <ServicesScreen onOpenService={setOpenServiceId} />
        ) : tab === "wallet" ? (
          <>
            <WalletScreen />
            {commerceFlags !== null && commerceFlags.commerce && commerceFlags.walletTopup ? (
              <div className="actions">
                <button
                  type="button"
                  className="button"
                  onClick={() => {
                    setTab("buy");
                    setBuyView({ kind: "topup" });
                  }}
                >
                  {COMMERCE_UI.topupTitle}
                </button>
              </div>
            ) : null}
          </>
        ) : tab === "support" ? (
          supportView.kind === "home" ? (
            <SupportScreen
              onOpenTickets={() => setSupportView({ kind: "list" })}
              onOpenTicket={(ticketId) => setSupportView({ kind: "ticket", ticketId })}
              onNewTicket={() => setSupportView({ kind: "new" })}
            />
          ) : supportView.kind === "list" ? (
            <SupportTicketsScreen
              onOpenTicket={(ticketId) => setSupportView({ kind: "ticket", ticketId })}
              onNewTicket={() => setSupportView({ kind: "new" })}
            />
          ) : supportView.kind === "ticket" ? (
            <SupportTicketScreen ticketId={supportView.ticketId} />
          ) : (
            <SupportNewTicketScreen
              // A created ticket lands on its own thread, so the user sees the
              // thing they just wrote rather than a list they have to search.
              onCreated={(ticketId) => setSupportView({ kind: "ticket", ticketId })}
              onCancel={goSupportHome}
            />
          )
        ) : (
          <ProfileScreen
            user={session.user}
            onSignedOut={() => {
              setOpenServiceId(null);
              setSupportView({ kind: "home" });
              setTab("dashboard");
              // Close if the host allows it; otherwise park on the signed-out
              // screen. Never `signIn()` - `initData` is still available and
              // calling it would immediately undo the logout.
              if (!closeMiniApp()) {
                setSession({ phase: "signedOut" });
              }
            }}
          />
        )}
      </main>

      <nav className="tabs">
        {(
          [
            ["dashboard", UI.navDashboard],
            ...(commerceFlags !== null && commerceFlags.commerce
              ? ([["buy", COMMERCE_UI.buyTab]] as Array<[Tab, string]>)
              : []),
            ["services", UI.navServices],
            ...(commerceFlags !== null && commerceFlags.commerce
              ? ([["orders", COMMERCE_UI.ordersTab]] as Array<[Tab, string]>)
              : []),
            ["wallet", UI.navWallet],
            ["support", UI.navSupport],
            ["profile", UI.navProfile],
          ] as Array<[Tab, string]>
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={`tab ${tab === key && !showingDetail ? "tab--active" : ""}`}
            aria-current={tab === key && !showingDetail ? "page" : undefined}
            onClick={() => {
              setOpenServiceId(null);
              // Leaving the Support tab resets it: a tap on «پشتیبانی» should
              // land on the Support Centre, not halfway through someone's
              // abandoned draft.
              setSupportView({ kind: "home" });
              setTab(key);
            }}
          >
            {label}
          </button>
        ))}
      </nav>
    </div>
  );
}

function titleFor(tab: Tab): string {
  switch (tab) {
    case "dashboard":
      return UI.appName;
    case "buy":
      return COMMERCE_UI.buyTab;
    case "orders":
      return COMMERCE_UI.ordersTab;
    case "services":
      return UI.navServices;
    case "wallet":
      return UI.navWallet;
    case "support":
      return UI.supportTitle;
    case "profile":
      return UI.navProfile;
  }
}

function supportTitleFor(view: SupportView): string {
  switch (view.kind) {
    case "home":
      return UI.supportTitle;
    case "list":
      return UI.supportListTitle;
    case "ticket":
      return UI.supportTitle;
    case "new":
      return UI.supportWizardTitle;
  }
}
