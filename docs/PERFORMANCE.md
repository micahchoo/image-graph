# Rendering performance

Measured on 2026-09-20 against the installed build in the authorized Image
vault: 20,005 images, a 1521 × 958 canvas, `devicePixelRatio` 1. These are real
application frames, not a synthetic harness.

## What was wrong

A frame drew every image in the shown set, whatever the zoom. At the whole-vault
view that was **40,011 canvas calls** — one `fillRect` and one `drawImage` per
image — at about 3.2 µs each, whether the image landed on half a pixel or on
twelve. The connection loop culled nothing at all.

| Workload | Before | After |
| --- | --- | --- |
| Pan, whole vault, 20,005 images on screen | 14.9 fps, 67.2 ms per frame | **59.9 fps, 16.7 ms** |
| Pan, working zoom, 570 images on screen | 59.9 fps | 59.9 fps |
| Draw call, whole vault, while panning | 34.1 ms | **1.0 ms** |
| 20,000 connections, 19 images on screen | 19.3 ms | **1.5 ms** |
| 20,000 regions, 19 images on screen | 3.3 ms | 1.4 ms |
| Atlas pages retained | 79 of 79, unbounded | bounded at 96 MB |

## The three changes

**A cached tile layer.** Below the detail-thumbnail threshold every image is one
atlas tile, so `view.ts#tileLayer` renders them once into a bitmap covering the
viewport and a quarter-viewport margin, then blits it. Panning inside the margin
costs one `drawImage`. The layer is dropped when the scale, the position map,
the data version or the canvas size changes, and while an image is being
dragged. Selection rings and labels are drawn live over it, so a click never
rebuilds it; no image is wide enough for a label while the layer is in use.

The blit is done in device pixels under an identity transform. A fractional
offset would resample the whole mosaic on every pan and soften it.

The layer is painted with the background colour rather than cleared. Antialiased
fills blend against what is under them, so a transparent layer produced a
different result from the direct path; against an opaque background the two
agree.

How closely they agree depends on sub-pixel phase. Where the layer's camera lands
on the same phase as the frame's, the two are the same picture: maximum channel
difference 4 of 255, mean 0, no channel differing. At an arbitrary phase the
offscreen and onscreen rasterisers diverge slightly — mean 0.7 to 1.9 of 255,
with isolated edge pixels reaching about 110. That is reproducible across runs
and reads as a hair softer at 200% magnification: no shift, nothing missing.
It applies only below the detail threshold, where an image is at most 32 pixels
wide.

Measure this from a freshly reloaded renderer. After a probe allocated 240
large canvases, the aligned case reported a maximum difference of 110 rather
than 4 — the renderer had degraded, not the code.

**Connection culling.** `view.ts#spans` tests the union of an edge's two image
rectangles against the viewport before computing endpoints, stroking, or
measuring a label. A 240-pixel margin keeps a midpoint label that overhangs the
edge of the screen. Verified by framing a 1,960-unit connection with both of its
images off screen: the line still draws.

**Bounded atlas retention.** `overview.ts#evict` drops least-recently-used page
canvases past a 96 MB budget, matching `ThumbnailCache`. A page the frame being
drawn has just asked for is never dropped, so a full-vault redraw cannot evict
its own tiles. An evicted page reloads from its saved PNG, not from the
originals. Tested with 120 resident pages, 40 of them stale: 24 evicted to reach
the budget, none of the 80 recent ones, each evicted page reset so it reloads.

At 20,005 images the atlas holds 79 pages and nothing is evicted; the bound
changes nothing below roughly 24,000 images.

## Correctness of the cache

Three defects were found by auditing the changes above against the live build,
and fixed.

**Eviction could take a page out from under its own load.** `load()` holds the
page canvas across a yield every eight tiles, so a page loading for longer than
the grace window became the least-recently-used candidate. Releasing it left
`load()` drawing into a zeroed canvas, re-filling `ready`, marking the page
complete and saving that canvas. Eviction now skips loading and queued pages.
Reproduced with a page marked loading and a stale timestamp: it was released,
its canvas zeroed and its ready set cleared. After the fix it survives while 24
stale pages are released to reach the budget.

**The cached layer pinned the theme colours it was built with.** Every colour is
read from computed style per frame, so the direct path follows a theme change on
the next redraw; the layer did not, and a redraw alone would not correct it. The
colours are now part of the layer key, and `css-change` invalidates and
schedules a redraw — which the view did not listen for before, so a theme switch
left the whole canvas stale until something else redrew it.

**The layer outlived its document.** A view moved to a popout window keeps a
canvas belonging to the old one. The layer now records its document and is
released when that changes, and `onClose` zeroes the backing store rather than
dropping the reference. Reasoned and fixed, not exercised against a real popout.

Two invariants were checked rather than assumed. `forceLayout` always returns a
new map, so comparing map identity really does catch an exploration relayout.
`edgeEndpoints` clips every endpoint to its own image or to a region inside it,
so the union of the two image rectangles really does bound the line.

The status count still means what it meant: every position in view has an image
record, so counting positions and counting records agree at 6,565 of 20,005.
The 240-pixel label margin is against a longest real label of 75 pixels.

## Measure the frame, not the draw

`stats.drawMs` stops when the draw call returns, before the compositor
rasterises what it queued. It reported 34 ms for a frame that took 67 ms.
`stats.frameMs` now records the gap between draws, which is what a pan feels
like. Tune against that one.

Two measurement traps, both hit here: running the cached and direct paths
back-to-back in a single synchronous block starved the GPU and reported 6,010 ms
frames, six times any real value; and comparing renders while the atlas was
still decoding compared different content, not different code.

## What is still slow

Zooming the whole vault still costs about 67 ms per frame. Every frame of a
wheel gesture changes the scale, so no cached layer survives it, and the cost
falls back to the 40,011 calls. The layer is deliberately not built during a
zoom — `zoomCursor` and `pinch` gate it — which showed no measurable gain at
`devicePixelRatio` 1 but avoids allocating and discarding a full-viewport bitmap
per frame on a denser display.

Making zoom smooth needs a different technique: blit the existing layer scaled
by the ratio between the current and cached scale, blurred, and re-render when
the gesture settles. That is not done.

`refresh()` costs 3.8 ms on every store change and allocates 20,005 rectangle
copies. Cold start is about 177 ms before the first frame: `refreshCatalog()`
53 ms, `store.load()` 123 ms. Both are linear in vault size and neither is
user-visible at this size.

Region drawing iterates every region rather than the regions of visible images,
and `endpointAt` scans every shown image on each pointer press. Both measure
under 2 ms here and both grow with the collection, not the viewport.
