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
- neighborhood(snapshot, rootId, depth, expanded: Set<string>, relationFilter: string, limit?: number): Neighborhood
- Neighborhood has ids: string[], edges: EdgeRecord[], distances: Map<string,number>, parents: Map<string,{imageId:string;edge:EdgeRecord}>, capped: boolean
- tracePath(rootId, targetId, neighborhood): Array<{from:string;to:string;edge:EdgeRecord}>
- forceLayout(images: ImageRecord[], neighborhood, rootId, pinned: Set<string>, previous: Map<string,Rect>): Map<string,Rect>
- endpointPosition(endpoint: Endpoint, images: Map<string,Rect>, regions: Map<string,RegionRecord>): Point
- edgeEndpoints(edge, images, regions): boundary-clipped source and target points for drawing and hit detection
- containsRegion(point: Point, shape: RegionShape): boolean (point normalized to image)
- parseProperties(text: string): Properties (parseYaml, reject non-mapping/unsafe keys)

Export module src/export.ts exports GraphExporter:
- constructor(app: App)
- canvas(snapshot: GraphSnapshot, frame: ViewFrame): Promise<TFile>
- visual(snapshot: GraphSnapshot, frame: ViewFrame, source?: HTMLCanvasElement): Promise<TFile>

View module src/view.ts exports VIEW_TYPE = 'image-graph-view' and ImageGraphView extends ItemView:
- constructor(leaf: WorkspaceLeaf, host: GraphHost)
- focusImage(imageId: string): void
- exploreImage(imageId: string): void
- all edits via GraphHost; subscribe/unsubscribe lifecycle managed
- Keyboard/context actions, mobile tap/long-press/pinch, slim inspector from prototype.
- Normalized rectangle and polygon regions, whole-image/region edges, arbitrary YAML with relation label, optional arrows.
- Whole vault uses cached overview atlas tiles at low zoom and bounded, adaptive detail thumbnails for visible images.
- Navigate mode pans even over images. Move images mode changes positions and snaps whole-vault top-left coordinates to a 40px grid.
- Properties use a typed builder with plain-language labels. Serialized metadata remains arbitrary YAML-compatible data.
- Exploration 1/2/3 hops, selective expansion, pins, relation filter, paths. Separate temporary layout restores whole-vault positions/camera.
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
