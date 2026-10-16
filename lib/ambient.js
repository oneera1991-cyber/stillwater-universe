/*
Stillwater sound v2: "music + cosmos" (Palm, 2026-10-09 18:09: keep the whole ambient like 13–20 s of the v1 render).
Synthesized in Web Audio, no audio files.

What 13–20 s of v1 was (analysis in dev/AMBIENT.md): ONE sustained Bm9 voicing (F#3 A3 C#4 D4, root F#2),
no chord change inside the window; the swept lowpass near its closed trough (cutoff ≈ 900–1240 Hz, mean ≈ 1010
vs ≈ 1780 elsewhere); shimmer A4 C#5 D5 at full level with slow tremolo; one soft chime pair (E5 + A5) and the
tail of a D5; "air" noise band low (≈ 560–1190 Hz). v2 holds that state for the whole duration.

VARIANT (single switch):
  "A" — closest to 13–20 s: the same Bm9 voicing held, filter breathing gently around 1010 Hz (±110 Hz, ~33 s),
        chimes only from D5 E5 F#5 A5, one event every ~5–8 s.
  "B" — same colour with a little more movement: single voices glide slowly between Bm9-mode voicings
        (F#3 A3 C#4 D4 → F#3 A3 B3 D4 → E3 A3 C#4 D4 …, one note at a time, ~4 s glides every 14 s; never a
        full chord change), filter ±200 Hz (~25 s), chimes may also use B5.

createSound(ctx, { destination, random, variant }) works on any BaseAudioContext (the page's AudioContext or an
OfflineAudioContext for dev/render-ambient.mjs).

Graph: pad (4 voices × saw+triangle, detuned) → lowpass (slow LFO) ┐
       root sine (F#2), shimmer (3 octave-up sines, tremolo),      ├→ bus → highpass 120 Hz → master (0 … LEVEL)
       sparse pentatonic bells, band-passed "air" noise           ┘          → compressor → makeup → destination
       sends: generated 5 s stereo convolution reverb, stereo ping-pong delay (shimmer + bells).
Sources: 8 pad + 1 root + 3 shimmer + 1 noise + 3 LFOs = 16 persistent (reused), + 2 per bell.
*/

export const VARIANT = "A"; // "A" | "B" — Palm picks
export const LEVEL = 0.6;   // master target when SOUND ON

const N = { E3: 164.81, Fs2: 92.5, Fs3: 185.0, A3: 220.0, B3: 246.94, Cs4: 277.18, D4: 293.66, A4: 440.0, Cs5: 554.37, D5: 587.33, E5: 659.25, Fs5: 739.99, A5: 880.0, B5: 987.77 };
export const PRESETS = {
  A: { voicings: [[N.Fs3, N.A3, N.Cs4, N.D4]], cutoff: 1010, cutoffDepth: 110, cutoffHz: 0.03,
       airHz: 0.022, airCenter: 870, airDepth: 150, bells: [N.D5, N.E5, N.Fs5, N.A5], bellGap: [5, 3], voiceEvery: 0 },
  B: { voicings: [[N.Fs3, N.A3, N.Cs4, N.D4], [N.Fs3, N.A3, N.B3, N.D4], [N.E3, N.A3, N.Cs4, N.D4], [N.Fs3, N.A3, N.Cs4, N.D4]],
       cutoff: 1030, cutoffDepth: 200, cutoffHz: 0.04, airHz: 0.03, airCenter: 870, airDepth: 260,
       bells: [N.D5, N.E5, N.Fs5, N.A5, N.B5], bellGap: [4.5, 3.5], voiceEvery: 14 }
};
// shimmer = octave above pad voices 2–4 (A4 C#5 D5 for the Bm9 voicing)
const shimmerOf = (v) => [v[1] * 2, v[2] * 2, v[3] * 2];

