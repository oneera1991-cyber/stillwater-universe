/*
Mae Manee (SCB "แม่มณี") bill-payment QR + slip checks — used by the PromptPay/EasySlip
adapter when PAYMENT_QR_MODE=maemanee. Pure functions, no network.

QR (EMVCo / Thai QR, Tag 30 bill payment), field for field the same as the reference
implementation TamRaiDee/PyThaiPaymentQR MaeManeeQR.py (unit-tested byte-identical):
  00 "01"                      payload format
  01 "11"                      point of initiation (as the reference)
  30 BillPayment:
     00 "A000000677010112"     AID (domestic bill payment)
     01 "010753600010286"      Biller ID (SCB Mae Manee)
     02 MAEMANEE_SHOP_ID       Reference 1 = 15-digit shop id
     03 <order ref>            Reference 2 = short order ref (A–Z 0–9, ≤ 20)
  53 "764"  54 "59.00"  58 "TH"
  62 → 07 "0000000000085234"   terminal id (as the reference)
  63 CRC-16/CCITT-FALSE over everything + "6304"

Slip checks (EasySlip v2 rawSlip; the exact Mae Manee slip JSON is UNVERIFIED until the
1-baht calibration test in LAUNCH.md). Each check is pass / fail / absent:
  bank      receiver.bank.id === "014" (SCB)                  absent counts as fail
  name      receiver.account.name.{th,en} fuzzy-matches MAEMANEE_SHOP_NAME
  biller    receiver.account.proxy (type BILLERID) === 010753600010286   (only if present)
  shop      ref1 or receiver.merchantId === shop id (masked x/* digits tolerated)  (only if present)
  ref2      rawSlip.ref2 === this order's ref                 (only if present)
  matched   EasySlip matchedAccount !== null
  identity  at least one POSITIVE proof: name, biller, shop or matched
Enforced checks come from MAEMANEE_CHECKS (comma list, default "bank,identity,biller,shop,ref2");
the rest are only logged. Add "matched" to also require EasySlip's matchAccount, or "name" to
require the name match by itself. A present-but-different biller/shop/ref2 fails when enforced.
*/

export const MAEMANEE_AID = "A000000677010112";
export const MAEMANEE_BILLER_ID = "010753600010286";
export const MAEMANEE_TERMINAL_ID = "0000000000085234";
export const SCB_BANK_ID = "014";
export const DEFAULT_CHECKS = ["bank", "identity", "biller", "shop", "ref2"];
export const ALL_CHECKS = ["bank", "name", "biller", "shop", "ref2", "matched", "identity"];

const field = (id, value) => id + String(value.length).padStart(2, "0") + value;

/** CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF), 4 uppercase hex chars. */
export function crc16(str) {
  let crc = 0xffff;
  for (const b of Buffer.from(str, "utf8")) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

/** Reference 2 for an order: A–Z 0–9 only, 12 chars (bill-payment refs allow ≤ 20). */
export function orderRef(orderId) {
  return String(orderId || "").replace(/^ord_/, "").replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 12);
}

export function maemaneePayload({ shopId, ref, amount }) {
  if (!/^\d{15}$/.test(String(shopId || ""))) throw new Error("MAEMANEE_SHOP_ID must be 15 digits");
  if (!/^[A-Za-z0-9]{1,20}$/.test(String(ref || ""))) throw new Error("Reference 2 must be 1–20 letters/digits");
  const bill = field("00", MAEMANEE_AID) + field("01", MAEMANEE_BILLER_ID) + field("02", String(shopId)) + field("03", String(ref));
  const body = field("00", "01") + field("01", "11") + field("30", bill) + field("53", "764") +
    field("54", Number(amount).toFixed(2)) + field("58", "TH") + field("62", field("07", MAEMANEE_TERMINAL_ID));
  return body + "6304" + crc16(body + "6304");
}

