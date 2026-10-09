/*
Scene 6 story helpers (shared by index.html and dev/unit.mjs).
Vera tells the paid reading one card at a time; each card gets a spoken
heading (strings full.headings.<position_key>) instead of a position label.
*/
import { t } from "../i18n/strings.js";

export const POSITION_ORDER = ["past", "present", "ahead"];

export function cardKey(card, i) {
  return POSITION_ORDER.includes(card && card.position_key) ? card.position_key : (POSITION_ORDER[i] || "ahead");
}

export function cardHeading(card, i, lang) {
  return t(lang, "full.headings." + cardKey(card, i));
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Reading lines for one card. If a reader still opens with a stiff label
 *  ("อดีต — The Moon", "Past: The Moon, …"), that label is dropped. */
export function storyLines(card, i) {
  const key = cardKey(card, i);
  const labels = [card && card.label, card && card.position, t("th", "positions." + key), t("en", "positions." + key)]
    .filter(Boolean).map(esc);
  const lead = new RegExp("^\\s*(?:" + labels.join("|") + ")\\s*(?:—|–|-|:)\\s*", "i");
  const lines = String((card && card.text) || "").split(/\n+/).map((s) => s.trim()).filter(Boolean);
  if (lines.length && lead.test(lines[0])) {
    lines[0] = lines[0].replace(lead, "").trim();
    if (!lines[0] || lines[0] === card.name) lines.shift();
  }
  return lines;
}
