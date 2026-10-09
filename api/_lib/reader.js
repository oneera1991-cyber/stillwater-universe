/*
READER SELECTION — the ONLY place the routes get Vera from.

  real  = api/_lib/vera.js       (Stillwater, copied verbatim from
          /workspace/stillwater/ai-publish branch vera-3card @ d91dfe1,
          with card-meanings.json + card-meanings.en.json)
  stub  = api/_lib/vera.stub.js  (same interface, no AI)

Choice (per call):
  VERA_READER=stub   → stub
  VERA_READER=real   → real
  unset              → real when OPENAI_API_KEY is set; otherwise stub —
                       EXCEPT on Vercel production (VERCEL_ENV=production),
                       which always uses real so a missing key fails loudly
                       (500) instead of serving filler readings.
Tests (dev/server.mjs, dev/unit.mjs) force the stub and unset OPENAI_API_KEY,
so they never call OpenAI.

Draws always come from vera.js (crypto.randomInt) in both modes — exactly
one server-side draw per step, done by the routes, passed in as card / cards3.
*/
import * as real from "./vera.js";
import * as stub from "./vera.stub.js";

export function readerMode() {
  const forced = String(process.env.VERA_READER || "").toLowerCase();
  if (forced === "stub" || forced === "real") return forced;
  if (process.env.OPENAI_API_KEY) return "real";
  return process.env.VERCEL_ENV === "production" ? "real" : "stub";
}
const impl = () => (readerMode() === "real" ? real : stub);

export const { drawOne, drawThree, cardById, normalizeLang, POSITION_KEYS } = real;
export const generateFree = (args) => impl().generateFree(args);
export const generateThree = (args) => impl().generateThree(args);
