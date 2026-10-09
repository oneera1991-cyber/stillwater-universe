/*
Stillwater sound: "music + cosmos" (Palm, 2026-10-09). Synthesized in Web Audio, no audio files.

createSound(ctx, { destination, random }) works on any BaseAudioContext (the page's AudioContext,
or an OfflineAudioContext for the preview render in dev/render-ambient.mjs).

Graph:
  pad (2 crossfading layers × 4 notes × saw+triangle, detuned) → lowpass (slow LFO sweep) ┐
  shimmer (3 octave-up sines, slow tremolo)                                                ├→ bus
  chimes (pentatonic bells, sparse random) + button chimes                                 │   │
  cosmic air (band-passed noise, slow sweep)                                               ┘   │
  sends: bus-level reverb (ConvolverNode, generated 5 s stereo decaying-noise impulse)         │
         + stereo ping-pong delay (shimmer + chimes)                                           ↓
  bus → highpass 120 Hz → master (0 … level) → DynamicsCompressor → destination
Energy sits in ~150 Hz–3 kHz so phone speakers carry it. Voices: 16 pad + 3 shimmer + 1 noise
oscillators/sources, all reused across chords (frequencies glide while a layer is silent);
chimes add 2 short-lived oscillators each. stop() stops every source; start() rebuilds them.
*/

const PROGRESSION = [ // Hz, mid register (4 notes per chord)
  [146.83, 220.00, 277.18, 329.63], // Dmaj9   D3 A3 C#4 E4
  [185.00, 220.00, 277.18, 293.66], // Bm9/F#  F#3 A3 C#4 D4
  [196.00, 246.94, 293.66, 369.99], // Gmaj7   G3 B3 D4 F#4
  [164.81, 220.00, 246.94, 329.63]  // Asus2/E E3 A3 B3 E4
];
const PENTA = [587.33, 659.25, 739.99, 880.00, 987.77, 1174.66, 1318.51]; // D major pentatonic
export const CHORD_SECONDS = 10;
const XFADE = 3.5;
export const LEVEL = 0.6; // master target when SOUND ON

