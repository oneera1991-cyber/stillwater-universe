/*
STILLWATER PLATFORM API — POST /api/sw  { a: action, ... }   (served through api/rate.js via the vercel.json rewrite /api/sw → /api/rate?sw=1, so the function count stays at 12)
  chart   {profile}                      → short first result (no sign-in)
  send    {email, profile?}              → emails a 6-digit code (dev mode: code returned outside production)
  verify  {email, code}                  → {token, user}
  me      {token}                        → daily (short | full for members), pattern, wallpaper element
  bonds   {token, other}                 → attraction / friction text
  card    {token}                        → one card image + simple reading (deeper for members)
  guide   {token, question}              → short answer (blocked topics redirected)
  dev_member {token, on}                 → preview only: flip the member flag to test tiers
TODO(Palm): how members pay (price, method). Existing Slip2Sure/Payhip code is untouched and NOT wired here.
*/
import crypto from "node:crypto";
import { buildChart, today, validInput, synastry } from "../../lib/sw/chart.js";
import { requestCode, verifyCode, userFromToken, saveUser } from "./sw-auth.js";
import { getJson, setJson, limit } from "./sw-store.js";
import { writeText, BLOCKED, REDIRECT } from "./sw-text.js";
import { drawOne, publicCard } from "./vera.js";
import { clientIp } from "./rate-limit.js";

const EL_TH = { wood: "ต้นไม้", fire: "แสงเทียน", earth: "ผืนดิน", metal: "ดวงดาว", water: "สายน้ำ" };
const EL_LINE = {
  wood: "คุณเติบโตอย่างเงียบๆ เหมือนต้นไม้ที่ค่อยๆ ยืดตัวหาแสง", fire: "คุณมีความอบอุ่นที่คนรอบข้างรู้สึกได้ แม้ในวันที่คุณเหนื่อย",
  earth: "คุณเป็นที่พักใจให้คนอื่นได้เสมอ มั่นคงกว่าที่ตัวเองคิด", metal: "คุณชัดเจนในสิ่งที่เชื่อ และมีความงามแบบเรียบง่ายในตัว",
  water: "คุณรับรู้ความรู้สึกได้ลึก และไหลไปกับชีวิตได้อย่างนุ่มนวล" };
const REL_LINE = { same: "วันนี้พลังรอบตัวคล้ายกับคุณ ทำอะไรด้วยจังหวะของตัวเองได้เลย", supports_you: "วันนี้มีแรงหนุนเบาๆ อยู่ข้างหลัง ลองเริ่มสิ่งที่ค้างไว้", you_give: "วันนี้คุณอาจให้มากกว่ารับ อย่าลืมเผื่อใจไว้ให้ตัวเองบ้าง", you_shape: "วันนี้เหมาะกับการจัดระเบียบ ตัดสินใจเรื่องเล็กๆ ให้เสร็จ", pressure: "วันนี้อาจรู้สึกถูกเร่งนิดหน่อย หายใจช้าๆ แล้วค่อยๆ ไป" };
const send = (res, s, j) => res.status(s).json(j);
const body = (req) => { try { return typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {}); } catch { return {}; } };
const facts = (c) => ({ inner: c.element, birthday: c.thai.key, sun: c.western.planets.Sun.sign, moon: c.western.planets.Moon.sign, rising: c.western.planets.Asc?.sign || null,
  venus: c.western.planets.Venus.sign, mars: c.western.planets.Mars.sign, aspects: c.western.aspects.map((x) => `${x.a}-${x.b} ${x.name}`), strongest: c.bazi.strongest, missing: c.bazi.missing });
const cleanProfile = (p) => ({ name: String(p?.name || "").trim().slice(0, 30), date: p?.date, time: p?.time || null, place: p?.place });

