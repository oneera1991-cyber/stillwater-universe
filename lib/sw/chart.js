/* Combines the three systems into one internal profile. */
import { baziFromBirth } from "../bazi.js";
import { westernChart, synastry } from "./western.js";
import { thaiBirthDay } from "./thai.js";
import { placeById, birthUtc, tzOffsetHours } from "./places.js";

const GEN = { wood: "fire", fire: "earth", earth: "metal", metal: "water", water: "wood" };
const CTRL = { wood: "earth", earth: "water", water: "fire", fire: "metal", metal: "wood" };
/** How today's day element meets the person's day-master element. */
export function relation(me, day) {
  if (me === day) return "same";
  if (GEN[day] === me) return "supports_you";
  if (GEN[me] === day) return "you_give";
  if (CTRL[me] === day) return "you_shape";
  return "pressure"; // CTRL[day] === me
}
// Two-hour windows (branch index → local hours) whose element feeds or matches the day master.
const BRANCH_EL = ["water","earth","wood","wood","earth","fire","fire","earth","metal","metal","earth","water"];
export function goodHours(dm) {
  const ok = [], avoid = [];
  BRANCH_EL.forEach((el, i) => { const start = (23 + 2 * i) % 24, label = `${String(start).padStart(2, "0")}:00–${String((start + 2) % 24).padStart(2, "0")}:00`;
    if (start >= 23 || start < 6) return; // skip sleeping hours
    if (el === dm || GEN[el] === dm) ok.push(label); else if (CTRL[el] === dm) avoid.push(label); });
  return { ok, avoid };
}

export function validInput(p) {
  return p && /^\d{4}-\d{2}-\d{2}$/.test(p.date || "") && (!p.time || /^\d{2}:\d{2}$/.test(p.time)) && !!placeById(p.place);
}
export function buildChart({ date, time, place }, now = new Date()) {
  const pl = placeById(place); if (!pl) throw new Error("bad place");
  const hasTime = !!time; const t = time || "12:00";
  const utc = birthUtc(date, t, pl.tz);
  const bazi = baziFromBirth({ date, time: hasTime ? t : null, tzOffsetHours: tzOffsetHours(pl.tz, date, t), now });
  if (!bazi) throw new Error("bad date");
  return { hasTime, place: pl.id, western: westernChart(utc, pl.lat, pl.lon, hasTime), bazi, thai: thaiBirthDay(date, t, hasTime), element: bazi.dayMaster.element };
}
/** Today's pillar (Bangkok date) and its meeting with the person. */
export function today(chart, now = new Date()) {
  const d = new Date(now.getTime() + 7 * 3600e3).toISOString().slice(0, 10);
  const tb = baziFromBirth({ date: d, time: "12:00", now: new Date(now.getTime() + 864e5) });
  return { date: d, dayElement: tb.day.stemElement, relation: relation(chart.element, tb.day.stemElement), hours: goodHours(chart.element) };
}
export { synastry };
