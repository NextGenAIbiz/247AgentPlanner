/* UI controller. All persistence goes through window.Store; all
   scheduling logic through window.Scheduler; all spreadsheet output
   through window.Exporter. There are NO fetch() calls anywhere -- the
   app is entirely static. */
(function (root) {
  const DOW = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

  // In-memory caches (kept in sync with localStorage)
  let regData = null, demData = null, finData = null;
  let peopleData = null;
  let peopleNamesMap = {};
  let appConfig = { month: 9, year: 2026, frozen: false };

  // ---------- tiny utilities ----------
  function status(id, msg, type = "success") {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = msg;
    el.className = "status " + type;
    el.style.display = "inline-block";
    if (type !== "info") setTimeout(() => { el.style.display = "none"; }, 3000);
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
  }
  function dayOfWeek(dateStr) {
    const parts = dateStr.split("/").map(Number);
    if (parts.length !== 3) return -1;
    return new Date(parts[2], parts[0] - 1, parts[1]).getDay();
  }
  function isDateHeader(s) { return /^\d+\/\d+\/\d+/.test(s); }

  // ---------- table rendering ----------
  function renderTable(tableId, rows, opts = {}) {
    const { editable = true, colorize = false, allowDeleteRows = false,
      dateColIndex = 1, peopleMap = null, onDeleteRow = null } = opts;
    const t = document.getElementById(tableId);
    t.innerHTML = "";
    if (!rows || !rows.length) {
      t.innerHTML = '<tbody><tr><td class="empty">No data yet.</td></tr></tbody>';
      return;
    }

    const thead = document.createElement("thead");
    const trh = document.createElement("tr");
    rows[0].forEach((h, i) => {
      const th = document.createElement("th");
      if (i === 0) {
        th.textContent = h;
        th.classList.add("col-name");
      } else if (isDateHeader(h)) {
        th.classList.add("day-header");
        const dow = dayOfWeek(h);
        const short = h.replace(/\/\d{4}$/, "");
        th.innerHTML = `${short}<br><small style="font-weight:400;opacity:0.7">${DOW[dow] || ""}</small>`;
        if (dow === 0) th.classList.add("sun");
      } else {
        th.textContent = h;
      }
      trh.appendChild(th);
    });
    if (allowDeleteRows) {
      const th = document.createElement("th");
      th.classList.add("col-action");
      trh.appendChild(th);
    }
    thead.appendChild(trh);
    t.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (let r = 1; r < rows.length; r++) {
      const tr = document.createElement("tr");
      rows[r].forEach((c, i) => {
        const td = document.createElement("td");
        const isSunCol = i >= dateColIndex && rows[0][i] && isDateHeader(rows[0][i]) && dayOfWeek(rows[0][i]) === 0;

        if (i === 0) {
          td.classList.add("col-name");
          if (peopleMap) {
            const id = (c || "").trim();
            const nm = peopleMap[id] || "";
            td.innerHTML = `<span class="person-id"></span><span class="person-name"></span>`;
            td.querySelector(".person-id").textContent = id;
            td.querySelector(".person-name").textContent = nm;
          } else {
            td.textContent = c;
          }
        } else if (editable) {
          const inp = document.createElement("input");
          inp.className = "cell";
          inp.value = c || "";
          td.appendChild(inp);
          if (isSunCol) td.classList.add("col-sun");
        } else {
          const val = (c || "").trim();
          td.textContent = val || "\u00A0";
          if (colorize) {
            if (val === "N") td.classList.add("shift-N");
            else if (val === "P") td.classList.add("shift-P");
            else if (val) td.classList.add("shift-work");
            else td.classList.add("shift-empty");
          }
          if (isSunCol && !colorize) td.classList.add("col-sun");
        }
        tr.appendChild(td);
      });
      if (allowDeleteRows) {
        const td = document.createElement("td");
        td.classList.add("col-action");
        const btn = document.createElement("button");
        btn.className = "btn-danger";
        btn.textContent = "\u2715";
        btn.title = "Remove this person";
        const id = (rows[r][0] || "").trim();
        btn.onclick = async () => {
          if (onDeleteRow) {
            const handled = await onDeleteRow(id, tr);
            if (handled === false) return;
          }
          tr.remove();
        };
        td.appendChild(btn);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    t.appendChild(tbody);
  }

  function gatherTable(tableId) {
    const t = document.getElementById(tableId);
    const rows = [];
    const ths = [...t.querySelectorAll("thead th")].filter(th => !th.classList.contains("col-action"));
    const hdr = ths.map(th => {
      const first = th.innerText.split("\n")[0].trim();
      // Headers are stripped of the year for display ("8/3" instead of "8/3/2026").
      // Re-attach the year using the original data so saving doesn't lose it.
      if (/^\d+\/\d+$/.test(first)) {
        const original = regData ? regData[0] : (demData ? demData[0] : (finData ? finData[0] : null));
        if (original) {
          const found = original.find(h => typeof h === "string" && h.startsWith(first + "/"));
          if (found) return found;
        }
        return first + "/" + appConfig.year;
      }
      return first;
    });
    rows.push(hdr);
    t.querySelectorAll("tbody tr").forEach(tr => {
      const row = [];
      [...tr.querySelectorAll("td")]
        .filter(td => !td.classList.contains("col-action"))
        .forEach(td => {
          const inp = td.querySelector("input");
          if (inp) {
            row.push(inp.value.trim());
          } else if (td.classList.contains("col-name")) {
            const idSpan = td.querySelector(".person-id");
            row.push(idSpan ? idSpan.textContent.trim() : td.textContent.trim());
          } else {
            row.push(td.textContent.trim());
          }
        });
      rows.push(row);
    });
    return rows;
  }

  // ---------- tab switching ----------
  function setupTabs() {
    document.querySelectorAll(".tab").forEach(t => {
      t.onclick = () => {
        document.querySelectorAll(".tab").forEach(x => x.classList.remove("active"));
        document.querySelectorAll(".panel").forEach(x => x.classList.remove("active"));
        t.classList.add("active");
        document.getElementById(t.dataset.tab).classList.add("active");
      };
    });
  }

  // ---------- Register ----------
  function loadRegister() {
    regData = Store.readRegisterRows(appConfig.month, appConfig.year);
    if (regData.length <= 1) {
      // No data yet -- start a blank scaffold from People + month dates
      const dates = Store.generateDates(appConfig.month, appConfig.year);
      regData = [["Name", ...dates]];
      for (const r of Store.getPeopleRows().slice(1)) {
        if (r && r[0]) regData.push([r[0], ...new Array(dates.length).fill("")]);
      }
    }
    peopleNamesMap = Store.getPeopleMap();
    renderTable("reg-table", regData, {
      editable: true,
      allowDeleteRows: true,
      peopleMap: peopleNamesMap,
      onDeleteRow: async (id) => {
        if (!confirm(`Remove ${id}${peopleNamesMap[id] ? " - " + peopleNamesMap[id] : ""}?\n\nThis removes them from the People list (all months).`)) return false;
        // Drop their per-row register entry for this period too.
        Store.removeRegisterRow(id, { month: appConfig.month, year: appConfig.year });
        removePersonFromPeople(id);
        return true;
      },
    });
    renderRegisterStatus();
    applyFrozenState();
  }

  function saveRegister() {
    if (Store.isFrozen()) return frozenAlert();
    const rows = gatherTable("reg-table");
    Store.writeRegisterRows(rows, { month: appConfig.month, year: appConfig.year });
    regData = rows;
    renderRegisterStatus();
    status("reg-status", "Saved!", "success");
  }

  // Render the "X of Y registered" summary + per-person timestamp badges.
  function renderRegisterStatus() {
    const meta = Store.getRegisterMeta(appConfig.month, appConfig.year);
    const peopleMap = Store.getPeopleMap();
    const ids = Object.keys(peopleMap).length
      ? Object.keys(peopleMap)
      : (regData.slice(1).map(r => r && r[0] && String(r[0]).trim()).filter(Boolean));

    const registeredIds = ids.filter(id => meta[id]);
    const missingIds    = ids.filter(id => !meta[id]);
    const summary = document.getElementById("reg-summary");
    if (summary) {
      const missingPreview = missingIds.slice(0, 5)
        .map(id => `${id}${peopleMap[id] ? " (" + peopleMap[id] + ")" : ""}`)
        .join(", ");
      const more = missingIds.length > 5 ? `, +${missingIds.length - 5} more` : "";
      summary.innerHTML = ids.length === 0
        ? ""
        : `<b>${registeredIds.length}</b> of <b>${ids.length}</b> registered`
          + (missingIds.length
              ? ` &middot; <span class="missing-list">missing: ${missingPreview}${more}</span>`
              : ` &middot; <span class="all-in">everyone in</span>`);
    }

    // Add timestamp badges to each row's first cell.
    const t = document.getElementById("reg-table");
    if (!t) return;
    [...t.querySelectorAll("tbody tr")].forEach(tr => {
      const idCell = tr.querySelector("td.col-name");
      if (!idCell) return;
      const idEl = idCell.querySelector(".person-id");
      const id = ((idEl && idEl.textContent) || idCell.textContent || "").trim();
      const ts = meta[id];
      const old = idCell.querySelector(".reg-when");
      if (old) old.remove();
      const badge = document.createElement("span");
      if (ts) {
        badge.className = "reg-when";
        badge.title = "Last registered " + new Date(ts).toLocaleString();
        badge.textContent = formatWhen(ts);
      } else {
        badge.className = "reg-when reg-when-missing";
        badge.title = "Has not registered yet";
        badge.textContent = "not yet";
      }
      idCell.appendChild(badge);
    });
  }

  function formatWhen(iso) {
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return "";
    const diff = (Date.now() - t) / 1000;
    if (diff < 60)        return "just now";
    if (diff < 3600)      return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400)     return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
    return new Date(iso).toLocaleDateString();
  }

  // ---------- Demand ----------
  function loadDemand() {
    const paths = Store.currentPaths();
    demData = Store.readRows(paths.demand);
    if (!demData.length) {
      const dates = Store.generateDates(appConfig.month, appConfig.year);
      demData = [["Plan", ...dates], ["Sum", ...new Array(dates.length).fill("0")]];
    }
    renderTable("dem-table", demData, { editable: true });
    setupDemandAutoSum();
    applyFrozenState();
  }

  function saveDemand() {
    if (Store.isFrozen()) return frozenAlert();
    const rows = gatherTable("dem-table");
    Store.writeRows(Store.currentPaths().demand, rows);
    demData = rows;
    status("dem-status", "Saved!", "success");
  }

  function setupDemandAutoSum() {
    const t = document.getElementById("dem-table");
    if (!t) return;
    const bodyRows = [...t.querySelectorAll("tbody tr")];
    if (!bodyRows.length) return;

    let sumRow = null;
    for (let i = bodyRows.length - 1; i >= 0; i--) {
      const name = bodyRows[i].querySelector("td.col-name")?.textContent.trim().toLowerCase();
      if (name === "sum") { sumRow = bodyRows[i]; break; }
    }
    if (!sumRow) return;

    sumRow.querySelectorAll("input.cell").forEach(inp => {
      inp.readOnly = true;
      inp.classList.add("sum-cell");
      inp.tabIndex = -1;
    });

    function recompute() {
      const sumInputs = [...sumRow.querySelectorAll("input.cell")];
      const otherRows = bodyRows.filter(r => r !== sumRow);
      sumInputs.forEach((sumInp, colIdx) => {
        let total = 0;
        otherRows.forEach(r => {
          const inp = r.querySelectorAll("input.cell")[colIdx];
          if (!inp) return;
          const v = parseFloat(inp.value);
          if (!isNaN(v)) total += v;
        });
        sumInp.value = total;
      });
    }

    bodyRows.forEach(r => {
      if (r === sumRow) return;
      r.querySelectorAll("input.cell").forEach(inp => inp.addEventListener("input", recompute));
    });
    recompute();
  }

  // ---------- Final ----------
  function loadFinal() {
    const paths = Store.currentPaths();
    finData = Store.readRows(paths.final);
    peopleNamesMap = Store.getPeopleMap();
    renderTable("fin-table", finData, {
      editable: false,
      colorize: true,
      peopleMap: peopleNamesMap,
    });
  }

  function generate(forceFull = false) {
    if (Store.isFrozen()) return frozenAlert();
    status("fin-status", forceFull ? "Full regenerate..." : "Generating (smart)...", "info");

    const paths = Store.currentPaths();
    let result;
    try {
      result = Scheduler.runSchedule({
        demandRows:           Store.readRows(paths.demand),
        registerRows:         Store.readRegisterRows(appConfig.month, appConfig.year),
        prevRegisterSnapRows: Store.readRows(paths.register_snap),
        prevDemandSnapRows:   Store.readRows(paths.demand_snap),
        prevFinalRows:        Store.readRows(paths.final),
        forceFull,
      });
    } catch (e) {
      console.error(e);
      document.getElementById("report").textContent = "Error: " + (e.message || e) + "\n\n" + (e.stack || "");
      status("fin-status", "Failed (exception)", "error");
      return;
    }

    renderWarnings(result.warnings || [], result.mode, result.locked_dates, result.dirty_dates);

    if (result.ok) {
      Store.writeRows(paths.final, result.rows);
      // Snapshot the inputs so the next generate can be incremental
      Store.writeRows(paths.register_snap, Store.readRegisterRows(appConfig.month, appConfig.year));
      Store.writeRows(paths.demand_snap,   Store.readRows(paths.demand));

      finData = result.rows;
      renderTable("fin-table", finData, {
        editable: false, colorize: true, peopleMap: peopleNamesMap,
      });
      document.getElementById("report").textContent = result.report || "";
      const dirtyMsg = (result.dirty_dates && result.dirty_dates.length)
        ? ` (re-arranged ${result.dirty_dates.length} date${result.dirty_dates.length === 1 ? "" : "s"})`
        : (result.locked_dates && result.locked_dates.length ? " (no changes detected)" : "");
      status("fin-status", `Plan generated${dirtyMsg}.`, "success");
    } else {
      document.getElementById("report").textContent = result.report || "Plan could not be generated.";
      status("fin-status", "Failed: see warnings", "error");
    }
  }

  function renderWarnings(list, mode, locked, dirty) {
    const box = document.getElementById("warnings-box");
    if (!list || list.length === 0) { box.style.display = "none"; return; }
    const fatals    = list.filter(w => w.startsWith("FATAL"));
    const conflicts = list.filter(w => w.startsWith("CONFLICT"));
    const warns     = list.filter(w => !w.startsWith("FATAL") && !w.startsWith("CONFLICT"));

    let html = "";
    if (fatals.length) {
      html += `<div class="alert alert-fatal"><b>${fatals.length} FATAL issue${fatals.length===1?"":"s"} - plan cannot be generated:</b><ul>`;
      fatals.forEach(w => html += `<li>${escapeHtml(w.replace(/^FATAL[: ]*/, ""))}</li>`);
      html += "</ul></div>";
    }
    if (conflicts.length) {
      html += `<div class="alert alert-conflict"><b>${conflicts.length} conflict${conflicts.length===1?"":"s"}:</b><ul>`;
      conflicts.forEach(w => html += `<li>${escapeHtml(w.replace(/^CONFLICT[: ]*/, ""))}</li>`);
      html += "</ul></div>";
    }
    if (warns.length) {
      html += `<div class="alert alert-warn"><b>${warns.length} warning${warns.length===1?"":"s"}:</b><ul>`;
      warns.forEach(w => html += `<li>${escapeHtml(w.replace(/^WARNING[: ]*/, ""))}</li>`);
      html += "</ul></div>";
    }
    box.innerHTML = html;
    box.style.display = "block";
  }

  // ---------- People (master list) ----------
  function loadPeople() {
    peopleData = Store.getPeopleRows();
    peopleNamesMap = {};
    for (const r of peopleData.slice(1)) {
      if (r && r[0]) peopleNamesMap[r[0].trim()] = (r[1] || "").trim();
    }
    renderTable("ppl-table", peopleData, {
      editable: true,
      allowDeleteRows: true,
      onDeleteRow: async (id) => {
        if (!confirm(`Remove ${id}${peopleNamesMap[id] ? " - " + peopleNamesMap[id] : ""}?\n\nThey will no longer appear in Register / Final Plan for any month.`)) return false;
        return true;
      },
    });
    applyFrozenState();
  }

  function savePeople() {
    if (Store.isFrozen()) return frozenAlert();
    const t = document.getElementById("ppl-table");
    const rows = [];
    const ths = [...t.querySelectorAll("thead th")].filter(th => !th.classList.contains("col-action"));
    rows.push(ths.map(th => th.innerText.trim()));
    t.querySelectorAll("tbody tr").forEach(tr => {
      const row = [];
      [...tr.querySelectorAll("td")]
        .filter(td => !td.classList.contains("col-action"))
        .forEach(td => {
          const inp = td.querySelector("input");
          row.push(inp ? inp.value.trim() : td.textContent.trim());
        });
      rows.push(row);
    });
    if (!rows[0] || rows[0].length < 2) {
      status("ppl-status", "Need at least ID and Name columns.", "error"); return;
    }
    const ids = rows.slice(1).map(r => (r[0] || "").trim()).filter(Boolean);
    if (new Set(ids).size !== ids.length) {
      const dupes = [...new Set(ids.filter((v, i, a) => a.indexOf(v) !== i))].sort();
      status("ppl-status", `Duplicate IDs: ${dupes.join(", ")}`, "error"); return;
    }
    Store.setPeopleRows(rows);
    peopleData = rows;
    peopleNamesMap = {};
    for (const r of rows.slice(1)) {
      if (r && r[0]) peopleNamesMap[r[0].trim()] = (r[1] || "").trim();
    }
    status("ppl-status", "Saved!", "success");
    loadRegister();
    loadFinal();
  }

  function addPersonToPeople() {
    const t = document.getElementById("ppl-table");
    const tbody = t.querySelector("tbody");
    if (!tbody) return;
    const cols = [...t.querySelectorAll("thead th")].filter(th => !th.classList.contains("col-action")).length;
    const ids = new Set([...tbody.querySelectorAll("td.col-name")].map(td => td.textContent.trim()));
    let n = 1;
    while (ids.has("P" + n)) n++;
    const id = (prompt("Person ID:", "P" + n) || "").trim();
    if (!id) return;
    if (ids.has(id)) { alert("That ID already exists."); return; }
    const name = (prompt(`Display name for ${id}:`, "") || "").trim();

    const tr = document.createElement("tr");
    const tdId = document.createElement("td");
    tdId.classList.add("col-name");
    tdId.textContent = id;
    tr.appendChild(tdId);
    for (let i = 1; i < cols; i++) {
      const td = document.createElement("td");
      const inp = document.createElement("input");
      inp.className = "cell";
      inp.value = (i === 1) ? name : "";
      td.appendChild(inp);
      tr.appendChild(td);
    }
    const tdAct = document.createElement("td");
    tdAct.classList.add("col-action");
    const btn = document.createElement("button");
    btn.className = "btn-danger";
    btn.textContent = "\u2715";
    btn.onclick = () => {
      if (!confirm(`Remove ${id}${name ? " - " + name : ""}?`)) return;
      tr.remove();
    };
    tdAct.appendChild(btn);
    tr.appendChild(tdAct);
    tbody.appendChild(tr);
    status("ppl-status", 'Click "Save People" to persist.', "info");
  }

  function addPeopleColumn() {
    const colName = (prompt("New column name (e.g., Department, Phone, Email):") || "").trim();
    if (!colName) return;
    const t = document.getElementById("ppl-table");
    const ths = [...t.querySelectorAll("thead th")].filter(th => !th.classList.contains("col-action"));
    if (ths.some(th => th.innerText.trim().toLowerCase() === colName.toLowerCase())) {
      alert("That column already exists."); return;
    }
    const newTh = document.createElement("th");
    newTh.textContent = colName;
    const actionTh = t.querySelector("thead th.col-action");
    t.querySelector("thead tr").insertBefore(newTh, actionTh || null);
    t.querySelectorAll("tbody tr").forEach(tr => {
      const td = document.createElement("td");
      const inp = document.createElement("input");
      inp.className = "cell";
      inp.value = "";
      td.appendChild(inp);
      const actionTd = tr.querySelector("td.col-action");
      tr.insertBefore(td, actionTd || null);
    });
    status("ppl-status", `Column "${colName}" added. Click "Save People" to persist.`, "info");
  }

  // ---------- Add/remove person from Register (synced to People list) ----------
  function addPersonToRegister() {
    if (Store.isFrozen()) return frozenAlert();
    const tbody = document.querySelector("#reg-table tbody");
    if (!tbody) return;
    const existingIds = new Set([...tbody.querySelectorAll("td.col-name .person-id, td.col-name")].map(el => {
      const span = el.querySelector ? el.querySelector(".person-id") : null;
      return (span ? span.textContent : el.textContent).trim();
    }));
    let n = 1;
    while (existingIds.has("P" + n)) n++;
    const id = (prompt("Person ID (e.g., P" + n + "):", "P" + n) || "").trim();
    if (!id) return;
    if (existingIds.has(id)) { alert("That ID already exists."); return; }
    const name = (prompt(`Display name for ${id} (optional):`, "") || "").trim();

    ensurePersonInPeople(id, name);
    peopleNamesMap[id] = name;

    const t = document.getElementById("reg-table");
    const cols = t.querySelectorAll("thead th").length - 1;
    const tr = document.createElement("tr");
    const tdName = document.createElement("td");
    tdName.classList.add("col-name");
    tdName.innerHTML = `<span class="person-id"></span><span class="person-name"></span>`;
    tdName.querySelector(".person-id").textContent = id;
    tdName.querySelector(".person-name").textContent = name;
    tr.appendChild(tdName);
    for (let i = 1; i < cols; i++) {
      const td = document.createElement("td");
      const inp = document.createElement("input");
      inp.className = "cell";
      inp.value = "";
      td.appendChild(inp);
      const headerText = t.querySelectorAll("thead th")[i]?.innerText.split("\n")[0].trim();
      if (headerText && /^\d+\/\d+/.test(headerText)) {
        const m = headerText.match(/^(\d+)\/(\d+)/);
        if (m) {
          const dow = new Date(appConfig.year, parseInt(m[1], 10) - 1, parseInt(m[2], 10)).getDay();
          if (dow === 0) td.classList.add("col-sun");
        }
      }
      tr.appendChild(td);
    }
    const tdAct = document.createElement("td");
    tdAct.classList.add("col-action");
    const btn = document.createElement("button");
    btn.className = "btn-danger";
    btn.textContent = "\u2715";
    btn.title = "Remove this person";
    btn.onclick = () => {
      if (!confirm(`Remove ${id}${name ? " - " + name : ""}?\n\nThis removes them from the People list (all months).`)) return;
      removePersonFromPeople(id);
      tr.remove();
    };
    tdAct.appendChild(btn);
    tr.appendChild(tdAct);
    tbody.appendChild(tr);
  }

  function ensurePersonInPeople(id, name) {
    const rows = Store.getPeopleRows();
    if (!rows.length) rows.push(["ID", "Name"]);
    const existing = rows.slice(1).find(r => (r[0] || "").trim() === id);
    if (existing) {
      if (name && !existing[1]) existing[1] = name;
    } else {
      const newRow = [id, name || ""];
      while (newRow.length < rows[0].length) newRow.push("");
      rows.push(newRow);
    }
    Store.setPeopleRows(rows);
    peopleData = rows;
    peopleNamesMap[id] = name || "";
  }

  function removePersonFromPeople(id) {
    const rows = Store.getPeopleRows().filter((r, i) => i === 0 || (r[0] || "").trim() !== id);
    Store.setPeopleRows(rows);
    peopleData = rows;
    delete peopleNamesMap[id];
  }

  // ---------- Period / Freeze ----------
  function loadConfig() {
    appConfig = Store.getConfig();
    appConfig.periods = Store.listPeriods();
    document.getElementById("month-sel").value = appConfig.month;
    document.getElementById("year-inp").value  = appConfig.year;
    updatePeriodBadge();
    applyFrozenState();
  }

  function applyFrozenState() {
    const body = document.body;
    const banner = document.getElementById("frozen-banner");
    const btn = document.getElementById("freeze-btn");
    if (Store.isFrozen()) {
      body.classList.add("frozen");
      banner.style.display = "flex";
      btn.textContent = "Unfreeze";
      btn.classList.remove("btn-frozen");
      btn.classList.add("btn-secondary");
      document.querySelectorAll("#reg-table input.cell, #dem-table input.cell, #ppl-table input.cell").forEach(i => {
        i.readOnly = true;
      });
    } else {
      body.classList.remove("frozen");
      banner.style.display = "none";
      btn.textContent = "Freeze Plan";
      btn.classList.add("btn-frozen");
      btn.classList.remove("btn-secondary");
      document.querySelectorAll("#reg-table input.cell, #dem-table input.cell, #ppl-table input.cell").forEach(i => {
        if (!i.classList.contains("sum-cell")) i.readOnly = false;
      });
    }
  }

  function applyPeriod() {
    const m = parseInt(document.getElementById("month-sel").value, 10);
    const y = parseInt(document.getElementById("year-inp").value, 10);
    if (!m || !y) { alert("Please choose a valid month and year."); return; }
    if (Store.isFrozen()) { alert("Plan is frozen. Unfreeze first."); return; }
    if (m === appConfig.month && y === appConfig.year) { alert("Already on this period."); return; }

    const monthName = document.getElementById("month-sel").selectedOptions[0].text;
    const exists = Store.periodExists(m, y);
    const msg = exists
      ? `Switch to ${monthName} ${y}?\n\nYour saved plan for that month will be loaded.\nThe current month's data is already saved.`
      : `Switch to ${monthName} ${y}?\n\nA new empty plan will be created (using the current month's people and shifts as a template).\nThe current month's data is already saved.`;
    if (!confirm(msg)) return;

    if (!exists) {
      Store.seedPeriod(m, y, Store.currentPaths());
    }
    appConfig.month = m;
    appConfig.year  = y;
    Store.setConfig(appConfig);
    appConfig.periods = Store.listPeriods();

    updatePeriodBadge();
    loadRegister();
    loadDemand();
    loadFinal();
    status("reg-status", exists ? `Loaded saved plan for ${monthName} ${y}` : `New plan created for ${monthName} ${y}`, "success");
  }

  function updatePeriodBadge() {
    const sel = document.getElementById("month-sel");
    const yr  = parseInt(document.getElementById("year-inp").value, 10);
    const periods = appConfig.periods || [];
    [...sel.options].forEach(opt => {
      const m = parseInt(opt.value, 10);
      const has = periods.some(p => p.month === m && p.year === yr);
      const baseName = opt.textContent.replace(/ \u2022 saved$/, "");
      opt.textContent = has ? `${baseName} \u2022 saved` : baseName;
    });
    const badge = document.getElementById("period-badge");
    if (badge) badge.textContent = `${periods.length} saved month${periods.length === 1 ? "" : "s"}`;
  }

  function toggleFreeze() {
    const willFreeze = !Store.isFrozen();
    const msg = willFreeze
      ? "Freeze the plan?\nAll editing will be disabled until you unfreeze."
      : "Unfreeze the plan? Editing will be enabled again.";
    if (!confirm(msg)) return;
    appConfig.frozen = willFreeze;
    Store.setConfig(appConfig);
    applyFrozenState();
  }

  function frozenAlert() {
    alert("Plan is frozen. Unfreeze to make changes.");
  }

  // ---------- Excel + JSON I/O ----------
  function exportExcel() {
    const cfg   = Store.getConfig();
    const paths = Store.currentPaths();
    Exporter.downloadExcel(`ShiftPlan_${cfg.year}-${String(cfg.month).padStart(2,"0")}.xlsx`, [
      { name: "Final Plan", rows: Store.readRows(paths.final),                          colorize: true  },
      { name: "Register",   rows: Store.readRegisterRows(cfg.month, cfg.year),          colorize: false },
      { name: "Demand",     rows: Store.readRows(paths.demand),                         colorize: false },
    ]);
  }

  function exportBackup() {
    const data = Store.exportAll();
    const cfg = Store.getConfig();
    Exporter.downloadJSON(`ShiftPlanner_backup_${cfg.year}-${String(cfg.month).padStart(2,"0")}.json`, data);
  }

  function setupRestoreInput() {
    const inp = document.getElementById("restore-input");
    if (!inp) return;
    inp.addEventListener("change", () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      const merge = confirm(
        "Restore from backup file:\n\n" +
        "OK = MERGE (keep existing data, overwrite by key)\n" +
        "Cancel = REPLACE (wipe all current data first)"
      );
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const payload = JSON.parse(e.target.result);
          Store.importAll(payload, { merge });
          loadConfig();
          loadPeople();
          loadRegister();
          loadDemand();
          loadFinal();
          status("reg-status", "Backup restored.", "success");
        } catch (err) {
          alert("Could not restore: " + (err.message || err));
        } finally {
          inp.value = "";
        }
      };
      reader.readAsText(f);
    });
  }

  // ---------- PIN gate ----------
  async function sha256Hex(text) {
    const buf = new TextEncoder().encode(text);
    const hash = await crypto.subtle.digest("SHA-256", buf);
    return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, "0")).join("");
  }

  async function setupPinGate() {
    const gate     = document.getElementById("pin-gate");
    const input    = document.getElementById("pin-input");
    const btn      = document.getElementById("pin-btn");
    const errEl    = document.getElementById("pin-error");
    const msgEl    = document.getElementById("pin-msg");

    // Pull the stored hash. Read directly from cloud first if configured,
    // because a different admin browser may have set it.
    let storedHash = null;
    if (Cloud.isConfigured()) {
      try {
        Cloud.init();
        storedHash = await Cloud.get("admin_pin_hash");
      } catch (_) { /* fall back to local */ }
    }
    if (!storedHash) {
      const local = Store.get("admin_pin_hash");
      try { storedHash = local ? JSON.parse(local) : null; } catch (_) { storedHash = local; }
    }

    return new Promise((resolve) => {
      const isFirstTime = !storedHash;
      if (isFirstTime) {
        msgEl.textContent = "First-time setup. Choose an admin PIN (4+ characters). Anyone who knows this PIN can edit the plan.";
        btn.textContent = "Set PIN";
      }

      const showError = (msg) => {
        errEl.textContent = msg; errEl.style.display = "block";
        setTimeout(() => { errEl.style.display = "none"; }, 4000);
      };

      const submit = async () => {
        const pin = (input.value || "").trim();
        if (!pin) return;
        if (isFirstTime) {
          if (pin.length < 4) return showError("PIN must be at least 4 characters.");
          const hash = await sha256Hex(pin);
          // Save in both places. If cloud isn't configured, only local.
          Store.set("admin_pin_hash", JSON.stringify(hash));
          if (Cloud.isConfigured()) {
            try { await Cloud.set("admin_pin_hash", hash); } catch (e) { console.warn("could not push PIN hash to cloud", e); }
          }
        } else {
          const hash = await sha256Hex(pin);
          if (hash !== storedHash) return showError("Wrong PIN.");
        }
        gate.classList.add("hidden");
        resolve();
      };

      btn.onclick = submit;
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
      setTimeout(() => input.focus(), 50);
    });
  }

  // ---------- cloud sync indicator ----------
  function updateCloudBadge(state, queueSize) {
    const el = document.getElementById("cloud-badge");
    if (!el) return;
    el.classList.remove("ok", "warn", "err", "local");
    if (!Store.useCloud) {
      el.classList.add("local");
      el.innerHTML = '<span class="dot"></span>local only';
      el.title = "Cloud not configured \u2014 changes are saved only in this browser (admin and register tabs in the same browser still sync live). Edit js/config.js to enable cross-device sync.";
    } else if (state === "err") {
      el.classList.add("err");
      el.innerHTML = '<span class="dot"></span>sync error';
      el.title = "A cloud write failed. The next change will retry. See console for details.";
    } else if (queueSize > 0) {
      el.classList.add("warn");
      el.innerHTML = '<span class="dot"></span>syncing\u2026';
      el.title = `${queueSize} change(s) waiting to be sent to the cloud.`;
    } else {
      el.classList.add("ok");
      el.innerHTML = '<span class="dot"></span>live';
      el.title = "Connected to cloud. Changes appear instantly for everyone.";
    }
  }

  // ---------- Live updates (cloud + cross-tab) ----------
  let suppressLiveReload = false;
  let regRefreshPending = false;

  // Coalesce cross-period register notifications: if many users register at
  // once for a period the admin isn't viewing, we want one summary toast,
  // not 18 in a row.
  const crossPeriodHintBatch = new Map(); // periodKey -> Set of personIds
  let crossPeriodHintTimer = null;

  function showCrossPeriodHint() {
    crossPeriodHintTimer = null;
    const adminLbl = Store.periodKey(appConfig.month, appConfig.year);
    const lines = [];
    for (const [periodKey, ids] of crossPeriodHintBatch.entries()) {
      const arr = [...ids];
      const list = arr.length > 3 ? `${arr.slice(0, 3).join(", ")} +${arr.length - 3} more` : arr.join(", ");
      lines.push(`${list} → ${periodKey}`);
    }
    crossPeriodHintBatch.clear();
    status("reg-status",
      `Team registered (you're viewing ${adminLbl}): ${lines.join("; ")}`,
      "info");
  }

  // Decide which UI piece to refresh based on which key changed.
  function applyExternalChange(k) {
    const cur = Store.currentPaths();
    const regKind = Store.classifyRegisterKey(k, appConfig.month, appConfig.year);
    const periodMatch = k && k.match(/^period:(\d{4})-(\d{2}):/);

    if (k === "people") {
      // The People list changed on another browser. Refresh People AND
      // every tab that shows person names (Register + Final Plan), so the
      // Name column reflects the new value immediately.
      loadPeople();
      loadRegister();
      loadFinal();
    }
    else if (k === "config") {
      const newCfg = Store.getConfig();
      appConfig = { ...appConfig, ...newCfg, periods: Store.listPeriods() };
      document.getElementById("month-sel").value = appConfig.month;
      document.getElementById("year-inp").value  = appConfig.year;
      applyFrozenState();
      loadRegister(); loadDemand(); loadFinal();
    }
    else if (regKind) {
      // Current-period register change (header / per-person row / legacy
      // single-blob). Coalesce rapid-fire row updates (one batch from many
      // users) into a single re-render so we don't thrash the table.
      console.debug("[live-sync] register update for current period:", k);
      if (!regRefreshPending) {
        regRefreshPending = true;
        setTimeout(() => { regRefreshPending = false; loadRegister(); }, 150);
      }
    }
    else if (k === cur.demand) loadDemand();
    else if (k === cur.final)  loadFinal();
    else if (periodMatch) {
      // A period:* key changed for some OTHER period than the one the admin
      // is currently viewing. Refresh the period dropdown so the "saved"
      // indicator is up to date, and surface a soft hint when team members
      // are registering somewhere the admin isn't looking.
      appConfig.periods = Store.listPeriods();
      updatePeriodBadge();
      const regRow = k.match(/^period:(\d{4})-(\d{2}):reg_row\.(.+)$/);
      if (regRow) {
        const otherPeriodKey = `${regRow[1]}-${regRow[2]}`;
        const personId = regRow[3];
        if (!crossPeriodHintBatch.has(otherPeriodKey)) crossPeriodHintBatch.set(otherPeriodKey, new Set());
        crossPeriodHintBatch.get(otherPeriodKey).add(personId);
        if (!crossPeriodHintTimer) crossPeriodHintTimer = setTimeout(showCrossPeriodHint, 1000);
      }
    }
    // Snapshots are intentionally ignored.
  }

  function attachCloudLiveSync() {
    if (!Store.useCloud) return;
    Cloud.subscribe(({ k, v, updated_at }) => {
      // Apply to local cache (and capture per-row update timestamps)
      Store.applyFromCloud(
        k,
        v == null ? null : (typeof v === "string" ? v : JSON.stringify(v)),
        updated_at
      );
      if (suppressLiveReload) return;
      applyExternalChange(k);
    });
  }

  // Cross-tab sync via the browser's storage event. Works without Supabase --
  // when the register tab saves in this same browser, the admin tab refreshes.
  function attachStorageLiveSync() {
    Store.listenToStorageEvents(({ k }) => {
      if (suppressLiveReload) return;
      applyExternalChange(k);
    });
  }

  // ---------- Boot ----------
  async function boot() {
    setupTabs();
    setupRestoreInput();
    document.getElementById("year-inp").addEventListener("input", updatePeriodBadge);
    document.getElementById("month-sel").addEventListener("change", updatePeriodBadge);

    Store.onStatus(updateCloudBadge);

    // Configured-cloud path: pull from cloud BEFORE rendering.
    // Local-only path: bootstrap from seed.js if storage is empty.
    if (Cloud.isConfigured()) {
      // PIN gate first (so we don't render anything before the user is admitted)
      await setupPinGate();

      // Pull. If cloud is empty AND we have local data, push local up first.
      const result = await Store.bootFromCloud({ pushLocalIfCloudEmpty: true });
      if (!result.ok) {
        console.warn("Cloud boot failed:", result);
        Store.useCloud = false;
      }
      // If everything (cloud + local) is empty, fall back to bundled seed.
      if (Store.useCloud && result.action === "empty") {
        Store.seedFromBundleIfEmpty();
        // ...and push the seeded data up so other users see it
        try {
          for (const k of Object.keys(Store.exportAll().keys)) {
            const v = Store.get(k);
            if (v != null) await Cloud.set(k, v);
          }
        } catch (e) { console.warn("seed push failed", e); }
      }
    } else {
      // No cloud: behave like before (local only, no PIN -- there's no
      // multi-user concern in this mode).
      Store.seedFromBundleIfEmpty();
      document.getElementById("pin-gate").classList.add("hidden");
    }

    updateCloudBadge("ok", 0);

    loadConfig();
    loadPeople();
    loadRegister();
    loadDemand();
    loadFinal();
    applyFrozenState();

    attachCloudLiveSync();
    attachStorageLiveSync();
  }

  // Public surface used by inline onclick=
  root.App = {
    saveRegister, loadRegister, addPersonToRegister,
    saveDemand, loadDemand,
    generate,
    loadPeople, savePeople, addPersonToPeople, addPeopleColumn,
    applyPeriod, toggleFreeze, exportExcel, exportBackup,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})(window);
