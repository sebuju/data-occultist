// Single source of truth for confidence-input defaults and the detect field shape.
// Mirrors DEFAULT_DETECT_THRESHOLD in src/oc/profile/models.py — no bare 0.8
// literals scattered across the front-end. New detect nodes seed from here; the
// two mappers below are the ONE place the detect knob set is read/written, so both
// the classic editor (model.js) and the graph editor (graph/model.js) stay in sync.

export const DEFAULT_DETECT_THRESHOLD = 0.8;

// Detect knob defaults — what a freshly-created detect node carries, and the
// fallback when an older profile omits a field.
export const DETECT_DEFAULTS = {
    match: "partial",
    included: false,
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
        included: !!b.included,
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
        included: !!a.included,
        case_sensitive: !!a.case_sensitive,
        min_chars: a.min_chars ?? DETECT_DEFAULTS.min_chars,
        strip: a.strip ?? DETECT_DEFAULTS.strip,
        id: a.id,
        ...extra,
        ...a.search,
    };
}
