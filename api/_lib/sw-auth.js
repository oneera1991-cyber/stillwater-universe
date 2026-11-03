/* Passwordless email codes. Codes are 6 digits, stored only as HMAC hashes, expire in 10 min, max 5 tries.
   Rate limits: 3 sends / 10 min per email, 20 sends / hour per IP. Sessions: HMAC-signed token, 30 days. */
import crypto from "node:crypto";
import { cmd, getJson, setJson, limit } from "./sw-store.js";
import { sendCode, devCodesAllowed } from "./sw-mail.js";
const secret = () => process.env.SW_SECRET || process.env.ORDER_SIGNING_KEY || "dev-only-secret";
const h = (s) => crypto.createHmac("sha256", secret()).update(s).digest("hex");
export const normEmail = (e) => String(e || "").trim().toLowerCase();
export const validEmail = (e) => /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/.test(e);
export const uid = (email) => h("u:" + email).slice(0, 24);
const CODE_TTL = 600, SESSION_DAYS = 30;

export async function requestCode(emailRaw, ip, profile) {
  const email = normEmail(emailRaw);
  if (!validEmail(email)) return { ok: false, code: "bad_email" };
  if (!(await limit("e:" + uid(email), 3, 600)) || !(await limit("ip:" + h(ip || "?").slice(0, 16), 20, 3600))) return { ok: false, code: "rate_limited" };
  const code = String(crypto.randomInt(0, 1e6)).padStart(6, "0");
  await setJson("otp:" + uid(email), { h: h(email + ":" + code), tries: 0, profile: profile || null }, CODE_TTL);
  await sendCode(email, code);
  return devCodesAllowed() ? { ok: true, devCode: code } : { ok: true };
}
export async function verifyCode(emailRaw, codeRaw) {
  const email = normEmail(emailRaw), code = String(codeRaw || "").replace(/\D/g, "");
  const id = uid(email), rec = await getJson("otp:" + id);
  if (!rec) return { ok: false, code: "expired" };
  if (rec.tries >= 5) { await cmd("DEL", "otp:" + id); return { ok: false, code: "too_many" }; }
  const good = code.length === 6 && crypto.timingSafeEqual(Buffer.from(rec.h), Buffer.from(h(email + ":" + code)));
  if (!good) { rec.tries++; await setJson("otp:" + id, rec, CODE_TTL); return { ok: false, code: "wrong" }; }
  await cmd("DEL", "otp:" + id);
  let user = await getJson("user:" + id);
  if (!user) user = { id, email, member: false, created: new Date().toISOString(), profile: rec.profile };
  else if (rec.profile && !user.profile) user.profile = rec.profile;
  user.last = new Date().toISOString();
  await setJson("user:" + id, user);
  return { ok: true, token: signSession(id), user };
}
export function signSession(id, now = Date.now()) {
  const body = Buffer.from(JSON.stringify({ id, exp: now + SESSION_DAYS * 864e5 })).toString("base64url");
  return body + "." + h("s:" + body).slice(0, 43);
}
export async function userFromToken(token) {
  const [body, sig] = String(token || "").split(".");
  if (!body || !sig || sig !== h("s:" + body).slice(0, 43)) return null;
  const s = JSON.parse(Buffer.from(body, "base64url").toString());
  if (!(s.exp > Date.now())) return null;
  return getJson("user:" + s.id);
}
export const saveUser = (u) => setJson("user:" + u.id, u);
