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
- `api/_lib/vera.js` + `card-meanings.json` + `card-meanings.en.json`: Stillwater's reader, copied verbatim from `stillwater/ai-publish` @ `4b4fa88` (5c79b3e added the internal, log-only `card_name_flags`: never sent to the page, no Sheet column; 4b4fa88 only changes Call B card 4). The card-meaning files are unchanged since `ce4add1`. Re-copy these three files when Stillwater updates them.
  - Internal fields `guarantee_flags` and `position_label_flags` are log-only checks (vera.js writes them to the server log with console.warn). `/api/deeper` and `/api/read` build their responses field by field, so these flags never reach the page. `buildRow` keeps only the Sheet columns, so they are not in the Sheet and there is no column for them.
- `api/_lib/reader.js`: the only place routes get Vera from. Real `vera.js` when `OPENAI_API_KEY` is set, else `api/_lib/vera.stub.js` (same interface, no AI). On Vercel production it always uses the real reader, so a missing key fails with an error instead of serving filler. `VERA_READER=stub|real` forces a choice.
- Draws: exactly one server-side draw per step, made by the route (`drawOne` in `/api/read`, `drawThree(card1)` in `/api/deeper`, crypto.randomInt), then passed to `generateFree({card})` / `generateThree({cards3})`.

### Languages (th / en)
- All user-facing copy is in `i18n/strings.js` (`th` + `en`), shared by the page (ES module) and the API. Thai is unchanged. English scene copy is Palm's approved text (`prompts/scene-copy.en.md`, approved 2026-10-09, marked `[Palm]`). Status, error and payment messages are not covered by that doc.
- Page: the TH/EN toggle next to SOUND. The default comes from `navigator.language` (`th*` → th, otherwise en) and the choice is remembered in `localStorage["stillwater.lang"]`. Switching re-renders the current scene without losing state. The reading text stays in the language it was written in.
- `/api/read` accepts `lang` (`th`/`en`/`en-US`…, anything else → `th`) and seals it into the order token. `/api/deeper` and `/api/payment/*` use the **token's** lang, never the client's. Old tokens without lang are treated as `th`.
- Positions: `position_key` (`past`/`present`/`ahead`) is used for ordering. Scene 6 no longer displays `position`/`label`. They appear only on the scene 5 locked cards, as in the prototype.

### V2: four cards, one story (Palm, 2026-10-09 13:39)
- The free card (scene 4) is card 1 of the story; scene 6 tells cards 2–4. Every card has only Vera's spoken heading, with no small labels anywhere:
  - card 1 (scene 4, `first.heading`): ไพ่ใบนี้มีบางอย่างอยากบอกคุณ / This card has something to tell you (replaces the report-style heading)
  - card 2, past: เรื่องนี้เริ่มต้นจากอะไร / Where did this begin?
  - card 3, present: แล้วตอนนี้ อะไรกำลังเกิดขึ้น / And now, what is happening?
  - card 4, future: ถ้าเรื่องนี้เดินต่อไป... / If this keeps unfolding...
- One card at a time. Each section has the heading, the card image, the card name, then the reading. The button "พี่เวราเล่าต่อค่ะ" / "Vera continues" (`full.next`) brings in the next card with a short fade-and-rise. A soft glow divider (`.glow-divider`) sits before cards 3 and 4. The card being read glows softly (`.chapter.is-current`), and earlier cards rest slightly dimmer.
- **Ending, after card 4** (`#fullFinal`), in order:
  1. Heading เมื่อมองไพ่ทั้งสี่ใบรวมกัน / Looking at all four cards together (`full.endingHeading`)
  2. Overview across all four cards = reader `final` (`#endOverview`)
  3. Vera's final words = reader `closing` (`#endWords`)
  4. Fixed line `full.thanks`: ขอบคุณจักรวาลที่ส่งคำตอบนี้มาให้คุณนะคะ / Thank you to the universe for sending you this answer.
  5. Fixed line `full.returnLine`: หากมีเรื่องที่อยากถามจักรวาล กลับมาหาพี่เวราได้เสมอ / Whenever there's something you'd like to ask the universe, you can always come back to Vera.
  6. Stars (`#rate-full`), then the final buttons below a divider:
     - "แชร์ Stillwater" / "Share Stillwater" (`#btnShareSite`) shares **only the site link** `location.origin + "/?src=share"` (`navigator.share({ title, url })`, or a clipboard copy as fallback). A new visitor arriving through it gets `src = share`, `src_type = referral` as their first touch. An existing first touch is never overwritten; only the last touch becomes `share`. It never includes the question, the cards or the reading.
     - "ปิดการอ่าน" / "Close reading" (`#btnClose`) ends the session: it clears the saved reading and ratings, resets every scene and returns to scene 1 (landing). A new question starts there with "พร้อมส่งคำถาม" / "I'm ready to ask".
