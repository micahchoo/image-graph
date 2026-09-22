# Image Graph implementation contracts

These are the module boundaries the production code holds to. Drawing and hit
detection are plain canvas work: no OpenSeadragon, no Annotorious.

Shared types live in `src/types.ts`. Treat every signature below as a contract;
changing one means changing its consumers in the same pass.

Roles (src/types.ts) — GraphData, GraphEdits, ImageAssets, BackgroundJobs, VaultDoors, AnnotationBridge:
- GraphHost is their union, so the plugin implements one thing; a collaborator takes only the role it needs and is handed a stub in a test.
- Split because a single 33-member interface had come to mirror the plugin's public surface rather than the workspace's need: imageUrl, resumeJobs and updateImage were on it although nothing across the seam called them.

Canvas renderer src/canvas-renderer.ts exports CanvasRenderer, FrameState and Palette:
- One frame of the live canvas. Everything it draws comes from the GraphScene it is handed and the FrameState of that frame; it owns only its caches — the tile mosaic and the version that invalidates it.
- Reads no DOM but the document it makes a detached canvas in, so tests/fake-canvas.ts drives it and reads back the calls.
- The richer sibling of render.ts#renderScene (still images for note embeds and PNG export). The two agree on culling, palette and captions because both read geometry.ts and presentation.ts; they part company over caching, hover, drafts and routed connections, which only a live canvas has.
- A connection is only NAMED when it is relevant — selected, hovered, on the traced path, or matching the filter. Every connection is still drawn.

Catalog module src/catalog.ts exports nextCatalog, isCatalogImage and stableId:
- Pure. The whole-vault layout is derived, not stored: one record per image file, each as wide as its own picture, wrapped into rows in path order.
- A placed image keeps its position and takes no slot in the rows. A record whose file has gone is marked missing, never dropped. An id is a function of the path.

Scene module src/scene.ts exports GraphScene, Hit, ROUTE_LIMIT and REACH:
- What is on screen, where it is, and what is under a point. NOT where we are looking — that is the camera, deliberately elsewhere.
- Takes `Pick<GraphData,'getSnapshot'>`, so it needs no DOM and no Obsidian and is driven directly by tests/scene.test.ts.
- Owns the routed polylines, because route() answers what a connection is drawn along and hit() must measure that same polyline. Keeping them apart is how a click came to select empty canvas beside a line and refuse the line itself.
- view.ts holds one GraphScene and delegates; it keeps the camera, the drag, the drawing and the chrome.

Shards module src/shards.ts exports ShardStore, shardIndex, shardPath, parseShardName, parseShard, validateRecord:
- The only place that knows the on-disk format. GraphStore above it deals in records and never in paths, JSON or versions.
- A record's id decides its shard, so nothing renumbers anything. Writes go through vault.process, so two writes on one shard merge rather than one losing.
- validateRecord is liberal on read and strict on write: one hand-edited field must not stop a whole shard loading.

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

The graph is four pure modules (one file, graph.ts, until 2026-09-21; none imports obsidian):
- src/traversal.ts — neighborhood(snapshot, rootId, depth, expanded: Set<string>, limit?: number): Neighborhood — no relation filter; one relation is relationNeighborhood, and dimming is presentation.ts. Neighborhood has ids: string[], edges: EdgeRecord[], distances: Map<string,number>, parents: Map<string,{imageId:string;edge:EdgeRecord}>, capped: boolean. tracePath(rootId, targetId, neighborhood): Array<{from:string;to:string;edge:EdgeRecord}>. relationNames(snapshot).
- src/force-layout.ts — forceLayout(images: ImageRecord[], neighborhood, rootId, pinned: Set<string>, previous: Map<string,Rect>): Map<string,Rect>; hopRadii.
- src/edge-endpoints.ts — endpointPosition(endpoint: Endpoint, images: Map<string,Rect>, regions: Map<string,RegionRecord>): Point; edgeEndpoints(edge, images, regions): boundary-clipped source and target points for drawing and hit detection.
- src/region-shape.ts — parseRegionShape, regionHandles, resizeRegion, containsRegion(point: Point, shape: RegionShape): boolean (point normalized to image).
- relationOf(properties) lives in properties.ts with the rest of what a property may hold; parseProperties is the only reader of a property value.
- One Palette (presentation.ts) serves the live canvas and the still renderer, with the theme's font; ROUTE_LIMIT and ROUTE_MIN_SCALE are routing.ts's.

