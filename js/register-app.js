/* End-user Register page.
 *
 * No tabs, no admin controls. The user picks their name from a dropdown,
 * sees their row of shift cells for the active period (set by the admin),
 * fills it in, and clicks Save. Save writes only this one row of the
 * shared Register CSV in the cloud, then notifies subscribers (the admin's
 * page) immediately via Supabase Realtime.
 */
(function () {
  const DOW = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  let appConfig = null;
  let dates = [];
  let myHeader = null;       // the period's date header (just for layout)
  let myRow = null;          // the user's own row [id, ...values]
  let finRows = null;        // current Final.csv rows (read-only)
  let myId = null;

  // Persist the user's last-used name in the browser so they don't have to
  // pick it every time.
  const NAME_KEY = "nga.register_page.last_name";

  function status(msg, type = "success") {
    const el = document.getElementById("reg-status");
    el.textContent = msg;
    el.className = "status " + type;
    el.style.display = "inline-block";
    if (type !== "info") setTimeout(() => { el.style.display = "none"; }, 3000);
  }

  function dayOfWeek(dateStr) {
    const [m, d, y] = dateStr.split("/").map(Number);
    return new Date(y, m - 1, d).getDay();
  }

  function updateBadge(state, queueSize) {
    const el = document.getElementById("cloud-badge");
    if (!el) return;
    el.classList.remove("ok", "warn", "err", "local");
    if (!Store.useCloud) {
      el.classList.add("local");
      el.innerHTML = '<span class="dot"></span>local only';
      el.title = "Cloud sync is not configured. Your changes are saved only in this browser (other tabs in the same browser still see them live). Ask the admin to enable cloud sync to share across devices.";
    } else if (state === "err") {
      el.classList.add("err"); el.innerHTML = '<span class="dot"></span>sync error';
    } else if (queueSize > 0) {
      el.classList.add("warn"); el.innerHTML = '<span class="dot"></span>saving\u2026';
    } else {
      el.classList.add("ok"); el.innerHTML = '<span class="dot"></span>live';
    }
  }

  // ---------- People dropdown ----------
  function fillNameDropdown() {
    const sel = document.getElementById("name-sel");
    const previous = sel.value || localStorage.getItem(NAME_KEY) || "";
    const map = Store.getPeopleMap();

    // Wipe and rebuild
    while (sel.options.length > 1) sel.remove(1);
    const ids = Object.keys(map);
    if (!ids.length) {
      const opt = document.createElement("option");
      opt.disabled = true;
      opt.textContent = "(no people configured \u2014 ask the admin)";
      sel.appendChild(opt);
      return;
    }
    for (const id of ids) {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = map[id] ? `${map[id]} (${id})` : id;
      sel.appendChild(opt);
    }
    if (ids.includes(previous)) sel.value = previous;
  }

  // ---------- Period info ----------
  // Register page ALWAYS targets next month based on the current date,
  // independently of whatever the admin happens to be working on.
  function nextMonth() {
    const now = new Date();
    let m = now.getMonth() + 2;   // +1 next month, +1 because getMonth is 0-indexed
    let y = now.getFullYear();
    if (m > 12) { m -= 12; y += 1; }
    return { month: m, year: y };
  }

  function refreshPeriodInfo() {
    const { month, year } = nextMonth();
    const adminCfg = Store.getConfig();
    // Only treat the page as "frozen" if the admin has frozen the very same
    // period the team is registering for (otherwise admin's freeze is for
    // some unrelated month and shouldn't block these registrations).
    const frozen = !!(adminCfg.frozen && adminCfg.month === month && adminCfg.year === year);
    appConfig = { month, year, frozen };

    const monthName = ["", "January","February","March","April","May","June",
                       "July","August","September","October","November","December"][month];
    const txt = document.getElementById("period-info");
    txt.textContent = `Registering for: ${monthName} ${year}` + (frozen ? " (FROZEN \u2014 read-only)" : "");
    txt.style.color = frozen ? "#dc2626" : "#6b7280";

    dates = Store.generateDates(month, year);
  }

  // Read just the user's own row (and the period's header).
  function loadMyRow() {
    if (!myId) { myHeader = ["Name", ...dates]; myRow = null; return; }
    const r = Store.readRegisterRow(myId, appConfig.month, appConfig.year);
    myHeader = r.header;
    myRow = r.row;
  }

  function loadFinalRows() {
    const paths = Store.periodPaths(appConfig.month, appConfig.year);
    finRows = Store.readRows(paths.final);
  }

  // ---------- Render the user's single row ----------
  function renderMyRow() {
    const area = document.getElementById("row-area");
    const tbar = document.getElementById("row-toolbar");
    if (!myId) {
      area.className = "register-empty";
      area.textContent = "Pick your name to begin.";
      tbar.style.display = "none";
      document.getElementById("final-card").style.display = "none";
      return;
    }

    // myRow always has the user's data (or a blank row if first time)
    let row = myRow ? myRow.slice() : [myId, ...new Array(dates.length).fill("")];
    // pad/truncate to current dates
    row = [myId, ...dates.map((_, i) => (row[i + 1] !== undefined ? row[i + 1] : ""))];

    const headerDates = (myHeader || []).slice(1).filter(Boolean);
    const dateCols = headerDates.length === dates.length ? headerDates : dates;

    // Build the table
    area.className = "table-wrap";
    area.innerHTML = "";
    const t = document.createElement("table");
    t.className = "register-row-table";
    const thead = document.createElement("thead");
    const trh = document.createElement("tr");
    const thName = document.createElement("th"); thName.classList.add("col-name"); thName.textContent = "You"; trh.appendChild(thName);
    dateCols.forEach((h) => {
      const th = document.createElement("th");
      const dow = dayOfWeek(h);
      const short = h.replace(/\/\d{4}$/, "");
      th.classList.add("day-header");
      th.innerHTML = `${short}<br><small style="font-weight:400;opacity:0.7">${DOW[dow]||""}</small>`;
      if (dow === 0) th.classList.add("sun");
      trh.appendChild(th);
    });
    thead.appendChild(trh); t.appendChild(thead);

    const tbody = document.createElement("tbody");
    const tr = document.createElement("tr");
    const tdName = document.createElement("td"); tdName.classList.add("col-name");
    tdName.innerHTML = `<span class="person-id"></span><span class="person-name"></span>`;
    tdName.querySelector(".person-id").textContent = myId;
    tdName.querySelector(".person-name").textContent = Store.getPeopleMap()[myId] || "";
    tr.appendChild(tdName);
    dateCols.forEach((h, i) => {
      const td = document.createElement("td");
      const dow = dayOfWeek(h);
      const isSun = dow === 0;
      if (isSun) td.classList.add("col-sun");
      const inp = document.createElement("input");
      inp.className = "cell";
      inp.value = isSun ? "N" : (row[i + 1] || "");
      if (isSun || appConfig.frozen) inp.readOnly = true;
      td.appendChild(inp);
      tr.appendChild(td);
    });
    tbody.appendChild(tr); t.appendChild(tbody);
    area.appendChild(t);

    tbar.style.display = appConfig.frozen ? "none" : "flex";
    if (appConfig.frozen) status("Plan is frozen \u2014 ask the admin to unfreeze.", "warn");

    renderFinalForMe();
  }

  // Returns the user's row as [id, ...dateValues]
  function gatherMyRow() {
    const inputs = document.querySelectorAll("#row-area input.cell");
    return [myId, ...[...inputs].map(i => i.value.trim())];
  }

  function renderFinalForMe() {
    const card = document.getElementById("final-card");
    const slot = document.getElementById("final-row");
    if (!myId || !finRows || !finRows.length) {
      card.style.display = "none";
      return;
    }
    const row = finRows.slice(1).find(r => (r[0] || "").trim() === myId);
    const headerDates = (finRows[0] || []).slice(1).filter(Boolean);
    if (!row || !headerDates.length) {
      card.style.display = "block";
      slot.innerHTML = '<span class="none">No plan generated yet for this period.</span>';
      return;
    }
    card.style.display = "block";
    let html = '<div class="table-wrap"><table>';
    html += "<thead><tr>";
    headerDates.forEach(h => {
      const dow = dayOfWeek(h);
      const cls = dow === 0 ? "day-header sun" : "day-header";
      const short = h.replace(/\/\d{4}$/, "");
      html += `<th class="${cls}">${short}<br><small style="font-weight:400;opacity:0.7">${DOW[dow]||""}</small></th>`;
    });
    html += "</tr></thead><tbody><tr>";
    headerDates.forEach((h, i) => {
      const dow = dayOfWeek(h);
      const v = (row[i + 1] || "").trim();
      let cls = "shift-empty";
      if (v === "N") cls = "shift-N";
      else if (v === "P") cls = "shift-P";
      else if (v) cls = "shift-work";
      else if (dow === 0) cls = "col-sun";
      html += `<td class="${cls}">${v || "&nbsp;"}</td>`;
    });
    html += "</tr></tbody></table></div>";
    slot.innerHTML = html;
  }

  // ---------- Save / Reload ----------
  function save() {
    if (!myId) return;
    // Only the next-month freeze blocks editing here.
    if (appConfig.frozen) { alert("Plan for this month is frozen. Ask the admin to unfreeze."); return; }

    const newRow = gatherMyRow();
    const dateValues = newRow.slice(1);

    // Per-row write -- this targets ONLY this user's cloud row, so two users
    // saving at the same instant cannot overwrite each other.
    Store.writeRegisterRow(myId, dateValues, { month: appConfig.month, year: appConfig.year });
    myRow = newRow;
    status("Saved!", "success");
  }

  function reload() {
    loadMyRow();
    loadFinalRows();
    renderMyRow();
    status("Reloaded.", "info");
  }

  // ---------- Live updates (cloud + cross-tab) ----------
  function applyExternalChange(k) {
    const finalKey = `period:${Store.periodKey(appConfig.month, appConfig.year)}:final`;
    const regKind  = Store.classifyRegisterKey(k, appConfig.month, appConfig.year);

    if (k === "people") {
      // Admin renamed/added/removed someone on another device. Refresh the
      // dropdown immediately. Also re-render the user's row so the name shown
      // next to the ID updates -- but only if the user isn't mid-edit, so we
      // never throw away unsaved input.
      fillNameDropdown();
      const inputs = document.querySelectorAll("#row-area input.cell");
      const dirty = myId && [...inputs].some(i => i === document.activeElement);
      if (!dirty) renderMyRow();
    }
    else if (k === "config") {
      // Only the freeze flag is interesting -- our period is fixed by the clock.
      refreshPeriodInfo();
      renderMyRow();
    }
    else if (regKind === "row:" + myId || regKind === "header" || regKind === "legacy") {
      // The admin (or this user, in another tab) touched the user's own row,
      // the period header, or pushed a legacy migration. Refresh -- but
      // never blow away what the user is currently typing.
      const inputs = document.querySelectorAll("#row-area input.cell");
      const dirty = myId && [...inputs].some(i => i === document.activeElement);
      if (!dirty) {
        loadMyRow();
        renderMyRow();
      }
    }
    // Other people's row updates (regKind === "row:<otherId>") -- ignored.
    else if (k === finalKey) {
      loadFinalRows();
      renderFinalForMe();
    }
  }

  function attachCloudLiveSync() {
    if (!Store.useCloud) return;
    Cloud.subscribe(({ k, v, updated_at }) => {
      Store.applyFromCloud(
        k,
        v == null ? null : (typeof v === "string" ? v : JSON.stringify(v)),
        updated_at
      );
      applyExternalChange(k);
    });
  }

  function attachStorageLiveSync() {
    Store.listenToStorageEvents(({ k }) => applyExternalChange(k));
  }

  // ---------- Boot ----------
  async function boot() {
    Store.onStatus(updateBadge);

    if (Cloud.isConfigured()) {
      const result = await Store.bootFromCloud({ pushLocalIfCloudEmpty: false });
      if (!result.ok) {
        console.warn("Cloud boot failed:", result);
        // fall back to local
        Store.seedFromBundleIfEmpty();
      }
    } else {
      Store.seedFromBundleIfEmpty();
    }
    updateBadge("ok", 0);

    refreshPeriodInfo();
    fillNameDropdown();
    loadFinalRows();

    // Restore last name
    const sel = document.getElementById("name-sel");
    const prev = localStorage.getItem(NAME_KEY) || "";
    if (prev && [...sel.options].some(o => o.value === prev)) {
      sel.value = prev;
      myId = prev;
    }
    loadMyRow();
    renderMyRow();

    sel.addEventListener("change", () => {
      myId = sel.value || null;
      if (myId) localStorage.setItem(NAME_KEY, myId);
      loadMyRow();
      renderMyRow();
    });

    attachCloudLiveSync();
    attachStorageLiveSync();
  }

  window.RegApp = { save, reload };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
