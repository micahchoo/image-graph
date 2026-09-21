# Image Graph implementation contracts

These are the module boundaries the production code holds to. Drawing and hit
detection are plain canvas work: no OpenSeadragon, no Annotorious.

Shared types live in `src/types.ts`. Treat every signature below as a contract;
changing one means changing its consumers in the same pass.

Storage module src/store.ts exports GraphStore:
- constructor(app: App, changed: () => void)
- load(): Promise<void>; refreshCatalog(): Promise<void>; getSnapshot(): GraphSnapshot
- upsertImage(image: ImageRecord): Promise<void>
- upsertRegion(region: RegionRecord): Promise<void>; removeRegion(id: string): Promise<void>
- upsertEdge(edge: EdgeRecord): Promise<void>; removeEdge(id: string): Promise<void>
- ensureCompanion(imageId: string): Promise<TFile>
- readMetadata(imageId: string): Promise<Properties>; writeMetadata(imageId: string, properties: Properties): Promise<void>
- renamePath(oldPath: string, newPath: string): Promise<void>
- flush(): Promise<void>

Graph module src/graph.ts exports:
- neighborhood(snapshot, rootId, depth, expanded: Set<string>, limit?: number): Neighborhood — no relation filter; one relation is relationNeighborhood, and dimming is presentation.ts
- Neighborhood has ids: string[], edges: EdgeRecord[], distances: Map<string,number>, parents: Map<string,{imageId:string;edge:EdgeRecord}>, capped: boolean
- tracePath(rootId, targetId, neighborhood): Array<{from:string;to:string;edge:EdgeRecord}>
- forceLayout(images: ImageRecord[], neighborhood, rootId, pinned: Set<string>, previous: Map<string,Rect>): Map<string,Rect>
- endpointPosition(endpoint: Endpoint, images: Map<string,Rect>, regions: Map<string,RegionRecord>): Point
- edgeEndpoints(edge, images, regions): boundary-clipped source and target points for drawing and hit detection
- containsRegion(point: Point, shape: RegionShape): boolean (point normalized to image)
- graph.ts imports nothing from obsidian. What a property may hold is properties.ts#parseProperties, and only that.

Exploration module src/exploration.ts exports Exploration and EXPLORE_LIMIT:
- Exploration.fromImages(snapshot, imageIds, savedCamera) and .fromRelation(snapshot, relation, savedCamera) return null rather than an empty view.
- anchor is the one starting picture; two roots or a relation anchor nothing. countsHops is false for a relation.
- setDepth clamps to 1..3 and clears expanded; expand/togglePin/pin/isRoot hold the rest. rebuild(snapshot) recomputes the graph and the layout.
- filter dims connections and never reaches the traversal. EXPLORE_LIMIT is the one cap, and the status text reads it.
- New exploration behaviour goes here, not in the view. The view keeps the camera, the selection and the two select elements.

Geometry module src/geometry.ts exports overlaps, onScreen and boundsOf:
- The single answer to "do these share area", "does this reach the viewport" and "what box holds these".
- The canvas, the note embed, the PNG export and the still renderer must agree, or an export shows what the view culled.
- view.ts#spans keeps its own union test on purpose: it runs per edge per frame and must allocate nothing.

Extraction module src/extraction.ts exports findExtractionPosition, regionCrop and MAX_EXTRACT_SIDE:
- regionCrop(shape, naturalWidth, naturalHeight, maxSide?) is the whole rule: bound a polygon by its corners, hold the crop inside the picture, refuse a region with no area, cap the longer side.
- findExtractionPosition places the result on the 40px grid, clear of every other image.
- extractionPath(label, parentPath, exists) names the file `<label> · <source>.png` under `_Image Graph/Extracted/`, numbering past a taken name.

Annotations module src/annotations.ts exports readAnnotationIndex, annotationRegionId, annotationId, isForeignRegion and annotationPlugin:
- readAnnotationIndex(text, imageIdByPath) turns Image Annotation's `index.json` into RegionRecords with `origin: 'image-annotation'` and `ia-` ids, plus per-region attachments and per-image sources. A region whose image is not catalogued is skipped and counted; a malformed record is skipped; a file that is not an index throws.
- GraphStore.setForeignRegions holds them beside its own; upsertRegion and removeRegion refuse a foreign id; nothing foreign is written to a shard or the history. removeDanglingRegionEdges is the undoable way out when Image Annotation deletes a region.
- annotationPlugin(app) finds the loaded plugin instance by duck-typing openRegion and openImage, at click time only. Absent means no menu item.
- links.ts#annotationLinks and #attachmentLink produce the `annotations` property (reserved) and the extracted companion's `source_notes`. syncAnnotationLinks writes into companions that already exist and never creates one.

