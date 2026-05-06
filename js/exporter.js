/* Excel + JSON export.

   Excel uses xlsx-js-style (CDN-loaded in index.html). It produces a styled
   .xlsx that mirrors the look of the on-screen tables (Sunday tint, shift
   colours, frozen header pane).
*/
(function (root) {
  function isSundayHeader(h) {
    if (typeof h !== "string") return false;
    const m = h.match(/^(\d+)\/(\d+)\/(\d+)$/);
    if (!m) return false;
    return new Date(+m[3], +m[1] - 1, +m[2]).getDay() === 0;
  }

  // Build an XLSX worksheet from rows; respects sun/shift colouring.
  function buildSheet(rows, { colorize = false } = {}) {
    if (!rows || !rows.length) return XLSX.utils.aoa_to_sheet([[""]]);

    const ws = XLSX.utils.aoa_to_sheet(rows);
    const header = rows[0];
    const sunCols = new Set();
    header.forEach((h, i) => { if (i > 0 && isSundayHeader(h)) sunCols.add(i); });

    const border = { style: "thin", color: { rgb: "E5E7EB" } };
    const baseBorder = { top: border, bottom: border, left: border, right: border };
    const center = { horizontal: "center", vertical: "center" };

    const FILL = {
      header: { patternType: "solid", fgColor: { rgb: "F9FAFB" } },
      sun:    { patternType: "solid", fgColor: { rgb: "FEF2F2" } },
      n:      { patternType: "solid", fgColor: { rgb: "F3F4F6" } },
      p:      { patternType: "solid", fgColor: { rgb: "DDD6FE" } },
      work:   { patternType: "solid", fgColor: { rgb: "DBEAFE" } },
    };

    for (let r = 0; r < rows.length; r++) {
      for (let c = 0; c < rows[r].length; c++) {
        const ref = XLSX.utils.encode_cell({ r, c });
        const cell = ws[ref] || (ws[ref] = { t: "s", v: rows[r][c] != null ? String(rows[r][c]) : "" });
        cell.s = { alignment: center, border: baseBorder, font: {} };
        if (r === 0) {
          cell.s.font = { bold: true, color: { rgb: "374151" } };
          cell.s.fill = sunCols.has(c) ? FILL.sun : FILL.header;
        } else if (c === 0) {
          cell.s.font = { bold: true };
          cell.s.fill = FILL.header;
        } else if (colorize) {
          const v = String(cell.v || "").trim();
          if (v === "N")      { cell.s.fill = FILL.n;    cell.s.font = { color: { rgb: "6B7280" } }; }
          else if (v === "P") { cell.s.fill = FILL.p;    cell.s.font = { color: { rgb: "5B21B6" }, bold: true }; }
          else if (v)         { cell.s.fill = FILL.work; cell.s.font = { color: { rgb: "1E40AF" } }; }
          else if (sunCols.has(c)) cell.s.fill = FILL.sun;
        } else if (sunCols.has(c)) {
          cell.s.fill = FILL.sun;
        }
      }
    }

    // Column widths + freeze pane on row 1 / col A
    const colWidths = [{ wch: 16 }];
    for (let c = 1; c < header.length; c++) colWidths.push({ wch: 9 });
    ws["!cols"] = colWidths;
    ws["!freeze"] = { xSplit: 1, ySplit: 1 };

    return ws;
  }

  function downloadExcel(filename, sheets) {
    const wb = XLSX.utils.book_new();
    for (const { name, rows, colorize } of sheets) {
      XLSX.utils.book_append_sheet(wb, buildSheet(rows, { colorize }), name);
    }
    XLSX.writeFile(wb, filename);
  }

  function downloadJSON(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  root.Exporter = { downloadExcel, downloadJSON };
})(window);
