# Ambient v1 → v2 analysis (Palm, 2026-10-09 18:09: "only 13–20 s is good")

Reference render: v1 `lib/ambient.js` (commit d817dae), `dev/render-ambient.mjs`, 40 s, 48 kHz, seed 7
(deterministic `random`; chime timings re-derived with a mock AudioContext replay of the same code).

## What was sounding

| | 0–13 s | 13–20 s (liked) | 20–40 s |
|---|---|---|---|
| Chord | fade-in (pad 4 s, shimmer 8 s), Dmaj9; crossfade to Bm9 starts at 10 s | **Bm9 only** (F#3 A3 C#4 D4, root F#2); crossfade done at 13.5 s; no change inside the window | Gmaj7 (20 s) → Asus2 (30 s): two audible chord changes |
| Lowpass cutoff (1600 ± 700 Hz, LFO 0.045 Hz) | opening → **~2300 Hz at 5.6 s**, closing by 13 s | **trough: 900–1240 Hz, mean ≈ 1010 Hz** (the darkest, softest part) | opening again → ~2300 Hz at 27.8 s, closing towards 39 s; mean elsewhere ≈ 1780 Hz |
| Shimmer | ramping up 0 → 0.05 over 8 s; A4 C#5 E5 | **full 0.05, A4 C#5 D5**, tremolo 0.23 Hz | full; B4 D5 F#5, then A4 B4 E5 |
| Chimes (onsets) | 2.5 D5, 2.8 D5, 8.3 D5, 12.9 D5 (tail rings into 13–16 s) | **1 pair: 18.6 E5 + 19.0 A5** (plus the D5 tail): sparse | 23.3 E6, 28.4 F#5, 32.3 E5 + 32.7 D6, 37.4 E5, 40.0 B5: includes the high D6/E6 |
| Air noise (band-pass 900 ± 500 Hz, 0.031 Hz) | 900 → 1400 → 1200 Hz | **1190 → 560 Hz (mean ≈ 870)**: low band | 550 → 400 → 1300 Hz |
| Level, RMS | −17.3 dBFS (incl. fade-in) | **−15.8 dBFS** | −16.2 dBFS |
| Level, LUFS | −14.7 | **−13.6** | −14.0 |
| < 200 Hz | −23.0 | **−21.0** | −21.8 |
| 200–1000 Hz | −18.7 | **−17.3** | −17.8 |
| 1–3 kHz | −35.0 | **−38.8** | −31.9 (−25.6 at 32 s) |
| > 3 kHz | −48.0 | **−53.5** | −48.9 |
| Spectral centroid | 315 Hz | **283 Hz** | 362 Hz |

In short, 13–20 s is the one window that is all of these at once: one sustained minor-9 colour with no chord change; the filter closed, so it is warm and dark, with the least 1–3 kHz and > 3 kHz energy; the shimmer fully in; only one soft, low chime pair; and the air noise in a low band. Everything else has at least one of: the fade-in, the brighter Dmaj9 / Gmaj7 / Asus2 colours, audible chord changes, the filter opened to ~2.3 kHz (buzzy saws), or high D6/E6 chimes.

## v2 (lib/ambient.js, `VARIANT`)
- Both variants:
  - hold Bm9 (F#3 A3 C#4 D4, root F#2) and shimmer A4 C#5 D5 at the 13–20 s level;
  - keep the air noise centred at ≈ 870 Hz;
  - use the same reverb / delay / compressor / master;
  - shorten the fade-in to 3–4 s;
  - play no chord changes.
- **A** (default): voicing never moves. Cutoff 1010 ± 110 Hz (LFO 0.03 Hz). Chimes D5 E5 F#5 A5 only, one event every 5–8 s (40 % pairs).
- **B**: voices glide one note at a time between Bm9-mode voicings every 14 s (F#3 A3 C#4 D4 → F#3 A3 B3 D4 → E3 A3 C#4 D4 → …), cutoff 1030 ± 200 Hz (LFO 0.04 Hz), chimes may also use B5, every 4.5–8 s.

| 40 s render (seed 7) | LUFS (whole / from 5 s) | peak | RMS 13–20-style windows | 1–3 kHz | > 3 kHz | centroid mean ± sd (2 s windows, 6–40 s) |
|---|---|---|---|---|---|---|
| v1 13–20 s excerpt | −13.6 | −4.9 dBFS | −15.8 | −38.8 | −53.5 | 283 Hz |
| v1 whole | −14.1 | −4.6 | −16.5 | −34.5 | −51.4 | 335 ± 42 Hz |
| v2 A | −13.8 / −13.6 | −4.3 | −16.0 | −38.3 | −53.4 | 298 ± 19 Hz |
| v2 B | −13.7 / −13.6 | −4.6 | −16.0 | −39.2 | −54.4 | 299 ± 17 Hz |

Re-render: `VARIANT=A node dev/render-ambient.mjs 40 /tmp` (dev server running).
