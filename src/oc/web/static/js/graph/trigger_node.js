// Trigger node: fires its target price node(s) on a condition. `interval` fires every N
// seconds; `on_change` fires when a watched dataset gains rows (pricing just those, live);
// `manual` never auto-fires (the sweep button drives it). All config persists in the
// profile YAML. Targets are wired by dragging the out-port to a price node; watch datasets
// and targets can also be added from the dropdowns here. Rendering only — wiring is in main.js.
import { h, frag, TRASH, labCell } from "../dom.js";

const KINDS = [["interval", "interval (periodic)"], ["on_change", "on change (live)"],
    ["on_app_start", "on app start"], ["on_capture", "on capture start"], ["manual", "manual only"]];

// removable source pill — same look as a subset's join-source pills (.sv-input). `rmCls`
// is the wiring hook (tg-rmwatch / tg-rmtarget); `attrKey`/`attrVal` carry the id back to
// the handler (e.g. data-ds / data-p, read by the wiring as el.dataset.ds / .p).
const srcChip = (val, attrKey, rmCls) =>
    h("span", { class: "sv-input" }, val,
        h("button", { class: `sv-rmin danger ${rmCls}`, dataset: { [attrKey]: val }, title: "remove" }, TRASH()));

// the pills + a "+ …" add-select that go in a watch/fires control cell. `chips` is an array
// of chip nodes; `addOpts` an array of <option> nodes.
const srcInputs = (chips, addCls, addOpts) =>
    h("div", { class: "sv-inputs" }, chips,
        h("span", { class: "sv-input sv-add" }, h("select", { class: `sv-addin ${addCls}` }, addOpts)));

export function triggerParts(t, model) {
    const kind = KINDS.some(([v]) => v === t.kind) ? t.kind : "interval";
    const kopt = ([v, l]) => h("option", { value: v, selected: v === kind }, l);

    const interval = kind === "interval"
        ? frag(labCell("every", "seconds between automatic sweeps"),
            h("span", { class: "tg-secs" },
                h("input", { class: "tg-interval", type: "number", min: "1", step: "1", value: t.interval_s || 300 }), " s"))
        : null;

    let watch = null;
    if (kind === "on_change") {
        const have = new Set(t.watch || []);
        // watch datasets OR subsets (a subset fires when any of its source datasets gains rows)
        const sources = [...model.datasets(), ...(model.profile.subsets || []).map((s) => s.id)];
        const opts = sources.filter((d) => !have.has(d)).map((d) => h("option", d));
        watch = frag(
            labCell("watch", "datasets or subsets; the trigger fires when one gains rows", true),
            srcInputs(
                (t.watch || []).map((w) => srcChip(w, "ds", "tg-rmwatch")),
                "tg-addwatch",
                [h("option", { value: "" }, "+ watch source"), opts],
            ));
    }

    // targets: drag the out-port to a producer / file source OR pick one here (same source-row UI
    // as watch). A target is a producer id (sweep/refresh) or a file-source id (read a log/config file).
    const haveT = new Set(t.targets || []);
    const tgtIds = [...(model.profile.producers || []).map((p) => p.id),
                    ...(model.profile.file_sources || []).map((s) => s.id)];
    const popts = tgtIds.filter((p) => !haveT.has(p)).map((p) => h("option", p));
    const targets = frag(
        labCell("fires", "producers (sweep/refresh) or file sources (read) this trigger fires", true),
        srcInputs(
            (t.targets || []).map((p) => srcChip(p, "p", "tg-rmtarget")),
            "tg-addfire",
            [h("option", { value: "" }, "+ fire target"), popts],
        ));

    // optional sound: the UI plays it (in the browser) when the trigger fires. Only shown when
    // the sounds/ folder has files; the chosen name is just persisted on the trigger. ▶ auditions.
    let sound = null;
    if ((model.sounds || []).length) {
        const cur = t.sound || "";
        const sopt = (s) => h("option", { selected: s === cur }, s);
        const vol = t.volume == null ? 1 : t.volume;
        sound = frag(
            labCell("sound", "optional sound played (in the browser) when it fires"),
            h("span", { class: "tg-secs" },
                h("select", { class: "tg-sound" },
                    h("option", { value: "", selected: !cur }, "none"),
                    model.sounds.map(sopt)),
                h("button", { class: "tg-sound-preview", title: "play this sound" }, "▶")),
            labCell("volume", "playback volume for the sound"),
            h("span", { class: "tg-secs" },
                h("input", { class: "tg-volume", type: "range", min: "0", max: "1", step: "0.05", value: vol }),
                h("span", { class: "tg-volnum muted" }, `${Math.round(vol * 100)}%`)));
    }

    return {
        title: h("input", { class: "gi gi-id tgrename", value: t.id, title: "rename trigger" }),
        body: frag(
            h("div", { class: "lab-grid" },
                labCell("kind", "how the trigger decides to fire"),
                h("select", { class: "tg-kind" }, KINDS.map(kopt)),
                interval, watch, targets, sound,
                labCell("progress", "what the current/last sweep is doing"),
                h("span", { class: "tg-prog muted" }, "idle"),
                labCell("last fired", "last time this trigger fired"),
                h("span", { class: "tg-last muted" }, "never fired")),
            h("div", { class: "gn-foot" }, h("button", { class: "tg-fire" }, "↻ fire now"))),
        ports: frag(
            h("span", { class: "port out", title: "drag to a price node this trigger should fire" }),
            kind === "on_change" && h("span", { class: "port pwatch", title: "drag to a dataset or subset to watch for new rows" })),
    };
}
