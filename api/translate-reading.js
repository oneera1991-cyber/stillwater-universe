import OpenAI from "openai";

const MODEL = "gpt-5.4-mini";
const MAX_TEXT = 6000;

function normLang(value) {
  const s = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^en([-_].*)?$/.test(s) ? "en" : "th";
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const text = typeof body.text === "string" ? body.text.trim().slice(0, MAX_TEXT) : "";
  const from = normLang(body.from);
  const to = normLang(body.to);

  if (!text) return res.status(400).json({ error: "Reading text is required" });
  if (from === to) return res.status(200).json({ ok: true, text });
  if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: "Translation is not configured" });

  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const sourceName = from === "th" ? "Thai" : "English";
    const targetName = to === "th" ? "Thai" : "English";
    const response = await client.responses.create({
      model: MODEL,
      instructions: `Translate the Stillwater tarot reading from ${sourceName} to ${targetName}. Preserve the meaning, tone, paragraph/line breaks, and card names exactly. Do not interpret, rewrite, shorten, expand, add disclaimers, or add commentary. Return only the translated reading.`,
      input: text,
      max_output_tokens: 1400
    });
    const translated = String(response.output_text || "").trim();
    if (!translated) return res.status(502).json({ error: "Translation returned no text" });
    return res.status(200).json({ ok: true, text: translated });
  } catch (error) {
    console.error("Stillwater translation error:", error?.message || error);
    return res.status(500).json({ error: "Unable to translate the reading" });
  }
}
