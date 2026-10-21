// Every path-to-screen decision the app makes lives in this file. There is no
// router library: the host serves index.html for any path, and the app reads
// window.location once, here. A future move to React Router replaces this
// module and the one switch in App.js that consumes resolveScreen().
//
// Deliberately pure -- no React, no supabase import -- so supabaseClient.js
// can import it without a cycle. That import order also means the URL is read
// before supabase-js initialises and strips the auth hash from the address bar.

const loc = typeof window !== "undefined" ? window.location : null;
const PATH = loc ? loc.pathname.replace(/\/+$/, "") : "";
const SEARCH = new URLSearchParams(loc ? loc.search : "");
const HASH = new URLSearchParams(loc ? loc.hash.replace(/^#/, "") : "");

// Demo Mode. Also decides, in supabaseClient.js, that this page load keeps its
// session in sessionStorage rather than localStorage.
export const IS_DEMO_PATH = PATH === "/demo";

// "?mode=signin" / "?mode=signup" -- the landing page's corner links, and the
// demo banner's "Create account" link, which lands here via a full page load
// so the Supabase client re-initialises against localStorage (see
// supabaseClient.js) -- the new real account must not inherit the demo's
// sessionStorage.
const MODE_PARAM = SEARCH.get("mode");
const AUTH_MODE_REQUESTED = MODE_PARAM === "signin" || MODE_PARAM === "signup" ? MODE_PARAM : null;

// A Supabase email link (password recovery, signup confirmation) lands on the
// site origin with its result in the hash -- tokens on success, error_code on
// an expired or already-used link. Either way the visitor came to deal with
// their account, so a logged-out result shows the auth card, not the landing
// page. A valid recovery link never reaches that branch: it resolves to
// session === "PASSWORD_RECOVERY" (see App.js's onAuthStateChange) first.
const AUTH_REDIRECT_IN_URL = HASH.has("access_token") || HASH.has("error_code");

/**
 * Which top-level screen to render.
 *
 * session:    undefined = still loading, null = logged out,
 *             "PASSWORD_RECOVERY" = arrived via a recovery link, object = logged in.
 * demoStatus: "off" | "bootstrapping" | "ready" | "expired" (App.js).
 *
 * Returns { screen, authMode } where screen is one of
 * loading | demo-expired | demo-bootstrap | reset | auth | landing | app.
 * Unknown paths fall through and behave like "/".
 */
export function resolveScreen({ session, demoStatus }) {
  if (session === undefined) return { screen: "loading" };

  if (demoStatus === "expired") return { screen: "demo-expired" };
  if (IS_DEMO_PATH && demoStatus !== "ready") return { screen: "demo-bootstrap" };

  if (session === "PASSWORD_RECOVERY") return { screen: "reset" };

  if (!session) {
    if (AUTH_MODE_REQUESTED) return { screen: "auth", authMode: AUTH_MODE_REQUESTED };
    if (AUTH_REDIRECT_IN_URL) return { screen: "auth", authMode: "signin" };
    return { screen: "landing" };
  }

  return { screen: "app" };
}
