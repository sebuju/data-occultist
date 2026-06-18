// Embeds a graph-view floating panel (live / precapture / tasks) into the pretty surface so its
// controls don't have to be replicated. The panel modules were refactored to a mount(host)
// adapter (rule 7): each owns ONE content root that is re-parented into whichever host is shown
// — the floatwin body in graph view, or this widget's host in pretty view. We only re-host +
// drive activate/deactivate; all the panel logic (polling, collector arm, sessions) is shared.

import { mountActivity, activateActivity, deactivateActivity } from "../../graph/panels/activity.js";
import { mountLive, activateLive, deactivateLive } from "../../graph/panels/livewin.js";
import { mountPrecap, showPrecap, hidePrecap } from "../../graph/panels/precap.js";

// pretty-side adapter: the panel's chrome hooks (fit/title/button/nav/close) are graph-only, so
// they're all no-ops here — the pretty widget frame supplies its own sizing + drag/resize.
const NOOP_ADAPTER = (host) => ({ host, fit() {}, nav() {}, setTitle() {}, setActive() {}, close() {} });

const PANELS = {
  live:     { mount: mountLive,     activate: activateLive,     deactivate: deactivateLive },
  precap:   { mount: mountPrecap,   activate: showPrecap,       deactivate: hidePrecap },
  activity: { mount: mountActivity, activate: activateActivity, deactivate: deactivateActivity },
};

export const PANEL_OPTIONS = [
  { value: "live", label: "live" },
  { value: "precap", label: "precapture" },
  { value: "activity", label: "tasks" },
];

export default {
  type: "panel",
  title: "Panel",
  icon: "▤",
  defaults: () => ({ config: { panel: "live" }, w: 280, h: 220 }),
  create(host, widget, ctx) {
    host.className = "pw-panel";
    const p = PANELS[widget.config?.panel] || PANELS.live;
    const adapter = NOOP_ADAPTER(host);
    p.mount(adapter);        // (re-)parent the panel content into THIS widget host
    p.activate();            // start its poll / render
    return {
      // update fires on every data tick AND when pretty is re-activated — only RECLAIM the
      // root here (cheap parent check, no-op in steady state), never re-activate (that would
      // re-subscribe the hub each tick). The shared poll keeps rendering into the moved root.
      update: () => p.mount(adapter),
      destroy: () => p.deactivate(),
    };
  },
};
