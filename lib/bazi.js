/*
BaZi (Four Pillars) — deterministic, no dependencies.
  baziFromBirth({ date: "YYYY-MM-DD", time?: "HH:MM" | null, tzOffsetHours = 7 })
Birth time is civil time in Thailand (UTC+7) unless tzOffsetHours is given.
- Year pillar changes at Li Chun (sun at 315°), not on 1 Jan / lunar new year.
- Month pillar changes at the 12 "jie" solar terms (sun longitude 315°, 345°, 15°, … every 30°).
- Day pillar: sexagenary day count from the Julian Day Number (2000-01-01 = 戊午); day starts at 00:00.
- Hour pillar only when a time is given (2-hour branches, 子 = 23:00–00:59; stem from the day stem).
Sun longitude: Meeus "Astronomical Algorithms" ch. 25 low-precision (≈0.01° → term times within ~15 min).
*/
export const STEMS = ["甲", "乙", "丙", "丁", "戊", "己", "庚", "辛", "壬", "癸"];
export const BRANCHES = ["子", "丑", "寅", "卯", "辰", "巳", "午", "未", "申", "酉", "戌", "亥"];
const STEM_EL = ["wood", "wood", "fire", "fire", "earth", "earth", "metal", "metal", "water", "water"];
const BRANCH_EL = ["water", "earth", "wood", "wood", "earth", "fire", "fire", "earth", "metal", "metal", "earth", "water"];
const ANIMALS_TH = ["ชวด", "ฉลู", "ขาล", "เถาะ", "มะโรง", "มะเส็ง", "มะเมีย", "มะแม", "วอก", "ระกา", "จอ", "กุน"];
const ANIMALS_EN = ["Rat", "Ox", "Tiger", "Rabbit", "Dragon", "Snake", "Horse", "Goat", "Monkey", "Rooster", "Dog", "Pig"];
export const ELEMENT_NAMES = {
  th: { wood: "ไม้", fire: "ไฟ", earth: "ดิน", metal: "ทอง", water: "น้ำ" },
  en: { wood: "Wood", fire: "Fire", earth: "Earth", metal: "Metal", water: "Water" }
};
const D2R = Math.PI / 180;
const mod = (a, n) => ((a % n) + n) % n;

/** Julian Day Number (integer, civil date, Gregorian). */
export function jdn(y, m, d) {
  const a = Math.floor((14 - m) / 12), yy = y + 4800 - a, mm = m + 12 * a - 3;
  return d + Math.floor((153 * mm + 2) / 5) + 365 * yy + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) - 32045;
}
/** Apparent solar longitude (degrees) at a UTC instant (ms). */
export function sunLongitude(ms) {
  const jd = ms / 86400000 + 2440587.5;
  const T = (jd - 2451545.0) / 36525;
  const L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T;
  const M = (357.52911 + 35999.05029 * T - 0.0001537 * T * T) * D2R;
  const C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(M) + (0.019993 - 0.000101 * T) * Math.sin(2 * M) + 0.000289 * Math.sin(3 * M);
  const omega = (125.04 - 1934.136 * T) * D2R;
  return mod(L0 + C - 0.00569 - 0.00478 * Math.sin(omega), 360);
}

/** Strict parse: "YYYY-MM-DD" (Gregorian, 1900..today) and optional "HH:MM". Returns null when invalid. */
export function parseBirth(date, time, now = new Date()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ""));
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  if (y < 1900 || dt.getTime() > now.getTime() + 86400000) return null;
  let hh = null, mi = null;
  if (time !== undefined && time !== null && time !== "") {
    const t = /^(\d{2}):(\d{2})$/.exec(String(time));
    if (!t || +t[1] > 23 || +t[2] > 59) return null;
    hh = +t[1]; mi = +t[2];
  }
  return { y, mo, d, hh, mi, date: m[0], time: hh === null ? null : String(time) };
}

const pillar = (s, b) => ({ stem: STEMS[s], branch: BRANCHES[b], stemIndex: s, branchIndex: b, chars: STEMS[s] + BRANCHES[b],
  stemElement: STEM_EL[s], branchElement: BRANCH_EL[b], yin: s % 2 === 1 });

