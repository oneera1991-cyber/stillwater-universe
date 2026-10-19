/*
UNLIMITED PACK MEMBERSHIP (฿399 → unlimited Deeper readings for 30 days)
Ported from the ideas in origin/test/unlimited-v5 (token + code login), simplified:
  - membership token: 32 random bytes (base64url), kept in the browser's localStorage
    ("stillwater.member"). Only its SHA-256 is stored server-side.
  - recovery code: "VERA-XXXX-XXXX" shown once to the customer after purchase; redeeming it on
    another browser issues a new token for the same membership.
Keys (Upstash, existing KV client):
  vera:member:m:<id>       JSON { id, startsAt, expiresAt, method, ref, readings }    EX until expiry + 7d
  vera:member:t:<sha256>   <id>                                                        same EX
  vera:member:c:<CODE>     <id>                                                        same EX
  vera:member:ref:<ref>    <id>   (one payment = one membership; SET NX)               same EX
*/
import { createHash, randomBytes } from "node:crypto";
import { redis } from "./kv.js";
import { UNLIMITED_DAYS } from "./payment.js";

const K = { m: "vera:member:m:", t: "vera:member:t:", c: "vera:member:c:", ref: "vera:member:ref:" };
export const DAY_MS = 24 * 60 * 60 * 1000;
const hash = (token) => createHash("sha256").update(String(token)).digest("hex");
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function newCode() {
  const b = randomBytes(8);
  const s = [...b].map((x) => CODE_ALPHABET[x % CODE_ALPHABET.length]).join("");
  return "VERA-" + s.slice(0, 4) + "-" + s.slice(4, 8);
}
export const normCode = (c) => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^VERA/, "").replace(/^(.{4})(.{4})$/, "VERA-$1-$2");
const isToken = (t) => typeof t === "string" && /^[A-Za-z0-9_-]{40,60}$/.test(t);
const ttlSec = (m, now) => Math.max(60, Math.ceil((m.expiresAt - now) / 1000) + 7 * 86400);

export function publicView(m, now = Date.now()) {
  if (!m) return { active: false };
  return { active: now < m.expiresAt, expiresAt: m.expiresAt, startsAt: m.startsAt, readings: m.readings || 0 };
}

/** Create a membership for one verified Unlimited payment. ref = slip transRef / Payhip txn id. */
export async function createMembership({ method, ref, now = Date.now() }) {
  if (!ref) throw Object.assign(new Error("membership needs a payment ref"), { code: "payment_missing" });
  const id = "mem_" + randomBytes(9).toString("base64url");
  const m = { id, startsAt: now, expiresAt: now + UNLIMITED_DAYS * DAY_MS, method: String(method || ""), ref: String(ref), readings: 0 };
  const ex = ttlSec(m, now);
  if ((await redis("SET", K.ref + m.ref, id, "NX", "EX", ex)) !== "OK") {
    throw Object.assign(new Error("payment already used for a membership"), { code: "member_used", status: 409 });
  }
  const token = randomBytes(32).toString("base64url");
  const code = newCode();
  await redis("SET", K.m + id, JSON.stringify(m), "EX", ex);
  await redis("SET", K.t + hash(token), id, "EX", ex);
  await redis("SET", K.c + code, id, "EX", ex);
  return { token, code, membership: m };
}

async function load(id) {
  if (!id) return null;
  const raw = await redis("GET", K.m + id);
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}
export async function membershipByToken(token) {
  if (!isToken(token)) return null;
  return load(await redis("GET", K.t + hash(token)));
}
/** Active membership for this token or null (30-day expiry check). */
export async function activeMembership(token, now = Date.now()) {
  const m = await membershipByToken(token);
  return m && now < m.expiresAt ? m : null;
}
/** Recovery code → a NEW token for the same membership (old tokens keep working). */
export async function recoverByCode(code, now = Date.now()) {
  const c = normCode(code);
  if (!/^VERA-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(c)) return null;
  const m = await load(await redis("GET", K.c + c));
  if (!m || now >= m.expiresAt) return null;
  const token = randomBytes(32).toString("base64url");
  await redis("SET", K.t + hash(token), m.id, "EX", ttlSec(m, now));
  return { token, membership: m };
}
export async function countReading(m, now = Date.now()) {
  try { const n = { ...m, readings: (m.readings || 0) + 1, lastAt: now }; await redis("SET", K.m + m.id, JSON.stringify(n), "EX", ttlSec(m, now)); } catch {}
}
