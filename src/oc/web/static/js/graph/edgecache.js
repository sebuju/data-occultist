// Offscreen bitmap cache + blit for the viewport geometry canvases (edgecanvas.js). ONE shared
// primitive (rule 7) backing both layers (#gcanvas-under groups, #gcanvas-over wires).
//
// WHY: with thousands of wires, re-stroking every polyline on every pan frame is the raster cost
// that janks the pan. Routing is already cached (routing.js) — so we cache the RASTER too: draw
// the geometry once into an offscreen bitmap covering viewport + margin, then a pan frame is a
// single integer-offset drawImage blit instead of N strokes. Re-raster only when the geometry or
// style changes (markDirty), the zoom/dpr changes, or the pan escapes the cached margin.
//
// CRISPNESS: camera.applyView() snaps the #gpan translate to whole device pixels, so
// round(panX·dpr) is always an integer. The cache origin is likewise an integer in world-device
// space (world · dpr · zoom), so the blit offset originDev + round(pan·dpr) is a whole device
// pixel — 1px strokes land on the exact same grid as a direct draw (pixel-identical at rest).
//
// STATES per render():
//   dirty                  -> direct draw (geometry changing, e.g. node drag / morph tick);
//                             quiet timer re-rasters 150ms after the last dirty frame
//   clean, zoom/dpr match,
//     viewport in cache    -> blit (the every-pan-frame fast path) + margin prefetch check
//   clean, zoom mismatch,
//     scaled cache covers  -> scale-blit (momentarily blurry) + settle timer -> sharp raster
//   anything else          -> synchronous raster + blit (rare hitch; correctness first)

import { view } from "./state.js";

const MARGIN_FRAC = 0.5;       // cache margin per side, as a fraction of the viewport
const MAX_MARGIN_DEV = 1024;   // margin cap in device px per side (memory ceiling)
const MAX_DIM_DEV = 12288;     // absolute cache canvas dimension cap
const QUIET_MS = 150;          // re-raster this long after the last dirty (direct-drawn) frame
const ZOOM_SETTLE_MS = 150;    // sharp re-raster this long after the last zoom scale-blit
const PREFETCH_FRAC = 0.25;    // re-centre when pan gets within this fraction of margin from edge

// A/B + e2e instrumentation (exposed as window.__edgecanvas by edgecanvas.js).
export const stats = { blits: 0, rasters: 0, directs: 0, scaleBlits: 0 };
export const flags = { bypass: false };   // bypass=true -> direct draw every frame (old behavior)
export function resetStats() { stats.blits = stats.rasters = stats.directs = stats.scaleBlits = 0; }

const dpr = () => window.devicePixelRatio || 1;

