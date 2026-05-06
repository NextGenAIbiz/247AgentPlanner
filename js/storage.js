/* Storage layer.
 *
 * Two backends: localStorage (cache) + Cloud (Supabase, if configured).
 * Cloud is the source of truth; localStorage is the fallback / offline cache.
 *
 * Keys (same in both backends):
 *   config                              JSON  {month, year, frozen}
 *   admin_pin_hash                      JSON  hex SHA-256 of the admin PIN
 *   people                              CSV   ID,Name,...
 *   period:<YYYY-MM>:demand             CSV
 *   period:<YYYY-MM>:register           CSV
 *   period:<YYYY-MM>:final              CSV
 *   period:<YYYY-MM>:demand_snapshot    CSV
 *   period:<YYYY-MM>:register_snapshot  CSV
 *
 * The legacy localStorage key prefix is "nga." -- we keep that for the cache
 * to avoid polluting localStorage. Cloud keys have no prefix.
 *
 * Public API:
 *   await Store.bootFromCloud()         - pulls every key from cloud into cache
 *   Store.useCloud                      - bool, set after bootFromCloud succeeds
 *   Store.get(key) / set(key,value)     - low-level, sync (writes cache + queues cloud push)
 *   Store.getRows(key) / setRows(key, rows)  - CSV helpers
 *   ... plus all the period helpers below.
 */
