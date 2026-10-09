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
- `api/_lib/order.js`: signed + sealed order token (HMAC-SHA256, keys via HKDF from `OMISE_SECRET_KEY`), `verifyPaidOrder()`.
- `api/_lib/payment.js`: the ONLY payment-provider boundary (`createPayment`, `getPaymentStatus`). Omise adapter in `api/_lib/payment/omise.js`.
- `api/_lib/rate-limit.js`: best-effort in-memory per-IP limit for `/api/read`.
- `api/read.js`, `api/deeper.js`: reading generation is a STUB until Stillwater's `vera-3card` lands.

Local test (no keys, mocked Omise, no OpenAI calls):
```
node dev/server.mjs 3123 &          # static + /api shim + mock Omise
node dev/unit.mjs                   # token / payment checks / draw / rate limit
PLAYWRIGHT=<path to playwright> node dev/e2e.mjs   # 390x844 walk-through + screenshots
```
`dev/` is excluded from deploys via `.vercelignore`.
