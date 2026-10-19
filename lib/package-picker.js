/*
STILLWATER reading packs (Palm, 2026-10-19) — chosen on the pack scene right after the form.
  starter   ~~฿9~~ ฟรี         short free reading (no payment)
  deeper    ~~฿59~~ ฿39        4 cards (ผลรวม + past / present / future), promo until 2026-11-30 23:59 BKK, then ฿59
  unlimited ฿399 / 30 days     unlimited Deeper readings; membership token in localStorage
Display only: the server (api/_lib/payment.js) is the authority on prices.
*/
export const PROMO_END_MS = Date.parse("2026-11-30T23:59:59.999+07:00");
export const MEMBER_KEY = "stillwater.member";
export const MEMBER_INFO_KEY = "stillwater.member.info";
export const DEVICE_KEY = "stillwater.device";

export function packPrices(now = Date.now()) {
  const promo = now <= PROMO_END_MS;
  return {
    starter: { regular: 9, price: 0 },
    deeper: { regular: 59, price: promo ? 39 : 59 },
    unlimited: { regular: 399, price: 399 }
  };
}

const COPY = {
  th: {
    title: "เลือกแบบที่อยากให้พี่เวราอ่าน",
    starter: ["Starter", "ไพ่ 1 ใบ คำตอบสั้น ๆ"],
    deeper: ["Deeper", "ไพ่ 4 ใบ ผลรวม อดีต ปัจจุบัน แนวโน้ม พร้อมดวงวันเกิด"],
    unlimited: ["Unlimited", "อ่านแบบ Deeper ได้ไม่จำกัด 30 วัน"],
    free: "ฟรี", days: "/ 30 วัน", member: "สมาชิก", memberUntil: (d) => "สมาชิก Unlimited ถึง " + d,
    haveCode: "มีรหัสสมาชิกแล้ว", codePh: "VERA-XXXX-XXXX", codeGo: "ใช้รหัส", codeBad: "ไม่พบรหัสนี้ หรือหมดอายุแล้วค่ะ", codeOk: "ยินดีต้อนรับกลับมาค่ะ"
  },
  en: {
    title: "Choose how Vera reads for you",
    starter: ["Starter", "1 card, a short answer"],
    deeper: ["Deeper", "4 cards: overall, past, present, future, with your birth chart"],
    unlimited: ["Unlimited", "Unlimited Deeper readings for 30 days"],
    free: "Free", days: "/ 30 days", member: "Member", memberUntil: (d) => "Unlimited member until " + d,
    haveCode: "I have a member code", codePh: "VERA-XXXX-XXXX", codeGo: "Use code", codeBad: "That code wasn't found or has expired.", codeOk: "Welcome back."
  }
};
export const packCopy = (lang) => COPY[lang === "en" ? "en" : "th"];

const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} }
};

/** Persistent random device id (returning-customer memory). */
export function deviceId() {
  let d = ls.get(DEVICE_KEY);
  if (!d || !/^[A-Za-z0-9_-]{16,64}$/.test(d)) {
    const b = new Uint8Array(18); crypto.getRandomValues(b);
    d = "d_" + btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    ls.set(DEVICE_KEY, d);
  }
  return d;
}

export function memberToken() { return ls.get(MEMBER_KEY) || null; }
export function memberInfo() { try { return JSON.parse(ls.get(MEMBER_INFO_KEY) || "null"); } catch { return null; } }
export function saveMember(token, info) { if (token) ls.set(MEMBER_KEY, token); if (info) ls.set(MEMBER_INFO_KEY, JSON.stringify(info)); }
export function clearMember() { ls.del(MEMBER_KEY); ls.del(MEMBER_INFO_KEY); }
export function memberActive(now = Date.now()) { const i = memberInfo(); return !!(memberToken() && i && i.expiresAt > now); }

/** Ask the server (30-day expiry check). Updates local info; clears an expired token. */
export async function refreshMember() {
  const token = memberToken();
  if (!token) return null;
  try {
    const r = await fetch("/api/membership", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "me", member: token }) });
    const d = await r.json();
    if (r.ok && d.active) { saveMember(null, { expiresAt: d.expiresAt, code: memberInfo()?.code || null }); return d; }
    if (r.ok && !d.active) clearMember();
  } catch {}
  return null;
}