(function (root) {
  const PREFIX = "nga.";
  const cloudQueue = [];
  let pushing = false;

  // ---------- low-level (cache only) ----------
  function getLocal(key)        { return localStorage.getItem(PREFIX + key); }
  function setLocal(key, value) { localStorage.setItem(PREFIX + key, value); }
  function removeLocal(key)     { localStorage.removeItem(PREFIX + key); }

  function listLocalKeys() {
    const out = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX)) out.push(k.slice(PREFIX.length));
    }
    return out;
  }

  // ---------- cloud sync queue ----------
  // Writes are non-blocking: write cache synchronously, queue the cloud
  // push, and process the queue in background. The status badge in the UI
  // can observe Store.cloudPending() to show "syncing..." indicators.
  function queuePush(key, value) {
    if (!Store.useCloud) return;
    cloudQueue.push({ key, value, op: value === null ? "del" : "set" });
    drain();
  }
  async function drain() {
    if (pushing) return;
    pushing = true;
    while (cloudQueue.length) {
      const { key, value, op } = cloudQueue.shift();
      try {
        if (op === "del") await Cloud.del(key);
        else              await Cloud.set(key, value);
        notifyStatus("ok");
      } catch (e) {
        console.error("cloud write failed", key, e);
        notifyStatus("err");
        // Push back and stop -- a later operation will retry
        cloudQueue.unshift({ key, value, op });
        break;
      }
    }
    pushing = false;
  }

  let statusListeners = [];
  function notifyStatus(s) { statusListeners.forEach(fn => { try { fn(s, cloudQueue.length); } catch (_) {} }); }
  function onStatus(fn) { statusListeners.push(fn); return () => { statusListeners = statusListeners.filter(x => x !== fn); }; }

  // ---------- cross-tab sync (no cloud needed) ----------
  // Browsers fire the `storage` event in OTHER tabs of the same origin
  // whenever localStorage is modified. We use this to live-sync the admin
  // tab and the register tab when both are open in the same browser, even
  // when Supabase isn't configured.
  function listenToStorageEvents(onChange) {
    window.addEventListener("storage", (e) => {
      if (!e.key || !e.key.startsWith(PREFIX)) return;
      const k  = e.key.slice(PREFIX.length);
      const v  = e.newValue;            // null if the key was removed
      const ts = new Date().toISOString();
      // localStorage in the receiving tab is ALREADY up-to-date -- the browser
      // wrote it before firing the event. Just refresh derived state and notify.
      noteRegisterMeta(k, v == null ? null : ts);
      try { onChange({ k, v, updated_at: ts, event: v == null ? "DELETE" : "UPDATE" }); }
      catch (err) { console.error("storage event handler failed", err); }
    });
  }

  // ---------- generic get/set ----------
  // Storage values are always plain text in cache; in cloud they're stored
  // as JSON (so we wrap/unwrap in JSON for the cache too if needed).
  function get(key) { return getLocal(key); }
  function set(key, value) {
    if (value === null || value === undefined) {
      removeLocal(key);
      queuePush(key, null);
      // Clear the per-person register timestamp (no-op for non-register keys)
      noteRegisterMeta(key, null);
    } else {
      setLocal(key, String(value));
      queuePush(key, String(value));
      // Stamp local saves immediately so the admin badge updates without
      // waiting for the cloud round-trip.
      noteRegisterMeta(key, new Date().toISOString());
    }
  }

  // Apply a value that came IN from the cloud -> cache only, no echo back.
  function applyFromCloud(key, value, updated_at) {
    if (value === null || value === undefined) {
      removeLocal(key);
      // Clear the meta timestamp on delete (so "registered when?" badges
      // disappear once the admin removes a person).
      noteRegisterMeta(key, null);
    } else {
      setLocal(key, String(value));
      noteRegisterMeta(key, updated_at);
    }
  }

  // ---------- per-person register meta (who registered when) ----------
  // Keyed by "YYYY-MM" -> { personId: ISO timestamp string, ... }
  const registerMeta = {};

  function noteRegisterMeta(key, updated_at) {
    const m = key && key.match(/^period:(\d{4}-\d{2}):reg_row\.(.+)$/);
    if (!m) return;
    const [, pk, id] = m;
    registerMeta[pk] = registerMeta[pk] || {};
    if (updated_at == null) delete registerMeta[pk][id];
    else                    registerMeta[pk][id] = updated_at;
  }

  function getRegisterMeta(month, year) {
    const pk = periodKey(month, year);
    return { ...(registerMeta[pk] || {}) };
  }

  // ---------- config ----------
  const DEFAULT_CONFIG = { month: new Date().getMonth() + 1, year: new Date().getFullYear(), frozen: false };

  function getConfig() {
    const raw = get("config");
    if (!raw) return { ...DEFAULT_CONFIG };
    try { return { ...DEFAULT_CONFIG, ...JSON.parse(raw) }; }
    catch (_) { return { ...DEFAULT_CONFIG }; }
  }
  function setConfig(cfg) { set("config", JSON.stringify(cfg)); }
  function isFrozen() { return !!getConfig().frozen; }

  // ---------- people ----------
  function getPeopleRows() {
    const raw = get("people");
    if (!raw) return [["ID", "Name"]];
    const rows = CSV.parse(raw);
    return rows.length ? rows : [["ID", "Name"]];
  }
  function setPeopleRows(rows) { set("people", CSV.serialize(rows)); }
  function getPeopleMap() {
    const map = {};
    for (const r of getPeopleRows().slice(1)) {
      if (r && r[0] && r[0].trim()) map[r[0].trim()] = (r[1] || "").trim();
    }
    return map;
  }

  // ---------- per-period rows ----------
  function periodKey(month, year) { return `${year}-${String(month).padStart(2, "0")}`; }
  function periodPaths(month, year) {
    const p = periodKey(month, year);
    return {
      key:           p,
      demand:        `period:${p}:demand`,
      register:      `period:${p}:register`,
      final:         `period:${p}:final`,
      demand_snap:   `period:${p}:demand_snapshot`,
      register_snap: `period:${p}:register_snapshot`,
    };
  }
  function currentPaths() {
    const c = getConfig();
    return periodPaths(c.month, c.year);
  }

  function readRows(key) {
    const raw = get(key);
    return raw ? CSV.parse(raw) : [];
  }
  function writeRows(key, rows) {
    rows = (rows || []).filter(r => r && r[0] && String(r[0]).trim() !== "");
    set(key, CSV.serialize(rows));
  }

  // ---------- per-person register layout ----------
  // To allow many users to save concurrently without overwriting each other,
  // the register is split into:
  //   period:<YYYY-MM>:reg_header        -> JSON ["Name","M/D/YYYY",...]
  //   period:<YYYY-MM>:reg_row.<personId> -> JSON ["C6","N","",...] (date values only)
  // The legacy single-blob key   period:<YYYY-MM>:register   is still read
  // (so existing data keeps working) and is deleted on the first admin save.
  function regHeaderKey(month, year) { return `period:${periodKey(month, year)}:reg_header`; }
  function regRowKey(month, year, id) { return `period:${periodKey(month, year)}:reg_row.${id}`; }
  function regRowPrefix(month, year)  { return `period:${periodKey(month, year)}:reg_row.`; }
  function legacyRegKey(month, year)  { return `period:${periodKey(month, year)}:register`; }

  function readRegisterRows(month, year, opts) {
    opts = opts || {};
    const cfg = (month && year) ? { month, year } : getConfig();
    const m = cfg.month, y = cfg.year;
    const dates = generateDates(m, y);
    const includeAllPeople = opts.includeAllPeople !== false; // default true

    let header = null;
    const map = new Map(); // id -> row array, ID at index 0

    const legacy = get(legacyRegKey(m, y));
    if (legacy) {
      const parsed = CSV.parse(legacy);
      if (parsed.length > 0) {
        header = parsed[0];
        for (const row of parsed.slice(1)) {
          const id = row && row[0] && String(row[0]).trim();
          if (id) map.set(id, row.slice());
        }
      }
    }

    const headerRaw = get(regHeaderKey(m, y));
    if (headerRaw) { try { header = JSON.parse(headerRaw); } catch (_) {} }
    if (!header) header = ["Name", ...dates];

    const rowKeyPrefix = regRowPrefix(m, y);
    for (const k of listLocalKeys()) {
      if (!k.startsWith(rowKeyPrefix)) continue;
      const id = k.slice(rowKeyPrefix.length);
      let values = [];
      try { values = JSON.parse(get(k) || "[]"); } catch (_) {}
      map.set(id, [id, ...values]);
    }

    if (includeAllPeople) {
      const numCols = header.length - 1;
      for (const r of getPeopleRows().slice(1)) {
        const id = r && r[0] && String(r[0]).trim();
        if (id && !map.has(id)) {
          map.set(id, [id, ...new Array(numCols).fill("")]);
        }
      }
    }

    // Order: people.csv order first, leftovers alphabetically.
    const peopleOrder = getPeopleRows().slice(1)
      .map(r => r && r[0] && String(r[0]).trim()).filter(Boolean);
    const seen = new Set();
    const ordered = [];
    for (const id of peopleOrder) {
      if (map.has(id)) { ordered.push(map.get(id)); seen.add(id); }
    }
    const extras = [...map.keys()].filter(id => !seen.has(id)).sort();
    for (const id of extras) ordered.push(map.get(id));

    return [header, ...ordered];
  }

  // Read a single user's row -- used by register.html.
  function readRegisterRow(personId, month, year) {
    const cfg = (month && year) ? { month, year } : getConfig();
    const m = cfg.month, y = cfg.year;
    const dates = generateDates(m, y);
    const id = String(personId || "").trim();

    let header;
    const headerRaw = get(regHeaderKey(m, y));
    try { header = headerRaw ? JSON.parse(headerRaw) : ["Name", ...dates]; }
    catch (_) { header = ["Name", ...dates]; }

    const perRow = get(regRowKey(m, y, id));
    if (perRow != null) {
      let values = [];
      try { values = JSON.parse(perRow); } catch (_) {}
      return { header, row: [id, ...values] };
    }

    const legacy = get(legacyRegKey(m, y));
    if (legacy) {
      const parsed = CSV.parse(legacy);
      const hdr = parsed[0] || header;
      for (const row of parsed.slice(1)) {
        if (row && row[0] && String(row[0]).trim() === id) return { header: hdr, row };
      }
      header = hdr;
    }

    return { header, row: [id, ...new Array(header.length - 1).fill("")] };
  }

  // Admin: write the entire register at once.
  // Splits into per-row keys and (one-time) deletes the legacy blob.
  function writeRegisterRows(rows, opts) {
    opts = opts || {};
    const cfg = (opts.month && opts.year) ? { month: opts.month, year: opts.year } : getConfig();
    const m = cfg.month, y = cfg.year;
    const cleaned = (rows || []).filter(r => r && r[0] && String(r[0]).trim() !== "");
    if (cleaned.length === 0) return;

    const header = cleaned[0];
    const dataRows = cleaned.slice(1);

    set(regHeaderKey(m, y), JSON.stringify(header));

    const newIds = new Set();
    for (const row of dataRows) {
      const id = String(row[0]).trim();
      if (!id) continue;
      newIds.add(id);
      set(regRowKey(m, y, id), JSON.stringify(row.slice(1)));
    }

    // Drop per-row keys for people that are no longer in the table.
    const prefix = regRowPrefix(m, y);
    for (const k of listLocalKeys()) {
      if (k.startsWith(prefix)) {
        const existingId = k.slice(prefix.length);
        if (!newIds.has(existingId)) set(k, null);
      }
    }

    // One-time migration: drop the legacy single-blob key.
    if (get(legacyRegKey(m, y)) != null) set(legacyRegKey(m, y), null);
  }

  // End user: write only their own row -- safe under concurrency.
  function writeRegisterRow(personId, dateValues, opts) {
    opts = opts || {};
    const cfg = (opts.month && opts.year) ? { month: opts.month, year: opts.year } : getConfig();
    const m = cfg.month, y = cfg.year;
    const id = String(personId || "").trim();
    if (!id) return;

    if (!get(regHeaderKey(m, y))) {
      const dates = generateDates(m, y);
      set(regHeaderKey(m, y), JSON.stringify(["Name", ...dates]));
    }
    set(regRowKey(m, y, id), JSON.stringify(dateValues || []));
  }

  function removeRegisterRow(personId, opts) {
    opts = opts || {};
    const cfg = (opts.month && opts.year) ? { month: opts.month, year: opts.year } : getConfig();
    const m = cfg.month, y = cfg.year;
    const id = String(personId || "").trim();
    if (!id) return;
    set(regRowKey(m, y, id), null);
  }

  // Classify an arbitrary cloud key for the live-update routing.
  // Returns "header" | "row:<personId>" | "legacy" | null for the given period.
  function classifyRegisterKey(key, month, year) {
    const cfg = (month && year) ? { month, year } : getConfig();
    const pk = periodKey(cfg.month, cfg.year);
    if (key === `period:${pk}:reg_header`) return "header";
    const rowPrefix = `period:${pk}:reg_row.`;
    if (key && key.startsWith(rowPrefix)) return "row:" + key.slice(rowPrefix.length);
    if (key === `period:${pk}:register`)   return "legacy";
    return null;
  }

  function periodExists(month, year) {
    const p = periodPaths(month, year);
    if (get(p.demand) || get(p.register) || get(p.final)) return true;
    if (get(regHeaderKey(month, year))) return true;
    const prefix = regRowPrefix(month, year);
    for (const k of listLocalKeys()) {
      if (k.startsWith(prefix)) return true;
    }
    return false;
  }

  function listPeriods() {
    const found = new Set();
    for (const k of listLocalKeys()) {
      const m = k.match(/^period:(\d{4})-(\d{2}):/);
      if (m) found.add(`${m[1]}-${m[2]}`);
    }
    return [...found].sort().map(p => {
      const [y, m] = p.split("-");
      return { year: parseInt(y, 10), month: parseInt(m, 10) };
    });
  }

  function generateDates(month, year) {
    const days = new Date(year, month, 0).getDate();
    const out = [];
    for (let d = 1; d <= days; d++) out.push(`${month}/${d}/${year}`);
    return out;
  }

  // Seed a fresh period using either an explicit previous period object
  // {month, year} -or- (for backward compat) a paths-object pointing at the
  // previous month's CSV blobs.
  function seedPeriod(month, year, prev) {
    const dates = generateDates(month, year);
    const target = periodPaths(month, year);

    // Normalise prev -> {month, year} where possible.
    let prevMY = null;
    if (prev && prev.month && prev.year) {
      prevMY = { month: prev.month, year: prev.year };
    } else if (prev && prev.key) {
      const pm = String(prev.key).match(/^(\d{4})-(\d{2})$/);
      if (pm) prevMY = { month: parseInt(pm[2], 10), year: parseInt(pm[1], 10) };
    }

    // Try the requested previous period first; if it has no shift types
    // (just Plan/Sum), fall back to ANY other saved period that does.
    const tryDemand = (key) => {
      const r = readRows(key);
      const realShifts = r.slice(1).filter(row => {
        const n = (row && row[0] || "").trim().toLowerCase();
        return n && n !== "sum";
      });
      return realShifts.length > 0 ? r : null;
    };
    let sourceDemand = (prev && prev.demand) ? tryDemand(prev.demand) : null;
    if (!sourceDemand) {
      // Pick the most-recent saved period (descending) that has shift types.
      const others = listPeriods()
        .filter(p => !(p.month === month && p.year === year))
        .sort((a, b) => (b.year - a.year) || (b.month - a.month));
      for (const o of others) {
        sourceDemand = tryDemand(periodPaths(o.month, o.year).demand);
        if (sourceDemand) break;
      }
    }

    const demandRows = [["Plan", ...dates]];
    if (sourceDemand) {
      for (const row of sourceDemand.slice(1)) {
        if (!row || !row[0] || !row[0].trim()) continue;
        const shift = row[0].trim();
        if (shift.toLowerCase() === "sum") {
          demandRows.push([shift, ...new Array(dates.length).fill("0")]);
        } else {
          const hadValue = row.slice(1).some(c => (c || "0").trim() !== "" && (c || "0").trim() !== "0");
          demandRows.push([shift, ...new Array(dates.length).fill(hadValue ? "1" : "0")]);
        }
      }
    }
    if (demandRows.length === 1) demandRows.push(["Sum", ...new Array(dates.length).fill("0")]);
    writeRows(target.demand, demandRows);

    const regRows = [["Name", ...dates]];
    if (prevMY) {
      for (const row of readRegisterRows(prevMY.month, prevMY.year, { includeAllPeople: false }).slice(1)) {
        if (row && row[0] && row[0].trim()) regRows.push([row[0].trim(), ...new Array(dates.length).fill("")]);
      }
    } else {
      for (const r of getPeopleRows().slice(1)) {
        if (r && r[0] && r[0].trim()) regRows.push([r[0].trim(), ...new Array(dates.length).fill("")]);
      }
    }
    writeRegisterRows(regRows, { month, year });
  }

  // ---------- backup / restore (full JSON dump) ----------
  function exportAll() {
    const data = {};
    for (const k of listLocalKeys()) data[k] = getLocal(k);
    return { generatedAt: new Date().toISOString(), version: 2, keys: data };
  }
  function importAll(payload, { merge = false, pushToCloud = true } = {}) {
    if (!payload || !payload.keys) throw new Error("Invalid backup file (no 'keys' field).");
    if (!merge) {
      for (const k of listLocalKeys()) {
        removeLocal(k);
        if (pushToCloud) queuePush(k, null);
      }
    }
    for (const [k, v] of Object.entries(payload.keys)) {
      if (typeof v === "string") {
        setLocal(k, v);
        if (pushToCloud) queuePush(k, v);
      }
    }
  }

  // Idempotent seed: only fills in pieces that are MISSING. Safe to call on
  // every page load -- it will never overwrite something the user has already
  // edited, but it WILL repopulate anything that's gone missing (e.g. a fresh
  // period that was switched to but never had shift types).
  function seedFromBundleIfEmpty() {
    const seed = root.SHIFT_PLANNER_SEED;
    if (!seed || typeof seed !== "object") return false;
    let didSeed = false;

    // People: seed only if the list is empty (just the header row).
    if (Array.isArray(seed.people) && getPeopleRows().length <= 1) {
      setPeopleRows(seed.people);
      didSeed = true;
    }

    // Each period is independent -- seed only the pieces that are missing.
    if (seed.periods && typeof seed.periods === "object") {
      for (const [periodName, p] of Object.entries(seed.periods)) {
        const mt = periodName.match(/^(\d{4})-(\d{2})$/);
        if (!mt) continue;
        const month = parseInt(mt[2], 10), year = parseInt(mt[1], 10);
        const paths = periodPaths(month, year);

        // Demand: seed if the stored CSV is missing OR is just the empty
        // Plan + Sum scaffold (which means seedPeriod produced a blank one).
        const existingDemand = readRows(paths.demand);
        const isBlankDemand  = existingDemand.length === 0
          || (existingDemand.length <= 2 && existingDemand.slice(1).every(r => {
              const name = (r[0] || "").trim().toLowerCase();
              return name === "" || name === "sum";
            }));
        if (Array.isArray(p.demand) && isBlankDemand) {
          writeRows(paths.demand, p.demand);
          didSeed = true;
        }

        if (Array.isArray(p.register)) {
          // Only seed register if NOTHING is registered yet for this period.
          const haveAnyReg = !!get(regHeaderKey(month, year))
            || !!get(legacyRegKey(month, year))
            || listLocalKeys().some(k => k.startsWith(regRowPrefix(month, year)));
          if (!haveAnyReg) {
            writeRegisterRows(p.register, { month, year });
            didSeed = true;
          }
        }

        if (Array.isArray(p.final) && !get(paths.final)) {
          writeRows(paths.final, p.final);
          didSeed = true;
        }
        if (Array.isArray(p.demand_snap) && !get(paths.demand_snap)) {
          writeRows(paths.demand_snap, p.demand_snap);
          didSeed = true;
        }
        if (Array.isArray(p.register_snap) && !get(paths.register_snap)) {
          writeRows(paths.register_snap, p.register_snap);
          didSeed = true;
        }
      }
    }

    if (seed.config && !get("config")) {
      setConfig({ ...DEFAULT_CONFIG, ...seed.config });
      didSeed = true;
    }
    return didSeed;
  }

  // ---------- cloud bootstrap ----------
  async function bootFromCloud({ pushLocalIfCloudEmpty = false } = {}) {
    if (!Cloud.isConfigured()) return { ok: false, reason: "not_configured" };
    if (!Cloud.init()) return { ok: false, reason: "init_failed" };
    Store.useCloud = true;

    let rows;
    try {
      rows = await Cloud.listKeys();
    } catch (e) {
      console.error("cloud listKeys failed:", e);
      Store.useCloud = false;
      return { ok: false, reason: "list_failed", error: e };
    }

    if (rows.length === 0) {
      if (pushLocalIfCloudEmpty && listLocalKeys().length > 0) {
        // Push everything we currently have locally up to the cloud.
        for (const k of listLocalKeys()) queuePush(k, getLocal(k));
        await drain();
        return { ok: true, action: "pushed_local" };
      }
      return { ok: true, action: "empty" };
    }

    // Cloud has data: it's the source of truth. Pull everything into cache.
    for (const k of listLocalKeys()) removeLocal(k);
    for (const { k, v, updated_at } of rows) applyFromCloud(k, v, updated_at);
    return { ok: true, action: "pulled_cloud", count: rows.length };
  }

  // ---------- exports ----------
  root.Store = {
    // generic
    get, set,
    onStatus, applyFromCloud,
    listenToStorageEvents,
    cloudPending: () => cloudQueue.length,
    flush: drain,

    // config
    getConfig, setConfig, isFrozen,

    // people
    getPeopleRows, setPeopleRows, getPeopleMap,

    // periods
    periodKey, periodPaths, currentPaths,
    readRows, writeRows,
    periodExists, listPeriods,
    generateDates, seedPeriod,

    // register (per-person, race-safe)
    readRegisterRows, readRegisterRow,
    writeRegisterRows, writeRegisterRow, removeRegisterRow,
    classifyRegisterKey,
    getRegisterMeta,

    // backup / restore
    exportAll, importAll, seedFromBundleIfEmpty,

    // cloud
    useCloud: false,
    bootFromCloud,
  };
})(window);