Export module src/export.ts exports GraphExporter:
- constructor(app: App)
- canvas(snapshot: GraphSnapshot, frame: ViewFrame): Promise<TFile>
- visual(snapshot: GraphSnapshot, frame: ViewFrame, source?: HTMLCanvasElement): Promise<TFile>

Selection module src/selection.ts exports Selection and its transitions:
- Selection = none | images | region | edge. A region carries its image; an edge carries none.
- selectTarget/prune/keepImages/imageSelection/selectedImages are pure; the view holds one Selection and one cached image set.
- Never add a second selection field. The two defects this replaced were both a disagreement between parallel fields.

Spatial module src/spatial.ts exports SpatialIndex(order, positions):
- query(rect) and at(point) answer in paint order; the renderer, region drawing and endpointAt all read it.
- Three paths by window size: whole layout returns the id list, most of the grid runs one scan, a small window walks buckets.
- Rebuilt only when the id list or position map changes identity, or view.ts#indexVersion is bumped for an in-place move.

Shortcuts module src/shortcuts.ts exports Command, commandFor, swallows and SHORTCUTS:
- commandFor maps a KeyboardEvent to a Command; view.ts#obey switches over it exhaustively, so a new Command must be handled.
- SHORTCUTS is the `?` panel. A new key needs a row there as well as a branch in obey.

View module src/view.ts exports VIEW_TYPE = 'image-graph-view' and ImageGraphView extends ItemView:
- constructor(leaf: WorkspaceLeaf, host: GraphHost)
- focusImage(imageId: string): void
- exploreImage(imageId: string): void
- all edits via GraphHost; subscribe/unsubscribe lifecycle managed
- Keyboard/context actions, mobile tap/long-press/pinch, slim inspector from prototype.
- Normalized rectangle and polygon regions, whole-image/region edges, arbitrary YAML with relation label, optional arrows.
- Whole vault uses cached overview atlas tiles at low zoom and bounded, adaptive detail thumbnails for visible images.
- Navigate mode pans even over images. Move images mode changes positions and snaps whole-vault top-left coordinates to a 40px grid.
- Wheel scrolls, ctrl/meta wheel zooms, deltaMode normalized. Shift-drag selects a band; dragging one selected image carries the selection.
- Hover is read once per frame inside draw(), never per pointermove, and frozen while a gesture owns the pointer. pointerDown re-reads instead.
- A selected region draws grips above 48 screen pixels; dragging one resizes through graph.ts#resizeRegion from the shape the drag began with.
- Properties use a typed builder with plain-language labels. Serialized metadata remains arbitrary YAML-compatible data.
- Exploration state and its transitions live in src/exploration.ts; the view holds one `Exploration | null`, restores the saved camera on exit, and syncs the depth and relation controls.
- Export whole/current/selected images using ViewFrame. Visual export is current viewport; ordinary Canvas cannot preserve region endpoints.
- Constructor/onOpen must not block whole vault with image loads or thousands of metadata writes.

For installed-build checks, the view type is `image-graph-view`, not `image-graph`.
Read only needed fields from `debugState()` because a whole-vault frame can contain tens of thousands of positions.
See [the runtime report](docs/verification.md) for verified behavior and limits.

Root agent owns package/config/types/main.ts/thumbnails.ts/docs and installation/runtime testing.
Agent 1 owns store.ts and storage tests only.
Agent 2 owns graph.ts/export.ts and their tests only.
Agent 3 owns view.ts/styles.css and view-specific modules only.

Use Obsidian public APIs, lifecycle disposal, no unsafe any, no broad ESLint disables. Required checks: npm run check, npm run lint, npm test, npm run build. Meaningful behavioral tests for persistence, geometry/traversal, export mapping; no mirrored UI tests.

## Build from source

```sh
npm ci
npm run release:verify
```

`release:verify` runs lint, TypeScript, both test suites, the production build,
and the release packaging check. It stages `main.js`, `manifest.json`, and
`styles.css` in `release/`.

To try the build in a vault, copy those three files into
`<vault>/.obsidian/plugins/image-graph/` and enable **Image Graph** under
Community plugins.

## Release

Bump `manifest.json`, `package.json`, `package-lock.json`, and `versions.json`
together, write `docs/RELEASE-NOTES.md`, then push a bare semver tag. The tag
fires `.github/workflows/release.yml`, which reruns every check, attests the
build provenance, and uploads exactly the three install files. Never cut a
release by hand; a hand-cut release carries no attestation.
