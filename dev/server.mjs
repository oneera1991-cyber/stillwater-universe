/*
LOCAL DEV SHIM — not deployed (see .vercelignore).
  node dev/server.mjs [port]
Serves the repo statically and runs /api/** handlers with a tiny Vercel-like
req/res shim. Mocks the payment providers by intercepting fetch():
  - https://api.easyslip.com  (active provider: PromptPay + EasySlip)
  - https://api.omise.co      (inactive option: PAYMENT_PROVIDER=omise)
Production code is untouched.

Mock EasySlip scenarios are chosen by an ASCII marker inside the uploaded
image bytes ("MOCK:<scenario>#<nonce>", e.g. appended after PNG IEND):
  success (default) | wrong_amount | wrong_account | pending | unreadable |
  quota | old | timeout (hangs until EASYSLIP_TIMEOUT_MS) | down (HTTP 500 API_SERVER_ERROR). Re-uploading a slip that already succeeded → isDuplicate=true
  (same transRef), like the real checkDuplicate=true.
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
import { setSink, consoleSink, redisFromEnv, redisSink } from "../api/_lib/log.js";
import { orderRef, MAEMANEE_BILLER_ID } from "../api/_lib/payment/maemanee.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.argv[2] || process.env.PORT || 3123);

if (process.env.PAYMENT_PROVIDER === "omise") {
  process.env.OMISE_PUBLIC_KEY ||= "pkey_test_mock";
  process.env.OMISE_SECRET_KEY ||= "skey_test_mock_" + crypto.randomBytes(8).toString("hex");
}
process.env.ORDER_SIGNING_KEY ||= crypto.randomBytes(32).toString("hex");
process.env.PROMPTPAY_ID ||= "0000000000"; // obviously-fake mock PromptPay ID
if (!("PAYEE_NAME_TH" in process.env)) process.env.PAYEE_NAME_TH = "นาย ทดสอบ ตัวอย่าง"; // dummy receiving account name (set PAYEE_NAME_TH= to test "missing")
if (!("PAYEE_NAME_EN" in process.env)) process.env.PAYEE_NAME_EN = "MR. TEST EXAMPLE";
process.env.EASYSLIP_API_KEY ||= "mock-easyslip-key";
process.env.EASYSLIP_MOCK = "1";
// PAYMENT_QR_MODE=maemanee node dev/server.mjs → Mae Manee bill-payment QR + Mae Manee-shaped mock slips
const MAEMANEE = String(process.env.PAYMENT_QR_MODE || "").toLowerCase() === "maemanee";
if (MAEMANEE) { process.env.MAEMANEE_SHOP_ID ||= "000000000000000"; process.env.MAEMANEE_SHOP_NAME ||= "ร้านทดสอบ สติลวอเตอร์"; }
delete process.env.OPENAI_API_KEY;
process.env.VERA_READER = "stub"; // never call OpenAI locally / in tests (see api/_lib/reader.js)

/* ---------------- event log: console + in-memory (GET /__mock/events) ---------------- */
// With KV_REST_API_URL / KV_REST_API_TOKEN set (e.g. dev/upstash-mock.mjs or a real Upstash DB),
// rows ALSO go through the production redisSink — the same code path as on Vercel.
const loggedEvents = [];
const devRedis = redisFromEnv() ? redisSink({ echo: false }) : null;
if (devRedis) console.log("dev: events also → Redis list", process.env.LOG_REDIS_KEY || "vera:events", "at", redisFromEnv().url);
setSink({
  name: "dev", timeoutMs: 2500,
  async write(row) { loggedEvents.push(row); if (process.env.LOG_QUIET !== "1") await consoleSink.write(row); if (devRedis) await devRedis.write(row); },
  async writeMany(rows) { for (const row of rows) { loggedEvents.push(row); if (process.env.LOG_QUIET !== "1") await consoleSink.write(row); } if (devRedis) await devRedis.writeMany(rows); }
});

