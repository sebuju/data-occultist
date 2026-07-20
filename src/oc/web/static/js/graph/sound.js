import { audioCtx, playSynth, prepareCue, volGain } from "./synth.js";

// Play a trigger sound in the browser. The file lives in the web sounds/ folder
// (served at /sounds/<name>); `file` is just its name, "" = no sound. Best-effort:
// a blocked autoplay (no user gesture yet) or a missing file just no-ops, never throws.
export function playSound(file, volume = 1) {
    if (!file) return;
    try {
        const a = new Audio(`/sounds/${encodeURIComponent(file)}`);
        a.volume = volGain(volume);
        a.play().catch(() => {});
    } catch { /* no Audio / bad name — silent */ }
}

// The single play funnel for a sound NODE — used by the node's test button AND the heartbeat
// fire-detector (rule 7: one helper, never copied). Dispatches on the node's config: a generated
// `synth` cue -> Web Audio (synth.js), else the plain file -> <audio>. Fires are always one-shot;
// only the open forge's PLAY loops (it calls playSynth directly with {loop:true}).
export function playCue(sound) {
    if (!sound) return;
    if (sound.synth) playSynth(sound.synth, sound.volume ?? 1, { loop: false });
    else playSound(sound.file, sound.volume ?? 1);
}

// Play SEVERAL cues as one chord — a trigger wired to more than one sound node must sound them
// together, not in a ragged sequence. Playing each via playCue() staggered them: every generated cue
// awaits its own offline render, so an uncached one started milliseconds after a cached one (and a
// slow render could drift far enough to read as "only one played"). So: warm every buffer first,
// then start the whole batch at ONE scheduled AudioContext time. Single cue takes the plain path.
export async function playCues(sounds) {
    const list = (sounds || []).filter(Boolean);
    if (list.length <= 1) { playCue(list[0]); return; }
    await Promise.all(list.filter((s) => s.synth).map((s) => prepareCue(s.synth)));
    const c = audioCtx();
    // a small lead so every source is scheduled before the clock reaches it (else the first ones
    // start immediately and the last still lags); 0 = no Web Audio, each starts now.
    const at = c ? c.currentTime + 0.03 : 0;
    for (const s of list) {
        if (s.synth) playSynth(s.synth, s.volume ?? 1, { at });
        else playSound(s.file, s.volume ?? 1);
    }
}
