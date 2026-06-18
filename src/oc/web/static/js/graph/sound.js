// Play a trigger sound in the browser. The file lives in the web sounds/ folder
// (served at /sounds/<name>); `file` is just its name, "" = no sound. The single
// play funnel — used by the node's preview button AND the heartbeat fire-detector
// (rule 7: one helper, never copied). Best-effort: a blocked autoplay (no user
// gesture yet) or a missing file just no-ops, never throws.
export function playSound(file, volume = 1) {
    if (!file) return;
    try {
        const a = new Audio(`/sounds/${encodeURIComponent(file)}`);
        a.volume = Math.max(0, Math.min(1, volume));
        a.play().catch(() => {});
    } catch { /* no Audio / bad name — silent */ }
}
