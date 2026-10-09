#!/usr/bin/env node
/*
OPTIONAL CLEANUP — NOT SCHEDULED, NOT RUN AUTOMATICALLY, DOES NOT CALL GOOGLE.

Plans which rows of the `events` Sheet to delete, from a CSV export of that tab
(File → Download → CSV), and prints the Google Sheets `batchUpdate` request
that would delete them. Nothing is sent anywhere.

  node scripts/purge-old-rows.mjs events.csv                       # rows older than 90 days (by ts)
  node scripts/purge-old-rows.mjs events.csv --days 30
  node scripts/purge-old-rows.mjs events.csv --reading-id KB1LPQJH # every row of one reading (deletion request)
  node scripts/purge-old-rows.mjs events.csv --sheet-gid 0 --json  # request body only

Reading ID = first 8 chars of order_id after "ord_", uppercased (see api/_lib/order.js readingId()).
The match is case-insensitive on that prefix; check the printed rows before deleting.

To actually delete: paste the printed request into the Sheets API explorer, or
use the Apps Script snippet in README (runs inside the Sheet, no keys needed).
TODO(auth): if this should run unattended, add a service-account token here
(same as api/_lib/log.js sheetsSink) — deliberately not implemented.
*/
import { readFileSync } from "node:fs";

/** Minimal RFC-4180 CSV parser (quotes, escaped quotes, newlines in fields). */
export function parseCSV(text) {
  const rows = []; let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || r[0] !== "");
}

export function readingIdOf(orderId) {
  return String(orderId || "").replace(/^ord_/, "").slice(0, 8).toUpperCase();
}

/**
 * @returns {{ header, matches: [{ sheetRow, ts, event, order_id }], request }}
 * sheetRow is 1-based (row 1 = header).
 */
export function planPurge(rows, { days = 90, readingId = null, now = Date.now(), sheetGid = 0 } = {}) {
  const [header, ...data] = rows;
  const col = (name) => header.indexOf(name);
  const iTs = col("ts"), iEv = col("event"), iOrder = col("order_id");
  if (iTs < 0 || iOrder < 0) throw new Error("CSV must have the events header (ts, event, order_id, ...)");
  const cutoff = now - days * 24 * 3600e3;
  const want = readingId ? String(readingId).trim().toUpperCase() : null;
  const matches = [];
  data.forEach((r, i) => {
    const ts = Date.parse(r[iTs]);
    const hit = want ? (r[iOrder] && readingIdOf(r[iOrder]) === want) : (!Number.isNaN(ts) && ts < cutoff);
    if (hit) matches.push({ sheetRow: i + 2, ts: r[iTs], event: r[iEv], order_id: r[iOrder] });
  });
  // Delete bottom-up so earlier deletions don't shift later indexes.
  const requests = [...matches].reverse().map((m) => ({
    deleteDimension: { range: { sheetId: sheetGid, dimension: "ROWS", startIndex: m.sheetRow - 1, endIndex: m.sheetRow } }
  }));
  return { header, matches, request: { requests } };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const args = process.argv.slice(2);
  const withValue = new Set(["--days", "--reading-id", "--sheet-gid"]);
  const file = args.find((a, i) => !a.startsWith("--") && !withValue.has(args[i - 1]));
  const opt = (name, d) => { const i = args.indexOf("--" + name); return i >= 0 ? args[i + 1] : d; };
  if (!file) { console.error("usage: node scripts/purge-old-rows.mjs <events.csv> [--days 90 | --reading-id ID] [--sheet-gid 0] [--json]"); process.exit(2); }
  const plan = planPurge(parseCSV(readFileSync(file, "utf8")), {
    days: Number(opt("days", 90)), readingId: opt("reading-id", null), sheetGid: Number(opt("sheet-gid", 0))
  });
  if (args.includes("--json")) { console.log(JSON.stringify(plan.request, null, 2)); process.exit(0); }
  console.log(`${plan.matches.length} row(s) would be deleted (dry run — nothing was sent):`);
  for (const m of plan.matches) console.log(`  row ${m.sheetRow}  ${m.ts}  ${m.event}  ${readingIdOf(m.order_id) || "(no order)"}`);
  console.log("\nSheets API: POST https://sheets.googleapis.com/v4/spreadsheets/<GOOGLE_SHEETS_ID>:batchUpdate");
  console.log(JSON.stringify(plan.request));
}
