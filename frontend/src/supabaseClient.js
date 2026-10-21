import { createClient } from "@supabase/supabase-js";
import { IS_DEMO_PATH } from "./routes";

const SUPABASE_URL = process.env.REACT_APP_SCHEDULER_URL;
const SUPABASE_ANON_KEY = process.env.REACT_APP_SCHEDULER_ANON_KEY;

// Demo Mode: a /demo visitor's anonymous session must survive a page refresh
// but not a new browser session, so that one page load uses sessionStorage
// instead of the default localStorage. Decided once, at module load, from the
// path the page was opened on -- which is also why signing up from inside the
// demo does a full navigation to "/" rather than swapping the screen in place:
// without the reload, the new real account's session would land in
// sessionStorage and evaporate when the browser closes. Real users' storage is
// untouched on every other path. (The path check itself lives in routes.js.)
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    flowType: "implicit",
    ...(IS_DEMO_PATH ? { storage: window.sessionStorage } : {}),
  },
});