// Single source of truth for confidence-input defaults, the detect field shape, and the
// generated-cue (synth) knob set.
// Mirrors DEFAULT_DETECT_THRESHOLD in src/oc/profile/models.py — no bare 0.8
// literals scattered across the front-end. New detect nodes seed from here; the
// two mappers below are the ONE place the detect knob set is read/written, so both
// the classic editor (model.js) and the graph editor (graph/model.js) stay in sync.

export const DEFAULT_DETECT_THRESHOLD = 0.8;

// Detect knob defaults — what a freshly-created detect node carries, and the
// fallback when an older profile omits a field.
export const DETECT_DEFAULTS = {
    match: "partial",
    case_sensitive: false,
    min_chars: 0,
    strip: "alnum",
};

// Profile detect/state-detect entry -> on-disk shape (text, threshold + knobs).
export function detectToProfile(b, search) {
    return {
        id: b.id,
        search,
        text: b.text || null,
        threshold: b.threshold ?? DEFAULT_DETECT_THRESHOLD,
        match: b.match ?? DETECT_DEFAULTS.match,
        case_sensitive: !!b.case_sensitive,
        min_chars: b.min_chars ?? DETECT_DEFAULTS.min_chars,
        strip: b.strip ?? DETECT_DEFAULTS.strip,
    };
}

// On-disk detect entry -> editor box. `extra` carries role-specific fields
// (role, stateId). Spreads the search box last so x/y/w/h land on the box.
export function detectToBox(a, extra) {
    return {
        text: a.text || "",
        threshold: a.threshold ?? DEFAULT_DETECT_THRESHOLD,
        match: a.match ?? DETECT_DEFAULTS.match,
        case_sensitive: !!a.case_sensitive,
        min_chars: a.min_chars ?? DETECT_DEFAULTS.min_chars,
        strip: a.strip ?? DETECT_DEFAULTS.strip,
        id: a.id,
        ...extra,
        ...a.search,
    };
}

// Generated sound-cue (synth) knob defaults — mirrors SynthDef in src/oc/profile/models.py.
// EVERY reader of a synth spec goes through this table (`s.cutoff ?? SYNTH_DEFAULTS.cutoff`):
// the forge UI (sound_node.js), the Web Audio renderer (synth.js), the roll, and the seed for a
// fresh cue (graph/model.js defaultSynth). A cue saved before a knob existed simply omits it, so
// a missing value MUST fall back to the neutral default here, never to 0 — 0 cutoff would choke
// every old cue down to a 200 Hz mumble and 0 glide would turn every slide into a stepped arp.
export const SYNTH_DEFAULTS = {
    wave: "square",
    length_ms: 220,
    attack: 4,
    decay: 55,
    vibrato: 0,
    crush: 0,
    cutoff: 100,      // 100 = filter bypassed (the pre-filter timbre)
    reso: 0,
    noise: 0,
    sub: 0,
    glide: 100,       // 100 = ramp the whole segment (how every pre-glide cue sounded)
    release: 0,
    echo: 0,
    echo_ms: 90,
    transpose: 0,
    repeat: 1,        // 1 = play the envelope once
};
