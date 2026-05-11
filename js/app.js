/* UI controller. All persistence goes through window.Store; all
   scheduling logic through window.Scheduler; all spreadsheet output
   through window.Exporter. There are NO fetch() calls anywhere -- the
   app is entirely static. */
(function (root) {
  const DOW = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

  // In-memory caches (kept in sync with localStorage)
  let regData = null;
  let peopleData = null;
  let peopleNamesMap = {};
  let groupsData = null;     // [{id, name}, ...]
  let shiftTypesData = null; // [{code, desc}, ...]
  let plansData = null;      // [{id, name, groupIds:[], shifts:[]}, ...]
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

  // ---------- echo-suppression helpers ----------
  // Used by applyExternalChange to detect "self-echo" cloud notifications.
  // When we ourselves just persisted something, Supabase Realtime will
  // broadcast the same value back to us; if we re-render blindly, any
  // in-progress UI state (clicked checkbox, focused input, warning box,
  // warning box, status pill...) gets wiped.
  //
  // We have two suppression mechanisms:
  // 1. Structural compare (samePlans / sameRows below) -- works for in-memory
  //    arrays like plansData but unreliable for tables rendered into DOM
  //    (CSV serialize <-> DOM textContent round-trip is lossy).
  // 2. Recent-write marker (markSelfWrite / isSelfEcho below) -- bulletproof
  //    because we know which keys we just wrote. We use this for the writes
  //    that come out of generatePlan / persistPlanMeta etc. so that the
  //    Realtime echo a few seconds later doesn't tear down warnings/status.
  const recentSelfWrites = new Map(); // key -> Date.now()
  const SELF_ECHO_WINDOW_MS = 8000;
  function markSelfWrite(key) {
    if (!key) return;
    recentSelfWrites.set(key, Date.now());
  }
  function isSelfEcho(key) {
    const t = recentSelfWrites.get(key);
    if (t == null) return false;
    if (Date.now() - t > SELF_ECHO_WINDOW_MS) {
      recentSelfWrites.delete(key);
      return false;
    }
    return true;
  }

  // Thin wrappers around the plan-scoped Store writers that also mark the
  // written key as a "recent self-write". Use these instead of calling
  // Store.* directly so that the Realtime echo for this exact key gets
  // suppressed in applyExternalChange and doesn't tear down UI state.
  function setPlansMarked(plans) {
    const opts = { month: appConfig.month, year: appConfig.year };
    markSelfWrite(`period:${String(opts.year).padStart(4,"0")}-${String(opts.month).padStart(2,"0")}:plans`);
    Store.setPlans(plans, opts);
  }
  function writePlanDemandMarked(planId, rows) {
    const opts = { month: appConfig.month, year: appConfig.year };
    markSelfWrite(Store.planDemandKey(planId, opts.month, opts.year));
    Store.writePlanDemand(planId, rows, opts);
  }
  function writePlanFinalMarked(planId, rows) {
    const opts = { month: appConfig.month, year: appConfig.year };
    markSelfWrite(Store.planFinalKey(planId, opts.month, opts.year));
    Store.writePlanFinal(planId, rows, opts);
  }
  function writePlanSnapshotsMarked(planId, demRows, regRows) {
    const opts = { month: appConfig.month, year: appConfig.year };
    markSelfWrite(Store.planDemandSnapKey(planId, opts.month, opts.year));
    markSelfWrite(Store.planRegisterSnapKey(planId, opts.month, opts.year));
    Store.writePlanSnapshots(planId, demRows, regRows, opts);
  }

  function samePlans(a, b) {
    a = Array.isArray(a) ? a : [];
    b = Array.isArray(b) ? b : [];
    if (a.length !== b.length) return false;
    // Order matters (we render in array order), but we still want a stable
    // structural comparison for each plan.
    try { return JSON.stringify(a) === JSON.stringify(b); }
    catch (_) { return false; }
  }
  function sameRows(a, b) {
    a = Array.isArray(a) ? a : [];
    b = Array.isArray(b) ? b : [];
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      const ra = a[i] || [], rb = b[i] || [];
      if (ra.length !== rb.length) return false;
      for (let j = 0; j < ra.length; j++) {
        if (String(ra[j] == null ? "" : ra[j]) !== String(rb[j] == null ? "" : rb[j])) return false;
      }
    }
    return true;
  }

  // ---------- table rendering ----------
  // `tableIdOrEl` may be either a DOM id (string) or the <table> element
  // itself. Accepting the element lets callers render into a freshly-created
  // table that hasn't been attached to document yet (getElementById would
  // miss it in that case).
  function renderTable(tableIdOrEl, rows, opts = {}) {
    const { editable = true, colorize = false, allowDeleteRows = false,
      dateColIndex = 1, peopleMap = null, peopleGroupMap = null,
      groupNameMap = null, onDeleteRow = null } = opts;
    const t = (typeof tableIdOrEl === "string")
      ? document.getElementById(tableIdOrEl)
      : tableIdOrEl;
    if (!t) {
      console.warn("[shift-planner] renderTable: target not found:", tableIdOrEl);
      return;
    }
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
            const groupId = peopleGroupMap ? (peopleGroupMap[id] || "") : "";
            const groupName = (groupId && groupNameMap) ? (groupNameMap[groupId] || groupId) : "";
            td.innerHTML = `<span class="person-id"></span><span class="person-name"></span><span class="person-group"></span>`;
            td.querySelector(".person-id").textContent = id;
            td.querySelector(".person-name").textContent = nm;
            const grpEl = td.querySelector(".person-group");
            if (groupName) { grpEl.textContent = groupName; }
            else { grpEl.remove(); }
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
      // Re-attach the year using the active period.
      if (/^\d+\/\d+$/.test(first)) {
        if (regData && regData[0]) {
          const found = regData[0].find(h => typeof h === "string" && h.startsWith(first + "/"));
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
        const target = t.dataset.tab;
        document.getElementById(target).classList.add("active");
        // Safety net: when the admin navigates to a tab, refresh that tab
        // from storage so it reflects the latest state. Surgical DOM updates
        // can miss in rare race conditions (stale plan references, missing
        // Final card at moment of edit, etc.), so a deterministic reload on
        // tab activation guarantees the view is always in sync.
        try {
          if (target === "final")   loadFinal();
          else if (target === "demand")  loadDemand();
          else if (target === "register") loadRegister();
          else if (target === "setting") { loadPeople(); loadGroups(); loadShiftTypes(); loadSchedulingRules(); }
        } catch (e) {
          console.warn("[shift-planner] tab refresh failed for", target, e);
        }
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
    const peopleGroupMap = Store.getPeopleGroupMap();
    const groupNameMap   = Store.getGroupNameMap();
    renderTable("reg-table", regData, {
      editable: true,
      allowDeleteRows: true,
      peopleMap: peopleNamesMap,
      peopleGroupMap,
      groupNameMap,
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

  // ---------- Demand (multi-plan) ----------
  function loadDemand() {
    plansData  = Store.getPlans(appConfig.month, appConfig.year);
    groupsData = Store.getGroups();
    shiftTypesData = Store.getShiftTypes();
    renderPlansContainer();
    applyFrozenState();
  }

  function planById(id) { return (plansData || []).find(p => p.id === id) || null; }

  function uniquePlanId(prefix) {
    const ids = new Set((plansData || []).map(p => p.id));
    let n = 1;
    while (ids.has(`${prefix}${n}`)) n++;
    return `${prefix}${n}`;
  }

  function addPlan() {
    if (Store.isFrozen()) return frozenAlert();
    try { return _addPlanInner(); }
    catch (e) {
      console.error("[shift-planner] addPlan failed:", e);
      alert("Could not add plan. See browser console for details.\n\n" + (e.message || e));
    }
  }
  function _addPlanInner() {
    // Re-pull from storage so we see the latest saved values, even if the
    // user navigated away from the Setting tab without saving (in which case
    // we want to validate against what's persisted, not stale UI state).
    groupsData     = Store.getGroups();
    shiftTypesData = Store.getShiftTypes();
    plansData      = Store.getPlans(appConfig.month, appConfig.year);

    console.debug("[shift-planner] addPlan groups=", groupsData.length,
                  "shiftTypes=", shiftTypesData.length,
                  "plans=", plansData.length);

    if (!groupsData || groupsData.length === 0) {
      alert(
        "No groups defined yet.\n\n" +
        "Go to the Setting tab \u2192 Groups \u2192 click \"+ Add Group\", " +
        "then click \"Save Groups\" before adding a plan."
      );
      return;
    }
    if (!shiftTypesData || shiftTypesData.length === 0) {
      alert(
        "No shift types defined yet.\n\n" +
        "Go to the Setting tab \u2192 Shift Types \u2192 click \"+ Add Shift\", " +
        "then click \"Save Shift Types\" before adding a plan."
      );
      return;
    }

    const name = (prompt("Plan name (e.g. \"Agent Call 1\"):", `Plan ${plansData.length + 1}`) || "").trim();
    if (!name) return;

    // New plan defaults to: no groups (admin picks via checkboxes), all shifts.
    const newPlan = {
      id:       uniquePlanId("PLAN"),
      name,
      groupIds: [],
      shifts:   shiftTypesData.map(s => s.code),
    };
    plansData.push(newPlan);
    setPlansMarked(plansData);

    // Seed an empty demand table for this plan with all shifts.
    const dates = Store.generateDates(appConfig.month, appConfig.year);
    const demand = [["Plan", ...dates]];
    for (const s of newPlan.shifts) demand.push([s, ...new Array(dates.length).fill("0")]);
    demand.push(["Sum", ...new Array(dates.length).fill("0")]);
    writePlanDemandMarked(newPlan.id, demand);

    console.debug("[shift-planner] addPlan created:", newPlan);
    renderPlansContainer();
    renderFinalsContainer();
    status("dem-status", `Plan "${name}" added. Tick its groups and adjust the demand below.`, "success");
  }

  function deletePlan(planId) {
    if (Store.isFrozen()) return frozenAlert();
    const p = planById(planId);
    if (!p) return;
    if (!confirm(`Remove plan "${p.name}"?\n\nThis deletes its demand, final and snapshots for ${appConfig.month}/${appConfig.year}.`)) return;
    plansData = plansData.filter(x => x.id !== planId);
    setPlansMarked(plansData);
    Store.deletePlanData(planId, { month: appConfig.month, year: appConfig.year });
    renderPlansContainer();
    renderFinalsContainer();
  }

  function persistPlanMeta() {
    setPlansMarked(plansData);
  }

  function renderPlansContainer() {
    const box = document.getElementById("plans-container");
    if (!box) return;
    // Defensive: in pathological boot orderings plansData may not yet be set.
    if (!Array.isArray(plansData)) plansData = Store.getPlans(appConfig.month, appConfig.year);
    box.innerHTML = "";
    if (!plansData || plansData.length === 0) {
      const groups = Store.getGroups();
      const shifts = Store.getShiftTypes();
      const missing = [];
      if (groups.length === 0) missing.push("<b>Groups</b>");
      if (shifts.length === 0) missing.push("<b>Shift Types</b>");

      let html = '<div class="empty-hint">No plans yet for this period.';
      if (missing.length) {
        html += '<br><br>Before adding a plan, go to the <b>Setting</b> tab and create ' +
                missing.join(" and ") +
                ' (don\'t forget to click <b>Save</b> after adding rows).';
      } else {
        html += ' Click <b>+ Add Plan</b> above to create one. ' +
                'Each plan covers a set of groups + a set of shift types.';
      }
      html += '</div>';
      box.innerHTML = html;
      return;
    }
    plansData.forEach(p => box.appendChild(renderPlanCard(p)));
  }

  function renderPlanCard(plan) {
    if (!plan || typeof plan !== "object") {
      console.warn("[shift-planner] renderPlanCard called with invalid plan:", plan);
      return document.createElement("div");
    }
    // Defensive: make sure all the arrays we read from below exist, even if
    // the persisted JSON was somehow malformed.
    plan.groupIds = Array.isArray(plan.groupIds) ? plan.groupIds : [];
    plan.shifts   = Array.isArray(plan.shifts)   ? plan.shifts   : [];
    if (!Array.isArray(groupsData))     groupsData     = Store.getGroups();
    if (!Array.isArray(shiftTypesData)) shiftTypesData = Store.getShiftTypes();

    const card = document.createElement("div");
    card.className = "plan-card";
    card.dataset.planId = plan.id;

    // Header: name input + group picker + delete
    const header = document.createElement("div");
    header.className = "plan-header";
    const nameInp = document.createElement("input");
    nameInp.type = "text";
    nameInp.value = plan.name || "";
    nameInp.placeholder = "Plan name";
    nameInp.addEventListener("change", () => {
      plan.name = nameInp.value.trim() || plan.id;
      persistPlanMeta();
      updateFinalCardTitle(plan);
    });
    header.appendChild(nameInp);

    const groupPicker = document.createElement("div");
    groupPicker.className = "group-picker";
    if (!groupsData.length) {
      const span = document.createElement("span");
      span.style.color = "#9ca3af"; span.style.fontSize = "12px";
      span.textContent = "(no groups defined yet)";
      groupPicker.appendChild(span);
    } else {
      for (const g of groupsData) {
        const lbl = document.createElement("label");
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.value = g.id;
        cb.checked = (plan.groupIds || []).includes(g.id);
        cb.addEventListener("change", () => {
          plan.groupIds = [...groupPicker.querySelectorAll("input[type=checkbox]")]
            .filter(c => c.checked).map(c => c.value);
          console.debug("[shift-planner] plan", plan.id, "groupIds now:", plan.groupIds);
          persistPlanMeta();
          // Update just the chip area of the matching Final card so we don't
          // wipe & rebuild the whole Final container (which would lose any
          // in-progress UI state in other Final cards).
          updateFinalCardChips(plan);
        });
        lbl.appendChild(cb);
        const txt = document.createElement("span");
        txt.textContent = g.name || g.id;
        lbl.appendChild(txt);
        groupPicker.appendChild(lbl);
      }
    }
    header.appendChild(groupPicker);

    const spacer = document.createElement("div");
    spacer.className = "spacer";
    header.appendChild(spacer);

    const delBtn = document.createElement("button");
    delBtn.className = "btn-danger";
    delBtn.textContent = "Remove plan";
    delBtn.onclick = () => deletePlan(plan.id);
    header.appendChild(delBtn);

    card.appendChild(header);

    // Toolbar
    const tbar = document.createElement("div");
    tbar.className = "plan-toolbar";
    const saveBtn = document.createElement("button");
    saveBtn.className = "btn-primary";
    saveBtn.textContent = "Save Plan";
    saveBtn.onclick = () => savePlanDemand(plan.id);
    tbar.appendChild(saveBtn);
    const addShiftBtn = document.createElement("button");
    addShiftBtn.className = "btn-secondary";
    addShiftBtn.textContent = "+ Add Shift Row";
    addShiftBtn.onclick = () => addShiftRowToPlan(plan.id);
    tbar.appendChild(addShiftBtn);
    const reloadBtn = document.createElement("button");
    reloadBtn.className = "btn-secondary";
    reloadBtn.textContent = "Reload";
    reloadBtn.onclick = () => loadDemand();
    tbar.appendChild(reloadBtn);
    const statusEl = document.createElement("span");
    statusEl.className = "status";
    statusEl.id = `plan-status-${plan.id}`;
    statusEl.style.display = "none";
    tbar.appendChild(statusEl);
    card.appendChild(tbar);

    // Demand table
    const wrap = document.createElement("div");
    wrap.className = "table-wrap";
    const tbl = document.createElement("table");
    tbl.id = `dem-table-${plan.id}`;
    wrap.appendChild(tbl);
    card.appendChild(wrap);

    // Render the demand. Pass `tbl` directly because at this point the
    // <table> is inside `card` but `card` hasn't been appended to the
    // document yet, so getElementById(tbl.id) would return null.
    const dates = Store.generateDates(appConfig.month, appConfig.year);
    let demand = Store.readPlanDemand(plan.id, appConfig.month, appConfig.year);
    if (!demand.length) {
      demand = [["Plan", ...dates]];
      for (const code of plan.shifts || []) demand.push([code, ...new Array(dates.length).fill("0")]);
      demand.push(["Sum", ...new Array(dates.length).fill("0")]);
    }
    renderTable(tbl, demand, { editable: true, allowDeleteRows: true,
      onDeleteRow: async (code) => {
        if (!code) return false;
        if (code.toLowerCase() === "sum") { alert("Cannot remove the Sum row."); return false; }
        // Also drop the code from plan.shifts so a future re-render of the
        // demand table doesn't re-add it.
        plan.shifts = (plan.shifts || []).filter(s => s !== code);
        persistPlanMeta();
        return true;
      },
    });
    setupPlanAutoSum(tbl);
    return card;
  }

  function setupPlanAutoSum(tableEl) {
    if (!tableEl) return;
    const bodyRows = [...tableEl.querySelectorAll("tbody tr")];
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

  function addShiftRowToPlan(planId) {
    if (Store.isFrozen()) return frozenAlert();
    const plan = planById(planId);
    if (!plan) return;
    const allCodes = (shiftTypesData || []).map(s => s.code).filter(Boolean);
    const usedRows = gatherTable(`dem-table-${planId}`).slice(1)
      .map(r => (r[0] || "").trim()).filter(Boolean);
    const used = new Set(usedRows);
    const candidates = allCodes.filter(c => !used.has(c));
    let code;
    if (candidates.length) {
      code = (prompt(`Add shift row. Available shift codes:\n${candidates.join(", ")}\n\nEnter the code to add:`, candidates[0]) || "").trim();
    } else {
      code = (prompt("All defined shift types are already in this plan.\nEnter a shift code anyway (it will not be a known shift type):", "") || "").trim();
    }
    if (!code) return;
    if (used.has(code)) { alert("That shift row already exists in this plan."); return; }
    if (!plan.shifts.includes(code)) {
      plan.shifts.push(code);
      persistPlanMeta();
    }
    // Re-render so the new row is wired up to the auto-sum logic.
    const dates = Store.generateDates(appConfig.month, appConfig.year);
    const current = gatherTable(`dem-table-${planId}`);
    // Insert before the Sum row (preserve other edited values).
    const sumIdx = current.findIndex(r => (r[0] || "").trim().toLowerCase() === "sum");
    const insertAt = sumIdx > 0 ? sumIdx : current.length;
    current.splice(insertAt, 0, [code, ...new Array(dates.length).fill("0")]);
    writePlanDemandMarked(planId, current);
    renderPlansContainer();
  }

  function savePlanDemand(planId) {
    if (Store.isFrozen()) return frozenAlert();
    const rows = gatherTable(`dem-table-${planId}`);
    writePlanDemandMarked(planId, rows);
    // Sync plan.shifts to match the demand rows (excluding Sum).
    const plan = planById(planId);
    if (plan) {
      plan.shifts = rows.slice(1)
        .map(r => (r[0] || "").trim())
        .filter(c => c && c.toLowerCase() !== "sum");
      persistPlanMeta();
    }
    status(`plan-status-${planId}`, "Saved!", "success");
  }

  // ---------- Final Plan (multi-plan) ----------
  function loadFinal() {
    plansData  = Store.getPlans(appConfig.month, appConfig.year);
    groupsData = Store.getGroups();
    peopleNamesMap = Store.getPeopleMap();
    renderFinalsContainer();
  }

  // Update just the group-chips area of a Final card without rebuilding the
  // whole Final container. This avoids wiping in-progress UI state in other
  // cards (e.g. open status messages or warning lists).
  function updateFinalCardChips(plan) {
    const card = document.querySelector(`#finals-container .plan-card[data-plan-id="${CSS.escape(plan.id)}"]`);
    if (!card) {
      console.debug("[shift-planner] no Final card for plan", plan.id, "- doing full render");
      renderFinalsContainer();
      return;
    }
    const groupChips = card.querySelector(".plan-header .group-chips");
    if (!groupChips) return;
    groupChips.innerHTML = "";
    const groupNameMap = Store.getGroupNameMap();
    if (!plan.groupIds || plan.groupIds.length === 0) {
      const c = document.createElement("span");
      c.className = "chip-group empty";
      c.textContent = "no groups";
      groupChips.appendChild(c);
    } else {
      for (const gid of plan.groupIds) {
        const c = document.createElement("span");
        c.className = "chip-group";
        c.textContent = groupNameMap[gid] || gid;
        groupChips.appendChild(c);
      }
    }
    console.debug("[shift-planner] updated Final chips for", plan.id, "->", plan.groupIds);
  }

  function updateFinalCardTitle(plan) {
    const card = document.querySelector(`#finals-container .plan-card[data-plan-id="${CSS.escape(plan.id)}"]`);
    if (!card) { renderFinalsContainer(); return; }
    const h = card.querySelector(".plan-header h4");
    if (h) h.textContent = plan.name || plan.id;
  }

  function renderFinalsContainer() {
    const box = document.getElementById("finals-container");
    if (!box) return;
    if (!Array.isArray(plansData)) plansData = Store.getPlans(appConfig.month, appConfig.year);
    box.innerHTML = "";
    if (!plansData || plansData.length === 0) {
      box.innerHTML = '<div class="empty-hint">No plans configured. Add a plan in the Demand tab first.</div>';
      return;
    }
    plansData.forEach(p => box.appendChild(renderFinalCard(p)));
  }

  function renderFinalCard(plan) {
    console.debug("[shift-planner] renderFinalCard", plan.id, "groupIds=", plan.groupIds);
    const card = document.createElement("div");
    card.className = "plan-card";
    card.dataset.planId = plan.id;

    const header = document.createElement("div");
    header.className = "plan-header";
    const h = document.createElement("h4");
    h.textContent = plan.name || plan.id;
    header.appendChild(h);

    const groupChips = document.createElement("div");
    groupChips.className = "group-chips";
    const groupNameMap = Store.getGroupNameMap();
    if (!plan.groupIds || plan.groupIds.length === 0) {
      const c = document.createElement("span");
      c.className = "chip-group empty";
      c.textContent = "no groups";
      groupChips.appendChild(c);
    } else {
      for (const gid of plan.groupIds) {
        const c = document.createElement("span");
        c.className = "chip-group";
        c.textContent = groupNameMap[gid] || gid;
        groupChips.appendChild(c);
      }
    }
    header.appendChild(groupChips);

    const spacer = document.createElement("div");
    spacer.className = "spacer";
    header.appendChild(spacer);
    card.appendChild(header);

    // Toolbar -- single "Generate Plan" button that re-arranges every person
    // in this plan's groups from scratch based on the current demand +
    // registrations. (We deliberately drop the old smart-incremental mode:
    // admins found it confusing to have two buttons, and the cost of a full
    // re-arrange is small for a single plan.)
    const tbar = document.createElement("div");
    tbar.className = "plan-toolbar";
    const genBtn = document.createElement("button");
    genBtn.className = "btn-success";
    genBtn.textContent = "Generate Plan";
    genBtn.title = "Re-arrange every person in this plan's groups based on the current demand + registrations";
    genBtn.onclick = () => generatePlan(plan.id);
    tbar.appendChild(genBtn);
    const statusEl = document.createElement("span");
    statusEl.className = "status";
    statusEl.id = `final-status-${plan.id}`;
    statusEl.style.display = "none";
    tbar.appendChild(statusEl);
    card.appendChild(tbar);

    // Warnings box (rendered into when generating)
    const warnBox = document.createElement("div");
    warnBox.id = `warnings-box-${plan.id}`;
    warnBox.style.display = "none";
    card.appendChild(warnBox);

    // Final table
    const wrap = document.createElement("div");
    wrap.className = "table-wrap";
    const tbl = document.createElement("table");
    tbl.id = `fin-table-${plan.id}`;
    wrap.appendChild(tbl);
    card.appendChild(wrap);

    // Render existing final rows if present. Pass `tbl` directly because
    // `card` isn't in the DOM yet at this point.
    const finRows = Store.readPlanFinal(plan.id, appConfig.month, appConfig.year);
    if (finRows.length) {
      renderTable(tbl, finRows, {
        editable: false, colorize: true,
        peopleMap: peopleNamesMap,
        peopleGroupMap: Store.getPeopleGroupMap(),
        groupNameMap: Store.getGroupNameMap(),
      });
    } else {
      tbl.innerHTML = '<tbody><tr><td class="empty">No final yet for this plan.</td></tr></tbody>';
    }

    return card;
  }

  function generatePlan(planId) {
    if (Store.isFrozen()) return frozenAlert();
    const plan = planById(planId);
    if (!plan) return;
    if (!plan.groupIds || plan.groupIds.length === 0) {
      status(`final-status-${planId}`, "Pick at least one group for this plan in the Demand tab.", "warn");
      return;
    }
    status(`final-status-${planId}`, "Generating...", "info");

    // Build inputs scoped to this plan.
    const planDemand = Store.readPlanDemand(planId, appConfig.month, appConfig.year);
    const allReg     = Store.readRegisterRows(appConfig.month, appConfig.year);
    const groupPids  = new Set(Store.getPeopleIdsInGroups(plan.groupIds));
    const filteredReg = [allReg[0] || ["Name"], ...allReg.slice(1).filter(r => groupPids.has((r[0] || "").trim()))];
    const snaps = Store.readPlanSnapshots(planId, appConfig.month, appConfig.year);
    const prevFinal = Store.readPlanFinal(planId, appConfig.month, appConfig.year);

    // Per-shift constraints from Setting -> Shift Types (Rules 7+8).
    const shiftMeta = {};
    for (const s of (Store.getShiftTypes() || [])) {
      if (!s || !s.code) continue;
      shiftMeta[s.code] = {
        monthlyCap:    s.monthlyCap || null,
        forbidNextDay: s.forbidNextDay || [],
      };
    }
    const maxWorkdaysPerMonth = Store.getMaxWorkdaysPerMonth();

    // Cross-month carry-over: collect what the people in this plan's groups
    // worked on the LAST DAY of the previous month, across ALL plans
    // (because a person might have been on plan A last month and plan B
    // this month). The scheduler uses this to enforce forbidNextDay and
    // the "*" force-rest rule across the boundary.
    const prevDayShifts = collectPrevMonthLastDayShifts(groupPids);

    let result;
    try {
      result = Scheduler.runSchedule({
        demandRows:           planDemand,
        registerRows:         filteredReg,
        prevRegisterSnapRows: snaps.register,
        prevDemandSnapRows:   snaps.demand,
        prevFinalRows:        prevFinal,
        // Always full-rebuild: the user wants a single Generate button that
        // re-arranges every person from scratch.
        forceFull:            true,
        shiftMeta,
        maxWorkdaysPerMonth,
        prevDayShifts,
      });
    } catch (e) {
      console.error(e);
      status(`final-status-${planId}`, "Failed (exception): " + (e.message || e), "error");
      return;
    }

    renderWarnings(`warnings-box-${planId}`, result.warnings || []);

    if (result.ok) {
      writePlanFinalMarked(planId, result.rows);
      writePlanSnapshotsMarked(planId, planDemand, filteredReg);

      renderTable(`fin-table-${planId}`, result.rows, {
        editable: false, colorize: true,
        peopleMap: peopleNamesMap,
        peopleGroupMap: Store.getPeopleGroupMap(),
        groupNameMap: Store.getGroupNameMap(),
      });
      const dirtyMsg = (result.dirty_dates && result.dirty_dates.length)
        ? ` (re-arranged ${result.dirty_dates.length} date${result.dirty_dates.length === 1 ? "" : "s"})`
        : (result.locked_dates && result.locked_dates.length ? " (no changes detected)" : "");
      status(`final-status-${planId}`, `Generated${dirtyMsg}.`, "success");
    } else {
      status(`final-status-${planId}`, "Failed: see warnings above.", "error");
    }
  }

  // Look up the shift each person in `targetPersonSet` worked on the LAST
  // DAY of the previous month. We scan EVERY plan from that month so we
  // catch the case where the person was in a different plan/group then.
  // Returns { personId -> "C22" | "C13" | ... }. Empty {} when there is
  // no previous month yet (e.g. January 2020 on a fresh install).
  function collectPrevMonthLastDayShifts(targetPersonSet) {
    const out = {};
    try {
      const m = appConfig.month;
      const y = appConfig.year;
      const prevMonth = m === 1 ? 12 : m - 1;
      const prevYear  = m === 1 ? y - 1 : y;
      const prevDates = Store.generateDates(prevMonth, prevYear);
      if (!prevDates.length) return out;
      const lastDate  = prevDates[prevDates.length - 1];
      const prevPlans = Store.getPlans(prevMonth, prevYear) || [];
      for (const pp of prevPlans) {
        const rows = Store.readPlanFinal(pp.id, prevMonth, prevYear);
        if (!rows || !rows.length) continue;
        const header = rows[0] || [];
        const idx = header.indexOf(lastDate);
        if (idx < 1) continue;
        for (const r of rows.slice(1)) {
          const id = (r[0] || "").trim();
          if (!id) continue;
          if (targetPersonSet && targetPersonSet.size && !targetPersonSet.has(id)) continue;
          const code = (r[idx] || "").trim();
          if (code) out[id] = code;
        }
      }
    } catch (e) {
      console.warn("[shift-planner] collectPrevMonthLastDayShifts failed:", e);
    }
    return out;
  }

  function generateAll() {
    if (Store.isFrozen()) return frozenAlert();
    if (!plansData || plansData.length === 0) {
      alert("No plans to generate. Add a plan in the Demand tab first.");
      return;
    }
    for (const p of plansData) generatePlan(p.id);
    status("fin-status", `Generated ${plansData.length} plan(s).`, "success");
  }

  function renderWarnings(boxId, list) {
    const box = document.getElementById(boxId);
    if (!box) return;
    if (!list || list.length === 0) { box.style.display = "none"; box.innerHTML = ""; return; }
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

  // ---------- People (master list, Setting tab) ----------
  // The People table is special: column 0 (ID) and column 2 (Group) are not
  // free-text inputs. ID is read-only after creation; Group is a dropdown
  // driven by the Groups list.
  function loadPeople() {
    peopleData     = Store.getPeopleRows();
    groupsData     = Store.getGroups();
    peopleNamesMap = {};
    for (const r of peopleData.slice(1)) {
      if (r && r[0]) peopleNamesMap[r[0].trim()] = (r[1] || "").trim();
    }
    renderPeopleTable();
    applyFrozenState();
  }

  function renderPeopleTable() {
    const t = document.getElementById("ppl-table");
    if (!t) return;
    t.innerHTML = "";
    const header = peopleData[0] || ["ID", "Name", "Group"];

    // Header row
    const thead = document.createElement("thead");
    const trh = document.createElement("tr");
    header.forEach((h, i) => {
      const th = document.createElement("th");
      th.textContent = h || "";
      if (i === 0) th.classList.add("col-name");
      trh.appendChild(th);
    });
    const thAct = document.createElement("th");
    thAct.classList.add("col-action");
    trh.appendChild(thAct);
    thead.appendChild(trh);
    t.appendChild(thead);

    // Body rows
    const tbody = document.createElement("tbody");
    for (let r = 1; r < peopleData.length; r++) {
      const row = peopleData[r];
      tbody.appendChild(buildPersonRow(row, header.length));
    }
    t.appendChild(tbody);
  }

  function buildPersonRow(row, numCols) {
    const tr = document.createElement("tr");
    for (let i = 0; i < numCols; i++) {
      const td = document.createElement("td");
      const v = (row && row[i] != null) ? String(row[i]) : "";
      if (i === 0) {
        td.classList.add("col-name");
        td.textContent = v;
      } else if (i === 2) {
        td.appendChild(buildGroupSelect(v));
      } else {
        const inp = document.createElement("input");
        inp.className = "cell text-cell";
        inp.value = v;
        td.appendChild(inp);
      }
      tr.appendChild(td);
    }
    const tdAct = document.createElement("td");
    tdAct.classList.add("col-action");
    const btn = document.createElement("button");
    btn.className = "btn-danger";
    btn.textContent = "\u2715";
    btn.title = "Remove this person";
    const id = (row && row[0] || "").trim();
    const nm = (row && row[1] || "").trim();
    btn.onclick = () => {
      if (!confirm(`Remove ${id}${nm ? " - " + nm : ""}?\n\nThey will no longer appear in Register / Final Plan for any month.`)) return;
      tr.remove();
    };
    tdAct.appendChild(btn);
    tr.appendChild(tdAct);
    return tr;
  }

  function buildGroupSelect(currentGroupId) {
    const sel = document.createElement("select");
    sel.className = "group-select";
    const blank = document.createElement("option");
    blank.value = ""; blank.textContent = "(none)";
    sel.appendChild(blank);
    for (const g of (groupsData || [])) {
      const opt = document.createElement("option");
      opt.value = g.id;
      opt.textContent = g.name || g.id;
      sel.appendChild(opt);
    }
    sel.value = currentGroupId || "";
    return sel;
  }

  function gatherPeopleTable() {
    const t = document.getElementById("ppl-table");
    const rows = [];
    const ths = [...t.querySelectorAll("thead th")].filter(th => !th.classList.contains("col-action"));
    rows.push(ths.map(th => th.innerText.trim()));
    t.querySelectorAll("tbody tr").forEach(tr => {
      const row = [];
      const cells = [...tr.querySelectorAll("td")].filter(td => !td.classList.contains("col-action"));
      cells.forEach((td, i) => {
        if (i === 0) {
          row.push(td.textContent.trim());
        } else if (i === 2) {
          const sel = td.querySelector("select.group-select");
          row.push(sel ? sel.value.trim() : "");
        } else {
          const inp = td.querySelector("input");
          row.push(inp ? inp.value.trim() : td.textContent.trim());
        }
      });
      rows.push(row);
    });
    return rows;
  }

  function savePeople() {
    if (Store.isFrozen()) return frozenAlert();
    const rows = gatherPeopleTable();
    if (!rows[0] || rows[0].length < 3) {
      status("ppl-status", "Need at least ID, Name, Group columns.", "error"); return;
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
    renderFinalsContainer();
  }

  function addPersonToPeople() {
    if (!peopleData || !peopleData[0]) peopleData = [["ID", "Name", "Group"]];
    const ids = new Set(peopleData.slice(1).map(r => (r[0] || "").trim()));
    let n = 1;
    while (ids.has("P" + n)) n++;
    const id = (prompt("Person ID:", "P" + n) || "").trim();
    if (!id) return;
    if (ids.has(id)) { alert("That ID already exists."); return; }
    const name = (prompt(`Display name for ${id}:`, "") || "").trim();

    const cols = peopleData[0].length;
    const newRow = new Array(cols).fill("");
    newRow[0] = id;
    if (cols >= 2) newRow[1] = name;
    const tbody = document.querySelector("#ppl-table tbody");
    if (tbody) tbody.appendChild(buildPersonRow(newRow, cols));
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
      inp.className = "cell text-cell";
      inp.value = "";
      td.appendChild(inp);
      const actionTd = tr.querySelector("td.col-action");
      tr.insertBefore(td, actionTd || null);
    });
    status("ppl-status", `Column "${colName}" added. Click "Save People" to persist.`, "info");
  }

  // ---------- Groups (Setting tab) ----------
  function loadGroups() {
    groupsData = Store.getGroups();
    renderSimpleTable("grp-table", ["ID", "Name"],
      groupsData.map(g => [g.id, g.name || ""]),
      { idLabel: "G", placeholder: "Group name" });
    applyFrozenState();
  }

  function saveGroups() {
    if (Store.isFrozen()) return frozenAlert();
    const rows = gatherSimpleTable("grp-table");
    const seen = new Set();
    const out = [];
    for (const r of rows) {
      const id = (r[0] || "").trim();
      const name = (r[1] || "").trim();
      if (!id) continue;
      if (seen.has(id)) {
        status("grp-status", `Duplicate group id: ${id}`, "error"); return;
      }
      seen.add(id);
      out.push({ id, name });
    }
    Store.setGroups(out);
    groupsData = out;
    status("grp-status", "Saved!", "success");
    loadPeople();           // refresh people dropdowns
    loadRegister();         // refresh group chips next to person names
    renderPlansContainer(); // refresh plan group pickers
    renderFinalsContainer();
  }

  function addGroup() {
    if (Store.isFrozen()) return frozenAlert();
    if (!groupsData) groupsData = [];
    const used = new Set(groupsData.map(g => g.id));
    let n = 1; while (used.has("G" + n)) n++;
    const id = (prompt("Group ID:", "G" + n) || "").trim();
    if (!id) return;
    if (used.has(id)) { alert("That group ID already exists."); return; }
    const name = (prompt(`Display name for ${id}:`, "") || "").trim();
    appendSimpleTableRow("grp-table", [id, name], { idLabel: "G" });
    status("grp-status", 'Click "Save Groups" to persist.', "info");
  }

  // ---------- Shift Types (Setting tab) ----------
  function loadShiftTypes() {
    shiftTypesData = Store.getShiftTypes();
    renderShiftTypesTable();
    applyFrozenState();
  }

  function renderShiftTypesTable() {
    const t = document.getElementById("sft-table");
    if (!t) return;
    t.innerHTML = "";
    const headers = ["Code", "Description", "Monthly Cap", "Forbid Next Day"];
    const thead = document.createElement("thead");
    const trh = document.createElement("tr");
    headers.forEach((h, i) => {
      const th = document.createElement("th");
      th.textContent = h;
      if (i === 0) th.classList.add("col-name");
      trh.appendChild(th);
    });
    const thAct = document.createElement("th");
    thAct.classList.add("col-action");
    trh.appendChild(thAct);
    thead.appendChild(trh);
    t.appendChild(thead);

    const tbody = document.createElement("tbody");
    if (!shiftTypesData.length) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = headers.length + 1;
      td.className = "empty";
      td.textContent = "(none yet)";
      tr.appendChild(td);
      tbody.appendChild(tr);
    } else {
      for (const s of shiftTypesData) tbody.appendChild(buildShiftTypeRow(s));
    }
    t.appendChild(tbody);
  }

  function buildShiftTypeRow(s) {
    const tr = document.createElement("tr");
    // Code (read-only)
    const tdCode = document.createElement("td");
    tdCode.classList.add("col-name");
    tdCode.textContent = s.code || "";
    tr.appendChild(tdCode);
    // Description
    const tdDesc = document.createElement("td");
    const inpDesc = document.createElement("input");
    inpDesc.className = "cell text-cell sft-desc";
    inpDesc.value = s.desc || "";
    inpDesc.placeholder = "Description (optional)";
    tdDesc.appendChild(inpDesc);
    tr.appendChild(tdDesc);
    // Monthly Cap
    const tdCap = document.createElement("td");
    const inpCap = document.createElement("input");
    inpCap.className = "cell sft-cap";
    inpCap.type = "number";
    inpCap.min = "1";
    inpCap.step = "1";
    inpCap.style.width = "70px";
    inpCap.placeholder = "no cap";
    inpCap.value = (s.monthlyCap != null && s.monthlyCap > 0) ? String(s.monthlyCap) : "";
    tdCap.appendChild(inpCap);
    tr.appendChild(tdCap);
    // Forbid Next Day
    const tdForbid = document.createElement("td");
    const inpForbid = document.createElement("input");
    inpForbid.className = "cell text-cell sft-forbid";
    inpForbid.placeholder = "e.g. C6,C10 or *";
    inpForbid.value = (s.forbidNextDay || []).join(",");
    tdForbid.appendChild(inpForbid);
    tr.appendChild(tdForbid);
    // Action
    const tdAct = document.createElement("td");
    tdAct.classList.add("col-action");
    const btn = document.createElement("button");
    btn.className = "btn-danger";
    btn.textContent = "\u2715";
    btn.title = "Remove";
    btn.onclick = () => {
      if (!confirm(`Remove shift ${s.code}?`)) return;
      tr.remove();
    };
    tdAct.appendChild(btn);
    tr.appendChild(tdAct);
    return tr;
  }

  function saveShiftTypes() {
    if (Store.isFrozen()) return frozenAlert();
    const t = document.getElementById("sft-table");
    if (!t) return;
    const seen = new Set();
    const out = [];
    for (const tr of t.querySelectorAll("tbody tr")) {
      const codeTd = tr.querySelector("td.col-name");
      if (!codeTd || codeTd.classList.contains("empty")) continue;
      const code = (codeTd.textContent || "").trim();
      if (!code) continue;
      if (seen.has(code)) {
        status("sft-status", `Duplicate shift code: ${code}`, "error"); return;
      }
      seen.add(code);
      const desc = (tr.querySelector("input.sft-desc")?.value || "").trim();
      const capRaw = (tr.querySelector("input.sft-cap")?.value || "").trim();
      const capNum = capRaw === "" ? null : parseInt(capRaw, 10);
      const cap = (typeof capNum === "number" && !isNaN(capNum) && capNum > 0) ? capNum : null;
      const forbidRaw = (tr.querySelector("input.sft-forbid")?.value || "").trim();
      const forbid = forbidRaw
        .split(",")
        .map(x => x.trim().toUpperCase())
        .filter(Boolean);
      out.push({ code, desc, monthlyCap: cap, forbidNextDay: forbid });
    }
    Store.setShiftTypes(out);
    shiftTypesData = out;
    status("sft-status", "Saved!", "success");
  }

  function addShiftType() {
    if (Store.isFrozen()) return frozenAlert();
    const code = (prompt("Shift code (e.g. C6, C730):", "") || "").trim();
    if (!code) return;
    const t = document.getElementById("sft-table");
    const used = new Set([...t.querySelectorAll("tbody tr td.col-name")].map(td => td.textContent.trim()));
    if (used.has(code)) { alert("That shift code already exists."); return; }
    const desc = (prompt(`Description for ${code} (optional):`, "") || "").trim();
    // Drop the "(none yet)" placeholder if present.
    let tbody = t.querySelector("tbody");
    if (!tbody) { tbody = document.createElement("tbody"); t.appendChild(tbody); }
    const empty = tbody.querySelector("td.empty");
    if (empty) tbody.innerHTML = "";
    tbody.appendChild(buildShiftTypeRow({ code, desc, monthlyCap: null, forbidNextDay: [] }));
    status("sft-status", 'Click "Save Shift Types" to persist.', "info");
  }

  // ---------- Scheduling Rules (global) ----------
  function loadSchedulingRules() {
    const cap = Store.getMaxWorkdaysPerMonth();
    const inp = document.getElementById("max-workdays-inp");
    if (inp) inp.value = (cap != null && cap > 0) ? String(cap) : "";
    applyFrozenState();
  }
  function saveSchedulingRules() {
    if (Store.isFrozen()) return frozenAlert();
    const inp = document.getElementById("max-workdays-inp");
    const raw = (inp && inp.value || "").trim();
    Store.setMaxWorkdaysPerMonth(raw === "" ? null : parseInt(raw, 10));
    status("rules-status", "Saved!", "success");
  }

  // ---------- Generic 2-column simple table (Groups & Shift Types) ----------
  function renderSimpleTable(tableId, headers, dataRows, opts) {
    opts = opts || {};
    const t = document.getElementById(tableId);
    if (!t) return;
    t.innerHTML = "";
    const thead = document.createElement("thead");
    const trh = document.createElement("tr");
    headers.forEach((h, i) => {
      const th = document.createElement("th");
      th.textContent = h;
      if (i === 0) th.classList.add("col-name");
      trh.appendChild(th);
    });
    const thAct = document.createElement("th");
    thAct.classList.add("col-action");
    trh.appendChild(thAct);
    thead.appendChild(trh);
    t.appendChild(thead);

    const tbody = document.createElement("tbody");
    if (!dataRows || dataRows.length === 0) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = headers.length + 1;
      td.className = "empty";
      td.textContent = "(none yet)";
      tr.appendChild(td);
      tbody.appendChild(tr);
    } else {
      for (const r of dataRows) tbody.appendChild(buildSimpleRow(tableId, r, opts));
    }
    t.appendChild(tbody);
  }

  function buildSimpleRow(tableId, row, opts) {
    const tr = document.createElement("tr");
    const tdId = document.createElement("td");
    tdId.classList.add("col-name");
    tdId.textContent = row[0] || "";
    tr.appendChild(tdId);
    for (let i = 1; i < row.length; i++) {
      const td = document.createElement("td");
      const inp = document.createElement("input");
      inp.className = "cell text-cell";
      inp.value = row[i] || "";
      if (opts.placeholder && i === 1) inp.placeholder = opts.placeholder;
      td.appendChild(inp);
      tr.appendChild(td);
    }
    const tdAct = document.createElement("td");
    tdAct.classList.add("col-action");
    const btn = document.createElement("button");
    btn.className = "btn-danger";
    btn.textContent = "\u2715";
    btn.title = "Remove";
    btn.onclick = () => {
      if (!confirm(`Remove ${row[0]}?`)) return;
      tr.remove();
    };
    tdAct.appendChild(btn);
    tr.appendChild(tdAct);
    return tr;
  }

  function gatherSimpleTable(tableId) {
    const t = document.getElementById(tableId);
    if (!t) return [];
    const out = [];
    t.querySelectorAll("tbody tr").forEach(tr => {
      const cells = [...tr.querySelectorAll("td")].filter(td => !td.classList.contains("col-action") && !td.classList.contains("empty"));
      if (cells.length === 0) return;
      const row = cells.map((td, i) => {
        if (i === 0) return td.textContent.trim();
        const inp = td.querySelector("input");
        return inp ? inp.value.trim() : td.textContent.trim();
      });
      out.push(row);
    });
    return out;
  }

  function appendSimpleTableRow(tableId, row, opts) {
    const t = document.getElementById(tableId);
    if (!t) return;
    let tbody = t.querySelector("tbody");
    if (!tbody) {
      tbody = document.createElement("tbody");
      t.appendChild(tbody);
    }
    // Drop the "(none yet)" placeholder if present.
    const empty = tbody.querySelector("td.empty");
    if (empty) tbody.innerHTML = "";
    tbody.appendChild(buildSimpleRow(tableId, row, opts || {}));
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
      document.querySelectorAll("#reg-table input.cell, #ppl-table input.cell, #grp-table input.cell, #sft-table input.cell, .plan-card input.cell").forEach(i => {
        i.readOnly = true;
      });
    } else {
      body.classList.remove("frozen");
      banner.style.display = "none";
      btn.textContent = "Freeze Plan";
      btn.classList.add("btn-frozen");
      btn.classList.remove("btn-secondary");
      document.querySelectorAll("#reg-table input.cell, #ppl-table input.cell, #grp-table input.cell, #sft-table input.cell, .plan-card input.cell").forEach(i => {
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

    appConfig.month = m;
    appConfig.year  = y;
    Store.setConfig(appConfig);
    appConfig.periods = Store.listPeriods();

    updatePeriodBadge();
    loadRegister();
    loadDemand();
    loadFinal();
    status("reg-status", exists ? `Loaded saved plan for ${monthName} ${y}` : `New empty period created for ${monthName} ${y} - add a plan in the Demand tab.`, "success");
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
    const sheets = [];
    // One Final + one Demand sheet per plan, plus the shared Register sheet.
    const plans = Store.getPlans(cfg.month, cfg.year);
    if (plans.length === 0) {
      alert("No plans configured for this period. Add a plan in the Demand tab first.");
      return;
    }
    const safe = (s) => String(s || "").replace(/[\\/:*?\[\]]/g, "_").slice(0, 28) || "plan";
    for (const p of plans) {
      const finRows = Store.readPlanFinal(p.id, cfg.month, cfg.year);
      if (finRows.length) sheets.push({ name: `Final - ${safe(p.name)}`, rows: finRows, colorize: true });
      const demRows = Store.readPlanDemand(p.id, cfg.month, cfg.year);
      if (demRows.length) sheets.push({ name: `Demand - ${safe(p.name)}`, rows: demRows, colorize: false });
    }
    sheets.push({ name: "Register", rows: Store.readRegisterRows(cfg.month, cfg.year), colorize: false });
    Exporter.downloadExcel(`ShiftPlan_${cfg.year}-${String(cfg.month).padStart(2,"0")}.xlsx`, sheets);
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
          loadGroups();
          loadShiftTypes();
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

  // Generate a 16-hex-char recovery code, formatted for legibility:
  // "aaaa-bbbb-cccc-dddd". Uses crypto.getRandomValues so it can't be
  // predicted from the PIN.
  function generateRecoveryCode() {
    const buf = new Uint8Array(8);
    crypto.getRandomValues(buf);
    const hex = [...buf].map(b => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}`;
  }

  // Save the new PIN hash + recovery hash to both cloud and localStorage.
  async function persistPinSecrets(pinHash, recoveryHash) {
    Store.set("admin_pin_hash",      JSON.stringify(pinHash));
    Store.set("admin_recovery_hash", JSON.stringify(recoveryHash));
    if (Cloud.isConfigured()) {
      try { await Cloud.set("admin_pin_hash",      pinHash); }      catch (e) { console.warn("could not push PIN hash to cloud", e); }
      try { await Cloud.set("admin_recovery_hash", recoveryHash); } catch (e) { console.warn("could not push recovery hash to cloud", e); }
    }
  }

  async function setupPinGate() {
    const gate    = document.getElementById("pin-gate");
    const title   = document.getElementById("pin-title");
    const msgEl   = document.getElementById("pin-msg");
    const errEl   = document.getElementById("pin-error");
    const pin1    = document.getElementById("pin-input");
    const pin2    = document.getElementById("pin-input-2");
    const recIn   = document.getElementById("recovery-input");
    const recBox  = document.getElementById("recovery-display");
    const recCode = document.getElementById("recovery-code-text");
    const recAck  = document.getElementById("recovery-ack");
    const btn     = document.getElementById("pin-btn");
    const backBtn = document.getElementById("pin-back-btn");
    const forgotLink = document.getElementById("forgot-pin-link");
    const copyBtn = document.getElementById("recovery-copy-btn");
    const dlBtn   = document.getElementById("recovery-download-btn");

    // ----- Pull stored hashes (cloud first, then local fallback) -----
    let storedPinHash = null;
    let storedRecoveryHash = null;
    if (Cloud.isConfigured()) {
      try {
        Cloud.init();
        storedPinHash      = await Cloud.get("admin_pin_hash");
        storedRecoveryHash = await Cloud.get("admin_recovery_hash");
      } catch (_) { /* fall back to local */ }
    }
    if (!storedPinHash) {
      const local = Store.get("admin_pin_hash");
      try { storedPinHash = local ? JSON.parse(local) : null; } catch (_) { storedPinHash = local; }
    }
    if (!storedRecoveryHash) {
      const local = Store.get("admin_recovery_hash");
      try { storedRecoveryHash = local ? JSON.parse(local) : null; } catch (_) { storedRecoveryHash = local; }
    }

    console.debug("[pin-gate] stored hashes:", {
      hasPin: !!storedPinHash,
      hasRecovery: !!storedRecoveryHash,
    });

    // ----- State machine -----
    // Stages:
    //   "login"            -> existing user types PIN
    //   "first-time"       -> no PIN exists yet, choose one
    //   "forgot"           -> existing user types recovery code
    //   "no-recovery-help" -> Forgot was clicked but no recovery hash exists;
    //                          show manual reset instructions
    //   "new-pin"          -> after recovery accepted, choose new PIN
    //   "show-recovery"    -> show the freshly generated recovery code
    //   "offer-recovery"   -> existing user logged in but has no recovery
    //                          hash; offer to generate one
    let stage = storedPinHash ? "login" : "first-time";

    // Carry the freshly accepted PIN between stages.
    let pendingPin = null;
    let pendingRecoveryCode = null;

    return new Promise((resolve) => {
      const showError = (msg) => {
        errEl.textContent = msg; errEl.style.display = "block";
        setTimeout(() => { errEl.style.display = "none"; }, 4500);
      };

      function render() {
        console.debug("[pin-gate] render stage:", stage);
        // Reset every dynamic field, then turn on what this stage needs.
        pin1.value = ""; pin2.value = ""; recIn.value = "";
        pin1.style.display = "none";
        pin2.style.display = "none";
        recIn.style.display = "none";
        recBox.style.display = "none";
        btn.style.display = "block";
        backBtn.style.display = "none";
        backBtn.textContent = "Back to login";
        forgotLink.style.display = "inline";
        errEl.style.display = "none";

        if (stage === "login") {
          title.textContent = "Admin access";
          msgEl.textContent = "Enter the admin PIN to load the planner.";
          pin1.placeholder  = "PIN";
          pin1.style.display = "block";
          btn.textContent = "Unlock";
          setTimeout(() => pin1.focus(), 30);
        }
        else if (stage === "first-time") {
          title.textContent = "First-time setup";
          msgEl.textContent = "Choose an admin PIN (4+ characters). Anyone who knows this PIN can edit the plan.";
          pin1.placeholder  = "Choose a PIN";
          pin2.placeholder  = "Confirm PIN";
          pin1.style.display = "block";
          pin2.style.display = "block";
          forgotLink.style.display = "none";
          btn.textContent = "Set PIN";
          setTimeout(() => pin1.focus(), 30);
        }
        else if (stage === "forgot") {
          title.textContent = "Reset PIN";
          msgEl.textContent = "Paste the recovery code you saved when you first set up your PIN.";
          recIn.style.display = "block";
          backBtn.style.display = "inline-block";
          forgotLink.style.display = "none";
          btn.textContent = "Verify recovery code";
          setTimeout(() => recIn.focus(), 30);
        }
        else if (stage === "no-recovery-help") {
          title.textContent = "No recovery code on file";
          msgEl.innerHTML =
            'There is no recovery code saved for this admin yet, so the PIN cannot be reset automatically.<br><br>' +
            'To reset the PIN manually:<br>' +
            '<b>Option 1 - Browser console:</b> press <code>F12</code>, paste this and press Enter:<br>' +
            '<code style="display:block;padding:8px;background:#f3f4f6;border-radius:4px;font-size:11px;margin:6px 0;text-align:left">' +
            'await Cloud.del("admin_pin_hash");<br>' +
            'localStorage.removeItem("admin_pin_hash");<br>' +
            'location.reload();</code>' +
            '<b>Option 2 - Supabase:</b> open Table Editor &rarr; <code>shift_planner</code> &rarr; delete the row where <code>k = admin_pin_hash</code>, then reload this page.';
          btn.style.display = "none";
          backBtn.style.display = "inline-block";
          forgotLink.style.display = "none";
        }
        else if (stage === "new-pin") {
          title.textContent = "Choose new PIN";
          msgEl.textContent = "Recovery accepted. Choose a new admin PIN (4+ characters).";
          pin1.placeholder  = "New PIN";
          pin2.placeholder  = "Confirm new PIN";
          pin1.style.display = "block";
          pin2.style.display = "block";
          backBtn.style.display = "inline-block";
          forgotLink.style.display = "none";
          btn.textContent = "Save new PIN";
          setTimeout(() => pin1.focus(), 30);
        }
        else if (stage === "show-recovery") {
          title.textContent = "Save your recovery code";
          msgEl.textContent = "This is the only time the recovery code is shown. Save it somewhere safe.";
          recBox.style.display = "block";
          recCode.textContent = pendingRecoveryCode || "";
          recAck.checked = false;
          forgotLink.style.display = "none";
          btn.textContent = "Continue";
        }
        else if (stage === "offer-recovery") {
          title.textContent = "Set up a recovery code";
          msgEl.textContent = "You don't have a recovery code yet. Generate one now so you can reset your PIN if you forget it.";
          backBtn.textContent = "Skip for now";
          backBtn.style.display = "inline-block";
          forgotLink.style.display = "none";
          btn.textContent = "Generate recovery code";
        }
      }

      async function submit() {
        const v1 = (pin1.value || "").trim();
        const v2 = (pin2.value || "").trim();
        const rc = (recIn.value || "").trim();

        if (stage === "login") {
          if (!v1) return;
          const hash = await sha256Hex(v1);
          if (hash !== storedPinHash) return showError("Wrong PIN.");
          // Logged in. If there's no recovery hash on file, offer to set one up.
          if (!storedRecoveryHash) {
            stage = "offer-recovery";
            render();
            return;
          }
          finish();
        }
        else if (stage === "first-time") {
          if (v1.length < 4) return showError("PIN must be at least 4 characters.");
          if (v1 !== v2) return showError("PINs do not match.");
          // Save PIN + generate recovery code, show it, then continue.
          const pinHash = await sha256Hex(v1);
          const code    = generateRecoveryCode();
          const recHash = await sha256Hex(code);
          await persistPinSecrets(pinHash, recHash);
          storedPinHash = pinHash;
          storedRecoveryHash = recHash;
          pendingRecoveryCode = code;
          stage = "show-recovery";
          render();
        }
        else if (stage === "forgot") {
          if (!rc) return showError("Enter your recovery code.");
          // Accept either the formatted "aaaa-bbbb-..." or the raw 16-hex
          // string the user might have typed without dashes.
          const normalised = rc.replace(/[-\s]/g, "").toLowerCase();
          if (!/^[0-9a-f]{16}$/.test(normalised)) return showError("Recovery code must be 16 hex characters.");
          const formatted = `${normalised.slice(0,4)}-${normalised.slice(4,8)}-${normalised.slice(8,12)}-${normalised.slice(12,16)}`;
          const hash = await sha256Hex(formatted);
          if (hash !== storedRecoveryHash) return showError("Recovery code does not match.");
          // Accepted -> let the user set a new PIN.
          stage = "new-pin";
          render();
        }
        else if (stage === "new-pin") {
          if (v1.length < 4) return showError("PIN must be at least 4 characters.");
          if (v1 !== v2) return showError("PINs do not match.");
          // Rotate BOTH the PIN hash AND the recovery code (one-time use).
          const pinHash = await sha256Hex(v1);
          const code    = generateRecoveryCode();
          const recHash = await sha256Hex(code);
          await persistPinSecrets(pinHash, recHash);
          storedPinHash = pinHash;
          storedRecoveryHash = recHash;
          pendingRecoveryCode = code;
          stage = "show-recovery";
          render();
        }
        else if (stage === "show-recovery") {
          if (!recAck.checked) return showError("Tick the checkbox to confirm you've saved the code.");
          finish();
        }
        else if (stage === "offer-recovery") {
          // User chose to generate a code. Reuse the same display flow.
          const code    = generateRecoveryCode();
          const recHash = await sha256Hex(code);
          Store.set("admin_recovery_hash", JSON.stringify(recHash));
          if (Cloud.isConfigured()) {
            try { await Cloud.set("admin_recovery_hash", recHash); } catch (e) { console.warn("could not push recovery hash to cloud", e); }
          }
          storedRecoveryHash = recHash;
          pendingRecoveryCode = code;
          stage = "show-recovery";
          render();
        }
      }

      function finish() {
        gate.classList.add("hidden");
        pendingPin = null;
        pendingRecoveryCode = null;
        resolve();
      }

      function back() {
        if (stage === "offer-recovery") {
          // "Skip for now": user is already authenticated; just close the
          // gate. We'll re-offer the recovery setup next visit.
          finish();
          return;
        }
        if (stage === "forgot" || stage === "no-recovery-help") {
          // User changed their mind about reset.
          stage = storedPinHash ? "login" : "first-time";
        }
        else if (stage === "new-pin") {
          // Cancel new-pin -> back to forgot screen so the user can re-enter
          // a different recovery code if needed.
          stage = "forgot";
        }
        render();
      }

      // ----- Wire up handlers -----
      btn.onclick = submit;
      backBtn.onclick = back;
      forgotLink.onclick = (e) => {
        if (e && e.preventDefault) e.preventDefault();
        console.debug("[pin-gate] forgot clicked, stage=", stage,
                      "hasRecovery=", !!storedRecoveryHash);
        if (stage !== "login") return;
        // If no recovery hash exists, route to a help screen instead of the
        // recovery-code form (which would never accept anything).
        stage = storedRecoveryHash ? "forgot" : "no-recovery-help";
        render();
      };
      [pin1, pin2, recIn].forEach(el => {
        el.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
      });

      copyBtn.onclick = async () => {
        try {
          await navigator.clipboard.writeText(pendingRecoveryCode || recCode.textContent);
          copyBtn.textContent = "Copied!";
          setTimeout(() => { copyBtn.textContent = "Copy"; }, 1500);
        } catch (_) {
          // Fallback: select the text so the user can Ctrl+C
          const range = document.createRange();
          range.selectNodeContents(recCode);
          const sel = window.getSelection();
          sel.removeAllRanges(); sel.addRange(range);
          showError("Copy failed. The code is selected - press Ctrl+C.");
        }
      };
      dlBtn.onclick = () => {
        const code = pendingRecoveryCode || recCode.textContent || "";
        const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const blob = new Blob(
          [
            "Shift Planner - Admin recovery code\n",
            "===================================\n\n",
            `Code: ${code}\n`,
            `Generated: ${new Date().toString()}\n\n`,
            "Use this code on the admin login page (\"Forgot PIN?\" link) to reset your PIN.\n",
            "This code is rotated every time you reset the PIN.\n",
          ],
          { type: "text/plain" }
        );
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = `shiftplanner-recovery-${stamp}.txt`;
        document.body.appendChild(a); a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      };

      render();
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
    const regKind = Store.classifyRegisterKey(k, appConfig.month, appConfig.year);
    const planKind = Store.classifyPlanKey(k, appConfig.month, appConfig.year);
    const periodMatch = k && k.match(/^period:(\d{4})-(\d{2}):/);

    if (k === "people") {
      // The People list changed on another browser. Refresh People AND
      // every tab that shows person names (Register + Final Plan), so the
      // Name column reflects the new value immediately.
      loadPeople();
      loadRegister();
      renderFinalsContainer();
    }
    else if (k === "groups") {
      loadGroups();
      loadPeople();          // group dropdowns in People table
      renderPlansContainer(); // group pickers in plan cards
      renderFinalsContainer();
    }
    else if (k === "shift_types") {
      loadShiftTypes();
    }
    else if (k === "max_workdays_per_month") {
      loadSchedulingRules();
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
    else if (planKind) {
      // A plan-scoped key changed for the period the admin is viewing
      // (plans list, demand.<id>, final.<id>, or snapshots).
      // Most of these notifications are echoes of our own writes -- when
      // the admin edits a plan card, we save to cloud, the cloud echoes
      // back, and we end up here. Re-rendering blindly would wipe the
      // user's in-progress UI state (checkboxes, focused inputs, scroll
      // position, warning box from a Generate run).
      //
      // First-line defence: if we just wrote this exact key locally in the
      // last few seconds, it's our own echo -- skip everything. The
      // structural compares below stay as a backup for unusual cases.
      console.debug("[live-sync] plan update:", k, planKind);
      if (isSelfEcho(k)) {
        console.debug("[live-sync] plan key self-echo (recent write) - skip:", k);
        return;
      }
      if (planKind.kind === "plans") {
        const fresh = Store.getPlans(appConfig.month, appConfig.year);
        if (samePlans(plansData, fresh)) {
          console.debug("[live-sync] plans unchanged (self-echo) - skip re-render");
          return;
        }
        // Plans really did change from another browser. Keep things smooth:
        // refresh in-memory plansData first, then surgically update the
        // Final cards' chips/titles instead of nuking the whole container,
        // so warnings / generated tables / report don't disappear.
        plansData = fresh;
        for (const p of plansData) {
          updateFinalCardChips(p);
          updateFinalCardTitle(p);
        }
        // Demand panel is editable -> safer to do a full rebuild so checkbox
        // state matches the new plans list. (No warnings live here.)
        renderPlansContainer();
      }
      else if (planKind.kind === "demand") {
        const fresh = Store.readPlanDemand(planKind.planId, appConfig.month, appConfig.year);
        const tableId = `dem-table-${planKind.planId}`;
        const tableEl = document.getElementById(tableId);
        const current = tableEl ? gatherTable(tableId) : [];
        if (sameRows(current, fresh)) {
          console.debug("[live-sync] demand unchanged (self-echo) - skip re-render");
          return;
        }
        loadDemand();
      }
      else if (planKind.kind === "final") {
        // The Final tab carries TRANSIENT UI state that lives outside the
        // <table> (warnings box, status pill). If we
        // re-run loadFinal() on every Realtime echo, those get wiped after
        // a few seconds -- which is exactly what users were seeing when the
        // warnings/conflict alerts flashed briefly and disappeared after
        // clicking Generate Plan. So compare the freshly stored final to
        // what is currently rendered and skip the re-render on self-echo.
        const fresh = Store.readPlanFinal(planKind.planId, appConfig.month, appConfig.year);
        const tableId = `fin-table-${planKind.planId}`;
        const tableEl = document.getElementById(tableId);
        const current = tableEl ? gatherTable(tableId) : [];
        if (sameRows(current, fresh)) {
          console.debug("[live-sync] final unchanged (self-echo) - skip re-render");
          return;
        }
        // Genuinely new final from another browser: re-render just that
        // card's table without touching the surrounding warnings/report.
        const card = document.querySelector(`#finals-container .plan-card[data-plan-id="${CSS.escape(planKind.planId)}"]`);
        const tbl = card && card.querySelector(`#fin-table-${planKind.planId}`);
        if (tbl && fresh.length) {
          renderTable(tbl, fresh, {
            editable: false, colorize: true,
            peopleMap: peopleNamesMap,
            peopleGroupMap: Store.getPeopleGroupMap(),
            groupNameMap: Store.getGroupNameMap(),
          });
        } else {
          loadFinal();
        }
      }
    }
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
    loadGroups();
    loadShiftTypes();
    loadSchedulingRules();
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
    // Register
    saveRegister, loadRegister, addPersonToRegister,
    // Demand (multi-plan)
    loadDemand, addPlan,
    // Final (multi-plan)
    generateAll,
    // Setting -> People
    loadPeople, savePeople, addPersonToPeople, addPeopleColumn,
    // Setting -> Groups
    loadGroups, saveGroups, addGroup,
    // Setting -> Shift Types
    loadShiftTypes, saveShiftTypes, addShiftType,
    // Setting -> Scheduling Rules
    loadSchedulingRules, saveSchedulingRules,
    // Period / actions
    applyPeriod, toggleFreeze, exportExcel, exportBackup,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})(window);