// draw(ctx, worldRect) strokes the layer's display model in WORLD coordinates onto a ctx whose
// transform is already set; worldRect {x,y,w,h} is the region being rastered — cull against it.
export function createCachedLayer({ id, before, draw }) {
    const canvas = document.createElement("canvas");
    canvas.id = id;
    canvas.className = "gcanvas";
    // GPU-accelerated by default (no willReadFrequently) — viewport-FIXED, never transformed.
    const ctx = canvas.getContext("2d");
    document.getElementById("graph").insertBefore(canvas, before);

    const cacheCanvas = document.createElement("canvas");   // detached, never in the DOM
    const cacheCtx = cacheCanvas.getContext("2d");
    // originDev*: cache rect's top-left in world-device coords (world · dpr · zoom), integer.
    const cache = { valid: false, zoom: 1, dpr: 1, originDevX: 0, originDevY: 0, mx: 0, my: 0 };

    let dirty = true;
    let quietTimer = 0, settleTimer = 0, prefetchRaf = 0;

    const layer = { canvas, cssW: 0, cssH: 0, render, markDirty, refit };

    function refit() {
        const r = canvas.getBoundingClientRect();
        const d = dpr();
        const w = Math.max(1, Math.round(r.width * d)), h = Math.max(1, Math.round(r.height * d));
        if (canvas.width !== w) canvas.width = w;
        if (canvas.height !== h) canvas.height = h;
        layer.cssW = r.width; layer.cssH = r.height;
        cache.valid = false;
    }
    refit();

    function markDirty() { dirty = true; cache.valid = false; }

    // world rect covered by a device-px rect at the current view (x0Dev/y0Dev in world-device px)
    const worldRect = (x0Dev, y0Dev, wDev, hDev, z, d) =>
        ({ x: x0Dev / (d * z), y: y0Dev / (d * z), w: wDev / (d * z), h: hDev / (d * z) });

    // Direct draw: today's path — world transform on the visible ctx, stroke everything visible.
    // Used while geometry is changing every frame (drag/morph) and for the bypass A/B switch.
    function direct() {
        const d = dpr();
        ctx.setTransform(d, 0, 0, d, 0, 0);
        ctx.clearRect(0, 0, layer.cssW, layer.cssH);
        const tx = Math.round(view.panX * d) / d, ty = Math.round(view.panY * d) / d;
        ctx.translate(tx, ty);
        ctx.scale(view.zoom, view.zoom);
        draw(ctx, worldRect(-Math.round(view.panX * d), -Math.round(view.panY * d), canvas.width, canvas.height, view.zoom, d));
        stats.directs++;
    }

    // Raster the viewport + margin into the offscreen cache at dpr·zoom, integer-snapped origin.
    function raster() {
        const d = dpr(), z = view.zoom;
        const vw = canvas.width, vh = canvas.height;
        const mx = Math.max(0, Math.min(Math.round(vw * MARGIN_FRAC), MAX_MARGIN_DEV, Math.floor((MAX_DIM_DEV - vw) / 2)));
        const my = Math.max(0, Math.min(Math.round(vh * MARGIN_FRAC), MAX_MARGIN_DEV, Math.floor((MAX_DIM_DEV - vh) / 2)));
        const cw = vw + 2 * mx, ch = vh + 2 * my;
        if (cacheCanvas.width !== cw) cacheCanvas.width = cw;
        if (cacheCanvas.height !== ch) cacheCanvas.height = ch;
        // viewport top-left in world-device coords is -round(pan·dpr) (integer); back off the margin
        const originDevX = -Math.round(view.panX * d) - mx;
        const originDevY = -Math.round(view.panY * d) - my;
        cacheCtx.setTransform(d * z, 0, 0, d * z, -originDevX, -originDevY);
        cacheCtx.clearRect(originDevX / (d * z), originDevY / (d * z), cw / (d * z), ch / (d * z));
        draw(cacheCtx, worldRect(originDevX, originDevY, cw, ch, z, d));
        cache.valid = true; cache.zoom = z; cache.dpr = d;
        cache.originDevX = originDevX; cache.originDevY = originDevY; cache.mx = mx; cache.my = my;
        stats.rasters++;
    }

    // Blit offset: destDev = worldDev + round(pan·dpr); cacheDev = worldDev - originDev
    // => dest = cacheDev + originDev + round(pan·dpr). Both terms integer -> crisp.
    const blitOffset = (d) => [cache.originDevX + Math.round(view.panX * d), cache.originDevY + Math.round(view.panY * d)];

    const covered = (dx, dy) =>
        dx <= 0 && dy <= 0 && dx + cacheCanvas.width >= canvas.width && dy + cacheCanvas.height >= canvas.height;

    function blit(dx, dy) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(cacheCanvas, dx, dy);
        stats.blits++;
    }

    // Zoom gesture: reuse the cached bitmap scaled by zoom/cache.zoom — momentarily soft, then the
    // settle timer re-rasters sharp. Offset is float here (blur is allowed anyway).
    function scaleBlit(k, d) {
        const dx = k * cache.originDevX + view.panX * d, dy = k * cache.originDevY + view.panY * d;
        if (!(dx <= 0 && dy <= 0 && dx + cacheCanvas.width * k >= canvas.width && dy + cacheCanvas.height * k >= canvas.height)) return false;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(cacheCanvas, dx, dy, cacheCanvas.width * k, cacheCanvas.height * k);
        stats.scaleBlits++;
        return true;
    }

    // Nearing the cache edge while panning: re-centre on a deferred one-shot rAF so the (rare)
    // raster hitch happens once per margin-length of travel, not on the frame that crosses it.
    function prefetchCheck(dx, dy) {
        if (prefetchRaf) return;
        const th = PREFETCH_FRAC;
        const need =
            (cache.mx > 0 && (-dx < cache.mx * th || dx + cacheCanvas.width - canvas.width < cache.mx * th)) ||
            (cache.my > 0 && (-dy < cache.my * th || dy + cacheCanvas.height - canvas.height < cache.my * th));
        if (!need) return;
        prefetchRaf = requestAnimationFrame(() => {
            prefetchRaf = 0;
            if (dirty || !cache.valid || cache.zoom !== view.zoom || cache.dpr !== dpr()) return;
            raster();
            const [nx, ny] = blitOffset(cache.dpr);
            blit(nx, ny);
        });
    }

    function render() {
        if (flags.bypass) { direct(); return; }
        if (dirty) {
            direct();
            // geometry is in flux — go back to cached blits QUIET_MS after the last dirty frame
            clearTimeout(quietTimer);
            quietTimer = setTimeout(() => { dirty = false; raster(); blit(...blitOffset(cache.dpr)); }, QUIET_MS);
            return;
        }
        const d = dpr();
        if (cache.valid && cache.dpr === d && cache.zoom !== view.zoom) {
            if (scaleBlit(view.zoom / cache.zoom, d)) {
                clearTimeout(settleTimer);
                settleTimer = setTimeout(() => {
                    if (dirty || flags.bypass) return;
                    raster(); blit(...blitOffset(cache.dpr));
                }, ZOOM_SETTLE_MS);
                return;
            }
            // scaled cache doesn't cover the viewport (big zoom-out) — fall through to a fresh raster
        }
        if (!cache.valid || cache.dpr !== d || cache.zoom !== view.zoom) { raster(); blit(...blitOffset(d)); return; }
        const [dx, dy] = blitOffset(d);
        if (!covered(dx, dy)) { raster(); blit(...blitOffset(d)); return; }   // prefetch missed
        blit(dx, dy);
        prefetchCheck(dx, dy);
    }

    return layer;
}
