/* Offline render of the ambient (new = lib/ambient.js, old = the previous inline ambient) for listening + loudness.
   node dev/server.mjs 3123 &  then  PLAYWRIGHT=… node dev/render-ambient.mjs [seconds] [outdir]
   Writes ambient-new.wav / ambient-old.wav (48 kHz stereo float → 16-bit). */
import { writeFile } from "node:fs/promises";
const { chromium } = await import(process.env.PLAYWRIGHT || "playwright");
const BASE = process.env.BASE || "http://localhost:3123";
const SECONDS = Number(process.argv[2] || 40), OUT = process.argv[3] || "/tmp";
const browser = await chromium.launch(); const page = await browser.newPage();
await page.goto(BASE + "/terms");
const res = await page.evaluate(async (S) => {
  const SR = 48000;
  const enc = (buf) => { const L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L; const i16 = new Int16Array(L.length * 2); let peak = 0;
    for (let i = 0; i < L.length; i++) { peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i])); i16[2 * i] = Math.max(-1, Math.min(1, L[i])) * 32767; i16[2 * i + 1] = Math.max(-1, Math.min(1, R[i])) * 32767; }
    let s = ""; const u8 = new Uint8Array(i16.buffer); for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return { b64: btoa(s), peak }; };
  // new
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const { createSound } = await import("/lib/ambient.js");
  const c1 = new OfflineAudioContext(2, SR * S, SR); const snd = createSound(c1, { random: rnd });
  snd.master.gain.setValueAtTime(0, 0); snd.master.gain.linearRampToValueAtTime(snd.LEVEL, 0.7);
  snd.start(0); snd.schedule(S);
  const nb = await c1.startRendering();
  // old (verbatim logic of the previous index.html ambient: master .2, sines 48/72/96 Hz + lowpassed noise .022)
  const c2 = new OfflineAudioContext(2, SR * S, SR); const m = c2.createGain(); m.gain.setValueAtTime(0, 0); m.gain.linearRampToValueAtTime(.2, .7); m.connect(c2.destination);
  [[48,.22],[72,.08],[96,.045]].forEach(([f,v]) => { const o = c2.createOscillator(), g = c2.createGain(); o.frequency.value = f; g.gain.setValueAtTime(0, 0); g.gain.linearRampToValueAtTime(v, 3); o.connect(g); g.connect(m); o.start(0); });
  const len = SR * 4, b = c2.createBuffer(1, len, SR), d = b.getChannelData(0); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * .45;
  const w = c2.createBufferSource(), wf = c2.createBiquadFilter(), wg = c2.createGain(); w.buffer = b; w.loop = true; wf.type = "lowpass"; wf.frequency.value = 260;
  wg.gain.setValueAtTime(0, 0); wg.gain.linearRampToValueAtTime(.022, 3); w.connect(wf); wf.connect(wg); wg.connect(m); w.start(0);
  const ob = await c2.startRendering();
  return { neu: enc(nb), old: enc(ob) };
}, SECONDS);
const wav = (b64) => { const pcm = Buffer.from(b64, "base64"); const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVEfmt ", 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22);
  h.writeUInt32LE(48000, 24); h.writeUInt32LE(48000 * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(pcm.length, 40); return Buffer.concat([h, pcm]); };
await writeFile(`${OUT}/ambient-new.wav`, wav(res.neu.b64)); await writeFile(`${OUT}/ambient-old.wav`, wav(res.old.b64));
console.log(JSON.stringify({ peak_new: res.neu.peak, peak_old: res.old.peak }));
await browser.close();