- Removed: "บันทึกคำอ่าน" (the saved-image PNG), "แชร์คำอ่าน" and "ถามพี่เวราอีกครั้ง".
- `#igStorySlot` (`data-slot="instagram-story"`, `hidden`, empty) is the hook for a future Instagram Story share button, placed in the final buttons. Nothing is shown.
- Card names stay under the images.
- `lib/story.js` drops a leading stiff label line from a reader's text ("อดีต — The Moon", "Past: …") if one appears.
- **Mobile (360 / 390 / 430 px):** the SOUND and TH/EN controls sit in a top band (`--bar`). Every scene scrolls only below that band, and its top edge fades softly (CSS mask), so the controls never cover headings, reading text or buttons at any scroll position. The background is on `<body>`, so the band shows the same sky. Reading text is 16px with line-height 1.95, and the card art stays ≥ 180px wide. e2e checks this at 13 scroll positions per width.
- Resume: `fullStep` is saved. A reload shows the cards already reached at once and continues with the button. After the end, the whole story shows at once. After "ปิดการอ่าน" a reload stays on the landing.
- The client analytics `full_card_shown {step}` / `reading_closed` are silent. Nothing goes to the Sheet from them.
- Safety: the fixed text from `vera.js` is shown as-is (Thai: 1323/1669; English: 1323 (Thai-language), 1669, embassy / local emergency services). No CTA.

### V2 and `vera.js` 2ed3ca4 → a179c20
Stillwater's `2ed3ca4` covers the V2 asks:
- Call A knows the free card sits under "ไพ่ใบนี้มีบางอย่างอยากบอกคุณ".
- Call B tells cards 2–4 of a four-card story.
- `final` is one overview across all four cards.
- `closing` is Vera's own words, with no thanks to the universe and no come-back invite, because the page adds those two fixed lines once.
- The fallbacks match.

`a179c20` adds a rule that Vera never says she keeps or holds the question, plus an internal, log-only `keep_question_flags` post-check. Like `guarantee_flags` / `position_label_flags`, it is never sent to the page (the API builds responses field by field) and never written to the Sheet (no column). The stub reader mirrors the fallback closing and returns `keep_question_flags: []`. Unit + e2e check that the thanks / come-back lines appear exactly once and that the ending never contains the old "น้ำนิ่ง" closing sentence (removed, Palm 2026-10-09).

