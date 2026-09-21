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
agree. Measured across the canvas, maximum channel difference 4 of 255, mean 0.

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
