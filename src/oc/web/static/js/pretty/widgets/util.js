// Shared widget plumbing: ONE data-subscription manager every widget uses, so a widget never
// hand-rolls require/subscribe/release bookkeeping (rule 7). `sync(keys)` makes the live
// subscription set exactly `keys` (requiring/releasing the polled ones as needed); `destroy()`
// releases everything. dataset/subset/status keys are polled; node:/widget: keys only notify.

import { tokensIn } from "../expr.js";
import { subKeyForToken, dataKeyForBinding } from "../binding.js";

export function keySubscription(ctx, onChange) {
  const active = new Map();   // key -> unsubscribe fn
  function sync(keys) {
    const want = new Set((keys || []).filter(Boolean));
    for (const [k, unsub] of active) if (!want.has(k)) { unsub(); ctx.data.release(k); active.delete(k); }
    for (const k of want) if (!active.has(k)) { ctx.data.require(k); active.set(k, ctx.data.subscribe(k, onChange)); }
  }
  return { sync, destroy() { for (const [k, unsub] of active) { unsub(); ctx.data.release(k); } active.clear(); } };
}

// Subscribe keys implied by every {{token}} in a piece of text (for dynamic labels).
export function textKeys(text) { return tokensIn(text).map(subKeyForToken).filter(Boolean); }

export { dataKeyForBinding };

// Tiny DOM helper: an element with class + optional text.
export function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// Default human label for a column key: special chars -> spaces, each word Capitalised.
// e.g. "price_median" -> "Price Median", "live.ask" -> "Live Ask".
export function humanize(key) {
  return String(key || "").replace(/[_\-.]+/g, " ").trim().replace(/\b\w/g, (c) => c.toUpperCase());
}
