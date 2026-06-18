// Embeds a graph-view floating panel (live / precapture / tasks) into the pretty surface so its
// controls don't have to be replicated. The panel modules were refactored to a mount(host)
// adapter (rule 7): each owns ONE content root that is re-parented into whichever host is shown
// — the floatwin body in graph view, or this widget's host in pretty view. We only re-host +
// drive activate/deactivate; all the panel logic (polling, collector arm, sessions) is shared.

import { mountActivity, activateActivity, deactivateActivity } from "../../graph/panels/activity.js";
import { mountLive, activateLive, deactivateLive } from "../../graph/panels/livewin.js";
import { mountPrecap, showPrecap, hidePrecap } from "../../graph/panels/precap.js";
import { floatWins } from "../../graph/floatwin.js";

// pretty-side adapter: the panel's chrome hooks (fit/title/button/nav/close) are graph-only, so
// they're all no-ops here — the pretty widget frame supplies its own sizing + drag/resize.
const NOOP_ADAPTER = (host) => ({ host, fit() {}, nav() {}, setTitle() {}, setActive() {}, close() {} });

// live / precapture / tasks were refactored to a movable content root with a shared poll, so
// they embed via their own mount/activate/deactivate adapter. Every OTHER floating panel embeds
// generically by borrowing its floatwin body (floatwin.embed — rule 7), so the select can expose
// them all without a bespoke adapter each.
const ADAPTERS = {
  live:     { mount: mountLive,     activate: activateLive,     deactivate: deactivateLive },
  precap:   { mount: mountPrecap,   activate: showPrecap,       deactivate: hidePrecap },
  activity: { mount: mountActivity, activate: activateActivity, deactivate: deactivateActivity },
};

// value = the floatwin id (so generic embed can look it up); label = how it reads in the select.
export const PANEL_OPTIONS = [
  { value: "live", label: "live" },
  { value: "precap", label: "precapture" },
  { value: "activity", label: "tasks" },
  { value: "stats", label: "stats" },
  { value: "nodemap", label: "node map" },
  { value: "nodelist", label: "node list" },
  { value: "toolbox", label: "toolbox" },
  { value: "testing", label: "testing" },
];

export default {
  type: "panel",
  title: "Embed",
  icon: "▤",
  defaults: () => ({ config: { panel: "live" }, w: 280, h: 220 }),
  create(host, widget, ctx) {
    host.className = "pw-panel";
    const id = widget.config?.panel || "live";
    const a = ADAPTERS[id];
    if (a) {
      const adapter = NOOP_ADAPTER(host);
      a.mount(adapter);        // (re-)parent the panel content into THIS widget host
      a.activate();            // start its poll / render
      // update fires on every data tick AND when pretty is re-activated — only RECLAIM the root
      // here (cheap parent check, no-op in steady state), never re-activate (that would re-
      // subscribe the hub each tick). The shared poll keeps rendering into the moved root.
      return { update: () => a.mount(adapter), destroy: () => a.deactivate() };
    }
    // generic: borrow the floating panel's body (it's built at app start). Some panels (e.g. the
    // node map) size to their own frame, so they may render small while embedded.
    const win = floatWins().get(id);
    if (!win) { host.textContent = `panel "${id}" unavailable`; return { update() {}, destroy() {} }; }
    win.embed(host);
    return { update: () => win.reclaim(), destroy: () => win.unembed() };
  },
};
