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
- `api/read.js`, `api/deeper.js`: reading generation is a STUB until Stillwater's `vera-3card` lands.

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
| `OPENAI_API_KEY` | after merge | For Stillwater's reading backend. |
| `OMISE_PUBLIC_KEY` / `OMISE_SECRET_KEY` | no | Only for `PAYMENT_PROVIDER=omise`. |

EasySlip IP whitelist: Vercel functions do not have fixed outbound IPs by default, so either leave the EasySlip whitelist open (`*`, rely on the secret key) or use a fixed-IP setup (Vercel static-IP / Secure Compute options are paid add-ons — check the current plan — or a small proxy) and whitelist that. A blocked call shows customers "ระบบตรวจสลิปยังไม่พร้อม" and logs `EasySlip error: IP_NOT_ALLOWED`.

### Local test (no keys, mocked EasySlip/Omise, no OpenAI calls)
```
npm install
node dev/server.mjs 3123 &          # static + /api shim + mock EasySlip (and Omise)
node dev/unit.mjs                   # tokens / EasySlip interpretation / QR / draw / rate limit
PLAYWRIGHT=<path to playwright> node dev/e2e.mjs   # 390x844 walk-through + screenshots
```
Restart `dev/server.mjs` before each e2e run (in-memory duplicate list + rate limits). `dev/` is excluded from deploys via `.vercelignore`.