async function cached(key, ttl, fn) { const v = await getJson(key); if (v) return v; const r = await fn(); await setJson(key, r, ttl); return r; }

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "method" });
  const b = body(req), ip = clientIp(req);
  try {
    if (!(await limit("api:" + crypto.createHash("sha256").update(ip).digest("hex").slice(0, 16), 120, 600))) return send(res, 429, { error: "ช้าลงนิดนึงนะคะ ลองใหม่อีกสักครู่" });
    if (b.a === "chart") {
      const p = cleanProfile(b.profile); if (!validInput(p)) return send(res, 400, { error: "ข้อมูลยังไม่ครบนะคะ" });
      const c = buildChart(p);
      return send(res, 200, { ok: true, element: c.element, color: c.thai.color, lines: [EL_LINE[c.element], `สิ่งที่อยู่ในตัวคุณคล้าย${EL_TH[c.element]}`, "เก็บดวงของคุณไว้ แล้วกลับมาฟังเรื่องของวันนี้ได้ทุกวันค่ะ"] });
    }
    if (b.a === "send") { const p = b.profile ? cleanProfile(b.profile) : null; const r = await requestCode(b.email, ip, p && validInput(p) ? p : null);
      return send(res, r.ok ? 200 : r.code === "rate_limited" ? 429 : 400, r.ok ? r : { error: r.code === "rate_limited" ? "ขอรหัสบ่อยไปนิดนะคะ รอสักครู่แล้วลองใหม่" : "อีเมลนี้ดูไม่ถูกต้องค่ะ", code: r.code }); }
    if (b.a === "verify") { const r = await verifyCode(b.email, b.code);
      return r.ok ? send(res, 200, { ok: true, token: r.token, user: pub(r.user) }) : send(res, 400, { error: r.code === "wrong" ? "รหัสยังไม่ตรงค่ะ ลองอีกครั้งนะคะ" : "รหัสหมดอายุแล้ว ขอรหัสใหม่ได้เลยค่ะ", code: r.code }); }

    const user = await userFromToken(b.token);
    if (!user) return send(res, 401, { error: "กรุณาเข้าสู่ระบบอีกครั้งนะคะ", code: "auth" });
    if (b.a === "profile") { const p = cleanProfile(b.profile); if (!validInput(p)) return send(res, 400, { error: "ข้อมูลยังไม่ครบนะคะ" }); user.profile = p; await saveUser(user); return send(res, 200, { ok: true, user: pub(user) }); }
    if (!user.profile) return send(res, 200, { ok: true, needProfile: true, user: pub(user) });
    const c = buildChart(user.profile), td = today(c), m = !!user.member, name = user.profile.name || "คุณ";

    if (b.a === "me") {
      const daily = await cached(`txt:${user.id}:daily:${td.date}`, 2 * 86400, () => writeText("ดวงประจำวัน", { name, ...facts(c), today: td.relation, good_hours: td.hours.ok, careful_hours: td.hours.avoid, lucky_colors: c.thai.lucky, avoid_color: c.thai.avoid },
        `{"lines":[5 บรรทัดสั้น],"good_times":"ช่วงเวลาดีวันนี้ 1-2 ประโยค ระบุช่วงเวลา","avoid":"สิ่งที่ควรเลี่ยง 1-2 ประโยค","work":"งาน 1-2 ประโยค","love":"ความรัก 1-2 ประโยค"}`,
        { lines: [`สวัสดีค่ะ ${name}`, REL_LINE[td.relation], `สีที่ช่วยให้ใจสบายวันนี้: ${c.thai.lucky.join(" หรือ ")}`, "ให้เวลากับสิ่งเล็กๆ ที่ทำให้ยิ้มได้", "คืนนี้นอนให้เร็วขึ้นสักหน่อยนะคะ"],
          good_times: `ช่วง ${td.hours.ok.slice(0, 2).join(" และ ")} เหมาะกับการเริ่มต้นหรือคุยเรื่องสำคัญ`, avoid: `ช่วง ${td.hours.avoid[0] || "บ่ายแก่ๆ"} ลองไม่ตัดสินใจเร็วเกินไป และเลี่ยงสี${c.thai.avoid}`,
          work: "ทำทีละอย่าง แล้วงานจะไหลลื่นกว่าที่คิด", love: "คำพูดอ่อนโยนสั้นๆ มีความหมายมากกว่าที่คุณคิดค่ะ" }));
      const pattern = await cached(`txt:${user.id}:pattern:${user.profile.date}${user.profile.time}${user.profile.place}`, 0, () => writeText("ตัวตนของฉัน (Pattern)", { name, ...facts(c) }, `{"paragraphs":[3 ย่อหน้าสั้น 2-3 ประโยค]}`,
        { paragraphs: [EL_LINE[c.element] + " ส่วนลึกๆ คุณต้องการพื้นที่ที่ปลอดภัยพอจะเป็นตัวเอง", "คุณมักคิดเผื่อคนอื่นก่อนเสมอ บางครั้งจนลืมถามใจตัวเองว่าต้องการอะไร", "การเติบโตของคุณไม่ต้องรีบ ค่อยๆ เลือกสิ่งที่ทำให้ใจเบา แล้วทางจะชัดขึ้นเอง"] }));
      return send(res, 200, { ok: true, user: pub(user), element: c.element, colors: { lucky: c.thai.lucky, avoid: c.thai.avoid },
        daily: m ? daily : { lines: daily.lines.slice(0, 3) }, pattern: m ? pattern : { paragraphs: pattern.paragraphs.slice(0, 1) }, member: m });
    }
    if (b.a === "bonds") {
      const o = cleanProfile(b.other); if (!validInput(o)) return send(res, 400, { error: "ข้อมูลของอีกคนยังไม่ครบค่ะ" });
      const c2 = buildChart(o), s = synastry(c.western, c2.western);
      const r = await writeText("ความสัมพันธ์ระหว่างสองคน", { me: facts(c), other: facts(c2), attraction: s.attraction, friction: s.friction }, `{"attraction":"2-3 ประโยค สิ่งที่ดึงดูดกัน","friction":"2-3 ประโยค จุดที่อาจเสียดทานและวิธีดูแล"}`,
        { attraction: s.attraction.length ? "คุณสองคนมีบางอย่างที่เข้าใจกันได้โดยไม่ต้องพูดมาก อยู่ด้วยกันแล้วรู้สึกเป็นธรรมชาติ" : "คุณสองคนต่างกันพอจะเติมเต็มกันได้ ถ้าเปิดใจเรียนรู้กัน",
          friction: s.friction.length ? "บางจังหวะอาจคิดเร็วช้าไม่เท่ากัน ลองบอกความรู้สึกตรงๆ แต่อ่อนโยนค่ะ" : "จุดเสียดทานไม่มาก แต่อย่าลืมให้พื้นที่ส่วนตัวกันบ้าง" });
      return send(res, 200, { ok: true, ...r });
    }
    if (b.a === "card") {
      if (!(await limit("card:" + user.id + ":" + td.date, m ? 5 : 1, 86400))) return send(res, 429, { error: "วันนี้เปิดครบแล้วนะคะ พรุ่งนี้มาใหม่ค่ะ", code: "card_limit" });
      const card = drawOne("th");
      const r = await writeText("ข้อความจากภาพที่เปิดได้", { name, meaning: card.core, advice: card.advice, love: card.love, work: card.work, inner: c.element, deeper: m }, m ? `{"text":"4-5 ประโยค"}` : `{"text":"2 ประโยค"}`,
        { text: String(card.advice || card.core || "ใจเย็นๆ แล้วสิ่งที่ใช่จะค่อยๆ เผยตัวค่ะ").slice(0, m ? 400 : 160) });
      return send(res, 200, { ok: true, image: publicCard(card).image, text: r.text });
    }
    if (b.a === "guide") {
      const q = String(b.question || "").trim().slice(0, 300); if (!q) return send(res, 400, { error: "พิมพ์คำถามก่อนนะคะ" });
      if (BLOCKED.test(q)) return send(res, 200, { ok: true, text: REDIRECT, redirected: true });
      if (!(await limit("guide:" + user.id + ":" + td.date, m ? 10 : 2, 86400))) return send(res, 429, { error: "วันนี้ถามครบแล้วนะคะ พรุ่งนี้มาคุยกันใหม่ค่ะ" });
      const r = await writeText("ตอบคำถาม", { question: q, ...facts(c), today: td.relation }, `{"text":"คำตอบ 2-4 ประโยค"}`, { text: REL_LINE[td.relation] + " ลองฟังเสียงเบาๆ ในใจตัวเองก่อนตัดสินใจนะคะ" });
      return send(res, 200, { ok: true, text: r.text });
    }
    if (b.a === "dev_member" && process.env.VERCEL_ENV !== "production") { user.member = !!b.on; await saveUser(user); return send(res, 200, { ok: true, user: pub(user) }); }
    return send(res, 400, { error: "unknown" });
  } catch (e) {
    console.warn("sw error", e?.message);
    return send(res, 500, { error: "ขอโทษนะคะ ลองใหม่อีกครั้งค่ะ" });
  }
}
const pub = (u) => ({ email: u.email, member: !!u.member, profile: u.profile });