export function createSound(ctx, { destination = ctx.destination, random = Math.random } = {}) {
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

  // dry + send helper
  function route(node, { verbSend = 0.5, delaySend = 0 } = {}) {
    node.connect(bus);
    if (verbSend) { const s = ctx.createGain(); s.gain.value = verbSend; node.connect(s); s.connect(verbIn); }
    if (delaySend) { const s = ctx.createGain(); s.gain.value = delaySend; node.connect(s); s.connect(dIn); }
  }
  const chimeOut = ctx.createGain(); chimeOut.gain.value = 1; route(chimeOut, { verbSend: 0.8, delaySend: 0.6 });

  let running = null; // { sources, timer, nextChord, nextChime, chordIdx, layer }

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

    // pad: lowpass with LFO-swept cutoff
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 1600; lp.Q.value = 0.9;
    const lfo = osc("sine", 0.045), lfoAmt = ctx.createGain(); lfoAmt.gain.value = 700; lfo.connect(lfoAmt); lfoAmt.connect(lp.frequency);
    const padOut = ctx.createGain(); padOut.gain.value = 0; lp.connect(padOut); route(padOut, { verbSend: 0.45 });
    padOut.gain.setValueAtTime(0, at); padOut.gain.linearRampToValueAtTime(1, at + 4);
    const layers = [0, 1].map(() => {
      const g = ctx.createGain(); g.gain.value = 0; g.connect(lp);
      const voices = [0, 1, 2, 3].map((i) => {
        const a = osc("sawtooth", 220, -7 + i), b = osc("triangle", 220, 6 - i);
        const va = ctx.createGain(); va.gain.value = 0.038; const vb = ctx.createGain(); vb.gain.value = 0.070;
        a.connect(va); b.connect(vb); va.connect(g); vb.connect(g);
        return [a, b];
      });
      return { g, voices };
    });
    // warm root (sine, one octave below the chord root; phones mostly hear its 2nd harmonic via the pad)
    const root = osc("sine", 73.4), rootG = ctx.createGain(); rootG.gain.value = 0; root.connect(rootG); rootG.connect(bus);
    rootG.gain.setValueAtTime(0, at); rootG.gain.linearRampToValueAtTime(0.06, at + 5);

    // shimmer: octave-up sines with slow tremolo
    const shim = ctx.createGain(); shim.gain.value = 0; route(shim, { verbSend: 0.9, delaySend: 0.35 });
    shim.gain.setValueAtTime(0, at); shim.gain.linearRampToValueAtTime(0.05, at + 8);
    const trem = osc("sine", 0.23), tremAmt = ctx.createGain(); tremAmt.gain.value = 0.022; trem.connect(tremAmt); tremAmt.connect(shim.gain);
    const shimmer = [0, 1, 2].map((i) => { const o = osc(i === 1 ? "triangle" : "sine", 880, i * 4 - 4); const g = ctx.createGain(); g.gain.value = i === 1 ? 0.5 : 0.8; o.connect(g); g.connect(shim); return o; });

    // cosmic air: band-passed noise with a slow sweep
    const nb = ctx.createBuffer(1, ctx.sampleRate * 4, ctx.sampleRate); { const d = nb.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = random() * 2 - 1; }
    const noise = ctx.createBufferSource(); noise.buffer = nb; noise.loop = true; noise.start(at); sources.push(noise);
    const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 900; bp.Q.value = 0.8;
    const sweep = osc("sine", 0.031), sweepAmt = ctx.createGain(); sweepAmt.gain.value = 500; sweep.connect(sweepAmt); sweepAmt.connect(bp.frequency);
    const air = ctx.createGain(); air.gain.value = 0; noise.connect(bp); bp.connect(air); route(air, { verbSend: 0.6 });
    air.gain.setValueAtTime(0, at); air.gain.linearRampToValueAtTime(0.022, at + 6);

    running = { sources, layers, root, shimmer, outs: [padOut, rootG, shim, air], chordIdx: 0, layer: 0, nextChord: at, nextChime: at + 2.5, timer: 0 };
    schedule(at + 6);
  }

  function setChord(t, idx, layerIdx, first) {
    const r = running, notes = PROGRESSION[idx % PROGRESSION.length];
    const L = r.layers[layerIdx], other = r.layers[1 - layerIdx];
    // the incoming layer is silent now → retune its oscillators, then fade it in
    L.voices.forEach(([a, b], i) => { a.frequency.setValueAtTime(notes[i], t); b.frequency.setValueAtTime(notes[i], t); });
    L.g.gain.cancelScheduledValues(t); L.g.gain.setValueAtTime(0, t); L.g.gain.linearRampToValueAtTime(1, t + (first ? 2 : XFADE));
    if (!first) { other.g.gain.cancelScheduledValues(t); other.g.gain.setValueAtTime(1, t); other.g.gain.linearRampToValueAtTime(0, t + XFADE); }
    r.root.frequency.setTargetAtTime(notes[0] / 2, t, 1.2);
    r.shimmer.forEach((o, i) => o.frequency.setTargetAtTime(notes[[1, 2, 3][i]] * 2, t, 1.5));
  }

  /** schedule chord changes + chimes up to `until` (seconds, context time). */
  function schedule(until) {
    const r = running; if (!r) return;
    while (r.nextChord < until) {
      setChord(r.nextChord, r.chordIdx, r.layer, r.chordIdx === 0);
      r.chordIdx++; r.layer = 1 - r.layer; r.nextChord += CHORD_SECONDS;
    }
    while (r.nextChime < until) {
      const n = random() < 0.35 ? 2 : 1;
      for (let k = 0; k < n; k++) bell(PENTA[Math.floor(random() * PENTA.length)], r.nextChime + k * (0.18 + random() * 0.25), 0.07 + random() * 0.05, 2.8 + random() * 1.5);
      r.nextChime += 2.5 + random() * 4.5;
    }
  }

  return {
    master, compressor: comp, LEVEL,
    get playing() { return !!running; },
    get voices() { return running ? running.sources.length : 0; },
    start(at) { start(at); if (typeof setInterval === "function" && !(ctx instanceof (globalThis.OfflineAudioContext || function () {}))) running.timer = setInterval(() => schedule(ctx.currentTime + 6), 1500); },
    schedule,
    /** fade the ambient layers out over `fade` s and stop every source. */
    stop(fade = 0.25) {
      const r = running; if (!r) return; running = null;
      clearInterval(r.timer);
      const t = ctx.currentTime;
      r.outs.forEach((g) => { g.gain.cancelScheduledValues(t); g.gain.setValueAtTime(g.gain.value, t); g.gain.linearRampToValueAtTime(0, t + fade); });
      r.sources.forEach((s) => { try { s.stop(t + fade + 0.05); } catch (e) {} });
    },
    /** soft chime phrase for buttons: notes = semitone steps from D5 pentatonic index. */
    chime(steps, { vol = 0.11, gap = 0.11, dur = 2.4, at = ctx.currentTime } = {}) {
      steps.forEach((s, i) => bell(PENTA[Math.max(0, Math.min(PENTA.length - 1, s))], at + i * gap, vol * (i ? 0.8 : 1), dur));
    },
    bell
  };
}
