// Confidence -> presentation tier: the single source for the app-wide >=.8 / >=.5 scale that
// every value display uses (item/readout live grids, dataset preview cells, the register memory
// bank, the canvas overlay tint). Author it once here so a threshold change lands everywhere
// (rule 7) instead of drifting across copy-pasted ternaries.
//   ok   -> high (>= .8)   green
//   warn -> medium (>= .5) amber
//   bad  -> low (< .5)     red
//   sub  -> substituted (a fallback value, not a live read) — muted italic
export function confTier(conf, substituted = false) {
    if (substituted) return "sub";
    return conf >= 0.8 ? "ok" : conf >= 0.5 ? "warn" : "bad";
}

// The `.conf-*` class form for the tier (styled in flow.css).
export const confClass = (conf, substituted = false) => "conf-" + confTier(conf, substituted);
