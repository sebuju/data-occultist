// The ONE copy/paste clipboard primitive for node body sections (rule 7). Three sections use it —
// a field's rule pipeline (rules_editor.js) and the sound forge's pitch/shape sections
// (sound_wire.js) — and they all want identical behaviour:
//
//   • copy stashes a DEEP CLONE of the section's value, so later edits to the source don't
//     retro-change what's on the clipboard;
//   • the stash outlives the node (paste is cross-node, for this page session), so copying must
//     un-disable EVERY paste button of that kind in the document — a sibling node's button was
//     rendered before the copy happened and would otherwise stay dead until its next rebuild;
//   • paste hands back another deep clone and REPLACES the section's value.
//
// Each section kind makes ONE clip at module scope (`const pitchClip = makeClip(".sf-ppaste")`) and
// re-wires it to each node body as that body is built. The buttons themselves come from dom.js
// `copyPasteBtns` — this file owns state, that one owns looks.
export function makeClip(pasteSel) {
    let held = null;
    return {
        has: () => held != null,
        // Bind one node body's button pair. `read` returns the value to stash, `write(value)`
        // installs a pasted one (the caller's own transaction/rebuild/save wrapper).
        wire(div, { copyCls, pasteCls, read, write }) {
            div.querySelector(copyCls)?.addEventListener("click", () => {
                held = structuredClone(read());
                document.querySelectorAll(pasteSel).forEach((b) => { b.disabled = false; });
            });
            const pb = div.querySelector(pasteCls);
            if (!pb) return;
            pb.disabled = held == null;   // nothing copied yet -> nothing to paste
            pb.addEventListener("click", () => { if (held != null) write(structuredClone(held)); });
        },
    };
}
