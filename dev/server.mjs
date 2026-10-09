/*
LOCAL DEV SHIM — not deployed (see .vercelignore).
  node dev/server.mjs [port]
Serves the repo statically and runs /api/** handlers with a tiny Vercel-like
req/res shim. Mocks the payment provider (Omise HTTP API) by intercepting
fetch() to https://api.omise.co — production code is untouched.
OpenAI is not called at all: /api/read and /api/deeper are stubs today.
(If Stillwater's vera.js lands, run with OPENAI_API_KEY unset and use its
setClientForTesting() mock, or extend the fetch interceptor below.)

Dev-only endpoints:
  POST /__mock/pay?payment=<id>          mark a mock charge successful
  POST /__mock/charge?payment=<id>&...    patch a mock charge (amount, currency, orderId, status)
*/
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import crypto from "node:crypto";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.argv[2] || process.env.PORT || 3123);

process.env.OMISE_PUBLIC_KEY ||= "pkey_test_mock";
process.env.OMISE_SECRET_KEY ||= "skey_test_mock_" + crypto.randomBytes(8).toString("hex");
delete process.env.OPENAI_API_KEY;

/* ---------------- mock Omise ---------------- */
const charges = new Map();
const QR_SVG = "data:image/svg+xml;utf8," + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 21 21" shape-rendering="crispEdges"><rect width="21" height="21" fill="#fff"/>` +
  Array.from({ length: 160 }, (_, i) => `<rect x="${(i * 7) % 21}" y="${(i * 11) % 21}" width="1" height="1"/>`).join("") +
  `<rect x="0" y="0" width="7" height="7" fill="none" stroke="#000"/><rect x="14" y="0" width="7" height="7" fill="none" stroke="#000"/><rect x="0" y="14" width="7" height="7" fill="none" stroke="#000"/><text x="10.5" y="12" font-size="2.2" text-anchor="middle" fill="#c00">MOCK</text></svg>`
);
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (url.hostname !== "api.omise.co") return realFetch(input, init);
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const auth = String(init.headers?.Authorization || "");
  if (!auth.startsWith("Basic ")) return json(401, { object: "error", message: "auth" });
  const form = init.body ? new URLSearchParams(String(init.body)) : new URLSearchParams();
  if (init.method === "POST" && url.pathname === "/sources") {
    return json(200, { object: "source", id: "src_test_" + crypto.randomBytes(6).toString("hex"), type: form.get("type") });
  }
  if (init.method === "POST" && url.pathname === "/charges") {
    const metadata = {};
    for (const [k, v] of form) { const m = k.match(/^metadata\[(.+)\]$/); if (m) metadata[m[1]] = v; }
    const charge = {
      object: "charge", id: "chrg_test_" + crypto.randomBytes(6).toString("hex"),
      status: "pending", amount: Number(form.get("amount")), currency: "THB", metadata,
      source: { id: form.get("source"), scannable_code: { image: { download_uri: QR_SVG } } }
    };
    charges.set(charge.id, charge);
    return json(200, charge);
  }
  const m = url.pathname.match(/^\/charges\/(chrg_[\w]+)$/);
  if (m && (!init.method || init.method === "GET")) {
    const c = charges.get(m[1]);
    return c ? json(200, c) : json(404, { object: "error", message: "charge not found" });
  }
  return json(404, { object: "error", message: "mock: unknown route" });
};

/* ---------------- Vercel-ish handler shim ---------------- */
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".jpg": "image/jpeg", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json", ".css": "text/css" };

function shimRes(res) {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => { if (!res.getHeader("content-type")) res.setHeader("content-type", "application/json; charset=utf-8"); res.end(JSON.stringify(obj)); return res; };
  res.send = (body) => { res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body)); return res; };
  res.redirect = (a, b) => { const [code, loc] = b === undefined ? [307, a] : [a, b]; res.statusCode = code; res.setHeader("location", loc); res.end(); return res; };
  return res;
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return undefined;
  if (String(req.headers["content-type"] || "").includes("application/json")) {
    try { return JSON.parse(raw); } catch { return raw; }
  }
  return raw;
}

const server = http.createServer(async (req, res) => {
  shimRes(res);
  const url = new URL(req.url, "http://" + req.headers.host);
  req.query = Object.fromEntries(url.searchParams);
  try {
    if (url.pathname.startsWith("/__mock/")) {
      const c = charges.get(url.searchParams.get("payment"));
      if (!c) return res.status(404).json({ error: "no such mock charge" });
      if (url.pathname === "/__mock/pay") c.status = "successful";
      if (url.pathname === "/__mock/charge") {
        for (const k of ["status", "currency"]) if (url.searchParams.has(k)) c[k] = url.searchParams.get(k);
        if (url.searchParams.has("amount")) c.amount = Number(url.searchParams.get("amount"));
        if (url.searchParams.has("orderId")) c.metadata.orderId = url.searchParams.get("orderId");
      }
      return res.status(200).json({ ok: true, charge: c });
    }
    if (url.pathname.startsWith("/api/")) {
      const rel = url.pathname.replace(/\/+$/, "");
      if (rel.split("/").some((p) => p.startsWith("_"))) return res.status(404).json({ error: "not found" });
      const file = path.join(ROOT, rel + ".js");
      if (!file.startsWith(path.join(ROOT, "api"))) return res.status(404).end();
      await stat(file);
      req.body = await readBody(req);
      const mod = await import(pathToFileURL(file).href);
      return await mod.default(req, res);
    }
    let p = decodeURIComponent(url.pathname);
    if (p === "/") p = "/index.html";
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT) || /\/(\.git|dev|api)\//.test(file.slice(ROOT.length) + "/")) return res.status(404).end("not found");
    const buf = await readFile(file);
    res.setHeader("content-type", MIME[path.extname(file)] || "application/octet-stream");
    return res.end(buf);
  } catch (err) {
    if (err.code === "ENOENT") return res.status(404).end("not found");
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: "dev server error" });
  }
});
server.listen(PORT, () => console.log(`stillwater dev shim on http://localhost:${PORT}`));