export const fmtDate = (ms, lang) => new Date(ms).toLocaleDateString(lang === "en" ? "en-GB" : "th-TH", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Bangkok" });

/** Render the three pack buttons into `root`; onPick(pack) when tapped. */
export function renderPicker(root, lang, onPick) {
  const c = packCopy(lang), p = packPrices(), member = memberActive();
  const price = (k) => {
    if (k === "starter") return `<span class="sw-pack-old">฿${p.starter.regular}</span><span class="sw-pack-now">${c.free}</span>`;
    if (k === "deeper") return member ? `<span class="sw-pack-now sw-pack-member">${c.member}</span>`
      : (p.deeper.price < p.deeper.regular ? `<span class="sw-pack-old">฿${p.deeper.regular}</span>` : "") + `<span class="sw-pack-now">฿${p.deeper.price}</span>`;
    return `<span class="sw-pack-now">฿${p.unlimited.price}</span><span class="sw-pack-per">${c.days}</span>`;
  };
  const packs = member ? ["starter", "deeper"] : ["starter", "deeper", "unlimited"];
  root.innerHTML = `<h2 class="say" id="packTitle">${c.title}</h2>` +
    (member ? `<p class="sw-member-note" id="memberNote">${c.memberUntil(fmtDate(memberInfo().expiresAt, lang))}</p>` : "") +
    packs.map((k) => `<button class="sw-pack${k === "deeper" ? " is-featured" : ""}" type="button" data-pack="${k}">
      <span><span class="sw-pack-name">${c[k][0]}</span><span class="sw-pack-note">${c[k][1]}</span></span>
      <span class="sw-pack-price">${price(k)}</span></button>`).join("") +
    (member ? "" : `<details class="sw-code"><summary>${c.haveCode}</summary><div class="sw-code-row"><input class="input" id="memberCode" placeholder="${c.codePh}" autocomplete="off" autocapitalize="characters"><button class="btn btn-quiet" type="button" id="memberCodeGo">${c.codeGo}</button></div><p class="sw-code-note" id="memberCodeNote" aria-live="polite"></p></details>`);
  root.querySelectorAll("[data-pack]").forEach((b) => b.addEventListener("click", () => { root.querySelectorAll("[data-pack]").forEach((x) => { x.disabled = true; x.classList.toggle("is-selected", x === b); }); onPick(b.dataset.pack); }));
  const go = root.querySelector("#memberCodeGo");
  if (go) go.addEventListener("click", async () => {
    const note = root.querySelector("#memberCodeNote");
    go.disabled = true;
    try {
      const r = await fetch("/api/membership", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "recover", code: root.querySelector("#memberCode").value }) });
      const d = await r.json();
      if (r.ok && d.member) { saveMember(d.member, { expiresAt: d.expiresAt, code: root.querySelector("#memberCode").value.trim().toUpperCase() }); note.textContent = c.codeOk; setTimeout(() => renderPicker(root, lang, onPick), 600); return; }
    } catch {}
    note.textContent = c.codeBad; go.disabled = false;
  });
}

export const PICKER_CSS = `
#packBox{display:grid;gap:12px;width:100%;max-width:420px;margin:0 auto;text-align:left}
#packBox .say{text-align:center;margin-bottom:6px}
.sw-pack{display:grid;grid-template-columns:1fr auto;gap:10px;align-items:center;width:100%;padding:16px;border:1px solid rgba(255,255,255,.16);border-radius:16px;background:rgba(255,255,255,.035);color:inherit;font:inherit;text-align:left;cursor:pointer;transition:.2s ease}
.sw-pack:hover{border-color:rgba(255,255,255,.34)}
.sw-pack.is-featured{border-color:rgba(226,197,183,.55);background:rgba(226,197,183,.06)}
.sw-pack.is-selected{border-color:rgba(226,197,183,.95);box-shadow:0 0 0 1px rgba(226,197,183,.3) inset}
.sw-pack:disabled{cursor:default}
.sw-pack-name{display:block;font-family:'Cormorant Garamond',serif;font-size:21px;font-weight:600;letter-spacing:.02em}
.sw-pack-note{display:block;margin-top:3px;font-size:13px;opacity:.72;line-height:1.45}
.sw-pack-price{text-align:right;white-space:nowrap}
.sw-pack-old{text-decoration:line-through;opacity:.5;font-size:13px;margin-right:6px}
.sw-pack-now{font-size:19px;font-weight:700}
.sw-pack-per{display:block;font-size:11px;opacity:.65}
.sw-member-note{text-align:center;font-size:13px;opacity:.8;margin:-4px 0 4px}
.sw-code{font-size:13px;opacity:.85;margin-top:4px}.sw-code summary{cursor:pointer;text-align:center;list-style:none;opacity:.75}
.sw-code-row{display:flex;gap:8px;margin-top:10px}.sw-code-row .input{flex:1;min-width:0;text-transform:uppercase}
.sw-code-note{min-height:1em;text-align:center}
#offerOld{text-decoration:line-through;opacity:.5;font-size:.6em}
.pack-name{font-size:13px;opacity:.75;margin:2px 0 10px}
.member-card{margin:14px auto 0;padding:16px;border:1px solid rgba(226,197,183,.6);border-radius:16px;background:rgba(226,197,183,.07);max-width:360px;text-align:center}
.member-card code{display:block;font-size:22px;letter-spacing:.12em;margin:8px 0;font-family:inherit;font-weight:700}
.member-card p{margin:4px 0;font-size:13px;opacity:.85}
`;