export function createSound(ctx, { destination = ctx.destination, random = Math.random, variant = VARIANT } = {}) {
  const P = PRESETS[variant] || PRESETS.A;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -22; comp.knee.value = 12; comp.ratio.value = 3; comp.attack.value = 0.012; comp.release.value = 0.35;
  const master = ctx.createGain(); master.gain.value = 0;
  const makeup = ctx.createGain(); makeup.gain.value = 1.25; master.connect(comp); comp.connect(makeup); makeup.connect(destination);
  const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 120; hp.Q.value = 0.5; hp.connect(master);
  const bus = ctx.createGain(); bus.gain.value = 1; bus.connect(hp);

  // reverb: generated stereo impulse (decaying noise, ~5 s)
  const verb = ctx.createConvolver();
  { const sec = 5, len = Math.floor(ctx.sampleRate * sec), ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); for (let i = 0; i < len; i++) { const t = i / ctx.sampleRate; d[i] = (random() * 2 - 1) * Math.pow(1 - t / sec, 2.2) * Math.exp(-t * 0.9); } }
    verb.buffer = ir; }
  const verbIn = ctx.createGain(); verbIn.gain.value = 0.55; verbIn.connect(verb);
  const verbOut = ctx.createGain(); verbOut.gain.value = 0.9; verb.connect(verbOut); verbOut.connect(bus);

  // stereo ping-pong delay
  const dIn = ctx.createGain(); dIn.gain.value = 0.32;
  const dL = ctx.createDelay(2), dR = ctx.createDelay(2); dL.delayTime.value = 0.42; dR.delayTime.value = 0.63;
  const fb = ctx.createGain(); fb.gain.value = 0.38;
  const dTone = ctx.createBiquadFilter(); dTone.type = "lowpass"; dTone.frequency.value = 2600;
  const merge = ctx.createChannelMerger(2);
  dIn.connect(dL); dL.connect(dR); dR.connect(dTone); dTone.connect(fb); fb.connect(dL);
  dL.connect(merge, 0, 0); dR.connect(merge, 0, 1);
  const dOut = ctx.createGain(); dOut.gain.value = 0.7; merge.connect(dOut); dOut.connect(bus); dOut.connect(verbIn);

  function route(node, { verbSend = 0.5, delaySend = 0 } = {}) {
    node.connect(bus);
    if (verbSend) { const s = ctx.createGain(); s.gain.value = verbSend; node.connect(s); s.connect(verbIn); }
    if (delaySend) { const s = ctx.createGain(); s.gain.value = delaySend; node.connect(s); s.connect(dIn); }
  }
  const chimeOut = ctx.createGain(); chimeOut.gain.value = 1; route(chimeOut, { verbSend: 0.8, delaySend: 0.6 });

  let running = null;

  function bell(freq, at, vol = 0.12, dur = 3.2) {
    const g = ctx.createGain(); g.gain.value = 0; g.connect(chimeOut);
    const o1 = ctx.createOscillator(), o2 = ctx.createOscillator(), g2 = ctx.createGain();
    o1.type = "sine"; o1.frequency.value = freq; o2.type = "sine"; o2.frequency.value = freq * 2.76; g2.gain.value = 0.18;
    o1.connect(g); o2.connect(g2); g2.connect(g);
    g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(vol, at + 0.008);
    g.gain.exponentialRampToValueAtTime(vol * 0.35, at + 0.35); g.gain.exponentialRampToValueAtTime(0.0008, at + dur);
    g2.gain.setValueAtTime(0.18, at); g2.gain.exponentialRampToValueAtTime(0.001, at + dur * 0.4);
    o1.start(at); o2.start(at); o1.stop(at + dur + 0.05); o2.stop(at + dur + 0.05);
  }

  function start(at = ctx.currentTime) {
    if (running) return;
    const sources = [];
    const osc = (type, f, det = 0) => { const o = ctx.createOscillator(); o.type = type; o.frequency.value = f; o.detune.value = det; o.start(at); sources.push(o); return o; };
    const v0 = P.voicings[0];

    // pad: one held voicing; lowpass breathing around the 13–20 s cutoff
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = P.cutoff; lp.Q.value = 0.9;
    const lfo = osc("sine", P.cutoffHz), lfoAmt = ctx.createGain(); lfoAmt.gain.value = P.cutoffDepth; lfo.connect(lfoAmt); lfoAmt.connect(lp.frequency);
    const padOut = ctx.createGain(); padOut.gain.value = 0; lp.connect(padOut); route(padOut, { verbSend: 0.45 });
    padOut.gain.setValueAtTime(0, at); padOut.gain.linearRampToValueAtTime(1, at + 3);
    const voices = v0.map((f, i) => {
      const a = osc("sawtooth", f, -7 + i), b = osc("triangle", f, 6 - i);
      const va = ctx.createGain(); va.gain.value = 0.038; const vb = ctx.createGain(); vb.gain.value = 0.070;
      a.connect(va); b.connect(vb); va.connect(lp); vb.connect(lp);
      return [a, b];
    });
    const root = osc("sine", N.Fs2), rootG = ctx.createGain(); rootG.gain.value = 0; root.connect(rootG); rootG.connect(bus);
    rootG.gain.setValueAtTime(0, at); rootG.gain.linearRampToValueAtTime(0.06, at + 4);

    // shimmer: octave-up sines, slow tremolo (full level as in 13–20 s; reached in 4 s)
    const shim = ctx.createGain(); shim.gain.value = 0; route(shim, { verbSend: 0.9, delaySend: 0.35 });
    shim.gain.setValueAtTime(0, at); shim.gain.linearRampToValueAtTime(0.05, at + 4);
    const trem = osc("sine", 0.23), tremAmt = ctx.createGain(); tremAmt.gain.value = 0.022; trem.connect(tremAmt); tremAmt.connect(shim.gain);
    const shimmer = shimmerOf(v0).map((f, i) => { const o = osc(i === 1 ? "triangle" : "sine", f, i * 4 - 4); const g = ctx.createGain(); g.gain.value = i === 1 ? 0.5 : 0.8; o.connect(g); g.connect(shim); return o; });

    // cosmic air: band-passed noise, low band as in 13–20 s
    const nb = ctx.createBuffer(1, ctx.sampleRate * 4, ctx.sampleRate); { const d = nb.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = random() * 2 - 1; }
    const noise = ctx.createBufferSource(); noise.buffer = nb; noise.loop = true; noise.start(at); sources.push(noise);
    const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = P.airCenter; bp.Q.value = 0.8;
    const sweep = osc("sine", P.airHz), sweepAmt = ctx.createGain(); sweepAmt.gain.value = P.airDepth; sweep.connect(sweepAmt); sweepAmt.connect(bp.frequency);
    const air = ctx.createGain(); air.gain.value = 0; noise.connect(bp); bp.connect(air); route(air, { verbSend: 0.6 });
    air.gain.setValueAtTime(0, at); air.gain.linearRampToValueAtTime(0.022, at + 4);

    running = { sources, voices, shimmer, outs: [padOut, rootG, shim, air], vIdx: 0, nextVoicing: at + (P.voiceEvery || Infinity), nextChime: at + 3 + random() * 2, timer: 0 };
    schedule(at + 6);
  }

  /** variant B: glide only the voices that differ to the next voicing (one note at a time, ~4 s glide). */
  function moveVoicing(t) {
    const r = running, from = P.voicings[r.vIdx % P.voicings.length]; r.vIdx++;
    const to = P.voicings[r.vIdx % P.voicings.length];
    to.forEach((f, i) => { if (f !== from[i]) { r.voices[i].forEach((o) => o.frequency.setTargetAtTime(f, t, 1.3)); } });
    const sh = shimmerOf(to); r.shimmer.forEach((o, i) => { if (sh[i] !== shimmerOf(from)[i]) o.frequency.setTargetAtTime(sh[i], t + 0.5, 1.6); });
  }

  /** schedule voicing glides (B) + chimes up to `until` (seconds, context time). */
  function schedule(until) {
    const r = running; if (!r) return;
    while (r.nextVoicing < until) { moveVoicing(r.nextVoicing); r.nextVoicing += P.voiceEvery; }
    while (r.nextChime < until) {
      const n = random() < 0.4 ? 2 : 1;
      for (let k = 0; k < n; k++) bell(P.bells[Math.floor(random() * P.bells.length)], r.nextChime + k * (0.3 + random() * 0.2), 0.07 + random() * 0.04, 3 + random() * 1.5);
      r.nextChime += P.bellGap[0] + random() * P.bellGap[1];
    }
  }

  return {
    master, compressor: comp, LEVEL, variant: P === PRESETS.B ? "B" : "A",
    get playing() { return !!running; },
    get voices() { return running ? running.sources.length : 0; },
    start(at) { start(at); if (typeof setInterval === "function" && !(ctx instanceof (globalThis.OfflineAudioContext || function () {}))) running.timer = setInterval(() => schedule(ctx.currentTime + 6), 1500); },
    schedule,
    /** fade the ambient out over `fade` s and stop every source. */
    stop(fade = 0.25) {
      const r = running; if (!r) return; running = null;
      clearInterval(r.timer);
      const t = ctx.currentTime;
      r.outs.forEach((g) => { g.gain.cancelScheduledValues(t); g.gain.setValueAtTime(g.gain.value, t); g.gain.linearRampToValueAtTime(0, t + fade); });
      r.sources.forEach((s) => { try { s.stop(t + fade + 0.05); } catch (e) {} });
    },
    /** soft chime phrase for buttons: indices into the B-minor / D-major pentatonic (D5 E5 F#5 A5 B5 D6 E6). */
    chime(steps, { vol = 0.11, gap = 0.11, dur = 2.4, at = ctx.currentTime } = {}) {
      const S = [587.33, 659.25, 739.99, 880.0, 987.77, 1174.66, 1318.51];
      steps.forEach((s, i) => bell(S[Math.max(0, Math.min(S.length - 1, s))], at + i * gap, vol * (i ? 0.8 : 1), dur));
    },
    bell
  };
}