export function baziFromBirth({ date, time = null, tzOffsetHours = 7, now } = {}) {
  const p = parseBirth(date, time, now);
  if (!p) return null;
  // Instant used for year/month (solar terms). Without a time use local noon.
  const hh = p.hh === null ? 12 : p.hh, mi = p.hh === null ? 0 : p.mi;
  const ms = Date.UTC(p.y, p.mo - 1, p.d, hh, mi) - tzOffsetHours * 3600000;
  const lon = sunLongitude(ms);
  // Solar year: before Li Chun (≈4 Feb) belongs to the previous year.
  // Sun longitude in [270°, 315°) during January/early February → previous year.
  let sy = p.y;
  if (p.mo <= 2 && lon >= 270 && lon < 315) sy -= 1;
  const yIdx = mod(sy - 4, 60);
  const year = pillar(yIdx % 10, yIdx % 12);
  const mIdx = Math.floor(mod(lon - 315, 360) / 30); // 0 = 寅 month (Li Chun → Jing Zhe)
  const month = pillar(mod((yIdx % 10) * 2 + 2 + mIdx, 10), mod(2 + mIdx, 12));
  const dIdx = mod(jdn(p.y, p.mo, p.d) + 49, 60);
  const day = pillar(dIdx % 10, dIdx % 12);
  let hour = null;
  if (p.hh !== null) {
    const hb = Math.floor(((p.hh + 1) % 24) / 2);
    hour = pillar(mod(day.stemIndex * 2 + hb, 10), hb);
  }
  const counts = { wood: 0, fire: 0, earth: 0, metal: 0, water: 0 };
  for (const x of [year, month, day, hour].filter(Boolean)) { counts[x.stemElement]++; counts[x.branchElement]++; }
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return {
    date: p.date, time: p.time, hasTime: p.hh !== null,
    year, month, day, hour,
    dayMaster: { stem: day.stem, element: day.stemElement, yin: day.yin },
    counts, strongest: sorted[0][0], missing: sorted.filter(([, n]) => n === 0).map(([e]) => e),
    weakest: sorted[sorted.length - 1][0],
    animal: { th: ANIMALS_TH[year.branchIndex], en: ANIMALS_EN[year.branchIndex] }
  };
}

/** Compact text block for the reading prompt (language of the reading). */
export function baziPromptBlock(b, lang = "th") {
  if (!b) return "";
  const E = ELEMENT_NAMES[lang === "en" ? "en" : "th"];
  const yy = (x) => (lang === "en" ? (x.yin ? "Yin" : "Yang") : (x.yin ? "หยิน" : "หยาง"));
  const pil = [["year", b.year], ["month", b.month], ["day", b.day], ["hour", b.hour]].filter(([, x]) => x)
    .map(([k, x]) => `${k}=${x.chars} (${E[x.stemElement]}/${E[x.branchElement]})`).join(", ");
  const cnt = Object.entries(b.counts).map(([e, n]) => `${E[e]} ${n}`).join(", ");
  if (lang === "en") {
    return [
      `BaZi (Four Pillars, computed by the system — use as given): ${pil}${b.hasTime ? "" : " — birth time unknown, no hour pillar; do not guess it"}`,
      `Day Master: ${b.day.stem} ${yy(b.day)} ${E[b.dayMaster.element]}. Element balance: ${cnt}. Strongest: ${E[b.strongest]}.${b.missing.length ? " Missing: " + b.missing.map((e) => E[e]).join(", ") + "." : ""}`
    ].join("\n");
  }
  return [
    `ปาจื่อ (สี่เสาชะตา คำนวณโดยระบบแล้ว ใช้ตามนี้): ${pil}${b.hasTime ? "" : " — ไม่ทราบเวลาเกิด ไม่มีเสายาม ห้ามเดาเวลา"}`,
    `ธาตุประจำตัว (Day Master): ${b.day.stem} ${E[b.dayMaster.element]}${yy(b.day)} สมดุลธาตุ: ${cnt} ธาตุเด่น: ${E[b.strongest]}${b.missing.length ? " ธาตุที่ขาด: " + b.missing.map((e) => E[e]).join(", ") : ""}`
  ].join("\n");
}
