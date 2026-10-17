# STILLWATER BaZi Reading Contract v1

## Client input

`POST /api/read` may now include:

```json
{
  "question": "ปี 2026 ควรลาออกจากงานไหม",
  "birthDate": "1991-11-01",
  "birthTime": "22:45",
  "timeZone": "Asia/Bangkok",
  "lang": "th"
}
```

`birthDate` and `birthTime` are optional at the route level for backward compatibility. When both are present, the deterministic BaZi engine runs and its evidence is inserted into the encrypted order context before the order is issued.

## Direct diagnostic endpoint

`POST /api/bazi`

Returns the deterministic chart, target-year analysis, and question-domain mapping without invoking the LLM.

## Important security rule

Birth data is not accepted from `/api/deeper` directly. Paid readings use the encrypted order token produced by `/api/read`. The deterministic BaZi evidence is embedded into that encrypted context, so the paid route receives the same evidence that was generated for the original question.

## LLM boundary

Vera receives a block marked `[STILLWATER BAZI EVIDENCE — deterministic; do not recalculate or invent rules]`. The model may explain and synthesize this evidence. It must not recalculate Four Pillars, invent classical rules, or override locked tarot meanings.

## Current v1 limitations

- Primary timezone support is `Asia/Bangkok` and `UTC`.
- Other IANA zones require `utcOffsetMinutes` in v1.
- Solar-term boundaries use an astronomical approximation and must be certified against a trusted ephemeris for production boundary dates.
- Pattern/useful-factor analysis is intentionally conservative in v1 and is evidence/candidate based, not a claim that every classical school agrees on one rule.
- Da Yun / 大運 is not yet part of v1. It is a separate implementation phase and must not be inferred by the LLM.
