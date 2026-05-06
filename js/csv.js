/* Minimal CSV parser / serializer (RFC 4180-ish).
   Handles quoted fields, embedded commas, escaped quotes ("").
   Returns array-of-arrays; keeps empty cells as "". */
(function (root) {
  function parse(text) {
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;
    let i = 0;
    const len = text.length;

    while (i < len) {
      const ch = text[i];

      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQuotes = false; i++; continue;
        }
        field += ch; i++; continue;
      }

      if (ch === '"') { inQuotes = true; i++; continue; }
      if (ch === ',') { row.push(field); field = ""; i++; continue; }
      if (ch === '\r') { i++; continue; }
      if (ch === '\n') {
        row.push(field); rows.push(row);
        row = []; field = "";
        i++; continue;
      }
      field += ch; i++;
    }
    // Trailing field
    if (field !== "" || row.length > 0) {
      row.push(field);
      rows.push(row);
    }
    // Drop fully-empty trailing rows
    while (rows.length && rows[rows.length - 1].every(c => c === "")) rows.pop();
    return rows;
  }

  function serialize(rows) {
    return rows.map(r => r.map(escapeCell).join(",")).join("\r\n") + "\r\n";
  }

  function escapeCell(v) {
    const s = v == null ? "" : String(v);
    if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  root.CSV = { parse, serialize };
})(window);
