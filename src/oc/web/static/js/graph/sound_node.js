// Sound node: plays a cue IN THE BROWSER when fired. A trigger names this node's id in its
// `targets` (drag the trigger's fire-port here, or pick it in the trigger's "fires"), so any
// trigger condition can play a sound — the web UI's fire-detector does the playback (never the
// server). The ▶ test button auditions it now (and unlocks browser autoplay for later auto-fires).
//
// The cue is EITHER a file from the sounds/ folder (model.sounds) OR a GENERATED synth cue: pick
// the last dropdown option, "[generator]", and the body grows an inline "forge" — a click-to-draw
// pitch-over-time plot + waveform + shape knobs + preset cues. A synth cue is a tiny param set on
// the node (x.synth), rendered by synth.js; "" file + no synth = silent.
//
// Rendering only — wiring (rename, file-change, volume, forge interactions, test) is in main.js
// (wireSound). Config persists in the profile YAML.
import { h, frag, svg, labCell, gspan, subhead } from "../dom.js";
import { confMeter } from "./meter.js";
import { iconFor } from "./node_icons.js";

export const GENERATOR = "[generator]";

// the four oscillator glyphs (square/sine/saw/triangle), drawn as inline svg so they take the
// button's own colour. One factory per shape keyed by wave name.
const WAVE_GLYPH = {
    square: () => svg("polyline", { points: "2,16 2,4 12,4 12,16 22,16 22,4 32,4 32,16 38,16" }),
    sine: () => svg("path", { d: "M2 10 Q8 -2 14 10 T26 10 T38 10" }),
    sawtooth: () => svg("polyline", { points: "2,16 12,4 12,16 22,4 22,16 32,4 32,16" }),
    triangle: () => svg("polyline", { points: "2,16 9,4 16,16 23,4 30,16 37,6" }),
};
const WAVES = ["square", "sine", "sawtooth", "triangle"];
const waveBtn = (w, on) => h("button", { class: "sf-wbtn" + (on ? " on" : ""), dataset: { wave: w }, title: w, type: "button" },
    svg("svg", { viewBox: "0 0 40 20" }, WAVE_GLYPH[w]()));

const KNOBS = [   // [key, label, min, max]
    ["length_ms", "len", 40, 1200], ["attack", "atk", 0, 100], ["decay", "dec", 0, 100],
    ["vibrato", "vib", 0, 100], ["crush", "crush", 0, 100],
];
const knob = (key, label, min, max, val) =>
    h("div", { class: "sf-knob" },
        h("input", { type: "range", class: "sf-k", dataset: { k: key }, min, max, value: val }),
        h("span", { class: "kl" }, label),
        h("span", { class: "sf-kv", dataset: { kv: key } }, String(val)));

// preset starting cues — a plain text chip you click to load & tweak. No colour dot: a coloured
// dot read like a node port/wire, which it isn't.
const PRESETS = ["pickup", "alert", "levelup", "deny", "coin", "hit"];
const presetChip = (name) => h("button", { class: "chip sf-cue", dataset: { cue: name }, type: "button" }, name);

// the inline forge body (shown when the node is in generator mode). All controls carry data-*
// hooks; wireForge (main.js) reads/writes x.synth and drives the canvas.
function forgeBody(syn) {
    return frag(
        subhead("pitch × time"),
        gspan("sf-plot",
            // total duration (left) + hover help (right) share ONE top row so the tip aligns with it
            h("div", { class: "sf-hud" },
                h("span", { class: "sf-len" }, `${syn.length_ms} ms`),
                h("span", { class: "sf-tip" }, "click add · drag move · right-click delete")),
            h("canvas", { class: "sf-plot-c" })),
        gspan("sf-waves", ...WAVES.map((w) => waveBtn(w, w === (syn.wave || "square")))),
        subhead("shape"),
        gspan("sf-knobs", ...KNOBS.map(([k, l, mn, mx]) => knob(k, l, mn, mx, syn[k] ?? 0))),
        subhead("starting cue"),
        gspan("sf-cues", ...PRESETS.map((n) => presetChip(n))),
    );
}

export function soundParts(x, model) {
    const cur = x.synth ? GENERATOR : (x.file || "");
    const sopt = (s) => h("option", { selected: s === cur }, s === cur ? `<${s}>` : s);
    const vol = x.volume == null ? 1 : x.volume;
    const gen = !!x.synth;
    return {
        title: h("input", { class: "gi gi-id sndrename", value: x.id, title: "rename sound" }),
        body: frag(
            h("div", { class: "lab-grid" },
                labCell("file", "the audio file (in the sounds/ folder) this node plays, or [generator] for a made cue"),
                h("select", { class: "sn-file" },
                    h("option", { value: "", selected: !cur }, "none"),
                    (model.sounds || []).map(sopt),
                    // the LAST option: build a unique cue in an inline forge instead of picking a file
                    h("option", { class: "sn-gen", value: GENERATOR, selected: gen }, GENERATOR)),
                labCell("volume", "playback volume — drag the bar to set it"),
                // same segmented meter as the confidence bars (rule 7): volume 0..1 as a draggable bar
                confMeter({ cls: "sn-volume", value: vol })),
            gen ? forgeBody(x.synth) : null,
        ),
        // synth mode: PLAY loops as a tweak-preview (wireForge toggles it); file mode: one-shot test.
        // roll (randomize) shows only in generator mode.
        foot: frag(
            h("button", { class: "sn-test", title: gen ? "loop preview (click to stop)" : "play this sound now" },
                iconFor("sound"), "play"),
            gen ? h("button", { class: "sn-roll", title: "randomize a new cue", type: "button" }, "roll") : null,
        ),
    };
}