/* ---------------- mock EasySlip v2 ---------------- */
const seenTransRefs = new Set();
const easyslipCalls = [];
async function mockEasySlip(url, init) {
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const err = (status, code, message) => json(status, { success: false, error: { code, message } });
  if (url.pathname !== "/v2/verify/bank" || init.method !== "POST") return err(404, "NOT_FOUND", "mock: unknown route");
  if (String(init.headers?.Authorization || "") !== "Bearer " + process.env.EASYSLIP_API_KEY) return err(401, "INVALID_API_KEY", "API key is invalid");
  const form = init.body;
  if (!(form instanceof FormData)) return err(400, "VALIDATION_ERROR", "mock expects multipart FormData");
  const image = form.get("image");
  const fields = { matchAmount: form.get("matchAmount"), matchAccount: form.get("matchAccount"), checkDuplicate: form.get("checkDuplicate"), remark: form.get("remark") };
  easyslipCalls.push(fields);
  if (!image || typeof image.arrayBuffer !== "function") return err(400, "VALIDATION_ERROR", "At least one of payload, image, url, or base64 is required");
  if (fields.matchAmount !== "59" || fields.matchAccount !== "true" || fields.checkDuplicate !== "true") {
    return err(400, "VALIDATION_ERROR", "mock: expected matchAmount=59, matchAccount=true, checkDuplicate=true");
  }
  const bytes = Buffer.from(await image.arrayBuffer());
  if (bytes.length > 4194304) return err(400, "IMAGE_SIZE_TOO_LARGE", "Image size exceeds 4MB limit");
  await new Promise((r) => setTimeout(r, 1500)); // let the UI show "checking"
  const marker = bytes.toString("latin1").match(/MOCK:([a-z_]+)#/);
  const scenario = marker ? marker[1] : "success";
  if (scenario === "timeout") { // hang until the caller's AbortSignal fires (EASYSLIP_TIMEOUT_MS)
    return new Promise((_, reject) => {
      const sig = init.signal;
      if (!sig) return;
      if (sig.aborted) return reject(sig.reason);
      sig.addEventListener("abort", () => reject(sig.reason), { once: true });
    });
  }
  if (scenario === "down") return err(500, "API_SERVER_ERROR", "Internal server error");
  if (scenario === "pending") return err(404, "SLIP_PENDING", "Bangkok Bank slip is pending. Please wait a few minutes and try again.");
  if (scenario === "unreadable") return err(404, "SLIP_NOT_FOUND", "No QR code found in the image");
  if (scenario === "quota") return err(403, "QUOTA_EXCEEDED", "Your API quota has been exceeded");
  const transRef = "MOCK" + crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 20).toUpperCase();
  const amount = scenario === "wrong_amount" ? 5.9 : 59;
  const isDuplicate = seenTransRefs.has(transRef);
  seenTransRefs.add(transRef);
  if (MAEMANEE) { // Mae Manee-shaped slip (assumed shape until the real 1-baht calibration; matchedAccount null on purpose)
    const wrong = scenario === "wrong_account";
    return json(200, { success: true, message: "Bank slip verified successfully", data: {
      remark: fields.remark, isDuplicate, matchedAccount: null, amountInOrder: 59, amountInSlip: amount, isAmountMatched: amount === 59,
      rawSlip: { payload: "mock", transRef, date: new Date(Date.now() - (scenario === "old" ? 3 * 864e5 : 60e3)).toISOString(), countryCode: "TH",
        amount: { amount, local: { amount, currency: "THB" } }, fee: 0,
        ref1: wrong ? "" : process.env.MAEMANEE_SHOP_ID, ref2: wrong ? "" : orderRef(fields.remark), ref3: "",
        sender: { bank: { id: "004", name: "กสิกรไทย", short: "KBANK" }, account: { name: { th: "ผู้โอน ทดสอบ" } } },
        receiver: wrong
          ? { bank: { id: "004", name: "กสิกรไทย", short: "KBANK" }, account: { name: { th: "ร้านอื่น" } } }
          : { bank: { id: "014", name: "ไทยพาณิชย์", short: "SCB" }, account: { name: { th: process.env.MAEMANEE_SHOP_NAME }, proxy: { type: "BILLERID", account: MAEMANEE_BILLER_ID } }, merchantId: null }
      } } });
  }
  return json(200, {
    success: true,
    message: "Bank slip verified successfully",
    data: {
      remark: fields.remark,
      isDuplicate,
      matchedAccount: scenario === "wrong_account" ? null : {
        bank: { nameTh: "กสิกรไทย", nameEn: "KASIKORNBANK", code: "004", shortCode: "KBANK" },
        nameTh: "บัญชีทดสอบ", nameEn: "MOCK ACCOUNT", type: "PERSONAL", bankNumber: "xxx-x-x0000-x"
      },
      amountInOrder: 59,
      amountInSlip: amount,
      isAmountMatched: amount === 59,
      rawSlip: {
        payload: "mock", transRef,
        date: new Date(Date.now() - (scenario === "old" ? 3 * 864e5 : 60e3)).toISOString(),
        countryCode: "TH",
        amount: { amount, local: { amount, currency: "THB" } }, fee: 0, ref1: "", ref2: "", ref3: "",
        sender: { bank: { id: "014", name: "ไทยพาณิชย์", short: "SCB" }, account: { name: { th: "ผู้โอน ทดสอบ" } } },
        receiver: { bank: { id: "004", name: "กสิกรไทย", short: "KBANK" }, account: { name: { th: "บัญชีทดสอบ" } } }
      }
    }
  });
}

