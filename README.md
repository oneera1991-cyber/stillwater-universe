# Stillwater AI Prototype

Prototype แยกจากเว็บเดิม: คำถาม → AI วิเคราะห์ → สุ่ม Major Arcana 1 ใบ → AI อ่าน → แสดง token/cost

## Deploy
1. สร้าง GitHub repo ใหม่แล้วอัปโหลดไฟล์ทั้งหมด
2. Import repo เข้า Vercel
3. Vercel → Project Settings → Environment Variables
4. เพิ่ม `OPENAI_API_KEY` = API key ของ OpenAI
5. Deploy

**ห้ามใส่ API key ใน index.html** เพราะ OpenAI ระบุว่า API key ต้องเก็บฝั่ง server/environment variable เท่านั้น.

Prototype นี้ใช้ `gpt-5.4-mini` ทั้ง 2 ขั้นเพื่อให้เราวัดคุณภาพก่อน และแสดง usage/cost จาก API response จริง

## Vera 6-scene (branch `vera-6scene`)
- `index.html`: one page, scenes `#scene-window` → `#scene-question` → `#scene-draw` → `#scene-first` → `#scene-offering` → `#scene-full` (+ `#scene-safety`, no CTA).
- `api/_lib/order.js`: signed + sealed tokens (HMAC-SHA256 + AES-GCM, HKDF keys): **order** token from `/api/read`, **paid** token from `/api/payment/verify-slip`; `verifyPaidOrder()` gate used by `/api/deeper`.
- `api/_lib/payment.js`: the ONLY payment-provider boundary. Active provider: `api/_lib/payment/promptpay-easyslip.js`. Inactive option: `api/_lib/payment/omise.js` (`PAYMENT_PROVIDER=omise`).
- `api/payment/verify-slip.js`: slip upload (multipart `order` + `slip`, JPG/PNG ≤ 4 MB) → EasySlip v2 → paid token.
- `api/_lib/rate-limit.js`: best-effort in-memory per-IP limits (`/api/read`, `/api/payment/verify-slip`).
- `api/_lib/vera.js` + `card-meanings.json` + `card-meanings.en.json`: Stillwater's reader, copied verbatim from `stillwater/ai-publish` branch `vera-3card` @ `ce4add1`. Re-copy these three files when Stillwater updates them.
- `api/_lib/reader.js`: the only place routes get Vera from. Real `vera.js` when `OPENAI_API_KEY` is set, else `api/_lib/vera.stub.js` (same interface, no AI). On Vercel production it always uses the real reader, so a missing key fails with an error instead of serving filler. `VERA_READER=stub|real` forces a choice.
- Draws: exactly one server-side draw per step, made by the route (`drawOne` in `/api/read`, `drawThree(card1)` in `/api/deeper`, crypto.randomInt), then passed to `generateFree({card})` / `generateThree({cards3})`.

### Languages (th / en)
- All user-facing copy is in `i18n/strings.js` (`th` + `en`), shared by the page (ES module) and the API. Thai is unchanged. English scene copy is Palm's approved text (`prompts/scene-copy.en.md`, approved 2026-10-09, marked `[Palm]`). Status, error and payment messages are not covered by that doc.
- Page: the TH/EN toggle next to SOUND. The default comes from `navigator.language` (`th*` → th, otherwise en) and the choice is remembered in `localStorage["stillwater.lang"]`. Switching re-renders the current scene without losing state. The reading text stays in the language it was written in.
- `/api/read` accepts `lang` (`th`/`en`/`en-US`…, anything else → `th`) and seals it into the order token. `/api/deeper` and `/api/payment/*` use the **token's** lang, never the client's. Old tokens without lang are treated as `th`.
- Positions: `position_key` (`past`/`present`/`ahead`) for ordering/logic, `position`/`label` for display (อดีต/ปัจจุบัน/แนวโน้มข้างหน้า, Past/Present/Future).
- Safety: the fixed text from `vera.js` is shown as-is (Thai: 1323/1669; English: 1323 (Thai-language), 1669, embassy / local emergency services). No CTA.

### Payment: PromptPay to own account + EasySlip
1. `/api/payment/create` → dynamic PromptPay QR for exactly ฿59.00 (`promptpay-qr` + `qrcode`), shown on the offering scene (with "บันทึกรูป QR" for phone users).
2. Customer pays in their bank app and attaches the slip.
3. Server calls `POST https://api.easyslip.com/v2/verify/bank` (multipart `image`, `matchAmount=59`, `matchAccount=true`, `checkDuplicate=true`, `remark=<orderId>`). Unlock ONLY if `isAmountMatched === true`, `matchedAccount !== null`, `isDuplicate === false` (and the slip is not older than the order).
4. The verified `transRef` is bound to the `orderId` in a sealed, signed **paid** token; `/api/deeper` accepts `{ order, paid }`.
- `SLIP_PENDING` (Bangkok Bank, ~5 min) → calm retry message + "ตรวจสลิปอีกครั้ง".
- TODO(DB): unique `transRef` storage, one-time use, re-issue on same-customer duplicate, reopen links — see the top of `api/_lib/order.js`.

### Environment variables (Vercel → Project Settings → Environment Variables)
| Name | Required | What |
| --- | --- | --- |
| `PROMPTPAY_ID` | yes | PromptPay ID that receives the ฿59 (mobile 10 digits, national/tax ID 13, or e-wallet 15). Must be the same account registered in EasySlip. |
| `EASYSLIP_API_KEY` | yes | EasySlip API key (Bearer). |
| `ORDER_SIGNING_KEY` | yes | Random secret ≥ 32 chars, e.g. `openssl rand -hex 32`. Signs/seals order + paid tokens. (Falls back to `OMISE_SECRET_KEY` only if that exists.) Changing it invalidates in-flight orders. |
| `PAYMENT_PROVIDER` | no | `promptpay` (default) or `omise` (inactive). |
| `OPENAI_API_KEY` | yes (production) | Stillwater's reader (`api/_lib/vera.js`). If it is missing on production, readings return an error. |
| `VERA_READER` | no | `stub` or `real` to force a reader. Leave it unset in production. |
| `OMISE_PUBLIC_KEY` / `OMISE_SECRET_KEY` | no | Only for `PAYMENT_PROVIDER=omise`. |

EasySlip IP whitelist: Vercel functions do not have fixed outbound IPs by default, so either leave the EasySlip whitelist open (`*`, rely on the secret key) or use a fixed-IP setup (Vercel static-IP / Secure Compute options are paid add-ons — check the current plan — or a small proxy) and whitelist that. A blocked call shows customers "ระบบตรวจสลิปยังไม่พร้อม" and logs `EasySlip error: IP_NOT_ALLOWED`.

### Local test (no keys, mocked EasySlip/Omise, no OpenAI calls)
```
npm install
node dev/server.mjs 3123 &          # static + /api shim + mock EasySlip (and Omise)
node dev/unit.mjs                   # tokens / EasySlip / QR / draw / rate limit / i18n / stub==vera.js shapes (fake OpenAI client)
PLAYWRIGHT=<path to playwright> node dev/e2e.mjs   # 390x844 walk-through, Thai + English (ONLY=en for English only) + screenshots
```
Tests force the stub reader, unset `OPENAI_API_KEY` and block any request to openai.com. Restart `dev/server.mjs` before each e2e run (in-memory duplicate list + rate limits). `dev/` is excluded from deploys via `.vercelignore`.
