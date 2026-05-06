/* ---------------------------------------------------------------------------
 *  CONFIGURATION
 *
 *  Edit the two strings below with your Supabase project credentials.
 *  Both can also be left empty for local-only mode (the app falls back to
 *  localStorage and shows a warning banner).
 *
 *  How to get them:
 *    1. Create a free project at https://supabase.com
 *    2. Project Settings -> API
 *         - "Project URL"  -> SUPABASE_URL
 *         - "anon public"  -> SUPABASE_ANON_KEY
 *    3. SQL Editor -> paste the SQL block from README.md and run it.
 *
 *  Security note: the anon key is intentionally public. Row-Level
 *  Security (RLS) policies in Supabase decide what the anon role can do.
 *  Use the policies in README.md.
 * ------------------------------------------------------------------------- */

window.APP_CONFIG = {
  SUPABASE_URL:      "https://dnkklzbcwdzmptpntutz.supabase.co/rest/v1/",   // e.g. "https://xxxxxxxxxxxxx.supabase.co"
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRua2tsemJjd2R6bXB0cG50dXR6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgwNTMzNzMsImV4cCI6MjA5MzYyOTM3M30.jFpkD1Yo5Bo4R_mzsPHdjm4dKLHWkFBVfCT33jfVkEM",   // e.g. "eyJhbGciOi....."

  // Name of the table that holds the app state (created by the SQL in README).
  TABLE_NAME: "shift_planner",

  // How often the Admin page polls Supabase as a *fallback* if realtime
  // websockets are not available (e.g. corporate network blocks WS).
  // Realtime is preferred; this is only a safety net.
  POLL_INTERVAL_MS: 15000,
};
