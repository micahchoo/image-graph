# Development verification

Desktop checks used Obsidian 1.13.7 and the authorized Image vault on September 20, 2026.
The starting vault contained 20,000 generated images, each 2048 × 2048 pixels.
These results describe local development, not Community plugin approval.

## Automated checks

TypeScript, the Obsidian ESLint configuration, and the production build passed.
All 36 tests passed across seven test files.
The test suite covers storage, graph traversal, endpoint geometry, thumbnail caches, extraction placement, and property validation.

## Checks inside Obsidian

- All 20,000 overview thumbnails loaded with two concurrent image decoders.
- Navigation preserved loaded thumbnails. Adding an extracted image preserved existing thumbnails.
- Reloading reused saved atlas pages instead of decoding every source again.
- Dragging in Navigate mode moved the viewport without moving the image record.
- Dragging in Move images mode snapped the image's top-left corner to the grid.
- A polygon completed through the Finish polygon control and saved inside its parent image.
- Typed properties saved through the properties panel.
- New property rows focused the name field. Blank numbers failed validation, and switching to Text recovered without an error.
- A relation filter preserved the three-hop neighborhood while highlighting matching connections.
- Extraction created a visible image, source metadata, and a “derived from” connection.
- Existing extracted images gained missing provenance connections.
- Editable exports contained valid image references and opened in native Canvas.
- Whole-vault, exploration, and selected-image exports produced the expected node sets.
- A visual snapshot preserved the visible region outlines and connections.

Automation used actual application controls and saved records.
Early pointer checks used synthetic DOM events within one evaluation and produced pointer-capture errors at 19:58 and 20:02.
Later work replaced them with `dev:cdp` input dispatch, which the canvas receives as trusted mouse events.
The error log recorded no further entries after 20:02.

## Documentation recording

Five recordings are in [the workflow recordings](workflows/README.md): draw a region, make an image from a region, connect two images, explore connections, and edit properties.
Each state was confirmed through `ImageGraphView.debugState()` and the saved record, not through the control that caused it.
The main agent reviewed every contact sheet and the full-size frames of each first, last, and middle state.
Drags, wheel zooms, typing, and a depth-control key press all used trusted input; none produced an error.
The clips show desktop mouse behavior only. They do not establish touch, stylus, or mobile behavior.
Earlier pan and polygon recordings failed review and remain excluded from the documentation.

## Release 0.1.0

`npm ci` installed the locked graph without changing it under npm 10.9.9 and npm 11.16.0.
`npm run release:verify` passed on both: lint, TypeScript, 36 Vitest tests, 4 release tests, the production build, and an asset check that allows exactly `main.js`, `manifest.json`, and `styles.css`.
CI repeated both legs on Node 22 and the release workflow repeated them again at the tag.

The three published assets are byte-identical to the locally built ones, so the build reproduced across machines.
`gh attestation verify` accepted each against a SLSA provenance statement from `release.yml` in this repository.
Reinstalling the downloaded files in the development vault loaded version 0.1.0 with no errors and a computed view padding of `0px`, which is the scoped selector that replaced an `!important`.

The stylesheet is now one file. `property-builder.css` was merged into `styles.css` and the build copies it unchanged, so a stale build is a checked mismatch rather than a silent difference.

`minAppVersion` is 1.8.7. The Obsidian APIs used are `Plugin`, `ItemView`, `Menu`, `Notice`, `TFile`, `TFolder`, `parseYaml`, `normalizePath`, and the `vault`, `workspace`, and `fileManager` calls listed in the source; all predate that version. No Node or Electron module is imported, which is what `isDesktopOnly: false` rests on.

## Rendering performance

Whole-vault panning went from 14.9 fps to 59.9 fps, and a connection loop that culled nothing went from 19.3 ms to 1.5 ms at 20,000 edges.
Atlas page retention is now bounded at 96 MB instead of growing with the vault.
Evidence, method and remaining limits: [rendering performance](PERFORMANCE.md).
The cached tile layer was compared against the direct path pixel by pixel: identical where the sub-pixel phases align, and a mean of 1 to 2 of 255 elsewhere.
An audit of those changes found and fixed three defects: eviction releasing a page its own load still held, the layer pinning stale theme colours, and the layer outliving a popout document.

## Canvas interaction, 0.2.0

Every gesture below was driven through `Input.dispatchMouseEvent` and
`Input.dispatchKeyEvent`, so the canvas received trusted events, against the
installed build in the vault of 20,005 images.

| Gesture | Observed |
| --- | --- |
| Wheel, no modifier | Camera panned by the delta on both axes |
| `Ctrl` and wheel | Scale went 0.0200 to 0.0287 about the pointer |
| Shift-drag across the mosaic | 242 images selected, one band drawn, drag released clean |
| Pointer resting on an image, then inside its region | Reported image, then region; cursor `target` |
| Pointer resting on the `se` grip of a selected region | Reported grip `se`; cursor `grip` |
| Dragging that grip | Width 0.40 to 0.58 live, saved once on release, draft cleared |
| Dragging one of four selected images | All four moved by the same offset |
| `ArrowRight`, then `Shift` and `ArrowDown` | Moved 40, then 200 |
| Arrow with nothing selected | Camera panned; no image moved |
| `?` then `Escape` | Panel opened with 4 groups and 24 rows, then closed |

The selection states the 0.1.0 model could reach were re-run and are gone:
shift-clicking a connection while an image is selected now reports
`{kind: edge, images: 0}`, and a region selection always carries its image.

Two defects were found by these runs and fixed before the release. Hover updated
only while a button was held, because `pointerMove` returns early for a pointer
it is not tracking. The first spatial index made whole-vault panning 21 times
slower than no index, which `docs/PERFORMANCE.md` records in full.

The clips and these runs show desktop mouse and keyboard behaviour only. Touch,
stylus, and mobile pointer behaviour are still unverified.

## Exploration clarity update — September 20, 2026

The layout update passed 76 Vitest tests and the release-script test.
TypeScript, ESLint, the production build, and the release asset check passed.
The build was installed and reloaded in Image vault.

The three-hop runtime check displayed 16 connected images.
Measured center distances formed separate bands: 328–634, 768–883, and 1115–1254 world units.
Crop captions showed region names rather than generated file IDs.
The [reviewed screenshot](decluttered-exploration.png) shows a selected connection, faint background links, and separated captions.

Added tests cover three-hop spacing, a 150-image neighborhood, selective labels, filter/path emphasis, and readable crop captions.
User-pinned positions remain fixed, even if their manual placement overlaps another card.
Existing workflow GIFs predate this visual update.

## Remaining limits

Physical mobile interaction and multi-device synchronization remain unverified.
`isDesktopOnly: false` rests on the absence of desktop-only imports, not on a device test.
Tests with generated images do not establish performance for every image format, file size, or graph density.
An earlier workstation crash has no confirmed attribution to Obsidian or this plugin.
