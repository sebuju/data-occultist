// Web Audio synth for GENERATED sound cues (the sound node's "forge"). A cue is a tiny param set
// (wave + a pitch-over-time envelope + amp/vibrato/crush knobs), NOT a file — so instead of an
// <audio> element (see sound.js) we synthesise it here.
//
// Rendered ONCE per spec into an AudioBuffer and cached; every later play reuses the buffer. Volume
// is a playback-time gain, never baked in, so changing a node's volume reuses the same render;
// editing the cue changes the spec key, so the next play renders fresh exactly once.
//
// Two play modes via `{loop}`: the open forge's PLAY loops (tweak while it repeats), while a real
// FIRE (trigger heartbeat) and the test button play one-shot. playSynth returns a controller with
// stop() so the forge can toggle/restart the loop.

let _ctx = null;
function ctx() {
    _ctx = _ctx || new (window.AudioContext || window.webkitAudioContext)();
    if (_ctx.state === "suspended") _ctx.resume();
    return _ctx;
}

// 0..1 pitch -> frequency. 0 = C3, 1 = three octaves up (36 semitones), quantised to semitones so
// hand-drawn envelopes land on notes (matches the forge's note readout).
const pToFreq = (p) => 130.81 * Math.pow(2, Math.round(p * 36) / 12);

// a stable string key for the cache — same spec (ignoring volume) => same key => same render.
function specKey(s) {
    const pts = (s.points || []).map((p) => `${(+p.t).toFixed(3)},${(+p.p).toFixed(3)}`).join(";");
    return `${s.wave}|${s.length_ms}|${s.attack}|${s.decay}|${s.vibrato}|${s.crush}|${pts}`;
}

// Build the oscillator graph for a cue into any context (offline for render, so the live timbre
// matches the cached buffer exactly). Starts/stops its own nodes; connects the tail to `dest`.
function buildGraph(c, s, dest) {
    const pts = s.points || [];
    if (!pts.length) return;
    const dur = s.length_ms / 1000;
    const osc = c.createOscillator();
    osc.type = s.wave || "square";
    osc.frequency.setValueAtTime(pToFreq(pts[0].p), 0);
    for (const pt of pts) osc.frequency.linearRampToValueAtTime(pToFreq(pt.p), pt.t * dur);
    if (s.vibrato > 0) {
        const lfo = c.createOscillator(), lg = c.createGain();
        lfo.frequency.value = 5 + s.vibrato * 0.12; lg.gain.value = s.vibrato * 0.9;
        lfo.connect(lg).connect(osc.frequency); lfo.start(0); lfo.stop(dur);
    }
    const g = c.createGain();
    const a = Math.max(0.002, s.attack / 1000 * 4), d = Math.max(0.03, s.decay / 100 * dur);
    g.gain.setValueAtTime(0, 0);
    g.gain.linearRampToValueAtTime(0.9, a);
    g.gain.exponentialRampToValueAtTime(0.0008, Math.max(a + 0.03, d));
    let tail = osc;
    if (s.crush > 0) {   // stepped waveshaper = bit-crush grit
        const ws = c.createWaveShaper(), steps = Math.max(2, 34 - ((s.crush / 3) | 0));
        const curve = new Float32Array(1024);
        for (let i = 0; i < 1024; i++) { const x = i / 1023 * 2 - 1; curve[i] = Math.round(x * steps) / steps; }
        ws.curve = curve; osc.connect(ws); tail = ws;
    }
    tail.connect(g).connect(dest);
    osc.start(0); osc.stop(dur + 0.02);
}

const _cache = new Map();   // specKey -> AudioBuffer
async function renderCue(s) {
    const key = specKey(s);
    let buf = _cache.get(key);
    if (buf) return buf;
    const sr = 44100, dur = s.length_ms / 1000 + 0.06;
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
export async function playSynth(spec, volume = 1, { loop = false } = {}) {
    const noop = { stop() {}, ctx: null, startedAt: null, duration: 0 };
    if (!spec || !(spec.points || []).length) return noop;
    try {
        const buf = await renderCue(spec);
        const c = ctx();
        const src = c.createBufferSource(), g = c.createGain();
        src.buffer = buf; g.gain.value = Math.max(0, Math.min(1, volume));
        if (loop) { src.loop = true; src.loopStart = 0; src.loopEnd = buf.duration; }
        src.connect(g).connect(c.destination);
        src.start();
        // setVolume adjusts the live gain WITHOUT restarting — a looping preview's volume tracks the
        // node's meter in real time (the buffer bakes in no volume, so this is the only gain stage).
        return {
            stop() { try { src.stop(); } catch { /* already stopped */ } },
            setVolume(v) { try { g.gain.value = Math.max(0, Math.min(1, v)); } catch { /* dead node */ } },
            ctx: c, startedAt: c.currentTime, duration: buf.duration,
        };
    } catch { return noop; }
}
