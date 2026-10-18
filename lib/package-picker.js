/* STILLWATER paid-pack selector: UI only + request enrichment. */
const STORE = "stillwater.package";
const PACKS = {
  starter: { name: "Starter Pack", regular: 9, price: 1, label: "Short reading" },
  deeper: { name: "Deeper Pack", regular: 59, price: 39, label: "Full Vera reading" }
};

function readStored() {
  try {
    const v = sessionStorage.getItem(STORE);
    return v === "starter" || v === "deeper" ? v : "";
  } catch { return ""; }
}
function store(value) {
  try { sessionStorage.setItem(STORE, value); } catch {}
}
function clearStored() {
  try { sessionStorage.removeItem(STORE); } catch {}
}
function selected() { return readStored(); }

function injectStyles() {
  if (document.getElementById("pack-picker-style")) return;
  const style = document.createElement("style");
  style.id = "pack-picker-style";
  style.textContent = `
    #packPicker{display:grid;gap:12px;margin:0 0 18px}
    #packPickerTitle{margin:0 0 2px;font-size:14px;letter-spacing:.04em;opacity:.78}
    .sw-pack{display:grid;grid-template-columns:1fr auto;gap:10px;align-items:center;width:100%;padding:15px 16px;border:1px solid rgba(255,255,255,.16);border-radius:16px;background:rgba(255,255,255,.035);color:inherit;text-align:left;cursor:pointer;transition:.2s ease}
    .sw-pack:hover{border-color:rgba(255,255,255,.34);transform:translateY(-1px)}
    .sw-pack.is-selected{border-color:rgba(226,197,183,.9);box-shadow:0 0 0 1px rgba(226,197,183,.22) inset;background:rgba(226,197,183,.08)}
    .sw-pack:disabled{opacity:.58;cursor:default;transform:none}
    .sw-pack-name{font-size:16px;font-weight:600}
    .sw-pack-note{display:block;margin-top:3px;font-size:12px;opacity:.68}
    .sw-pack-price{text-align:right;white-space:nowrap}
    .sw-pack-old{text-decoration:line-through;opacity:.45;font-size:12px;margin-right:5px}
    .sw-pack-now{font-size:18px;font-weight:700}
    #packRequired{margin:-4px 0 12px;font-size:12px;opacity:.72}
  `;
  document.head.appendChild(style);
}

function initPicker() {
  const scene = document.getElementById("scene-offering");
  const pay = document.getElementById("btnPay");
  if (!scene || !pay || document.getElementById("packPicker")) return;
  injectStyles();

  const picker = document.createElement("div");
  picker.id = "packPicker";
  picker.setAttribute("aria-label", "Choose a reading pack");
  picker.innerHTML = `
    <p id="packPickerTitle">Choose your reading</p>
    <button class="sw-pack" type="button" data-pack="starter">
      <span><span class="sw-pack-name">Starter Pack</span><span class="sw-pack-note">Short reading</span></span>
      <span class="sw-pack-price"><span class="sw-pack-old">฿9</span><span class="sw-pack-now">฿1</span></span>
    </button>
    <button class="sw-pack" type="button" data-pack="deeper">
      <span><span class="sw-pack-name">Deeper Pack</span><span class="sw-pack-note">Full Vera reading</span></span>
      <span class="sw-pack-price"><span class="sw-pack-old">฿59</span><span class="sw-pack-now">฿39</span></span>
    </button>
    <p id="packRequired" hidden>Please choose a pack before payment.</p>
  `;
  const anchor = pay.closest(".pay-card") || pay.parentElement;
  anchor.parentElement.insertBefore(picker, anchor);

  const buttons = [...picker.querySelectorAll("[data-pack]")];
  const required = picker.querySelector("#packRequired");

  function syncFullPresentation(value) {
    const heading = document.getElementById("endHeading");
    if (!heading) return;
    if (value === "starter") {
      heading.textContent = "คำตอบสำหรับคำถามนี้ของคุณ";
      heading.dataset.packOverride = "starter";
    } else if (heading.dataset.packOverride === "starter") {
      heading.textContent = "เมื่อมองไพ่ทั้งสี่ใบรวมกัน";
      delete heading.dataset.packOverride;
    }
  }

  function sync() {
    const value = selected();
    const locked = pay.hidden || !document.getElementById("payQr")?.hidden || !document.getElementById("slipBox")?.hidden;
    buttons.forEach((b) => { b.classList.toggle("is-selected", b.dataset.pack === value); b.disabled = locked; });
    if (!locked) pay.disabled = !value;
    required.hidden = !!value || locked;
    const p = PACKS[value || "deeper"];
    const priceNodes = document.querySelectorAll("#payPrice, #offeringPrice, [data-payment-price]");
    priceNodes.forEach((n) => { if (n) n.textContent = `฿${p.price}`; });
    const hint = document.getElementById("payHint");
    if (hint && !hint.hidden) hint.textContent = `Transfer ฿${p.price} to the account shown below, then attach your slip.`;
    syncFullPresentation(value);
  }

  buttons.forEach((button) => button.addEventListener("click", () => {
    if (button.disabled) return;
    store(button.dataset.pack);
    sync();
  }));

  const observer = new MutationObserver(sync);
  observer.observe(pay, { attributes: true, attributeFilter: ["disabled", "hidden"] });
  const qr = document.getElementById("payQr");
  if (qr) observer.observe(qr, { attributes: true, attributeFilter: ["hidden"] });
  const slip = document.getElementById("slipBox");
  if (slip) observer.observe(slip, { attributes: true, attributeFilter: ["hidden"] });
  const full = document.getElementById("scene-full");
  if (full) observer.observe(full, { attributes: true, attributeFilter: ["class"] });

  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input?.url || "";
    const path = (() => { try { return new URL(url, location.href).pathname; } catch { return url; } })();
    if (path === "/api/read" && String(init.method || "GET").toUpperCase() === "POST") clearStored();
    if (path === "/api/payment/create" && String(init.method || "GET").toUpperCase() === "POST") {
      const pack = selected();
      if (pack && init.body) {
        try {
          const body = JSON.parse(init.body);
          body.package = pack;
          init = { ...init, body: JSON.stringify(body) };
        } catch {}
      }
    }
    if (path === "/api/payment/verify-slip" && String(init.method || "GET").toUpperCase() === "POST" && selected()) {
      if (init.body instanceof FormData && !init.body.has("package")) init.body.append("package", selected());
    }
    if (path === "/api/deeper" && String(init.method || "GET").toUpperCase() === "POST" && selected() && init.body) {
      try {
        const body = JSON.parse(init.body);
        body.package = selected();
        init = { ...init, body: JSON.stringify(body) };
      } catch {}
    }
    return originalFetch(input, init);
  };

  sync();
}

export function initPackagePicker() {
  if (typeof document === "undefined") return;
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initPicker, { once: true });
  else initPicker();
}