Exploration module src/exploration.ts exports Exploration and EXPLORE_LIMIT:
- Exploration.fromImages(snapshot, imageIds, savedCamera) and .fromRelation(snapshot, relation, savedCamera) return null rather than an empty view.
- anchor is the one starting picture; two or more roots, or a relation, anchor nothing. countsHops is false for a relation.
- isRoot is a starting picture (ringed, never a path's far end); isAnchor is the one image never moved or pinned. togglePin and pin refuse only the anchor.
- setDepth clamps to 1..3 and clears expanded; expand is a no-op for a relation. Both mark the question changed.
- rebuild(snapshot) recomputes the graph and the layout. After a changed question every unpinned image settles again from where it was; otherwise every placed image is held and only newcomers are placed, so a vault change moves nothing.
- pathTo(imageId) traces back to whichever root reached the image. The traversal caps starting images along with the rest.
- filter dims connections and never reaches the traversal. EXPLORE_LIMIT is the one cap, and the status text reads it.
- New exploration behaviour goes here, not in the view. The view keeps the camera, the selection and the two select elements.

Gestures module src/gestures.ts exports Mode, DRAG_THRESHOLD, movedEnough, pressIntent, dragBecomes, pinchFrom and pinchStep:
- A press is ambiguous until it moves. pressIntent says what it arms (marquee, handle, plain); dragBecomes says what it turns into once it passes DRAG_THRESHOLD.
- dragBecomes is total: `pan` is the answer to everything unclaimed, because an unrecognised drag on a map must move the map rather than do nothing. A connection cannot be dragged, so a press on one pans.
- Mode lives here, not in view.ts: what a drag means is the gesture's question.
- pinchStep reports the spread and the slide together, because fingers do both at once, and zooms about the previous centre so the two do not fight.
- Decisions only: no DOM, no camera, no records. view.ts does the effects.

Camera module src/camera.ts exports toWorld, toScreen, viewportRect, zoomAt, scrollBy, fitBox, boxAround, scrollIntoView, wheelGesture and spansViewport:
- Every function is pure and returns a new Camera; nothing here mutates the one it is given. Screen coordinates are relative to the canvas, never the client — only the caller knows where the element is.
- zoomAt holds the world point under `at` fixed, including when the scale clamps. That fixed point is the contract.
- fitBox is the one answer to "what camera shows this box". embed.ts#fitCamera is the same call with a block's padding and zoom limits; the workspace passes its own.
- boxAround makes the symmetric box an anchored neighbourhood needs, so a fit keeps the starting picture centred without pushing half the graph off screen.
- wheelGesture takes WheelInput as data, not a DOM event: deltaMode 1 is lines and 2 is screens, ctrl or meta zooms, shift pans a one-axis wheel sideways.
- spansViewport is written out rather than built from boundsOf: it runs once per connection per frame and must allocate nothing.
- view.ts holds the Camera and the element; it asks this module for every value it puts there.

Folders module src/folders.ts exports ensureFolder, THUMBNAILS_ROOT, EXPORTS_ROOT and DATA_ROOT:
- ensureFolder(app, path) is the only caller of vault.createFolder. It makes every missing parent and treats a lost race as success, because the folder is there either way; a folder still missing afterwards is a real failure and throws.
- Every plugin folder is named here or in links.ts (PLUGIN_ROOT, NOTES_ROOT, EXTRACTED_ROOT). main.ts#scheduleRefresh matches vault changes against those names, not against literals, so a renamed folder cannot silently stop being watched.
- OLD_NOTES_ROOT stays a literal on purpose: it names where an older version filed notes and must never follow a rename.

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
- exploreImage(imageId: string): void; exploreImages(imageIds): every picture of a selection, none anchored
- all edits via GraphHost; subscribe/unsubscribe lifecycle managed
- Keyboard/context actions, mobile tap/long-press/pinch, slim inspector from prototype.
- Normalized rectangle and polygon regions, whole-image/region edges, arbitrary YAML with relation label, optional arrows.
- Whole vault uses cached overview atlas tiles at low zoom and bounded, adaptive detail thumbnails for visible images.
- Navigate mode pans even over images. Move images mode changes positions and snaps whole-vault top-left coordinates to a 40px grid.
- Wheel scrolls, ctrl/meta wheel zooms, deltaMode normalized. Shift-drag selects a band; dragging one selected image carries the selection.
- Hover is read once per frame inside draw(), never per pointermove, and frozen while a gesture owns the pointer. pointerDown re-reads instead.
- A selected region draws grips above 48 screen pixels; dragging one resizes through region-shape.ts#resizeRegion from the shape the drag began with.
- Properties use a typed builder with plain-language labels. Serialized metadata remains arbitrary YAML-compatible data.
- Exploration state and its transitions live in src/exploration.ts; the view holds one `Exploration | null`, restores the saved camera on exit, and syncs the depth and relation controls.
- Export whole/current/selected images using ViewFrame. Visual export is current viewport; ordinary Canvas cannot preserve region endpoints.
- Constructor/onOpen must not block whole vault with image loads or thousands of metadata writes.

For installed-build checks, the view type is `image-graph-view`, not `image-graph`.
Read only needed fields from `debugState()` because a whole-vault frame can contain tens of thousands of positions.
See [the runtime report](docs/verification.md) for verified behavior and limits.

Root agent owns package/config/types/main.ts/thumbnails.ts/docs and installation/runtime testing.
Agent 1 owns store.ts and storage tests only.
Agent 2 owns traversal.ts/force-layout.ts/edge-endpoints.ts/region-shape.ts/export.ts and their tests only.
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
