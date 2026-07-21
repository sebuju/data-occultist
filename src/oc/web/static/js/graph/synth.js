// Web Audio synth for GENERATED sound cues (the sound node's "forge"). A cue is a tiny param set
// (wave + a pitch-over-time envelope + amp/timbre/arrangement knobs), NOT a file — so instead of an
// <audio> element (see sound.js) we synthesise it here.
//
// Rendered ONCE per spec into an AudioBuffer and cached; every later play reuses the buffer. Volume
// is a playback-time gain, never baked in, so changing a node's volume reuses the same render;
// editing the cue changes the spec key, so the next play renders fresh exactly once.
//
// Two play modes via `{loop}`: the open forge's PLAY loops (tweak while it repeats), while a real
// FIRE (trigger heartbeat) and the test button play one-shot. playSynth returns a controller with
// stop() so the forge can toggle/restart the loop.
import { SYNTH_DEFAULTS } from "../defaults.js";

let _ctx = null;
function ctx() {
    _ctx = _ctx || new (window.AudioContext || window.webkitAudioContext)();
    if (_ctx.state === "suspended") _ctx.resume();
    return _ctx;
}

// Every knob read goes through here: a cue saved before a knob existed omits it, and the neutral
// value lives in ONE table (defaults.js, mirroring SynthDef) — never a `?? 0` at the read site.
const K = (s, k) => s[k] ?? SYNTH_DEFAULTS[k];
const KNOB_KEYS = Object.keys(SYNTH_DEFAULTS).filter((k) => k !== "wave");

// 0..1 pitch -> frequency. 0 = C3, 1 = three octaves up (36 semitones), quantised to semitones so
// hand-drawn envelopes land on notes (matches the forge's note readout), then shifted by the cue's
// `transpose` (semitones).
const SEMIS = (p, semis) => Math.round(p * 36) + semis;
const pToFreq = (p, semis = 0) => 130.81 * Math.pow(2, SEMIS(p, semis) / 12);
const NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
// The note a plot point sounds AS, transpose included — the ONE pitch->name mapping (the forge's
// labels import this rather than keeping their own copy, so a label can never disagree with the audio).
export function noteName(p, semis = 0) {
    const s = SEMIS(p, semis);
    return NOTES[((s % 12) + 12) % 12] + (3 + Math.floor(s / 12));
}

// a stable string key for the cache — same spec (ignoring volume) => same key => same render.
function specKey(s) {
    const pts = (s.points || []).map((p) => `${(+p.t).toFixed(3)},${(+p.p).toFixed(3)}`).join(";");
    // every knob, read through K so an omitted one keys the same as its explicit default
    return `${K(s, "wave") || "square"}|${KNOB_KEYS.map((k) => K(s, k)).join("|")}|${pts}`;
}

// How long the cue rings ON past `length_ms`: the release fade plus the echo's repeats. Both the
// render length and the oscillator stop times derive from this ONE helper so a tail can't be cut off.
const relTail = (s) => K(s, "release") / 100 * 0.9;                        // 0..0.9 s of extra fade
const echoTail = (s) => (K(s, "echo") > 0
    ? Math.min(2.0, K(s, "echo_ms") / 1000 * (3 + K(s, "echo") / 25)) : 0);
const cueTail = (s) => relTail(s) + echoTail(s);