/* ---------------- mock Omise ---------------- */
const charges = new Map();
const QR_SVG = "data:image/svg+xml;utf8," + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 21 21" shape-rendering="crispEdges"><rect width="21" height="21" fill="#fff"/>` +
  Array.from({ length: 160 }, (_, i) => `<rect x="${(i * 7) % 21}" y="${(i * 11) % 21}" width="1" height="1"/>`).join("") +
  `<rect x="0" y="0" width="7" height="7" fill="none" stroke="#000"/><rect x="14" y="0" width="7" height="7" fill="none" stroke="#000"/><rect x="0" y="14" width="7" height="7" fill="none" stroke="#000"/><text x="10.5" y="12" font-size="2.2" text-anchor="middle" fill="#c00">MOCK</text></svg>`
);
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  if (/openai\.com/i.test(String(input?.url || input))) throw new Error("dev/server.mjs: OpenAI calls are blocked in local tests");
  const url = new URL(typeof input === "string" ? input : input.url);
  if (url.hostname === "api.easyslip.com") return mockEasySlip(url, init);
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
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".jpg": "image/jpeg", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json", ".css": "text/css", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8" };

function shimRes(res) {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => { if (!res.getHeader("content-type")) res.setHeader("content-type", "application/json; charset=utf-8"); res.end(JSON.stringify(obj)); return res; };
  res.send = (body) => { res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body)); return res; };
  res.redirect = (a, b) => { const [code, loc] = b === undefined ? [307, a] : [a, b]; res.statusCode = code; res.setHeader("location", loc); res.end(); return res; };
  return res;
}

async function readJsonBody(req) {
  if (!String(req.headers["content-type"] || "").includes("application/json")) return undefined; // leave the stream (multipart etc.) for the handler
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return undefined;
  try { return JSON.parse(raw); } catch { return raw; }
}

const server = http.createServer(async (req, res) => {
  shimRes(res);
  const url = new URL(req.url, "http://" + req.headers.host);
  req.query = Object.fromEntries(url.searchParams);
  try {
    if (url.pathname === "/__mock/easyslip-calls") return res.status(200).json(easyslipCalls);
    if (url.pathname === "/__mock/events") return res.status(200).json(loggedEvents);
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
      req.body = await readJsonBody(req);
      const mod = await import(pathToFileURL(file).href);
      return await mod.default(req, res);
    }
    let p = decodeURIComponent(url.pathname);
    if (p === "/") p = "/index.html";
    if (p === "/terms" || p === "/terms/") p = "/terms.html";       // mirrors the vercel.json rewrites
    if (p === "/privacy" || p === "/privacy/") p = "/privacy.html";
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
