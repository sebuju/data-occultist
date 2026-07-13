// Canvas re-implementations of the SVG edge end-cap markers (index.html #defs). Each marker is
// stamped at a line endpoint, oriented to the end segment, and sized in WORLD units — exactly
// like the SVG markers (all markerUnits="userSpaceOnUse", so they scale with the #gworld zoom;
// the canvas ctx is already world-scaled, so marker sizes are plain world units here too).
//
// Geometry is transcribed 1:1 from the SVG defs (viewBox / markerWidth / refX / path) so the
// canvas glyphs land pixel-for-pixel where the SVG ones did. Only the markers actually wired to
// an edge kind are implemented (flowarrow / squarecap / portcap[-sel] / hexcap / watchcap); the
// unused palette in the defs is dead and gets deleted with the SVG at the full-sweep step.
//
// A def: { vb:[w,h], size:[mw,mh], ref:[rx,ry], draw(ctx, color, selColor) }. draw() issues path
// commands in VIEWBOX coordinates; stamp() sets up the transform that maps the ref point onto the
// endpoint, rotates to the segment angle, and scales viewBox → world.

const SEL_RING = 0.75;   // portcap-sel ring width, in viewBox units (matches .portcap-ring)

export const MARKERS = {
    // data-flow arrow — filled triangle centred on the endpoint (refX5). auto-start-reverse in
    // SVG only matters as a start cap; here it is always an end cap, orient auto.
    flowarrow: {
        vb: [10, 10], size: [8, 8], ref: [5, 5],
        draw(ctx, color) {
            ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(10, 5); ctx.lineTo(0, 10); ctx.closePath();
            ctx.fillStyle = color; ctx.fill();
        },
    },
    // default cap on both ends — small filled square.
    squarecap: {
        vb: [10, 10], size: [7, 7], ref: [5, 5],
        draw(ctx, color) {
            ctx.beginPath(); ctx.rect(2, 2, 6, 6);
            ctx.fillStyle = color; ctx.fill();
        },
    },
    // out-port dot — filled circle, the START cap of every line leaving an out-port.
    portcap: {
        vb: [10, 10], size: [8, 8], ref: [5, 5],
        draw(ctx, color) {
            ctx.beginPath(); ctx.arc(5, 5, 5, 0, Math.PI * 2);
            ctx.fillStyle = color; ctx.fill();
        },
    },
    // selected variant — grown circle (viewBox 12) + a crisp --sel ring.
    "portcap-sel": {
        vb: [12, 12], size: [12, 12], ref: [6, 6],
        draw(ctx, color, selColor) {
            ctx.beginPath(); ctx.arc(6, 6, 5, 0, Math.PI * 2);
            ctx.fillStyle = color; ctx.fill();
            ctx.lineWidth = SEL_RING; ctx.strokeStyle = selColor; ctx.stroke();
        },
    },
    // trigger "fires" line end — filled hexagon centred on the node edge (refX8 = centre5 + inset3).
    hexcap: {
        vb: [10, 10], size: [11, 11], ref: [8, 5],
        draw(ctx, color) {
            ctx.beginPath();
            ctx.moveTo(9, 5); ctx.lineTo(7, 8.46); ctx.lineTo(3, 8.46);
            ctx.lineTo(1, 5); ctx.lineTo(3, 1.54); ctx.lineTo(7, 1.54); ctx.closePath();
            ctx.fillStyle = color; ctx.fill();
        },
    },
    // on_change watch line end — filled diamond (refX8 = centre5 + inset3).
    watchcap: {
        vb: [10, 10], size: [11, 11], ref: [8, 5],
        draw(ctx, color) {
            ctx.beginPath(); ctx.moveTo(0, 5); ctx.lineTo(5, 0); ctx.lineTo(10, 5); ctx.lineTo(5, 10); ctx.closePath();
            ctx.fillStyle = color; ctx.fill();
        },
    },
};

// Stamp marker `name` at world point (px,py), rotated so the marker's +x axis aligns with
// `angle` (the segment direction), coloured `color` (the line's colour) with `selColor` for the
// selection ring. No-op for an unknown/none name.
export function stampMarker(ctx, name, px, py, angle, color, selColor) {
    const m = MARKERS[name];
    if (!m) return;
    const [vbW, vbH] = m.vb, [mw, mh] = m.size, [rx, ry] = m.ref;
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(angle);
    ctx.scale(mw / vbW, mh / vbH);
    ctx.translate(-rx, -ry);
    m.draw(ctx, color, selColor);
    ctx.restore();
}
