/* Supabase wrapper.
 *
 * Wraps the @supabase/supabase-js v2 client in a tiny key/value API so the
 * rest of the app doesn't have to know about supabase at all.
 *
 * Single table:
 *   create table shift_planner (
 *     k text primary key,
 *     v jsonb,
 *     updated_at timestamptz default now()
 *   );
 *
 * Public API:
 *   Cloud.isConfigured()         -> bool
 *   Cloud.init()                 -> void  (creates the supabase client)
 *   await Cloud.get(key)         -> any | null
 *   await Cloud.set(key, value)  -> void
 *   await Cloud.del(key)         -> void
 *   await Cloud.listKeys(prefix) -> [{k, v}]
 *   Cloud.subscribe(callback)    -> unsubscribe()  (callback({k,v,event}))
 */
(function (root) {
  let client = null;
  let polling = null;
  let onChangeCallbacks = [];

  function isConfigured() {
    const c = root.APP_CONFIG || {};
    return !!(c.SUPABASE_URL && c.SUPABASE_ANON_KEY && root.supabase && typeof root.supabase.createClient === "function");
  }

  function init() {
    if (client) return client;
    if (!isConfigured()) return null;
    const { SUPABASE_URL, SUPABASE_ANON_KEY } = root.APP_CONFIG;
    client = root.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      realtime: { params: { eventsPerSecond: 5 } },
    });
    return client;
  }

  function table() { return client.from(root.APP_CONFIG.TABLE_NAME); }

  async function get(key) {
    const { data, error } = await table().select("v").eq("k", key).maybeSingle();
    if (error && error.code !== "PGRST116") throw error;   // "no rows" is fine
    return data ? data.v : null;
  }

  async function set(key, value) {
    const { error } = await table().upsert({ k: key, v: value, updated_at: new Date().toISOString() });
    if (error) throw error;
  }

  async function del(key) {
    const { error } = await table().delete().eq("k", key);
    if (error) throw error;
  }

  async function listKeys(prefix = "") {
    const q = table().select("k,v,updated_at");
    const { data, error } = prefix ? await q.like("k", `${prefix}%`) : await q;
    if (error) throw error;
    return data || [];
  }

  // Realtime: WebSocket subscription. Falls back to polling if the channel
  // status isn't SUBSCRIBED within 5 s (corporate WS block).
  function subscribe(callback) {
    onChangeCallbacks.push(callback);

    let channel = null;
    let healthy = false;

    if (client) {
      channel = client.channel("shift_planner_changes")
        .on("postgres_changes",
            { event: "*", schema: "public", table: root.APP_CONFIG.TABLE_NAME },
            (payload) => {
              const k = (payload.new && payload.new.k) || (payload.old && payload.old.k);
              const v = payload.new ? payload.new.v : null;
              const ts = payload.commit_timestamp
                       || (payload.new && payload.new.updated_at)
                       || new Date().toISOString();
              for (const cb of onChangeCallbacks) {
                try { cb({ k, v, event: payload.eventType, updated_at: ts }); } catch (e) { console.error(e); }
              }
            })
        .subscribe((status) => {
          if (status === "SUBSCRIBED") {
            healthy = true;
            stopPolling();
          }
        });

      // Safety net: if realtime never connects, start polling.
      setTimeout(() => { if (!healthy) startPolling(); }, 5000);
    } else {
      startPolling();
    }

    return function unsubscribe() {
      onChangeCallbacks = onChangeCallbacks.filter(c => c !== callback);
      if (channel && client) client.removeChannel(channel);
      if (onChangeCallbacks.length === 0) stopPolling();
    };
  }

  let lastSeen = null;
  function startPolling() {
    if (polling) return;
    polling = setInterval(async () => {
      try {
        const { data, error } = await table().select("k,v,updated_at")
          .gt("updated_at", lastSeen || "1970-01-01");
        if (error) return;
          if (data && data.length) {
          lastSeen = data.reduce((mx, r) => (r.updated_at > mx ? r.updated_at : mx), lastSeen || "");
          for (const row of data) {
            for (const cb of onChangeCallbacks) {
              try { cb({ k: row.k, v: row.v, event: "POLL", updated_at: row.updated_at }); } catch (e) { console.error(e); }
            }
          }
        }
      } catch (e) { console.warn("poll error", e); }
    }, (root.APP_CONFIG && root.APP_CONFIG.POLL_INTERVAL_MS) || 15000);
  }
  function stopPolling() {
    if (polling) { clearInterval(polling); polling = null; }
  }

  root.Cloud = { isConfigured, init, get, set, del, listKeys, subscribe };
})(window);