// one channel of white noise, long enough for the whole cue (percussive/hiss layer)
function noiseBuf(c, seconds) {
    const n = Math.max(1, Math.ceil(c.sampleRate * seconds));
    const b = c.createBuffer(1, n, c.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return b;
}

// Build the oscillator graph for a cue into any context (offline for render, so the live timbre
// matches the cached buffer exactly). Starts/stops its own nodes; connects the tail to `dest`.
//
// Signal path: [osc + sub + noise] -> crush -> lowpass -> amp envelope -> echo -> dest.
function buildGraph(c, s, dest) {
    const pts = s.points || [];
    if (!pts.length) return;
    const dur = s.length_ms / 1000;
    const reps = Math.max(1, Math.min(8, K(s, "repeat") | 0));
    const period = dur / reps;              // `repeat` retriggers the WHOLE envelope inside length_ms
    const semis = K(s, "transpose");
    const glide = K(s, "glide") / 100;
    const rel = relTail(s), stopAt = dur + rel + 0.02;

    // Pitch automation for one frequency param, scaled by `mult` (the sub-oscillator rides at 0.5).
    // `glide` is the FRACTION of each segment spent ramping: 0 holds the old pitch and jumps at the
    // point (stepped/chiptune arp), 1 ramps across the whole segment (the original slide).
    const automate = (param, mult) => {
        param.setValueAtTime(pToFreq(pts[0].p, semis) * mult, 0);
        for (let r = 0; r < reps; r++) {
            const t0 = r * period;
            param.setValueAtTime(pToFreq(pts[0].p, semis) * mult, t0 + pts[0].t * period);
            for (let i = 1; i < pts.length; i++) {
                const a = pts[i - 1], b = pts[i];
                const ta = t0 + a.t * period, tb = t0 + b.t * period;
                const f = pToFreq(b.p, semis) * mult;
                if (glide <= 0) { param.setValueAtTime(f, tb); continue; }
                const rampFrom = tb - (tb - ta) * glide;
                if (rampFrom > ta) param.setValueAtTime(pToFreq(a.p, semis) * mult, rampFrom);
                param.linearRampToValueAtTime(f, Math.max(tb, rampFrom + 0.001));
            }
        }
    };

    // Headroom: the extra layers SUM into the mix and a resonant filter peaks well above unity, so
    // without compensation a cue with sub+noise+resonance renders past ±1.0 and clips (measured at
    // 1.75). Normalise by the layer weights, and pay back the filter's resonance boost — the knobs
    // then colour the cue instead of just making it louder and dirtier.
    const subG = K(s, "sub") / 100 * 0.8, noiseG = K(s, "noise") / 100 * 0.5;
    const makeup = 1 / ((1 + subG + noiseG) * (1 + (K(s, "cutoff") < 100 ? K(s, "reso") / 100 * 1.2 : 0)));

    const mix = c.createGain();
    const osc = c.createOscillator();
    osc.type = s.wave || "square";
    automate(osc.frequency, 1);
    osc.connect(mix); osc.start(0); osc.stop(stopAt);
    const oscs = [osc];
    if (K(s, "sub") > 0) {          // an octave-down twin for weight/body
        const so = c.createOscillator(), sg = c.createGain();
        so.type = s.wave || "square";
        automate(so.frequency, 0.5);
        sg.gain.value = subG;
        so.connect(sg).connect(mix); so.start(0); so.stop(stopAt);
        oscs.push(so);
    }
    if (K(s, "vibrato") > 0) {
        const lfo = c.createOscillator(), lg = c.createGain();
        lfo.frequency.value = 5 + K(s, "vibrato") * 0.12; lg.gain.value = K(s, "vibrato") * 0.9;
        lfo.connect(lg);
        for (const o of oscs) lg.connect(o.frequency);   // the sub wobbles with the main osc
        lfo.start(0); lfo.stop(stopAt);
    }
    if (K(s, "noise") > 0) {        // white noise through the same envelope: air, hiss, percussion
        const ns = c.createBufferSource(), ng = c.createGain();
        ns.buffer = noiseBuf(c, stopAt);
        ng.gain.value = noiseG;
        ns.connect(ng).connect(mix); ns.start(0); ns.stop(stopAt);
    }

    let tail = mix;
    if (K(s, "crush") > 0) {   // stepped waveshaper = bit-crush grit
        const ws = c.createWaveShaper(), steps = Math.max(2, 34 - ((K(s, "crush") / 3) | 0));
        const curve = new Float32Array(1024);
        for (let i = 0; i < 1024; i++) { const x = i / 1023 * 2 - 1; curve[i] = Math.round(x * steps) / steps; }
        ws.curve = curve; tail.connect(ws); tail = ws;
    }
    if (K(s, "cutoff") < 100) {   // 100 = bypass the filter node entirely (pre-filter timbre)
        const flt = c.createBiquadFilter();
        flt.type = "lowpass";
        flt.frequency.value = 200 * Math.pow(90, K(s, "cutoff") / 100);   // 200 Hz .. 18 kHz, by ear
        flt.Q.value = 0.7 + K(s, "reso") / 100 * 17.3;
        tail.connect(flt); tail = flt;
    }

    // amp envelope, retriggered once per repeat; the LAST repeat's fall is stretched by `release`
    const g = c.createGain();
    const atk = Math.max(0.002, K(s, "attack") / 1000 * 4);
    const dec = Math.max(0.03, K(s, "decay") / 100 * period);
    const top = 0.9 * makeup;
    g.gain.setValueAtTime(0, 0);
    for (let r = 0; r < reps; r++) {
        const t0 = r * period;
        if (r) g.gain.setValueAtTime(0.0008, t0);   // re-strike from (near) silence
        g.gain.linearRampToValueAtTime(top, t0 + Math.min(atk, period * 0.5));
        const fall = Math.max(atk + 0.03, Math.min(period, dec)) + (r === reps - 1 ? rel : 0);
        g.gain.exponentialRampToValueAtTime(0.0008, t0 + fall);
    }
    tail.connect(g);

    if (K(s, "echo") > 0) {   // feedback delay, post-amp so the repeats decay on their own
        const dl = c.createDelay(1.0), fb = c.createGain(), wet = c.createGain();
        dl.delayTime.value = K(s, "echo_ms") / 1000;
        fb.gain.value = Math.min(0.72, K(s, "echo") / 100 * 0.72);
        wet.gain.value = Math.min(0.8, K(s, "echo") / 100 * 0.9);
        g.connect(dl); dl.connect(fb).connect(dl); dl.connect(wet).connect(dest);
    }
    g.connect(dest);
}

const _cache = new Map();   // specKey -> AudioBuffer
async function renderCue(s) {
    const key = specKey(s);
    let buf = _cache.get(key);
    if (buf) return buf;
    const sr = 44100, dur = s.length_ms / 1000 + cueTail(s) + 0.06;
    const oac = new OfflineAudioContext(1, Math.max(1, Math.ceil(sr * dur)), sr);
    buildGraph(oac, s, oac.destination);
    buf = await oac.startRendering();
    _cache.set(key, buf);
    return buf;
}

// Play a generated cue. Returns a controller { stop(), ctx, startedAt, duration } — the timing
// fields let a caller (the forge playhead) map ctx.currentTime onto the loop for a sweep line.
// `loop` repeats it (forge preview); one-shot otherwise. Best-effort: no points / no Web Audio /
// blocked autoplay just no-ops (a null-timing controller so callers guard cleanly).
// Meter position (0..1) -> linear gain. Perceived loudness is ~logarithmic, so mapping a linear
// meter straight onto linear gain crams all the useful control into the top of the bar. Send it
// through a 40 dB exponential curve instead — pos 0 = silent, 0.5 ≈ -20 dB, 1 = unity — so dragging
// the bar gives even loudness control across its whole range. The one funnel for every play site.
export function volGain(pos) {
    const p = Math.max(0, Math.min(1, pos));
    return p <= 0 ? 0 : Math.pow(10, 2 * (p - 1));
}

// The shared AudioContext, for a caller that needs to SCHEDULE against it (playing several cues at
// one common start time). Null if Web Audio is unavailable — callers fall back to "start now".
export function audioCtx() { try { return ctx(); } catch { return null; } }

// Render a cue into the buffer cache WITHOUT playing it. Playing several cues together has to warm
// every buffer first: an uncached spec renders offline (milliseconds), so a cold cue would start
// late and the batch would sound staggered instead of simultaneous. Best-effort -> null.
export async function prepareCue(spec) {
    if (!spec || !(spec.points || []).length) return null;
    try { return await renderCue(spec); } catch { return null; }
}

// `at` schedules the start at an absolute AudioContext time (0 = now) so a batch of cues can be
// sample-aligned; without it each cue starts whenever its own await happens to resolve.
export async function playSynth(spec, volume = 1, { loop = false, at = 0 } = {}) {
    const noop = { stop() {}, ctx: null, startedAt: null, duration: 0 };
    if (!spec || !(spec.points || []).length) return noop;
    try {
        const buf = await renderCue(spec);
        const c = ctx();
        const src = c.createBufferSource(), g = c.createGain();
        src.buffer = buf; g.gain.value = volGain(volume);
        // Loop on the CUE's own length, not the buffer's: the buffer carries the release/echo tail
        // (up to ~3 s), which would sit in the preview as a long silent gap and drift the forge's
        // playhead sweep off the plot. The tail is simply cut when the loop wraps; a one-shot fire
        // plays the whole buffer.
        const period = Math.min(buf.duration, spec.length_ms / 1000);
        if (loop) { src.loop = true; src.loopStart = 0; src.loopEnd = period; }
        src.connect(g).connect(c.destination);
        // a scheduled time already in the past would throw; clamp to "now"
        const t0 = at && at > c.currentTime ? at : 0;
        src.start(t0);
        // setVolume adjusts the live gain WITHOUT restarting — a looping preview's volume tracks the
        // node's meter in real time (the buffer bakes in no volume, so this is the only gain stage).
        return {
            stop() { try { src.stop(); } catch { /* already stopped */ } },
            setVolume(v) { try { g.gain.value = volGain(v); } catch { /* dead node */ } },
            ctx: c, startedAt: t0 || c.currentTime, duration: loop ? period : buf.duration,
        };
    } catch { return noop; }
}
