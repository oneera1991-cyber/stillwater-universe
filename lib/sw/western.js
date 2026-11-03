/* Western chart (tropical) — astronomy-engine, deterministic. Internal only: customers never see these terms. */
import { createRequire } from "node:module";
const A = createRequire(import.meta.url)("astronomy-engine"); // CJS build: Vercel loads the package ESM build as CJS and crashes
const SIGNS = ["aries","taurus","gemini","cancer","leo","virgo","libra","scorpio","sagittarius","capricorn","aquarius","pisces"];
const BODIES = ["Sun","Moon","Mercury","Venus","Mars"];
export const ASPECTS = [["conjunction",0,8],["sextile",60,5],["square",90,7],["trine",120,7],["opposition",180,8]];
const mod = (a, n = 360) => ((a % n) + n) % n;
const R = Math.PI / 180;
export const signOf = (lon) => SIGNS[Math.floor(mod(lon) / 30)];

export function longitude(body, date) {
  if (body === "Moon") return A.EclipticGeoMoon(date).lon;
  if (body === "Sun") return A.SunPosition(date).elon;
  return A.Ecliptic(A.GeoVector(A.Body[body], date, true)).elon;
}
export function ascendant(date, lat, lon) {
  const ramc = mod(A.SiderealTime(date) * 15 + lon) * R;
  const eps = A.e_tilt(A.MakeTime(date)).tobl * R;
  return mod(Math.atan2(Math.cos(ramc), -(Math.sin(ramc) * Math.cos(eps) + Math.tan(lat * R) * Math.sin(eps))) / R);
}
export function aspectBetween(a, b) {
  const d = Math.abs(mod(a - b + 180) - 180);
  for (const [name, angle, orb] of ASPECTS) if (Math.abs(d - angle) <= orb) return { name, orb: +Math.abs(d - angle).toFixed(2) };
  return null;
}
/** date: UTC Date of birth; hasTime false → Ascendant omitted (12:00 used for the rest). */
export function westernChart(date, lat, lon, hasTime = true) {
  const planets = {};
  for (const b of BODIES) { const l = longitude(b, date); planets[b] = { lon: +l.toFixed(2), sign: signOf(l) }; }
  if (hasTime) { const a = ascendant(date, lat, lon); planets.Asc = { lon: +a.toFixed(2), sign: signOf(a) }; }
  const keys = Object.keys(planets), aspects = [];
  for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
    const x = aspectBetween(planets[keys[i]].lon, planets[keys[j]].lon); if (x) aspects.push({ a: keys[i], b: keys[j], ...x });
  }
  return { planets, aspects };
}
/** Cross-aspects between two charts → attraction (soft/conjunction) vs friction (hard). */
export function synastry(c1, c2) {
  const pairs = [["Venus","Mars"],["Mars","Venus"],["Sun","Moon"],["Moon","Sun"],["Moon","Moon"],["Venus","Venus"],["Mercury","Mercury"],["Sun","Sun"],["Mars","Mars"]];
  const attraction = [], friction = [];
  for (const [p, q] of pairs) { const x = aspectBetween(c1.planets[p].lon, c2.planets[q].lon); if (!x) continue;
    const row = `${p}-${q} ${x.name}`; (["square","opposition"].includes(x.name) ? friction : attraction).push(row); }
  return { attraction, friction };
}
