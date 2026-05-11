/* Scheduler - direct JavaScript port of build_schedule.py.

   Inputs (all arrays-of-arrays from CSV.parse):
     demandRows
     registerRows
   Optional:
     prevRegisterSnapRows   (snapshot taken after last successful generate)
     prevDemandSnapRows
     prevFinalRows          (the previous Final.csv contents)
     forceFull              (boolean, default false)
     shiftMeta              ({ code -> {monthlyCap, forbidNextDay: [codes]} })
                            -- per-shift constraints. forbidNextDay may
                            contain "*" meaning "force N the day after".
     maxWorkdaysPerMonth    (number | null) -- cap per person per month
                            on non-N/non-P days.
     prevDayShifts          ({ personId -> shift_code }) -- the shift each
                            person worked on the LAST DAY of the previous
                            month, used to enforce forbidNextDay across
                            the month boundary (e.g. C22 on Jun 30 ->
                            force N on Jul 1).

   Returns: {
     ok, rows, report, warnings, locked_dates, dirty_dates, mode
   }

   Rules:
     1. Honor every entry in registerRows.
     2. Each person should have a balanced number of working days.
     3. Each person should be exposed to all shift types during the month.
     4. Sundays: nobody works.
     5. No back-to-back N for the same person (best effort).
     6. N = day off (rest), P = annual leave; P does NOT trigger consecutive-N.
     7. (Admin-configurable) Per-shift monthly caps from shiftMeta.
     8. (Admin-configurable) After certain shifts the next day's shift is
        restricted -- forbidNextDay list, applied within month AND across
        month boundaries via prevDayShifts.
     9. (Admin-configurable) Hard cap on workdays per person per month
        (maxWorkdaysPerMonth).
*/
(function (root) {
  const OFF_CODES   = new Set(["N", "P"]);
  const PLACEHOLDER = "OFF";

  function parseDate(s) {
    const [m, d, y] = s.split("/").map(Number);
    return new Date(y, m - 1, d);
  }
  function isSunday(s) { return parseDate(s).getDay() === 0; }
  function dateSortKey(s) { return parseDate(s).getTime(); }

  function cleanRows(rows) {
    return (rows || []).filter(r => r && r.length > 0 && (r[0] || "").trim() !== "");
  }

  function parseDemand(rows) {
    rows = cleanRows(rows);
    if (!rows.length) return { dates: [], demand: {} };
    const header = rows[0].filter(h => (h || "").trim() !== "");
    const dates  = header.slice(1);
    const demand = {};
    for (const r of rows.slice(1)) {
      const shift = (r[0] || "").trim();
      if (!shift) continue;
      if (shift.toLowerCase() === "sum") continue;
      if (OFF_CODES.has(shift.toUpperCase())) continue;
      const map = {};
      for (let i = 0; i < dates.length; i++) {
        const v = parseInt((r[i + 1] || "0").trim() || "0", 10);
        map[dates[i]] = isNaN(v) ? 0 : v;
      }
      demand[shift] = map;
    }
    return { dates, demand };
  }

  function parseRegister(rows, dates) {
    rows = cleanRows(rows);
    const people = [];
    const registered = {};
    for (const r of rows.slice(1)) {
      const p = (r[0] || "").trim();
      if (!p) continue;
      people.push(p);
      registered[p] = {};
      for (let i = 0; i < dates.length; i++) {
        const cell = ((r[i + 1] !== undefined ? r[i + 1] : "") || "").trim();
        if (cell) registered[p][dates[i]] = cell;
      }
    }
    return { people, registered };
  }

  function parseFinal(rows, dates) {
    rows = cleanRows(rows);
    const out = {};
    for (const r of rows.slice(1)) {
      const p = (r[0] || "").trim();
      if (!p) continue;
      const m = {};
      for (let i = 0; i < dates.length; i++) {
        m[dates[i]] = ((r[i + 1] !== undefined ? r[i + 1] : "") || "").trim();
      }
      out[p] = m;
    }
    return out;
  }

  // ------- helpers used by the main loop -------
  function defaultDictInt() {
    return new Proxy({}, { get: (t, k) => (k in t ? t[k] : 0) });
  }

  function minBy(arr, keyFn) {
    let best = null;
    let bestKey = null;
    for (const item of arr) {
      const k = keyFn(item);
      if (best === null || compareTuple(k, bestKey) < 0) {
        best = item; bestKey = k;
      }
    }
    return best;
  }

  function compareTuple(a, b) {
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
      if (a[i] < b[i]) return -1;
      if (a[i] > b[i]) return 1;
    }
    return a.length - b.length;
  }

  function sortByKey(arr, keyFn) {
    arr.sort((x, y) => compareTuple(keyFn(x), keyFn(y)));
    return arr;
  }

  function listsEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function setsEqual(a, b) {
    if (a.size !== b.size) return false;
    for (const v of a) if (!b.has(v)) return false;
    return true;
  }

  // ------- the main entry point -------
  function runSchedule(opts) {
    const {
      demandRows,
      registerRows,
      prevRegisterSnapRows = null,
      prevDemandSnapRows   = null,
      prevFinalRows        = null,
      forceFull            = false,
      shiftMeta            = {},   // {code -> {monthlyCap, forbidNextDay:[]}}
      maxWorkdaysPerMonth  = null, // number | null
      prevDayShifts        = {},   // {personId -> last-day-of-prev-month code}
    } = opts;

    const lines = [];
    const log = (...a) => lines.push(a.join(" "));
    const warnings = [];

    // Build helper lookups for the per-shift constraints.
    function metaFor(code) {
      const m = shiftMeta && shiftMeta[code];
      if (!m) return { monthlyCap: null, forbidNextDay: new Set() };
      const cap = (typeof m.monthlyCap === "number" && m.monthlyCap > 0) ? m.monthlyCap : null;
      const fset = new Set();
      const fnd = m.forbidNextDay;
      if (Array.isArray(fnd)) for (const x of fnd) {
        if (x) fset.add(String(x).trim().toUpperCase());
      } else if (typeof fnd === "string") {
        for (const x of fnd.split(",")) {
          const v = x.trim().toUpperCase();
          if (v) fset.add(v);
        }
      }
      return { monthlyCap: cap, forbidNextDay: fset };
    }
    // "*" in forbidNextDay means "force N the day after".
    function prevDayForcesRest(prevCode) {
      if (!prevCode) return false;
      return metaFor(prevCode).forbidNextDay.has("*");
    }
    function prevDayForbids(prevCode, candidateShift) {
      if (!prevCode) return false;
      const fs = metaFor(prevCode).forbidNextDay;
      if (!fs.size) return false;
      if (fs.has("*")) return true; // force N -> nothing else allowed
      return fs.has(String(candidateShift || "").trim().toUpperCase());
    }

    // ---------- read current ----------
    const { dates, demand } = parseDemand(demandRows);
    const sundays = new Set(dates.filter(isSunday));
    for (const d of sundays) {
      for (const s of Object.keys(demand)) demand[s][d] = 0;
    }
    const activeShifts = Object.keys(demand).filter(s =>
      Object.values(demand[s]).some(v => v > 0)
    );

    const { people, registered } = parseRegister(registerRows, dates);

    if (!people.length) {
      return { ok: false, rows: [], report: "No people in Register.",
        warnings: ["No people defined."], locked_dates: [], dirty_dates: [], mode: "full" };
    }
    if (!activeShifts.length) {
      return { ok: false, rows: [], report: "No active shifts in Demand.",
        warnings: ["All demand is zero."], locked_dates: [], dirty_dates: [], mode: "full" };
    }

    // ---------- pre-flight conflict checks (Rule 4) ----------
    const validCodes = new Set([...Object.keys(demand), ...OFF_CODES]);

    // 1. Unknown codes in registrations
    for (const p of people) {
      for (const [d, code] of Object.entries(registered[p] || {})) {
        if (!validCodes.has(code)) {
          warnings.push(`WARNING: ${p} on ${d} -> unknown code '${code}'. Use one of N, P, or a known shift code.`);
        }
      }
    }

    // 2. Sundays + over-registered shifts
    //
    // If MORE people register for shift X on date D than demand[X][D] needs,
    // we:
    //   - Emit a CONFLICT warning so the admin sees what happened.
    //   - Honor the first `demand` registrants (in people order) -- their
    //     registration stands.
    //   - Drop the surplus registrations: those people become "unassigned"
    //     for that date, so the main scheduler loop further down will give
    //     them a different shift (if another shift is under-staffed that
    //     day) or an N. This implements the admin request: "neu co nhieu
    //     nguoi dang ky cung 1 ca, nhieu hon demand, thi thong bao cho
    //     admin va sap xep tu dong theo demand".
    for (const date of dates) {
      if (sundays.has(date)) {
        for (const p of people) {
          const c = (registered[p] || {})[date] || "";
          if (c && c !== "N") {
            warnings.push(`WARNING: ${p} registered on Sunday ${date} but Sundays are forced off.`);
          }
        }
        continue;
      }
      const perShift = {};
      for (const p of people) {
        const code = (registered[p] || {})[date] || "";
        if (code && !OFF_CODES.has(code) && activeShifts.includes(code)) {
          (perShift[code] = perShift[code] || []).push(p);
        }
      }
      for (const [shift, ppl] of Object.entries(perShift)) {
        const need = demand[shift][date];
        if (ppl.length > need) {
          const honored = ppl.slice(0, need);
          const dropped = ppl.slice(need);
          warnings.push(
            `CONFLICT ${date} shift ${shift}: ${ppl.length} people registered (${ppl.join(", ")}) ` +
            `but demand is only ${need}. Honoring ${honored.join(", ") || "(none)"}; ` +
            `auto-arranging ${dropped.join(", ")} (will be placed in another open shift or N).`
          );
          for (const p of dropped) {
            if (registered[p]) delete registered[p][date];
          }
        }
      }
    }

    // 3. Total capacity vs total demand
    let totalDemand = 0;
    for (const s of activeShifts) for (const d of dates) totalDemand += demand[s][d];
    const totalCapacity = people.length * (dates.length - sundays.size);
    if (totalDemand > totalCapacity) {
      const shortfall = totalDemand - totalCapacity;
      const workedDays = Math.max(1, dates.length - sundays.size);
      const morePeople = Math.ceil(shortfall / workedDays);
      warnings.push(`FATAL: total demand = ${totalDemand} person-days, capacity = ${totalCapacity}. Short ${shortfall} person-days (need ~${morePeople} more person(s) or reduce demand).`);
    }

    // 4. Per-day demand vs free-people-after-registered-offs
    for (const date of dates) {
      if (sundays.has(date)) continue;
      let dayDemand = 0;
      for (const s of activeShifts) dayDemand += demand[s][date];
      let regOff = 0;
      for (const p of people) {
        if (OFF_CODES.has((registered[p] || {})[date] || "")) regOff++;
      }
      const free = people.length - regOff;
      if (dayDemand > free) {
        warnings.push(`FATAL ${date}: demand needs ${dayDemand} people but only ${free} free (${regOff} registered off).`);
      }
    }

    // ---------- decide mode (full / incremental) ----------
    let incremental    = false;
    const lockedDates  = new Set();
    const dirtyDates   = new Set();
    let prevFinalMap   = {};

    if (!forceFull && prevRegisterSnapRows && prevFinalRows
        && prevRegisterSnapRows.length && prevFinalRows.length) {
      const prevRegRows = cleanRows(prevRegisterSnapRows);
      const prevDatesAll = (prevRegRows[0] || []).slice(1).filter(h => (h || "").trim() !== "");
      const prevPeople = prevRegRows.slice(1).map(r => (r[0] || "").trim()).filter(Boolean);
      const { registered: prevRegistered } = parseRegister(prevRegRows, prevDatesAll);

      let prevDemData = null;
      if (prevDemandSnapRows && prevDemandSnapRows.length) {
        prevDemData = parseDemand(prevDemandSnapRows).demand;
      }

      const compat = setsEqual(new Set(prevPeople), new Set(people))
        && listsEqual(prevDatesAll, dates)
        && (prevDemData === null || setsEqual(new Set(Object.keys(prevDemData)), new Set(Object.keys(demand))));

      if (compat) {
        for (const date of dates) {
          if (sundays.has(date)) continue;
          let changed = false;
          for (const p of people) {
            if (((registered[p] || {})[date] || "") !== ((prevRegistered[p] || {})[date] || "")) {
              changed = true; break;
            }
          }
          if (!changed && prevDemData) {
            for (const s of Object.keys(demand)) {
              if ((demand[s][date] || 0) !== ((prevDemData[s] && prevDemData[s][date]) || 0)) {
                changed = true; break;
              }
            }
          }
          if (changed) dirtyDates.add(date); else lockedDates.add(date);
        }
        prevFinalMap = parseFinal(prevFinalRows, dates);
        incremental = true;
        log(`Mode: incremental (${lockedDates.size} dates kept from previous plan, ${dirtyDates.size} dates re-arranged, ${sundays.size} Sundays).`);
      } else {
        log("Mode: FULL (structure changed since last generate -- people / shift list / dates differ).");
      }
    } else {
      log("Mode: FULL.");
    }

    if (warnings.some(w => w.startsWith("FATAL"))) {
      const report = formatReport({ lines, warnings, overCapacity: [], people, dates,
        activeShifts, sundays, lockedDates, dirtyDates,
        schedule: null, registered, demand });
      return { ok: false, rows: [], report, warnings,
        locked_dates: [...lockedDates].sort((a, b) => dateSortKey(a) - dateSortKey(b)),
        dirty_dates:  [...dirtyDates].sort((a, b) => dateSortKey(a) - dateSortKey(b)),
        mode: "full" };
    }

    // ---------- initialize schedule ----------
    const schedule = {};
    for (const p of people) {
      schedule[p] = {};
      for (const d of dates) schedule[p][d] = "";
    }

    // Sundays first
    for (const d of sundays) for (const p of people) schedule[p][d] = "N";

    // Lock previous Final on locked dates
    if (incremental) {
      for (const d of lockedDates) {
        for (const p of people) {
          const cell = (prevFinalMap[p] || {})[d] || "";
          if (cell) schedule[p][d] = cell;
        }
      }
    }

    // Apply registrations (override)
    for (const p of people) {
      for (const [d, code] of Object.entries(registered[p] || {})) schedule[p][d] = code;
    }

    // ---------- cross-month carry-over (Rule 8) ----------
    // If a person worked a shift on the LAST DAY of the previous month that
    // forbids any work the next day (forbidNextDay contains "*", typical for
    // a late/heavy shift such as C22), force them to N on day 1 of THIS
    // month -- but only if they haven't explicitly registered something else
    // on that day (registrations always win, the admin will see a CONFLICT
    // warning instead).
    if (dates.length && prevDayShifts && Object.keys(prevDayShifts).length) {
      const firstDate = dates[0];
      for (const p of people) {
        const prev = prevDayShifts[p];
        if (!prev || !prevDayForcesRest(prev)) continue;
        const cur = schedule[p][firstDate];
        if (cur && !sundays.has(firstDate)) {
          // Person registered something else on day 1; flag conflict but
          // don't auto-override (admin decides).
          if (cur !== "N") {
            warnings.push(
              `WARNING: ${p} worked ${prev} on the last day of the previous ` +
              `month (carry-over rule requires N on ${firstDate}), but ` +
              `they are registered/locked for '${cur}' on ${firstDate}. ` +
              `Edit the registration or remove the carry-over rule.`
            );
          }
        } else if (!sundays.has(firstDate)) {
          schedule[p][firstDate] = "N";
          log(`Carry-over: ${p} -> N on ${firstDate} (worked ${prev} previous month).`);
        }
      }
    }

    // ---------- helpers (closures over schedule) ----------
    const isOff = c => OFF_CODES.has(c) || c === PLACEHOLDER;
    const isN   = c => c === "N" || c === PLACEHOLDER;

    const workdays = p => dates.reduce((n, d) => n + (schedule[p][d] && !isOff(schedule[p][d]) ? 1 : 0), 0);
    const ndays    = p => dates.reduce((n, d) => n + (isN(schedule[p][d]) ? 1 : 0), 0);

    const dateIndex = {};
    dates.forEach((d, i) => { dateIndex[d] = i; });
    function adjacentN(p, date) {
      const idx = dateIndex[date];
      if (idx > 0 && isN(schedule[p][dates[idx - 1]])) return true;
      if (idx < dates.length - 1 && isN(schedule[p][dates[idx + 1]])) return true;
      return false;
    }

    function remainingDemand(date) {
      const taken = {};
      for (const p of people) {
        const s = schedule[p][date];
        if (s && !OFF_CODES.has(s) && s !== PLACEHOLDER) taken[s] = (taken[s] || 0) + 1;
      }
      const out = [];
      for (const s of activeShifts) {
        const need = Math.max(0, demand[s][date] - (taken[s] || 0));
        for (let i = 0; i < need; i++) out.push(s);
      }
      return out;
    }

    // Initial shift counter
    const shiftCount = {};
    for (const p of people) {
      shiftCount[p] = {};
      for (const d of dates) {
        const s = schedule[p][d];
        if (s && !isOff(s)) shiftCount[p][s] = (shiftCount[p][s] || 0) + 1;
      }
    }

    const nActive = activeShifts.length;
    function shiftTypesCovered(p) {
      let n = 0;
      for (const s of activeShifts) if ((shiftCount[p][s] || 0) > 0) n++;
      return n;
    }
    const shiftTypesMissing = p => nActive - shiftTypesCovered(p);

    // ---------- main assignment loop ----------
    const overCapacity = [];
    const workDates = dates.filter(d => !sundays.has(d));

    // What did each person work the calendar day BEFORE `date`? For day 0
    // that's `prevDayShifts` (last day of previous month). For day i>0 it's
    // schedule[p][dates[i-1]].
    function prevDayShiftOf(p, date) {
      const idx = dateIndex[date];
      if (idx === 0) return prevDayShifts ? prevDayShifts[p] : null;
      if (idx > 0)  return schedule[p][dates[idx - 1]];
      return null;
    }

    // Soft-violations: when we couldn't honor a cap because the schedule
    // would otherwise be infeasible. Reported as warnings (not FATAL).
    const capRelaxed = [];

    workDates.forEach((d, dayIdx) => {
      // Skip locked dates whose demand is already met
      if (lockedDates.has(d) && remainingDemand(d).length === 0) return;

      const needed = remainingDemand(d);
      let free = people.filter(p => schedule[p][d] === "");

      if (free.length < needed.length) overCapacity.push([d, needed.length, free.length]);

      // 1) Pick extras for OFF (PLACEHOLDER N)
      //    A person whose previous-day shift forces rest MUST land in this
      //    bucket today.
      const surplus = free.length - needed.length;
      const mustRest = free.filter(p => prevDayForcesRest(prevDayShiftOf(p, d)));
      if (mustRest.length) {
        for (const p of mustRest) schedule[p][d] = PLACEHOLDER;
        free = people.filter(p => schedule[p][d] === "");
      }
      const surplusNow = free.length - needed.length;
      if (surplusNow > 0) {
        const offKey = p => [
          -shiftTypesCovered(p),
          ndays(p),
          -workdays(p),
        ];
        const safe   = free.filter(p => !adjacentN(p, d));
        const unsafe = free.filter(p =>  adjacentN(p, d));
        sortByKey(safe, offKey);
        sortByKey(unsafe, offKey);
        let chosen = safe.slice(0, surplusNow);
        if (chosen.length < surplusNow) chosen = chosen.concat(unsafe.slice(0, surplusNow - chosen.length));
        for (const p of chosen) schedule[p][d] = PLACEHOLDER;
        free = people.filter(p => schedule[p][d] === "");
      }

      // 2) Decide shift processing order today
      const shiftTotalDone = {};
      for (const s of activeShifts) {
        let t = 0;
        for (const pp of people) t += (shiftCount[pp][s] || 0);
        shiftTotalDone[s] = t;
      }
      const orderedNeeded = needed.slice().sort((a, b) => {
        const ka = [shiftTotalDone[a], (activeShifts.indexOf(a) + dayIdx) % Math.max(1, nActive)];
        const kb = [shiftTotalDone[b], (activeShifts.indexOf(b) + dayIdx) % Math.max(1, nActive)];
        return compareTuple(ka, kb);
      });

      // 3) Assign each shift, preferring people who NEED it most.
      //    Filter candidates by:
      //      - monthly cap for this shift (Rule 7)
      //      - forbidNextDay from the previous calendar day (Rule 8)
      //      - global maxWorkdaysPerMonth (Rule 9)
      //    When NO candidate passes all filters we relax the soft caps
      //    (monthlyCap, maxWorkdaysPerMonth) so the demand is still met --
      //    and emit a WARNING describing what we had to relax.
      for (const shift of orderedNeeded) {
        if (!free.length) break;
        const meta = metaFor(shift);
        const passCap     = p => meta.monthlyCap == null || (shiftCount[p][shift] || 0) < meta.monthlyCap;
        const passWorkCap = p => maxWorkdaysPerMonth == null || workdays(p) < maxWorkdaysPerMonth;
        const passForbid  = p => !prevDayForbids(prevDayShiftOf(p, d), shift);

        let pool = free.filter(p => passCap(p) && passWorkCap(p) && passForbid(p));
        let relaxedTags = [];

        if (!pool.length) {
          // Relaxation order: keep forbidNextDay (it's a real rest
          // requirement) but relax the monthly cap first, then the workday
          // cap. forbidNextDay is treated as hard because relaxing it would
          // schedule unsafe back-to-back patterns.
          pool = free.filter(p => passWorkCap(p) && passForbid(p));
          if (pool.length) relaxedTags.push("monthly-cap");
        }
        if (!pool.length) {
          pool = free.filter(p => passForbid(p));
          if (pool.length) relaxedTags.push("max-workdays");
        }
        if (!pool.length) {
          // Even the hard forbid blocks every remaining person -- nothing
          // we can do but leave the slot unfilled (existing behavior).
          continue;
        }

        const candidate = minBy(pool, p => [
          shiftCount[p][shift] || 0,
          -shiftTypesMissing(p),
          workdays(p),
        ]);
        schedule[candidate][d] = shift;
        shiftCount[candidate][shift] = (shiftCount[candidate][shift] || 0) + 1;
        free = free.filter(p => p !== candidate);

        if (relaxedTags.length) {
          capRelaxed.push([d, shift, candidate, relaxedTags.join(", ")]);
        }
      }
    });

    if (capRelaxed.length) {
      // Summarise rather than spam one warning per cell.
      const byTag = {};
      for (const [d, s, p, tag] of capRelaxed) {
        (byTag[tag] = byTag[tag] || []).push(`${p}@${d}:${s}`);
      }
      for (const [tag, list] of Object.entries(byTag)) {
        warnings.push(
          `WARNING: had to relax ${tag} on ${list.length} assignment(s) to keep demand met: ${list.slice(0, 8).join(", ")}${list.length > 8 ? `, ...(+${list.length - 8} more)` : ""}.`
        );
      }
    }

    // PLACEHOLDER -> N
    for (const p of people) {
      for (const d of dates) if (schedule[p][d] === PLACEHOLDER) schedule[p][d] = "N";
    }

    // ---------- assemble Final rows ----------
    const outRows = [["Name", ...dates]];
    for (const p of people) outRows.push([p, ...dates.map(d => schedule[p][d])]);

    // ---------- report ----------
    const report = formatReport({ lines, warnings, overCapacity, people, dates,
      activeShifts, sundays, lockedDates, dirtyDates,
      schedule, registered, demand });

    return {
      ok: !warnings.some(w => w.startsWith("FATAL")),
      rows: outRows,
      report,
      warnings,
      locked_dates: [...lockedDates].sort((a, b) => dateSortKey(a) - dateSortKey(b)),
      dirty_dates:  [...dirtyDates].sort((a, b) => dateSortKey(a) - dateSortKey(b)),
      mode: incremental ? "incremental" : "full",
    };
  }

  // ---------- text report ----------
  function formatReport(ctx) {
    const { lines, warnings, overCapacity, people, dates,
      activeShifts, sundays, lockedDates, dirtyDates,
      schedule, registered, demand } = ctx;
    const log = (...a) => lines.push(a.join(" "));

    log("=".repeat(72));
    log("VERIFICATION REPORT");
    log("=".repeat(72));

    if (warnings.length) {
      log("");
      log("!! WARNINGS / CONFLICTS:");
      for (const w of warnings) log("   " + w);
    } else {
      log("");
      log("No conflicts detected.");
    }

    log("");
    log("Sundays (everyone off): " + JSON.stringify([...sundays].sort((a, b) => parseDate(a) - parseDate(b))));
    if (lockedDates.size || dirtyDates.size) {
      log(`Incremental: kept ${lockedDates.size} dates from previous plan, re-arranged ${dirtyDates.size} dates.`);
      if (dirtyDates.size) {
        log("  Re-arranged: " + JSON.stringify([...dirtyDates].sort((a, b) => parseDate(a) - parseDate(b))));
      }
    }

    if (!schedule) return lines.join("\n");

    const OFF = new Set(["N", "P"]);
    log("");
    log("Working days per person (target 22-24):");
    for (const p of people) {
      const w  = dates.reduce((n, d) => n + (schedule[p][d] && !OFF.has(schedule[p][d]) ? 1 : 0), 0);
      const nn = dates.reduce((n, d) => n + (schedule[p][d] === "N" ? 1 : 0), 0);
      const pl = dates.reduce((n, d) => n + (schedule[p][d] === "P" ? 1 : 0), 0);
      const flag = (w >= 22 && w <= 24) ? "" : "  <-- outside 22-24";
      log(`  ${p.padEnd(5)} work=${String(w).padStart(2)}  N=${String(nn).padStart(2)}  P=${pl}  total=${String(w+nn+pl).padStart(2)}${flag}`);
    }

    log("");
    log("Demand coverage:");
    let coverageOk = true;
    for (const d of dates) {
      const counts = {};
      for (const p of people) {
        const s = schedule[p][d];
        if (s && !OFF.has(s)) counts[s] = (counts[s] || 0) + 1;
      }
      for (const s of activeShifts) {
        if ((counts[s] || 0) !== demand[s][d]) {
          log(`  MISMATCH ${d} ${s}: needed ${demand[s][d]}, got ${counts[s] || 0}`);
          coverageOk = false;
        }
      }
    }
    log(coverageOk ? "  All days fully covered." : "  -- DEMAND NOT FULLY MET --");

    log("");
    log("Registrations honored:");
    let regOk = true;
    for (const p of people) {
      for (const [d, code] of Object.entries(registered[p] || {})) {
        if (schedule[p][d] !== code) {
          log(`  VIOLATION ${p} ${d}: registered=${code} got=${schedule[p][d]}`);
          regOk = false;
        }
      }
    }
    log(regOk ? "  All registrations preserved." : "  -- REGISTRATION VIOLATIONS --");

    log("");
    log("Shift-type coverage per person (Rule 3 - everyone tries every shift):");
    let perfect = true;
    const counts = {};
    for (const p of people) {
      counts[p] = {};
      for (const s of activeShifts) counts[p][s] = 0;
      for (const d of dates) {
        const s = schedule[p][d];
        if (activeShifts.includes(s)) counts[p][s]++;
      }
      const missing = activeShifts.filter(s => counts[p][s] === 0);
      if (missing.length) { perfect = false; log(`  ${p}: missing [${missing.join(", ")}]`); }
      else log(`  ${p}: all ${activeShifts.length} shift types covered`);
    }
    if (perfect) log("  Every person rotated through every shift type.");

    // Shift count matrix
    log("");
    log("Shift-count matrix (per person x shift):");
    const headerCells = activeShifts.map(s => s.padStart(6));
    log("  " + "P".padEnd(5) + headerCells.join("") + "  TOT");
    log("  " + "-".repeat(5 + headerCells.join("").length + 5));
    const totals = {};
    for (const s of activeShifts) totals[s] = 0;
    for (const p of people) {
      let line = "  " + p.padEnd(5);
      let row = 0;
      for (const s of activeShifts) {
        line += String(counts[p][s]).padStart(6);
        totals[s] += counts[p][s];
        row += counts[p][s];
      }
      line += "  " + String(row).padStart(3);
      log(line);
    }
    log("  " + "-".repeat(5 + headerCells.join("").length + 5));
    log("  " + "TOT".padEnd(5) + activeShifts.map(s => String(totals[s]).padStart(6)).join(""));

    log("");
    log("Shift-balance summary (lower spread = fairer distribution):");
    for (const s of activeShifts) {
      const cArr = people.map(p => dates.reduce((n, d) => n + (schedule[p][d] === s ? 1 : 0), 0));
      const mn = Math.min(...cArr), mx = Math.max(...cArr);
      log(`  ${s.padEnd(6)}: min=${mn}  max=${mx}  spread=${mx - mn}  total=${cArr.reduce((a, b) => a + b, 0)}`);
    }

    log("");
    log("No-consecutive-N check:");
    const nViolations = [];
    for (const p of people) {
      for (let i = 0; i < dates.length - 1; i++) {
        if (schedule[p][dates[i]] === "N" && schedule[p][dates[i + 1]] === "N") {
          nViolations.push([p, dates[i], dates[i + 1]]);
        }
      }
    }
    if (!nViolations.length) {
      log("  No back-to-back N anywhere.");
    } else {
      log(`  ${nViolations.length} pair(s) of consecutive N (usually unavoidable when a Sat/Mon adjoins a Sunday with full demand):`);
      for (const [p, d1, d2] of nViolations) log(`    ${p}: ${d1} & ${d2}`);
    }

    if (overCapacity.length) {
      log("");
      log("Days where demand exceeded available people:");
      for (const [d, need, have] of overCapacity) log(`  ${d}: needed ${need}, only ${have} free`);
    }

    return lines.join("\n");
  }

  root.Scheduler = { runSchedule };
})(window);
