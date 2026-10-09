/*
====================================================
STILLWATER — TRAFFIC SOURCE (first-touch / last-touch)
====================================================
Shared by the page (index.html imports /lib/source.js) and the API
(api/read.js imports ../lib/source.js). The server re-sanitizes everything
with sanitizeTouch(); the browser value is only a hint.

Touch = {
  src,          // preset (friends | tiktok | ig | fb | line | fb_ads | youtube),
                // a sanitized custom tag, or derived: google | direct | referral
  src_type,     // "tag" (?src=) | "utm" (utm_source) | "click" (fbclid/ttclid) | "referrer" | "direct"
  utm_source, utm_medium, utm_campaign,   // sanitized, max 32, or ""
  fbclid, ttclid,                         // booleans (presence only; ids are NOT stored)
  ref,          // referrer host (e.g. "l.facebook.com"), "" when none — host only, never path/query
  at            // ISO time of the landing (client clock)
}
*/
export const SRC_PRESETS = ["friends", "tiktok", "ig", "fb", "line", "fb_ads", "youtube"];
export const SRC_TYPES = ["tag", "utm", "click", "referrer", "direct"];
export const TRACKING_PARAMS = ["src", "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid", "ttclid"];

/** lowercase, spaces → "_", then [a-z0-9_-] only, max 32 chars; "" when nothing is left. */
export function sanitizeTag(value) {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_-]+/g, "").replace(/^[_-]+|[_-]+$/g, "").slice(0, 32);
}

/** Host only, lowercase, [a-z0-9.-], max 64. */
export function sanitizeHost(value) {
  if (typeof value !== "string") return "";
  let host = value.trim().toLowerCase();
  try { if (/^[a-z]+:\/\//.test(host)) host = new URL(host).hostname; } catch { return ""; }
  return host.replace(/[^a-z0-9.-]+/g, "").slice(0, 64);
}

const REFERRER_RULES = [
  [/(^|\.)(facebook\.com|fb\.com|fb\.me|messenger\.com)$/, "fb"],
  [/(^|\.)(instagram\.com)$/, "ig"],
  [/(^|\.)(tiktok\.com)$/, "tiktok"],
  [/(^|\.)(line\.me|line-apps\.com|line\.naver\.jp)$/, "line"],
  [/(^|\.)(youtube\.com|youtu\.be)$/, "youtube"],
  [/(^|\.)google\.[a-z.]+$/, "google"]
];

/** Source from a referrer host: preset-style names, "direct" for none/self, else "referral". */
export function sourceFromReferrer(refHost, selfHost = "") {
  const h = sanitizeHost(refHost);
  if (!h || (selfHost && h === sanitizeHost(selfHost))) return "direct";
  for (const [re, src] of REFERRER_RULES) if (re.test(h)) return src;
  return "referral";
}

/**
 * Build a touch from a landing URL + document.referrer.
 * Priority: ?src= → utm_source → fbclid/ttclid → referrer → direct.
 */
export function touchFromLanding({ search = "", referrer = "", selfHost = "", now = new Date() } = {}) {
  const q = new URLSearchParams(search);
  const ref = sanitizeHost(referrer);
  const refHost = ref && ref !== sanitizeHost(selfHost) ? ref : "";
  const touch = {
    src: "", src_type: "direct",
    utm_source: sanitizeTag(q.get("utm_source") || ""),
    utm_medium: sanitizeTag(q.get("utm_medium") || ""),
    utm_campaign: sanitizeTag(q.get("utm_campaign") || ""),
    fbclid: q.has("fbclid"), ttclid: q.has("ttclid"),
    ref: refHost,
    at: now.toISOString()
  };
  const tag = sanitizeTag(q.get("src") || "");
  if (tag) { touch.src = tag; touch.src_type = "tag"; }
  else if (touch.utm_source) { touch.src = touch.utm_source; touch.src_type = "utm"; }
  else if (touch.fbclid || touch.ttclid) { touch.src = touch.fbclid ? "fb" : "tiktok"; touch.src_type = "click"; }
  else {
    touch.src = sourceFromReferrer(refHost, selfHost);
    touch.src_type = touch.src === "direct" ? "direct" : "referrer";
  }
  return touch;
}

/** A landing that carries a real signal (anything but a plain direct visit). */
export function isSignal(touch) {
  return !!touch && touch.src_type !== "direct";
}

/** Server-side: never trust the browser's shape. Returns a clean touch or null. */
export function sanitizeTouch(t) {
  if (!t || typeof t !== "object") return null;
  const src = sanitizeTag(t.src);
  if (!src) return null;
  const at = typeof t.at === "string" && !Number.isNaN(Date.parse(t.at)) ? new Date(t.at).toISOString() : "";
  return {
    src,
    src_type: SRC_TYPES.includes(t.src_type) ? t.src_type : "direct",
    utm_source: sanitizeTag(t.utm_source),
    utm_medium: sanitizeTag(t.utm_medium),
    utm_campaign: sanitizeTag(t.utm_campaign),
    fbclid: t.fbclid === true,
    ttclid: t.ttclid === true,
    ref: sanitizeHost(t.ref),
    at
  };
}

/** { first, last } from the request body → clean pair (last falls back to first). */
export function sanitizeSource(source) {
  const s = source && typeof source === "object" ? source : {};
  const first = sanitizeTouch(s.first);
  const last = sanitizeTouch(s.last) || first;
  return { first, last };
}
