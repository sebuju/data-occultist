// Sound node: plays an audio file IN THE BROWSER when fired. A trigger names this node's id in
// its `targets` (drag the trigger's fire-port here, or pick it in the trigger's "fires"), so any
// trigger condition can play a sound — the web UI's fire-detector does the playback (never the
// server). The ▶ test button auditions it now at the current volume (and unlocks browser autoplay
// for later auto-fires). `file` is a name from the sounds/ folder (model.sounds); "" = silent.
// Rendering only — wiring is in main.js (wireSound). Config persists in the profile YAML.
import { h, frag, labCell } from "../dom.js";
import { iconFor } from "./node_icons.js";

export function soundParts(x, model) {
    const cur = x.file || "";
    const sopt = (s) => h("option", { selected: s === cur }, s);
    const vol = x.volume == null ? 1 : x.volume;
    return {
        title: h("input", { class: "gi gi-id sndrename", value: x.id, title: "rename sound" }),
        body: frag(
            h("div", { class: "lab-grid" },
                labCell("file", "the audio file (in the sounds/ folder) this node plays"),
                h("select", { class: "sn-file" },
                    h("option", { value: "", selected: !cur }, "none"),
                    (model.sounds || []).map(sopt)),
                labCell("volume", "playback volume for the sound"),
                // .tg-secs is the shared range-row layout (label + slider); reuse it (rule 7)
                h("span", { class: "tg-secs" },
                    h("input", { class: "sn-volume", type: "range", min: "0", max: "1", step: "0.05", value: vol }),
                    h("span", { class: "sn-volnum tg-volnum muted" }, `${Math.round(vol * 100)}%`))),
            h("div", { class: "gn-foot" },
                h("span", { class: "sn-prog muted" }, ""),
                h("button", { class: "sn-test", title: "play this sound now" }, iconFor("sound"), "test"))),
    };
}
