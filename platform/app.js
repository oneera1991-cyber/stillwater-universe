import { PLACES } from "/lib/sw/places.js";
import { touchFromLanding } from "/lib/source.js";
const $ = (s) => document.querySelector(s);
const S = { profile: JSON.parse(localStorage.getItem("sw_profile") || "null") || {}, token: sessionStorage.getItem("sw_token"), email: "", login: false };
const WALL = { wood: ["#0f2a22", "#3f7a5c", "#cfe8c6"], fire: ["#2a0f18", "#b24a4a", "#ffd9b8"], earth: ["#22180f", "#9a7a4e", "#f1e1c0"], metal: ["#141a30", "#8f93b8", "#f2f0ff"], water: ["#071a2e", "#2f6f9c", "#cfe6f6"] };
const EL_TH = { wood: "ต้นไม้", fire: "แสงเทียน", earth: "ผืนดิน", metal: "ดวงดาว", water: "สายน้ำ" };

/* ---------- silent ?src= tracking via the existing /api/ev ---------- */
try {
  const sid = sessionStorage.sw_sid || (sessionStorage.sw_sid = crypto.randomUUID().replace(/-/g, ""));
  const t = touchFromLanding({ search: location.search, referrer: document.referrer, selfHost: location.host });
  const first = JSON.parse(localStorage.getItem("sw_first") || "null") || t; localStorage.setItem("sw_first", JSON.stringify(first));
  const b = JSON.stringify({ sid, lang: "th", source: { first, last: t }, events: [{ e: "page_view", ts: new Date().toISOString(), detail: "platform" }] });
  navigator.sendBeacon?.("/api/ev", new Blob([b], { type: "text/plain;charset=UTF-8" }));
} catch {}

/* ---------- sky ---------- */
const cv = $("#sky"), cx = cv.getContext("2d"); let stars = [];
function sky() { cv.width = innerWidth * devicePixelRatio; cv.height = innerHeight * devicePixelRatio; stars = Array.from({ length: 140 }, () => [Math.random() * cv.width, Math.random() * cv.height, Math.random() * 1.4 + .2, Math.random() * 6]); }
function tick(t) { const g = cx.createLinearGradient(0, 0, 0, cv.height); g.addColorStop(0, "#0b0f1e"); g.addColorStop(1, "#1a1838"); cx.fillStyle = g; cx.fillRect(0, 0, cv.width, cv.height);
  for (const [x, y, r, p] of stars) { cx.globalAlpha = .35 + .35 * Math.sin(t / 1400 + p); cx.fillStyle = "#fff"; cx.beginPath(); cx.arc(x, y, r * devicePixelRatio, 0, 7); cx.fill(); } cx.globalAlpha = 1; requestAnimationFrame(tick); }
sky(); addEventListener("resize", sky); requestAnimationFrame(tick);

/* ---------- helpers ---------- */
const show = (id) => { document.querySelectorAll(".s").forEach((s) => s.classList.toggle("on", s.id === "s-" + id)); scrollTo(0, 0); };
const err = (id, m) => { const e = $(`#s-${id} .err`); if (e) e.textContent = m || ""; };
async function api(a, data = {}) { const r = await fetch("/api/sw", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ a, token: S.token, ...data }) });
  const j = await r.json().catch(() => ({ error: "ขอโทษนะคะ ลองใหม่อีกครั้งค่ะ" })); if (r.status === 401) { logout(); throw new Error(j.error); } if (!r.ok || j.error) throw new Error(j.error); return j; }
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const paras = (arr) => arr.map((l) => `<p>${esc(l)}</p>`).join("");
function fillPlaces(sel) { sel.innerHTML = `<option value="">เลือกจังหวัด / ประเทศ</option><optgroup label="ประเทศไทย">${PLACES.filter((p) => p.id.startsWith("th:")).map((p) => `<option value="${p.id}">${p.th}</option>`).join("")}</optgroup><optgroup label="ต่างประเทศ">${PLACES.filter((p) => p.id.startsWith("c:")).map((p) => `<option value="${p.id}">${p.th}</option>`).join("")}</optgroup>`; }
fillPlaces($("#f-place")); fillPlaces($("#b-place"));

