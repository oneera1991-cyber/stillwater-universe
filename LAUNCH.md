# Stillwater × Vera — launch checklist (preview → production)

Target: Vercel project **stillwater-universe** → `https://stillwater-universe.vercel.app`
Code: repo `oneera1991-cyber/stillwater-universe`, branch `vera-6scene` (committed locally, **not pushed**).
Nothing in this file has been done yet. Every push, deploy, env-var change and Sheet edit below needs Palm's go-ahead.

---

## 0. Status at hand-off
- `node dev/unit.mjs` and the full Playwright e2e (`dev/e2e.mjs`, TH + EN) pass locally. They use the stub reader, a mocked EasySlip and a mocked Google Sheets fetch, so nothing external is called.
- `vercel build` (local, no deploy) succeeds: 9 functions on **nodejs24.x**, and the static site includes `/terms` and `/privacy` rewrites.
- These fixes were found by the local build and are already in this commit:
  - `/api/read` and `/api/deeper` would have crashed on Vercel, because `card-meanings*.json` was not bundled (file tracing misses `vera.js`'s `loadDeck(file)`). `vercel.json` → `functions.*.includeFiles` now ships them.
  - Vercel no longer builds on Node 20. `package.json` has `"engines": { "node": "24.x" }`, and `openai@7` needs Node ≥ 22 anyway.
  - `"type": "module"` is set, so the API ships as native ESM instead of being down-compiled to CommonJS.
- `package-lock.json` is committed, so Vercel installs the same versions that were tested.

## 1. What Palm must provide

| # | Item | Notes |
| --- | --- | --- |
| 1 | **PromptPay ID** that receives the ฿59 | A mobile number (10 digits), national/tax ID (13) or e-wallet ID (15). It goes in `PROMPTPAY_ID`. It must be the **same account** registered in EasySlip, or `matchAccount` fails every slip. |
| 2 | **EasySlip account + API key** | Sign up at EasySlip and register the receiving bank / PromptPay account. Create an API key → `EASYSLIP_API_KEY`. IP whitelist: Vercel has no fixed outbound IP by default, so leave the whitelist open (`*`) or set up a fixed-IP option and whitelist it. If the IP is blocked, customers see "ระบบตรวจสลิปยังไม่พร้อม" and the logs show `IP_NOT_ALLOWED`. |
| 3 | **OpenAI API key** → `OPENAI_API_KEY` | Stillwater's reader. Without it, **production** readings return an error, and preview falls back to the stub reader. |
| 4 | **Google service account** (for the Sheet log) | Created under oneera1991@gmail.com. Steps are in §3. |
| 5 | **Approval to push** branch `vera-6scene` and later merge/promote to production | |
| 6 | Optional, before launch: Stillwater's `vera.js` update | `final` should cover all four cards, `closing` should be Vera's words only, and the CALL_B page description should be updated (README → "V2: changes Stillwater needs to make"). It works without this, but `final` still says "สามใบ…" / "these three cards…". |

## 2. Environment variables (Vercel → Project → Settings → Environment Variables)

| Name | Required | Scope | Value |
| --- | --- | --- | --- |
| `ORDER_SIGNING_KEY` | **yes** | Preview + Production (use **different** values) | `openssl rand -hex 32` (≥ 32 chars). Signs order/paid tokens. Changing it invalidates in-flight orders. Mark it Sensitive. |
| `PROMPTPAY_ID` | **yes** | Preview + Production | From §1.1 |
| `EASYSLIP_API_KEY` | **yes** | Preview + Production | From §1.2. Sensitive. |
| `OPENAI_API_KEY` | **yes** (production) | Preview + Production | From §1.3. Sensitive. |
| `LOG_SINK` | recommended | Preview + Production | `sheets`. (`console` = Vercel logs only; `none` = off.) |
| `GOOGLE_SHEETS_ID` | with `sheets` | Preview + Production | `1IlhWkJJBKTs3UTtbAPcQLreHouSCRF04QFqfsS93W58` (not a secret) |
| `GOOGLE_SHEETS_TAB` | no | Production: `events`; Preview: `events_preview` (recommended) | Defaults to `events`. A separate preview tab keeps test rows out of the real log. The `env` column also records `preview` / `production`. |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | with `sheets` | Preview + Production | The key-file JSON, raw or base64 (`base64 -w0 key.json`). Sensitive. Or use the alternative below. |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` + `GOOGLE_PRIVATE_KEY` | alternative to the JSON | same | `client_email` and `private_key` from the key file (`\n` escapes are fine). |
| `PAYMENT_PROVIDER` | no | — | Leave unset (= `promptpay`). |
| `VERA_READER` | no | — | **Leave unset** in production. `stub` forces the offline reader. |
| `EASYSLIP_MOCK` | no | — | **Never set** on Vercel (it is for the local dev server only). |
| `OMISE_PUBLIC_KEY` / `OMISE_SECRET_KEY` | no | — | Only for `PAYMENT_PROVIDER=omise` (inactive). |

If `LOG_SINK=sheets` but the Sheet id or service account is missing, the app logs a warning and uses the console. A failed Sheet append never affects a reading: the row is still printed as `STILLWATER_EVENT {...}` in the Vercel logs.

## 3. Google service account for the Sheet log (one time, ~10 min)
1. Sign in to <https://console.cloud.google.com> as **oneera1991@gmail.com**. Create a project (e.g. `stillwater-logs`). Billing is not needed for the Sheets API.
2. **APIs & Services → Library → "Google Sheets API" → Enable.**
3. **IAM & Admin → Service Accounts → Create service account.** Name it `vera-logger` and skip the optional role / user-access steps (it needs no project roles).
4. Open the new account → **Keys → Add key → Create new key → JSON**. A file like `stillwater-logs-xxxx.json` downloads. Treat it like a password.
5. Copy its `client_email` (`vera-logger@<project>.iam.gserviceaccount.com`). Open the **Vera Readings** Sheet (`1IlhWkJJBKTs3UTtbAPcQLreHouSCRF04QFqfsS93W58`) → **Share** → paste that email → **Editor** → untick "Notify" → Share.
6. **Sheet header** (Palm, by hand): tab `events` currently has 29 header columns. Add `share_channel` in **AD1** and `share_result` in **AE1**. No other columns move. For preview, duplicate the tab as `events_preview` (header row only).
7. In Vercel, add `LOG_SINK=sheets`, `GOOGLE_SHEETS_ID`, `GOOGLE_SHEETS_TAB` and `GOOGLE_SERVICE_ACCOUNT_JSON` (§2). Then **delete the downloaded key file** from the computer.
8. Check: after one preview reading, a `read_free` row appears in `events_preview` within a few seconds. The Vercel function logs show no `Stillwater log: sink error`.
- How it works (`api/_lib/log.js`): the service account signs an RS256 JWT, which is exchanged at `oauth2.googleapis.com/token` for a token cached ~55 min per warm instance. Each event is one `values:append` to `<tab>!A1` (`RAW`, 31 columns). The write is handed to `waitUntil()`, so it finishes after the response without slowing the page, with an 8 s cap.
- Rotate a key: create a new key, update the env var, redeploy, then delete the old key in the console.
- Retention: install the `purgeOldRows` Apps Script daily trigger from README ("Retention: 90 days").

## 4. Order of steps
1. Palm provides §1.1–1.4 and approves the push.
2. Vercel project → Settings → General → **Node.js Version 24.x** (`engines` in `package.json` also enforces it).
3. Add the **Preview** env vars (§2), with `GOOGLE_SHEETS_TAB=events_preview`.
4. Palm adds AD1/AE1 to the Sheet and creates `events_preview` (§3.6).
5. Push branch `vera-6scene`. The Vercel Git integration builds a **preview** URL. If it doesn't, run `vercel deploy` (preview), not `--prod`.
6. Run the **preview test plan** (§5 A), including one real ฿59 payment.
7. Add the **Production** env vars (a different `ORDER_SIGNING_KEY`, `GOOGLE_SHEETS_TAB=events`).
8. Merge `vera-6scene` into the production branch, or **Promote to Production** the tested preview deployment. Note the previous production deployment's URL for rollback (§6).
9. Run the **production smoke test** (§5 B) on `https://stillwater-universe.vercel.app`, including one real ฿59 payment.
10. Install the 90-day `purgeOldRows` trigger. Watch the Vercel logs and the Sheet for the first day.

## 5. Real ฿59 end-to-end test plan

### A. Preview (all real services: OpenAI, PromptPay QR, EasySlip, Sheets → `events_preview`)
Use a phone (360–430 px wide) in Safari/LINE in-app and Chrome. Pay from a personal bank app into Palm's PromptPay.

| # | Step | Expected |
| --- | --- | --- |
| A1 | Open the preview URL with `?src=friends` | Landing (TH). No notices or links. SOUND / TH-EN never cover text while scrolling. |
| A2 | "พร้อมส่งคำถาม" → type a real question → "พร้อมรับคำตอบ" | Draw → scene 4: heading "ไพ่ใบนี้มีบางอย่างอยากบอกคุณ", the card and 4 real lines (not stub wording). The Sheet gets `read_free` (src `friends`, question redacted of phone/email). |
| A3 | Rate 4★ on scene 4 → "ให้พี่ถามต่อ" | `rating` row (`<order>:free`, 4). Scene 5 shows **฿59**. |
| A4 | "เข้าสู่การชำระเงิน" | QR appears. Scan it in the bank app: payee name = Palm's account, amount **59.00** pre-filled. |
| A5 | Pay ฿59 and upload the slip from the bank app | "ได้รับแล้ว…" → scene 6 within ~3 s. `payment_verified` row: `trans_ref` = slip ref, `amount_thb` 59. |
| A6 | Read the cards: "พี่เวราเล่าต่อค่ะ" ×2 | Cards 2, 3, 4 with headings and glow dividers, then the ending: overview → Vera's words → thanks line → return line → stars → "แชร์ Stillwater" / "ปิดการอ่าน". `read_full` row with `cards3`. |
| A7 | Reload mid-story, then at the end | Resumes at the card reached, then shows the whole story. No second charge, no new draw. |
| A8 | Rate 5★ → "แชร์ Stillwater" (share sheet → cancel, then share to LINE) | `rating` (`:full`) row + `share` rows `native:cancelled` and `native:completed`. The shared content is **only** the site link. |
| A9 | "ปิดการอ่าน" | Back to the landing. `close` row. Reload stays on the landing. |
| A10 | Upload **the same slip** again on a new order | Rejected: "เคยถูกใช้". No unlock. |
| A11 | Upload an older slip / a non-slip photo | Friendly error. No unlock. |
| A12 | Repeat A1–A9 in **EN** (toggle) — optional second ฿59 | English copy throughout, rows have `lang=en`. |
| A13 | Safety: ask "ช่วงนี้ไม่อยากมีชีวิตอยู่แล้ว" | Calm screen with 1323, no button. `read_free` row with `safety=TRUE` and empty question. |
| A14 | `/terms`, `/privacy` by URL | Final copy, TH/EN toggle. Not linked from any scene. |

### B. Production smoke test (after promote)
Repeat A1, A2, A4–A6, A9 and A13 on `stillwater-universe.vercel.app` with one real ฿59. Rows land in `events` with `env=production`. Check the Vercel logs for `sink error`, `IP_NOT_ALLOWED` and `config_missing`.

The test payments go into Palm's own PromptPay. Note their `trans_ref`s so the test rows can be filtered out or deleted later (README → "Deleting a reading on request").

## 6. Rollback
- **App:** Vercel → Deployments → the previous production deployment → **Instant Rollback** (or "Promote to Production"). This takes seconds and needs no rebuild. Then revert the merge commit on the production branch, so the next push doesn't re-ship the release.
- **Sheet logging only:** set `LOG_SINK=console` (or `none`) and redeploy. Readings and payments are unaffected, and events stay in the Vercel logs.
- **Payments misbehaving** (EasySlip down / IP blocked): there is no kill switch. Roll back the app, or fix the EasySlip whitelist/key. Customers who paid but didn't get the reading can be found by `trans_ref` in the `payment_verified` rows (or the Vercel logs). Their paid token stays valid on the same device, so reopening the page resumes the reading.
- **Bad reader output:** roll back, or temporarily set `VERA_READER=stub` (offline readings, no OpenAI) as a last resort.
- **Leaked key:** rotate it (`ORDER_SIGNING_KEY` invalidates in-flight orders; the service-account key is deleted in the Cloud console; EasySlip/OpenAI keys are regenerated in their dashboards), update Vercel and redeploy.

## 7. Local commands
```
npm install
node dev/unit.mjs                                   # unit (mock Sheets fetch, stub reader)
node dev/server.mjs 3123 &                          # local server: stub reader, mocked EasySlip
PLAYWRIGHT=/path/to/playwright SHOTS=/tmp/shots node dev/e2e.mjs
vercel build --yes                                  # build only (needs .vercel/project.json; .vercel/ is git-ignored)
```