### Sound ("music + cosmos", Palm 2026-10-09; v2 after "only 13–20 s is good")
- `lib/ambient.js` is Web Audio, fully synthesized, with no audio files.
- **v2** holds the character of 13–20 s of the v1 render for the whole time:
  - one sustained Bm9 colour (F#3 A3 C#4 D4, root F#2) with no chord changes;
  - a warm lowpass breathing around ~1 kHz;
  - an octave-up shimmer (A4 C#5 D5) with slow tremolo;
  - a sparse low pentatonic bell every ~5–8 s;
  - low "cosmic air" noise;
  - a generated 5 s convolution reverb and a stereo ping-pong delay → highpass 120 Hz → master (0.6) → compressor → makeup.
- `export const VARIANT = "A" | "B"` is the single switch. A (default) holds the voicing still. B lets single notes glide slowly between Bm9-mode voicings and breathes a little more.
- The analysis and numbers are in `dev/AMBIENT.md`. Loudness is about −13.6 LUFS steady state with peaks around −4.5 dBFS; the old v0 ambient was −31 LUFS.
- Button sounds are soft chimes from the same scale.
- Sound still starts only on a user gesture.
- SOUND OFF fades out, stops every source and suspends the AudioContext. Hiding the page does the same, and coming back resumes if SOUND is on.
- There are 16 persistent sources, plus 2 per bell.
- Render: `VARIANT=A node dev/render-ambient.mjs 40 /tmp`.

### Fonts
- **All Thai text uses Noto Sans Thai, the loopless face the live site uses.** Never use Noto Sans Thai Looped, Sarabun or other looped/head faces.
- It is self-hosted in `fonts/`: Google Fonts v29 variable woff2 in thai, latin and latin-ext subsets, under the OFL (`fonts/OFL.txt`).
- The thai and latin files are preloaded, and `font-display: block` stops a looped system fallback from flashing.
- Fallbacks are loopless only: Noto Sans Thai UI, Leelawadee UI, Sukhumvit Set, Thonburi, then sans-serif. There is no `system-ui`.
- Form controls inherit the page font.
- Latin display text stays in Cormorant Garamond (Google Fonts).

### Customer scenes = the prototype (Palm, 2026-10-09)
- Scenes 1–6 (TH and EN) carry no disclaimer, privacy/data note, Reading ID, Terms/Privacy links, or any other notice, warning or consent text. They match the prototype (`04942b9`): same layout, copy, fonts and flow.
- The star rating (scene 4 + scene 6) stays. Since V2, scene 6 ends with "แชร์ Stillwater" + "ปิดการอ่าน" (see V2 above).
- Source tracking, ratings, share tracking and event logging all run silently.
- `/terms` and `/privacy` exist but are reachable only by direct URL. Nothing in the scenes links to them.
- e2e `noNotices()` checks every scene for notice elements and notice text. Screenshots are `16-th-*` and `16-en-*`.
- The page copy never mentions "AI".

### Data collection (source, ratings, event log)
- **Source** (`lib/source.js`, shared by the page and the API):
  - On landing the page reads `?src=` (presets: `friends`, `tiktok`, `ig`, `fb`, `line`, `fb_ads`, `youtube`, `share`, `group`; any other value is lowercased, spaces become `_`, and only `[a-z0-9_-]` is kept, up to 32 chars).
  - It also reads `utm_source` / `utm_medium` / `utm_campaign`, and whether `fbclid` / `ttclid` are present (the id values are never stored).
  - With no tag, the source comes from `document.referrer`: `fb`, `ig`, `tiktok`, `line`, `google`, `youtube`, `referral` (other site) or `direct`.
  - The first touch is stored once in `localStorage["stillwater.src.first"]`. The last touch (`stillwater.src.last`) is updated on every non-direct landing.
  - Tracking params are removed from the address bar.
  - `/api/read` re-sanitizes `{first, last}` and seals it in the order token, so payment / full-reading / rating / share events carry the source server-side.
- **Ratings**: an optional 1–5 star "ให้ดาวพี่เวรา" / "Rate Vera" widget after the free answer (`stage: "free"`) and after the full reading (`stage: "full"`).
  - `POST /api/rate { order, stage, stars, paid? }`: `stars` must be an integer 1–5. `full` requires this order's payment (same gate as `/api/deeper`).
  - There is one rating per order + stage. `rating_key = <order_id>:<stage>`; rating again adds a row with the same key, and the latest row wins. TODO(storage): upsert.
- **Share tracking (silent):** tapping "แชร์ Stillwater" on scene 6 fires `POST /api/share { order, channel, result }` without awaiting it. There's no visible change, and errors are ignored.
  - `channel`: `native` (navigator.share; the target app is unknown) or `copy_link` (clipboard fallback). `download_image` (no longer used since the saved image was removed in V2) and `line` / `facebook` / `x` stay accepted for future buttons (e.g. the Instagram Story slot).
  - `result`: `completed` / `cancelled` (navigator.share AbortError) / `failed` / `unknown`.
  - `order_id`, `lang` and `src` / `first_src` come only from the sealed order token.
- **Close (silent):** "ปิดการอ่าน" fires `POST /api/close { order }` (fire-and-forget) → one `close` event row with the token's `order_id` / `lang` / source, `device` and `card1`. It uses no new column.
- **Privacy** (no notice in the scenes; the copy lives on `/privacy`):
  - No IP or user agent is logged, only a coarse `device` (mobile/tablet/desktop/bot/unknown).
  - Phone numbers, emails and LINE ids in the question/context are redacted to `[phone]` / `[email]` / `[line id]` before logging.
  - Safety (self-harm / crisis) `read_free` rows keep `question` and `context` empty; the safety flag, source, lang and device are still logged.
- **Event log** (`api/_lib/log.js`):
  - `logEvent()` is fire-and-forget: never awaited by the routes, 1.5 s timeout, all errors swallowed. A broken sink never breaks a reading.
  - Sinks are chosen with `LOG_SINK`: `console` (default; one `STILLWATER_EVENT {json}` line in the Vercel logs), `sheets` (Google Sheets) or `none`.
  - **Google Sheets sink:** a service account signs an RS256 JWT (no extra library), and the access token is cached ~55 min. Each event is one `values:append` (RAW, 31 columns) to `GOOGLE_SHEETS_TAB`. The write is handed to `waitUntil()` (`@vercel/functions`), so it finishes after the response, with an 8 s cap. If it fails, the row is still printed to the Vercel logs. Unit tests use a mock fetch and never call Google. Setup: LAUNCH.md §3.

**Events**: `read_free` (every free attempt, including safety / needs_rewrite), `payment_verified` (slip OK), `read_full` (3 cards generated), `rating`, `share`.

**Sheet columns** (Google Sheet `1IlhWkJJBKTs3UTtbAPcQLreHouSCRF04QFqfsS93W58`, row 1 of tab `events`, already written, in this order; every event fills the common columns plus its own):

| # | column | filled by | meaning |
| --- | --- | --- | --- |
| 1 | `ts` | all | server time (ISO, UTC) |
| 2 | `event` | all | `read_free` / `payment_verified` / `read_full` / `rating` / `share` / `close` |
| 3 | `env` | all | `production` / `preview` / `dev` |
| 4 | `order_id` | all (empty for safety / needs_rewrite) | from the order token |
| 5 | `lang` | all | `th` / `en` |
| 6 | `src` | all | last-touch source |
| 7 | `src_type` | all | `tag` / `referral` (`?src=share`) / `utm` / `click` / `referrer` / `direct` |
| 8–10 | `utm_source`, `utm_medium`, `utm_campaign` | all | last touch |
| 11 | `click_id` | all | `fbclid` / `ttclid` / `fbclid+ttclid` (presence only) |
| 12 | `referrer` | all | referrer host only |
| 13–16 | `first_src`, `first_src_type`, `first_utm_campaign`, `first_at` | all | first touch |
| 17 | `device` | all | mobile / tablet / desktop / bot / unknown |
| 18 | `reader` | read_free, read_full | `real` / `stub` |
| 19–20 | `question`, `context` | read_free | PII-redacted; empty when `safety` = TRUE |
| 21 | `card1` | read_free, read_full, rating, share, close | free card id |
| 22–23 | `safety`, `needs_rewrite` | read_free | TRUE / FALSE |
| 24–25 | `trans_ref`, `amount_thb` | payment_verified | EasySlip transRef, 59 |
| 26 | `cards3` | read_full | ids past,present,future, e.g. `4,17,9` |
| 27–29 | `stage`, `stars`, `rating_key` | rating | `free`/`full`, 1–5, `<order_id>:<stage>` |
| 30 | `share_channel` | share | `native` / `copy_link` / `download_image` / `line` / `facebook` / `x` |
| 31 | `share_result` | share | `completed` / `cancelled` / `failed` / `unknown` |

**Sheet header change needed** (the live sheet is not edited from here): the Vera Readings `events` tab has 29 header columns. Add `share_channel` in **AD1** and `share_result` in **AE1**, right after `rating_key` (AC1). Earlier columns don't move, so existing rows stay valid.

### Reading ID, deletion requests, retention
- **Reading ID** = first 8 chars of `order_id` after `ord_`, uppercased. For example `ord_KB1lpqjhlyTa…` becomes `KB1LPQJH` (`readingId()` in `api/_lib/order.js`).
  - It is **not shown** to the customer anywhere (Palm, 2026-10-09). `/api/read` and `/api/deeper` still return `reading_id`, and the page keeps it in state.
  - It is not a separate column, because it can be derived. In the Sheet, a helper column can use `=UPPER(MID(D2,5,8))` (`order_id` is column D).
  - The match ignores case, so check the matching rows before deleting.
- **Deleting a reading on request:**
  1. The customer can't see a Reading ID, so identify the rows by their payment reference (`trans_ref` on the `payment_verified` row, from their slip), the time of the reading, and the question they asked. That gives the `order_id`.
  2. In the Sheet: Data → Create a filter, then filter the `order_id` column with that value (or "Text contains" `ord_<ID>`, match case off, or use the helper column).
  3. Check the rows: `read_free`, `payment_verified`, `read_full`, `rating` and `share` all share that `order_id`. Delete them.
  4. Alternatively, run `deleteByReadingId("<ID>")` from the Apps Script below, or plan it offline with `node scripts/purge-old-rows.mjs events.csv --reading-id <ID>`.
  - Safety rows have no `order_id` and never contain question text.
- **Retention: 90 days, via an Apps Script trigger that Palm installs on the Sheet.**
  - Function `purgeOldRows` on tab `events`, daily, deletes rows whose `ts` is older than 90 days.
  - Setup: Extensions → Apps Script, paste the code below, then Triggers → Add trigger → `purgeOldRows` → Time-driven → Day timer.
  - It runs as the Sheet owner with no keys, and nothing in this repo calls Google.
  - For an offline check, `node scripts/purge-old-rows.mjs events.csv [--days 90]` is a dry run on a CSV export: it prints the rows and the equivalent Sheets `batchUpdate` request and sends nothing.

```js
// Apps Script — paste into the Sheet (Extensions → Apps Script). Nothing runs until you run or schedule it.
const TAB = 'events';
function purgeOldRows(days) {
  days = days || 90;
  const sh = SpreadsheetApp.getActive().getSheetByName(TAB);
  const values = sh.getDataRange().getValues();           // row 0 = header
  const tsCol = values[0].indexOf('ts');
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  let deleted = 0;
  for (let r = values.length - 1; r >= 1; r--) {            // bottom-up
    const ts = new Date(values[r][tsCol]).getTime();
    if (!isNaN(ts) && ts < cutoff) { sh.deleteRow(r + 1); deleted++; }
  }
  Logger.log('deleted ' + deleted + ' row(s) older than ' + days + ' days');
}
function deleteByReadingId(id) {
  const want = String(id).trim().toUpperCase();
  const sh = SpreadsheetApp.getActive().getSheetByName(TAB);
  const values = sh.getDataRange().getValues();
  const orderCol = values[0].indexOf('order_id');
  let deleted = 0;
  for (let r = values.length - 1; r >= 1; r--) {
    const rid = String(values[r][orderCol] || '').replace(/^ord_/, '').slice(0, 8).toUpperCase();
    if (rid && rid === want) { sh.deleteRow(r + 1); deleted++; }
  }
  Logger.log('deleted ' + deleted + ' row(s) for Reading ID ' + want);
}
// Daily trigger (Palm installs): Triggers → Add trigger → purgeOldRows → Time-driven → Day timer.
```

### Legal pages
- `/terms` → `terms.html` and `/privacy` → `privacy.html` (`vercel.json` rewrites, mirrored in `dev/server.mjs`).
- They render Stillwater's final copy word for word: `legal/{terms,privacy}.{th,en}.md`, copied from `stillwater/prompts/` (the effective date is whatever line 3 of each file says; no launch date is hardcoded here), support email oneera1991@gmail.com.
- `scripts/build-legal.mjs` turns the markdown into `legal/content.js`. It only maps headings, lists, bold and paragraphs, and links the email (mailto:) and 1323 / 1669 (tel:).
- Rebuild after any copy change with `node scripts/build-legal.mjs`. `dev/unit.mjs` fails if the generated file is stale, and e2e compares the page text with the markdown.
- Both pages follow the TH/EN toggle (`?lang=`, otherwise the saved choice, otherwise the browser language) and use the same loopless fonts.
- Links: scene 5 (next to the QR / slip upload) and the footers of scenes 4, 5 and 6, opening in a new tab so the reading isn't lost.

### Payment: PromptPay to own account + EasySlip
1. `/api/payment/create` → dynamic PromptPay QR for exactly ฿59.00 (`promptpay-qr` + `qrcode`), shown on the offering scene (with "บันทึกรูป QR" for phone users).
2. Customer pays in their bank app and attaches the slip.
3. Server calls `POST https://api.easyslip.com/v2/verify/bank` (multipart `image`, `matchAmount=59`, `matchAccount=true`, `checkDuplicate=true`, `remark=<orderId>`). Unlock ONLY if `isAmountMatched === true`, `matchedAccount !== null`, `isDuplicate === false` (and the slip is not older than the order).
4. The verified `transRef` is bound to the `orderId` in a sealed, signed **paid** token; `/api/deeper` accepts `{ order, paid }`.
- `SLIP_PENDING` (Bangkok Bank, ~5 min) → calm retry message + "ตรวจสลิปอีกครั้ง".
- TODO(DB): unique `transRef` storage, one-time use, re-issue on same-customer duplicate, reopen links — see the top of `api/_lib/order.js`.

### Environment variables (Vercel → Project Settings → Environment Variables)
Full launch checklist (order of steps, real ฿59 test, rollback): **LAUNCH.md**. Node.js 24.x (`engines`).
| Name | Required | What |
| --- | --- | --- |
| `PROMPTPAY_ID` | yes | PromptPay ID that receives the ฿59 (mobile 10 digits, national/tax ID 13, or e-wallet 15). Must be the same account registered in EasySlip. |
| `EASYSLIP_API_KEY` | yes | EasySlip API key (Bearer). |
| `ORDER_SIGNING_KEY` | yes | Random secret ≥ 32 chars, e.g. `openssl rand -hex 32`. Signs/seals order + paid tokens. (Falls back to `OMISE_SECRET_KEY` only if that exists.) Changing it invalidates in-flight orders. |
| `PAYMENT_PROVIDER` | no | `promptpay` (default) or `omise` (inactive). |
| `OPENAI_API_KEY` | yes (production) | Stillwater's reader (`api/_lib/vera.js`). If it is missing on production, readings return an error. |
| `LOG_SINK` | no | `console` (default), `sheets` (Google Sheets append via a service account; see LAUNCH.md §3), `none`. |
| `GOOGLE_SHEETS_ID` | later | Intended value: `1IlhWkJJBKTs3UTtbAPcQLreHouSCRF04QFqfsS93W58` (spreadsheet id, not a secret). Header row has the first 29 columns; add `share_channel` (AD1) and `share_result` (AE1) for the 31-column schema. |
| `GOOGLE_SHEETS_TAB` | later | `events` (default; `events_preview` recommended for Preview). |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | later | Service-account key file JSON (raw or base64) for the Sheets sink (secret). Alternative: `GOOGLE_SERVICE_ACCOUNT_EMAIL` + `GOOGLE_PRIVATE_KEY`. Share the sheet with the service-account email as Editor. Setup: LAUNCH.md §3. |
| `PAYMENT_TEST_MODE` | no (Preview only) | `1` = any uploaded JPG/PNG passes slip verification (no EasySlip call, `trans_ref` `TEST-…`). The page looks the same as the real flow. If `PROMPTPAY_ID` is not a valid ID, the QR is a non-payable demo QR (plain text, not a payment). **Ignored whenever `VERCEL_ENV=production`** (hard guard, unit-tested). Never set it for Production. |
| `VERA_READER` | no | `stub` or `real` to force a reader. Leave it unset in production. |
| `OMISE_PUBLIC_KEY` / `OMISE_SECRET_KEY` | no | Only for `PAYMENT_PROVIDER=omise`. |
| `PAYMENT_QR_MODE` | no | `promptpay` (default; launch). `maemanee` is an optional, **inactive** SCB Mae Manee bill-payment QR mode (`MAEMANEE_SHOP_ID`, `MAEMANEE_SHOP_NAME`, optional `MAEMANEE_CHECKS` / `MAEMANEE_NAME_MIN`). See LAUNCH.md §7. It needs a 1-baht calibration test before use. |

EasySlip IP whitelist: Vercel functions do not have fixed outbound IPs by default, so either leave the EasySlip whitelist open (`*`, rely on the secret key) or use a fixed-IP setup (Vercel static-IP / Secure Compute options are paid add-ons — check the current plan — or a small proxy) and whitelist that. A blocked call shows customers "ระบบตรวจสลิปยังไม่พร้อม" and logs `EasySlip error: IP_NOT_ALLOWED`.

### Local test (no keys, mocked EasySlip/Omise, no OpenAI calls)
```
npm install
node dev/server.mjs 3123 &          # (run with `env -u PROMPTPAY_ID` if the shell has a placeholder PROMPTPAY_ID) static + /api shim + mock EasySlip (and Omise)
node dev/unit.mjs                   # tokens / EasySlip / QR / draw / rate limit / i18n / stub==vera.js shapes (fake OpenAI client)
PLAYWRIGHT=<path to playwright> node dev/e2e.mjs   # 390x844 walk-through, Thai + English + data (ONLY=en / ONLY=data) + screenshots
```
The dev server records events in memory (`GET /__mock/events`; `LOG_QUIET=1` silences the console lines). Tests force the stub reader, unset `OPENAI_API_KEY` and block any request to openai.com. Restart `dev/server.mjs` before each e2e run (in-memory duplicate list + rate limits). `dev/` is excluded from deploys via `.vercelignore`.