/* ---------- flow ---------- */
document.querySelectorAll("[data-go]").forEach((b) => b.onclick = () => { S.login = b.dataset.go === "login"; show(S.login ? "email" : b.dataset.go); });
$("#no-time").onclick = () => { $("#f-time").value = ""; S.profile.time = null; next("place"); };
const checks = {
  date() { const v = $("#f-name").value.trim(); if (!v) return "ใส่ชื่อเล่นก่อนนะคะ"; S.profile.name = v; },
  time() { const v = $("#f-date").value; if (!v || v > new Date().toISOString().slice(0, 10)) return "เลือกวันเกิดก่อนนะคะ"; S.profile.date = v; },
  place() { S.profile.time = $("#f-time").value || null; },
  first() { const v = $("#f-place").value; if (!v) return "เลือกสถานที่เกิดก่อนนะคะ"; S.profile.place = v; }
};
async function next(to) {
  const prev = document.querySelector(".s.on").id.slice(2); const m = checks[to]?.(); if (m) return err(prev, m); err(prev, "");
  localStorage.setItem("sw_profile", JSON.stringify(S.profile));
  if (to === "first") {
    if (S.token) { await api("profile", { profile: S.profile }); return loadMain(); }
    try { const r = await api("chart", { profile: S.profile }); $("#first-h").textContent = `${S.profile.name} คือ${EL_TH[r.element]}`; $("#first-t").innerHTML = paras(r.lines); } catch (e) { return err(prev, e.message); }
  }
  show(to);
}
document.querySelectorAll("[data-next]").forEach((b) => b.onclick = () => next(b.dataset.next));
async function sendCode() {
  S.email = $("#f-email").value.trim(); err("email", "");
  try { const r = await api("send", { email: S.email, profile: S.login ? null : S.profile }); $("#code-to").textContent = "ส่งไปที่ " + S.email;
    const d = $("#dev"); d.hidden = !r.devCode; if (r.devCode) { d.textContent = "โหมดทดสอบ (preview เท่านั้น) — รหัส: " + r.devCode; console.info("[preview dev mode] code", r.devCode); }
    show("code"); } catch (e) { err(document.querySelector(".s.on").id.slice(2), e.message); }
}
$("#send").onclick = sendCode; $("#resend").onclick = sendCode;
$("#verify").onclick = async () => { try { const r = await api("verify", { email: S.email, code: $("#f-code").value }); S.token = r.token; sessionStorage.setItem("sw_token", r.token);
  if (!r.user.profile) { S.profile = {}; return show("name"); } loadMain(); } catch (e) { err("code", e.message); } };
function logout() { S.token = null; sessionStorage.removeItem("sw_token"); show("home"); }
$("#logout").onclick = logout;

/* ---------- main ---------- */
let element = "metal", member = false;
async function loadMain() {
  show("main"); $("#daily").innerHTML = `<p class="dim">กำลังฟังดวงดาวของคุณ…</p>`;
  const r = await api("me"); if (r.needProfile) { S.profile = {}; return show("name"); }
  element = r.element; member = r.member;
  $("#daily").innerHTML = paras(r.daily.lines); $("#pattern").innerHTML = paras(r.pattern.paragraphs);
  $("#more").innerHTML = member ? `<b>ช่วงเวลาดี</b>${esc(r.daily.good_times)}<b>สิ่งที่ควรเลี่ยง</b>${esc(r.daily.avoid)}<b>งาน</b>${esc(r.daily.work)}<b>ความรัก</b>${esc(r.daily.love)}` : `<p class="lock">ส่วนนี้สำหรับสมาชิก — ช่วงเวลาดี สิ่งที่ควรเลี่ยง งานและความรัก</p>`;
  $("#tier").textContent = member ? "สมาชิก" : "คุณกำลังใช้แบบฟรี";
  $("#wall").src = wallpaper(element, 360, 780).toDataURL();
}
$("#more-btn").onclick = () => $("#more").classList.toggle("on");
$("#bonds-btn").onclick = async () => { $("#b-err").textContent = ""; try { const r = await api("bonds", { other: { date: $("#b-date").value, time: $("#b-time").value || null, place: $("#b-place").value } });
  $("#bonds").innerHTML = `<p style="margin-top:20px"><b style="font-weight:500">สิ่งที่ดึงดูดกัน</b><br>${esc(r.attraction)}</p><p><b style="font-weight:500">จุดที่ต้องดูแล</b><br>${esc(r.friction)}</p>`; } catch (e) { $("#b-err").textContent = e.message; } };
