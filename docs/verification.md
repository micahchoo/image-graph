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

## Limits

Physical mobile interaction and multi-device synchronization remain unverified.
Tests with generated images do not establish performance for every image format, file size, or graph density.
An earlier workstation crash has no confirmed attribution to Obsidian or this plugin.
