# Handover: `on_new_batch` trigger kind

## Goal

Add a trigger **kind that fires once per NEW BATCH** of a watched dataset — even when the
row values are identical to the previous batch. Pushing the same relic screen again (a fresh
detection/commit) should re-fire (→ re-sweep → re-toast), which today it does **not**.

This is a *deliberate* new capability alongside the existing kinds — it does **not** replace
`on_change` (whose value-gating is correct and stays).

## Why the existing kinds don't cover it

Chain for a re-push of identical relics:
`relics_offered` (new batch, same names) → subset `relic_rewards_limit` (latest-batch, **same
visible output**) → `trigger_on_new_relic` (`kind: on_change`, watches that subset).

- **`on_change`** on a subset fires only when the subset's *visible output* actually changes
  (`_subset_sig` compares projected rows — `triggers.py`). Same names → sig unchanged → no fire.
  Correct and wanted for live (don't re-sweep every detection tick of the same screen).
- **`on_any_change`** fires on *every write reaching* the watched dataset/subset — i.e. per
  announced **record**, many times per batch, not once per batch. Too noisy, and semantically
  "per write" not "per batch".

Neither is "once per new batch".

## Load-bearing facts (verified in code)

- **Batches**: `DatasetStore.begin_batch()` bumps `self._batch` and writes the `batch` column in
  the `datasets` table. One commit/detection/run = one `begin_batch()`. `relics_offered` is
  `batch_mode: detection` (`sync_mode: accumulate`), so **each push is its own batch**.
- **Announce on identical data depends on `dedup`**:
  - `relics_offered` is `dedup: false` → `_plan_observation` takes the `_no_dedup` branch and
    **always returns a plan** (`dataset_store.py`), so **every** `record_seen` announces on the
    change bus — *including identical values*. So a re-push **already reaches the change bus**;
    only the on_change subset-sig gate suppresses the downstream fire.
  - `dedup: true` datasets return `None` for an identical read → **no announce**. A new-batch
    kind driven purely off the change bus would therefore **miss an identical re-push on a
    dedup:true dataset**. Decide whether that matters (see Open Questions).
- **Change bus** (`store/changes.py`) currently publishes `(game, dataset, records,
  data_changed)` — **no batch number**. That's the main missing piece.
- **Reference implementation to copy**: the `on_ready` kind added this session
  (`triggers.py::on_sweep_done`, wired via a dedicated bus channel `subscribe_sweep_done` /
  `publish_sweep_done` in `store/changes.py`, fired from `price_runner._reap`, subscribed in
  `web/app.py` and `cli/collect.py`). A new kind that rides a bus signal follows the same shape.

## Recommended design

Fire on a **batch-number increase** for a watched **dataset**, coalesced to one fire per batch.

**Surface the batch number, track the last-fired batch per (trigger, dataset), fire on increase.**

Two viable mechanisms — pick per the dedup caveat:

- **A (rides the existing change bus — simplest):** add the current `batch` to the change-bus
  publish (`_announce` → `changes.publish(..., batch=n)`). In the trigger runner, for each
  `on_new_batch` trigger watching `dataset`, remember the last batch it fired on; when an announce
  arrives with `batch > last`, fire once and store `batch`. Coalescing (fire once per batch even
  though a batch announces many rows) falls out naturally since all rows of a batch share `batch`.
  - Works for `relics_offered` (dedup:false announces every batch). **Misses identical re-push on
    dedup:true datasets** (no announce). Good enough if watched datasets are dedup:false.
- **B (dedicated batch-committed event — robust):** emit a `publish_batch_done(game, dataset,
  batch)` at the point a batch is finalised (a single choke point — e.g. `DatasetStore.save()`
  after a `begin_batch`, or the commit paths `collect/commit.py` / `web/routes/preview.py`
  `/commit` / the sweep). Runner subscribes (mirror `subscribe_sweep_done`) and fires. Independent
  of `dedup`/value changes. More plumbing, but no dedup blind spot.

Recommend **A first** (matches the relic use case, minimal), and note B as the upgrade if a
dedup:true dataset ever needs it.

### Watch a DATASET, not a subset

Batches are a dataset concept. `on_new_batch` should `watch` a **dataset** id (e.g.
`relics_offered`), not a subset — cleaner than "the subset's leaf dataset". For the relic wiring,
point `trigger_on_new_relic` (or a parallel trigger) at `relics_offered` with `kind: on_new_batch`.

## Files to touch

- **`src/oc/profile/models.py`** — `TriggerDef`: document `on_new_batch` in the kind docstring +
  the inline kind list. `watch` already holds dataset ids. (kind is free-form; no validator.)
- **`src/oc/store/changes.py`** (design A) — add `batch` param to `publish`/subscriber signature,
  OR (design B) add `publish_batch_done`/`subscribe_batch_done` (copy the sweep-done pair).
- **`src/oc/store/dataset_store.py`** — (A) pass `self._batch` into `_announce`/`publish`; (B) emit
  the batch-done event at the finalise choke point.
- **`src/oc/collect/triggers.py`** — handle `on_new_batch`: track last-fired batch per
  `(trigger_id, dataset)` (new dict in `__init__`), fire via the shared `_emit_fire` funnel (so
  throttle/history/settle still apply). If design A, hook it inside the change-bus path
  (`on_change`) reading the batch; if B, add an `on_batch_done(dataset, batch)` entry point.
- **`src/oc/web/app.py`** + **`src/oc/cli/collect.py`** — wiring (rides the existing
  `OnChangeFirer` for A; add a `subscribe_batch_done` for B, mirroring the sweep-done wiring).
- **UI**: `web/static/js/graph/trigger_node.js` `KINDS` (add `["on_new_batch","on new batch"]`);
  `model.js` `setTriggerKind` whitelist + `addTrigger` default; the watch cell/port should offer
  **datasets** for this kind (mirror the on_change branch, dataset-only); `model.js` watch-edge
  builder already draws for the kinds it lists — add `on_new_batch`.

## Open questions / decisions

1. **dedup:true datasets** — accept the change-bus blind spot (design A) or go with a batch event
   (design B)? For relics (dedup:false) A is fine.
2. **Coalescing** — one fire per batch even when the batch announces many rows. With design A,
   dedup by the `batch` number (only fire when it increases). Confirm the `OnChangeFirer` 0.25s
   window doesn't split a batch across two flushes (it shouldn't — same dataset key).