/** Mae Manee config from env. Throws a plain Error with .code on a missing/invalid shop id. */
export function maemaneeConfig(env = process.env) {
  const shopId = String(env.MAEMANEE_SHOP_ID || "").replace(/[\s-]/g, "");
  if (!/^\d{15}$/.test(shopId)) { const e = new Error("ยังไม่ได้ตั้งค่า MAEMANEE_SHOP_ID"); e.code = "config_missing"; throw e; }
  const list = String(env.MAEMANEE_CHECKS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const checks = list.length ? list.filter((c) => ALL_CHECKS.includes(c)) : DEFAULT_CHECKS.slice();
  const nameMin = Number.isFinite(Number(env.MAEMANEE_NAME_MIN)) && env.MAEMANEE_NAME_MIN !== undefined && env.MAEMANEE_NAME_MIN !== "" ? Number(env.MAEMANEE_NAME_MIN) : 0.6;
  return { shopId, shopName: String(env.MAEMANEE_SHOP_NAME || "").trim(), checks, nameMin };
}

/* ---------- fuzzy name match ---------- */
const HONORIFICS = /^(?:ร้าน|บริษัท|บจก\.?|หจก\.?|นางสาว|นาง|นาย|น\.ส\.|mr\.?|mrs\.?|ms\.?|miss|shop|store)\s*/i;
export function normName(s) {
  let x = String(s || "").normalize("NFC").toLowerCase().trim();
  for (let i = 0; i < 3; i++) x = x.replace(HONORIFICS, "");
  return x.replace(/(?:จำกัด|จํากัด|co\.?,?\s*ltd\.?|company limited|limited)$/i, "").replace(/[\s.,'"()\-_/]+/g, "");
}
function bigrams(s) { const a = []; for (let i = 0; i < s.length - 1; i++) a.push(s.slice(i, i + 2)); return a; }
/** 0..1 similarity; masked/truncated slip names ("STILLWAT", "สติลxxx") count via the visible prefix. */
export function nameSimilarity(slipName, expected) {
  const a = normName(slipName), b = normName(expected);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const visible = a.split(/[x*]{2,}/)[0];               // drop masked tail
  if (visible.length >= 4 && (b.startsWith(visible) || b.includes(visible))) return 0.9;
  if (b.length >= 4 && a.includes(b)) return 0.9;
  const A = bigrams(a), B = bigrams(b); if (!A.length || !B.length) return 0;
  const pool = B.slice(); let hit = 0;
  for (const g of A) { const k = pool.indexOf(g); if (k >= 0) { hit++; pool.splice(k, 1); } }
  return (2 * hit) / (A.length + B.length);
}

/** Equal ignoring separators; x/X/* in the slip value match any char (masked digits). */
export function maskedEqual(slipValue, expected) {
  const a = String(slipValue || "").replace(/[\s-]/g, ""), b = String(expected || "").replace(/[\s-]/g, "");
  if (!a || a.length !== b.length) return false;
  let visible = 0;
  for (let i = 0; i < a.length; i++) {
    if (/[xX*]/.test(a[i])) continue;
    if (a[i].toUpperCase() !== b[i].toUpperCase()) return false;
    visible++;
  }
  return visible >= Math.min(4, b.length);
}

/** Receiver-side fields only (what is printed for the shop on the slip) — for calibration logs. */
export function receiverSnapshot(raw = {}) {
  const r = raw.receiver || {};
  return {
    bank: r.bank ? { id: r.bank.id ?? null, short: r.bank.short ?? null } : null,
    name: r.account?.name ? { th: r.account.name.th ?? null, en: r.account.name.en ?? null } : null,
    account: r.account?.bank ? { type: r.account.bank.type ?? null, account: r.account.bank.account ?? null } : null,
    proxy: r.account?.proxy ? { type: r.account.proxy.type ?? null, account: r.account.proxy.account ?? null } : null,
    merchantId: r.merchantId ?? null,
    ref1: raw.ref1 ?? null, ref2: raw.ref2 ?? null, ref3: raw.ref3 ?? null
  };
}

/**
 * Pure Mae Manee receiver checks. Returns { ok, checks: {name: "pass"|"fail"|"absent"}, similarity }.
 */
export function checkMaeManeeSlip(raw = {}, matchedAccount, { shopId, shopName, checks = DEFAULT_CHECKS, nameMin = 0.6 }, ref) {
  const r = raw.receiver || {};
  const out = {};
  const bankId = r.bank?.id != null ? String(r.bank.id).padStart(3, "0") : "";
  out.bank = !bankId ? "absent" : bankId === SCB_BANK_ID ? "pass" : "fail";
  const names = [r.account?.name?.th, r.account?.name?.en].filter(Boolean);
  const similarity = shopName && names.length ? Math.max(...names.map((n) => nameSimilarity(n, shopName))) : 0;
  out.name = !shopName || !names.length ? "absent" : similarity >= nameMin ? "pass" : "fail";
  const proxy = r.account?.proxy;
  out.biller = proxy && String(proxy.type || "").toUpperCase() === "BILLERID" && proxy.account
    ? (maskedEqual(proxy.account, MAEMANEE_BILLER_ID) ? "pass" : "fail") : "absent";
  const shopVals = [raw.ref1, r.merchantId].filter((v) => v != null && String(v).trim() !== "");
  out.shop = !shopVals.length ? "absent" : shopVals.some((v) => maskedEqual(v, shopId)) ? "pass" : "fail";
  out.ref2 = raw.ref2 == null || String(raw.ref2).trim() === "" || !ref ? "absent"
    : String(raw.ref2).replace(/[^A-Za-z0-9]/g, "").toUpperCase() === ref ? "pass" : "fail";
  out.matched = matchedAccount ? "pass" : "fail";
  out.identity = ["name", "biller", "shop", "matched"].some((k) => out[k] === "pass") ? "pass" : "fail";

  const enforced = new Set(checks);
  let ok = true;
  if (enforced.has("bank") && out.bank !== "pass") ok = false;
  if (enforced.has("identity") && out.identity !== "pass") ok = false;
  if (enforced.has("name") && out.name !== "pass") ok = false;
  if (enforced.has("matched") && out.matched !== "pass") ok = false;
  for (const k of ["biller", "shop", "ref2"]) if (enforced.has(k) && out[k] === "fail") ok = false;
  return { ok, checks: out, similarity: Math.round(similarity * 100) / 100 };
}
