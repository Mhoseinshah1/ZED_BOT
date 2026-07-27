import { useCallback, useEffect, useState, type ReactNode } from "react";

import { authenticate, type ApiFailure, type UserDto } from "./api";
import { FailureScreen } from "./components";
import { UI } from "./i18n";
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
  closeMiniApp,
  isTelegramEnvironment,
  rawInitData,
  signalReady,
  subscribeToThemeChanges,
} from "./telegram";

// =============================================================================
// The shell: authentication, then a four-tab read-only app.
//
// Sign-in happens ONCE, on mount. The raw `initData` is posted to the server,
// which verifies Telegram's HMAC and answers with an HttpOnly cookie; from then
// on the cookie is the credential and `initData` is not touched again. It is
// never stored, never put in a header, never logged.
//
// Navigation is component state, not a router. There are four tabs and one
// detail view - a routing library would be more code than the thing it routes,
// and a URL-driven router inside a Telegram WebView adds history semantics
// nobody asked for.
//
// SIGNING OUT STAYS SIGNED OUT. The shell must never re-authenticate on its
// own after a logout: `initData` is still sitting in the WebView, so calling
// `signIn` again would silently mint a fresh cookie and the user would watch
// their own logout undo itself. A successful logout therefore closes the Mini
// App through the host bridge, or - when the host has no `close` - shows a
// signed-out screen whose "ورود مجدد" button is the ONLY thing that
// authenticates again.
// =============================================================================

type Tab = "dashboard" | "services" | "wallet" | "profile";

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
  return (
    <div className="app">
      <header className="header">
        {showingDetail ? (
          <button type="button" className="header__back" onClick={() => setOpenServiceId(null)}>
            {`‹ ${UI.back}`}
          </button>
        ) : null}
        <h1 className="header__title">{showingDetail ? UI.navServices : titleFor(tab)}</h1>
      </header>

      <main className="app__content">
        {showingDetail ? (
          <ServiceDetailScreen serviceId={openServiceId} />
        ) : tab === "dashboard" ? (
          <DashboardScreen onOpenService={setOpenServiceId} />
        ) : tab === "services" ? (
          <ServicesScreen onOpenService={setOpenServiceId} />
        ) : tab === "wallet" ? (
          <WalletScreen />
        ) : (
          <ProfileScreen
            user={session.user}
            onSignedOut={() => {
              setOpenServiceId(null);
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
            ["services", UI.navServices],
            ["wallet", UI.navWallet],
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
    case "services":
      return UI.navServices;
    case "wallet":
      return UI.navWallet;
    case "profile":
      return UI.navProfile;
  }
}