$("#card-btn").onclick = async () => { try { const r = await api("card"); $("#card").innerHTML = `<img class="card" src="${esc(r.image)}" alt=""><p>${esc(r.text)}</p>`; } catch (e) { $("#card").innerHTML = `<p class="dim">${esc(e.message)}</p>`; } };
$("#g-btn").onclick = async () => { $("#g-err").textContent = ""; try { const r = await api("guide", { question: $("#g-q").value }); $("#g-a").innerHTML = `<p>${esc(r.text)}</p>`; } catch (e) { $("#g-err").textContent = e.message; } };
$("#wall-btn").onclick = () => { const a = document.createElement("a"); a.download = `stillwater-${element}.png`; a.href = wallpaper(element, 1170, 2532).toDataURL("image/png"); a.click(); };

/* Wallpaper: soft gradient + moon + stars + a small motif per element. Deterministic per element. */
function wallpaper(el, w, h) {
  const [a, b, c] = WALL[el] || WALL.metal, cv = document.createElement("canvas"); cv.width = w; cv.height = h; const x = cv.getContext("2d"); const u = w / 390;
  const g = x.createLinearGradient(0, 0, 0, h); g.addColorStop(0, a); g.addColorStop(.75, b); g.addColorStop(1, a); x.fillStyle = g; x.fillRect(0, 0, w, h);
  let s = el.length * 9973; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  x.fillStyle = c; for (let i = 0; i < 160; i++) { x.globalAlpha = rnd() * .7 + .1; x.beginPath(); x.arc(rnd() * w, rnd() * h * .7, rnd() * 1.3 * u, 0, 7); x.fill(); }
  x.globalAlpha = .9; x.beginPath(); x.arc(w / 2, h * .3, 46 * u, 0, 7); x.fill(); x.globalAlpha = 1; x.fillStyle = a; x.beginPath(); x.arc(w / 2 + 18 * u, h * .3 - 8 * u, 42 * u, 0, 7); x.fill();
  x.strokeStyle = c; x.globalAlpha = .55; x.lineWidth = 1.2 * u; const cy = h * .72;
  if (el === "water") for (let k = 0; k < 4; k++) { x.beginPath(); for (let i = 0; i <= w; i += 4) x.lineTo(i, cy + k * 18 * u + Math.sin(i / (30 * u)) * 6 * u); x.stroke(); }
  else if (el === "wood") { x.beginPath(); x.moveTo(w / 2, h * .86); x.lineTo(w / 2, cy - 40 * u); x.stroke(); for (let k = 0; k < 4; k++) { const y = cy - k * 22 * u; x.beginPath(); x.ellipse(w / 2 + (k % 2 ? -1 : 1) * 16 * u, y, 16 * u, 6 * u, (k % 2 ? 1 : -1) * .5, 0, 7); x.stroke(); } }
  else if (el === "fire") { x.beginPath(); x.moveTo(w / 2, cy - 50 * u); x.quadraticCurveTo(w / 2 + 30 * u, cy, w / 2, cy + 30 * u); x.quadraticCurveTo(w / 2 - 30 * u, cy, w / 2, cy - 50 * u); x.stroke(); }
  else if (el === "earth") for (let k = 0; k < 3; k++) { x.beginPath(); x.moveTo(0, cy + k * 26 * u); x.quadraticCurveTo(w / 2, cy - 40 * u + k * 26 * u, w, cy + k * 26 * u); x.stroke(); }
  else { x.beginPath(); for (let i = 0; i < 5; i++) { const t = -Math.PI / 2 + i * 4 * Math.PI / 5; x.lineTo(w / 2 + Math.cos(t) * 34 * u, cy + Math.sin(t) * 34 * u); } x.closePath(); x.stroke(); }
  x.globalAlpha = .8; x.fillStyle = c; x.font = `300 ${14 * u}px 'Cormorant Garamond', serif`; x.textAlign = "center"; x.fillText("S T I L L W A T E R", w / 2, h * .93); x.globalAlpha = 1;
  return cv;
}
if (S.token) loadMain().catch(() => {});
