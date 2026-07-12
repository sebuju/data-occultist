import { playSynth } from "./synth.js";

// Play a trigger sound in the browser. The file lives in the web sounds/ folder
// (served at /sounds/<name>); `file` is just its name, "" = no sound. Best-effort:
// a blocked autoplay (no user gesture yet) or a missing file just no-ops, never throws.
export function playSound(file, volume = 1) {
    if (!file) return;
    try {
        const a = new Audio(`/sounds/${encodeURIComponent(file)}`);
        a.volume = Math.max(0, Math.min(1, volume));
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
