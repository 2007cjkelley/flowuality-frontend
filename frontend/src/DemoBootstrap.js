import { useCallback, useEffect, useRef, useState } from "react";
import axios from "axios";
import { supabase } from "./supabaseClient";

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL || "http://127.0.0.1:8001";
const API = `${BACKEND_URL}/api`;
const TURNSTILE_SITE_KEY = process.env.REACT_APP_TURNSTILE_SITE_KEY || "";
const TURNSTILE_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

// Loaded here rather than in index.html so a real user's page never fetches
// Cloudflare's script at all.
function loadTurnstileScript() {
  if (window.turnstile) return Promise.resolve();
  const existing = document.querySelector(`script[src="${TURNSTILE_SRC}"]`);
  if (existing) return new Promise((resolve, reject) => {
    existing.addEventListener("load", resolve);
    existing.addEventListener("error", reject);
  });
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = TURNSTILE_SRC;
    script.async = true;
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

// The whole of /demo before the app itself renders: human check -> Supabase
// anonymous sign-in -> POST /demo/finalize (sets up the demo's data) ->
// onReady.
export default function DemoBootstrap({ onReady }) {
  const [status, setStatus] = useState("loading"); // loading | challenge | starting | error
  const [errorMessage, setErrorMessage] = useState(null);
  const widgetRef = useRef(null);
  const startedRef = useRef(false);

  const finalize = useCallback(async (captchaToken) => {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    // The Turnstile token is verified by our own backend here, not by
    // Supabase during sign-in: Supabase's CAPTCHA setting is project-wide and
    // would also demand a token on the ordinary sign-in/sign-up forms.
    await axios.post(`${API}/demo/finalize`, { timezone, turnstile_token: captchaToken || null });
    onReady();
  }, [onReady]);

  const startDemo = useCallback(async (captchaToken) => {
    if (startedRef.current) return;
    // Never re-armed, including on failure: every error here is terminal and
    // the copy tells the visitor to reload. Re-arming it turned a failing
    // sign-in into an infinite retry loop against Supabase.
    startedRef.current = true;
    setStatus("starting");
    try {
      // No captchaToken passed here on purpose -- Supabase's own CAPTCHA
      // setting stays off, and the token is checked by our backend in
      // finalize() instead.
      const { error } = await supabase.auth.signInAnonymously();
      if (error) {
        throw new Error("The demo isn't available right now. Reload the page to try again.");
      }
      await finalize(captchaToken);
    } catch (err) {
      // A failed start leaves no usable demo, so clear the half-made session
      // rather than leaving the browser holding a token for it.
      await supabase.auth.signOut().catch(() => {});
      setErrorMessage(
        err.response?.data?.detail ||
        err.message ||
        "Something went wrong starting the demo."
      );
      setStatus("error");
    }
  }, [finalize]);

  // Empty deps on purpose: this must run on mount and never again. Its real
  // dependencies (onReady, startDemo) are not stable across renders, and
  // re-running this is what produced a retry loop against Supabase. The
  // single sign-in attempt is guaranteed by startDemo's own startedRef, not
  // by this effect firing once -- StrictMode deliberately mounts twice in
  // development, and an effect-level "already ran" flag would let the first
  // pass be torn down and permanently block the second.
  useEffect(() => {
    (async () => {
      // A refresh inside a live demo already has its session in
      // sessionStorage and its data already seeded -- straight through.
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.user?.is_anonymous) {
        onReady();
        return;
      }
      if (!TURNSTILE_SITE_KEY) {
        // No site key configured (local dev): skip the challenge entirely.
        // Supabase only enforces its captcha where the project has it turned
        // on, so this is the same path staging/prod take minus the widget.
        startDemo(null);
        return;
      }
      try {
        await loadTurnstileScript();
        setStatus("challenge");
      } catch {
        setErrorMessage("We couldn't load the human-verification widget. Reload the page to try again.");
        setStatus("error");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (status !== "challenge" || !widgetRef.current || !window.turnstile) return;
    window.turnstile.render(widgetRef.current, {
      sitekey: TURNSTILE_SITE_KEY,
      callback: (token) => startDemo(token),
      "error-callback": () => {
        // The widget itself failed, so there's no token and finalize never
        // runs; let the server know.
        axios.post(`${API}/demo/turnstile-failure`).catch(() => {});
        setErrorMessage("Human verification failed. Reload the page to try again.");
        setStatus("error");
      },
    });
  }, [status, startDemo]);

  return (
    <div className="auth-screen">
      <div className="auth-card" style={{ textAlign: "center" }} data-testid="demo-bootstrap">
        <h1 className="auth-title">Flowuality demo</h1>
        {status === "error" ? (
          <>
            <p className="demo-bootstrap-message" data-testid="demo-bootstrap-error">{errorMessage}</p>
            <a className="auth-link-button" href="/">Create an account instead</a>
          </>
        ) : (
          <p className="demo-bootstrap-message">
            {status === "starting" ? "Setting up your demo…" : "Just checking you're human…"}
          </p>
        )}
        <div ref={widgetRef} style={{ display: "flex", justifyContent: "center", marginTop: 16 }} />
      </div>
    </div>
  );
}
