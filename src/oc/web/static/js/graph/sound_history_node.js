// Sound-history node: a sound's recent plays (satellite; NON-persisted, this-session only). A
// standard vttable satellite (kind "soundhistory") — same resizable, scrolling, virtualized grid
// every history satellite shares (rule 7: VTable + `satVT` lifecycle + `.hist-host`).
//
// One row per play (newest first): WHEN, and BY (the trigger id that named this sound in its fire
// cue). This is the only "played" signal the server has — sounds are always CLIENT-played (see
// sound.js/playFire), so a row here means the cue was PUBLISHED, not that audio actually sounded
// (autoplay-blocked, no listening tab, etc). Data rides the activity heartbeat TOP-LEVEL
// (`sound_history["<id>"]`, build_activity). Painted on satellite open and each beat (activity.js)
// — a closed satellite (no host in the DOM) costs nothing.
import * as hub from "../hub.js";
import { nodeEls } from "./state.js";
import { fmtDateTimeMs } from "../datefmt.js";
import { satVTData } from "./sat_vtable.js";

const COLS = ["when", "by"];

// Render a sound's play-history into its (open) satellite. No-op when the satellite is hidden (no
// host in the DOM). `history` defaults to the last heartbeat snapshot for this sound, so a bare call
// (satellite just opened) paints immediately without waiting for the next beat.
export function renderSoundHistory(id, history) {
    const host = nodeEls.get(`sndhist:${id}`)?.querySelector(".hist-host");
    if (!host) return;
    if (history === undefined)
        history = hub.latest()?.sound_history?.[id] || [];
    const rows = history.map((e) => ({
        when: fmtDateTimeMs(e.ts),
        by: e.trigger || "",
    }));
    satVTData(`sndhist:${id}`, host, COLS, rows);
}