3. **Items passed to the fire** — for the relic path the target is a producer sweep; pass the
   batch's rows as `items` (like on_change) or `None` (price the node's sources)? Match on_change:
   pass the changed rows so the sweep prices exactly the batch.
4. **Restart/persistence** — should "last-fired batch" survive a runner rebuild? The runner is now
   cached per game (`app.py`), so in-memory is fine within a process; a fresh process starting
   mid-life would fire on the first batch it sees (acceptable — matches interval reseed behaviour).
5. **Naming** — `on_new_batch` vs `on_batch`. Pick one and use it consistently in models + UI.

## Verification

- **Unit** (`tests/test_triggers.py`): push identical rows to a dedup:false dataset twice (two
  `begin_batch` + `record_seen`); assert an `on_new_batch` trigger fires **twice** while an
  `on_change` trigger on the same watch fires **once**.
- **Live/serve**: re-push the same relic screen via the window node "test" / vttable push; confirm
  the sweep + toast fire **each** push. Capture the event-log SSE (`/api/events/warframe`) — the
  `trigger fired` line should appear per push.

## Context / related work (this session)

- `on_ready` (producer-completion) — the pattern to copy for a bus-driven kind. See commit
  `feat(pricing): deterministic relic toast + producer queue modes`.
- The relic toast is now causal (fires on the market sweep's reap) and renders the sweep's own
  priced batch (`relic_priced_batch` subset = `relic_prices` latest batch), so once `on_new_batch`
  re-fires the sweep, the toast will re-render correctly with no extra work.
- Producer `queue_mode` (drop/latest/queue) already handles rapid re-fires piling onto a busy
  sweep — relevant if `on_new_batch` fires faster than a sweep completes.
