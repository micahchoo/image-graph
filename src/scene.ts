import type {EdgeRecord, Endpoint, GraphData, GraphSnapshot, ImageRecord, Point, Rect, RegionRecord} from './types';
import {containsRegion} from './graph';
import {Exploration} from './exploration';
import {boundsOf} from './geometry';
import {imageCaptions} from './presentation';
import {LANE, distanceToPath, routeOrthogonal} from './routing';
import {SpatialIndex} from './spatial';
import {NOTHING, prune, selectTarget, selectedImages, type Selection} from './selection';

/** What a pointer resolved to: a picture or one of its regions, or a connection. */
export type Hit = {endpoint: Endpoint} | {edge: EdgeRecord};

/** Above this many connections on screen, routing costs more than the tangle it removes. */
export const ROUTE_LIMIT = 240;
/** How near the pointer must come to a connection, in screen pixels. */
export const REACH = 7;
/** Whole-vault positions snap to this grid. */
const GRID = 40;

const copy = (r: Rect): Rect => ({x: r.x, y: r.y, width: r.width, height: r.height});

/**
 * What is on screen, where it is, and what is under a given point.
 *
 * Not *where we are looking* — that is the camera, and it is deliberately not here. This holds
 * the graph as last read, the layout it has (the derived whole-vault rows, or an exploration's
 * own), the grid over that layout, the selection, and the routed polylines. It needs no DOM and
 * no Obsidian: it takes `GraphData`, which is two methods.
 *
 * The routes live here rather than with the renderer because two callers must agree about them.
 * `route()` answers what a connection is drawn along and `hit()` measures that same polyline; a
 * frame that fell back to straight lines leaves routes in the cache it did not use, so `routed`
 * carries the last frame's answer and both read it. Keeping them apart is how a click came to
 * select empty canvas beside a line and refuse the line itself.
 */
export class GraphScene {
 private data: GraphSnapshot = {images: [], regions: [], edges: []};
 private byId = new Map<string, ImageRecord>();
 private regionById = new Map<string, RegionRecord>();
 private byImage = new Map<string, RegionRecord[]>();
 private names = new Map<string, string>();
 private wholePositions = new Map<string, Rect>();
 private wholeIds: readonly string[] = [];
 private index: {ids: readonly string[]; positions: Map<string, Rect>; version: number; value: SpatialIndex} | null = null;
 /** Bumped where a position map is changed in place rather than replaced. */
 private version = 0;
 /** `Point[]` routed, `null` the router declined, absent not computed. Only the first may be measured. */
 private routes = new Map<string, Point[] | null>();
 private routing = false;
 private current: Selection = NOTHING;
 private currentImages: ReadonlySet<string> = selectedImages(NOTHING);

 /** What is on screen instead of the vault, or null in the whole-vault view. */
 exploration: Exploration | null = null;

 constructor(private readonly host: Pick<GraphData, 'getSnapshot'>) {}

 // ---- the graph as last read -------------------------------------------------------------

 get snapshot(): GraphSnapshot { return this.data; }
 get images(): ReadonlyMap<string, ImageRecord> { return this.byId; }
 get regions(): ReadonlyMap<string, RegionRecord> { return this.regionById; }
 regionsOf(imageId: string): readonly RegionRecord[] { return this.byImage.get(imageId) ?? []; }
 caption(imageId: string): string { return this.names.get(imageId) ?? 'Image'; }

 /**
  * Take the graph again and derive everything from it.
  *
  * The whole-vault layout is a copy of each record's own rectangle, because a drag writes into
  * the map and must not reach the snapshot. A selection whose image has gone is dropped.
  */
 refresh(): void {
  this.data = this.host.getSnapshot();
  this.byId = new Map(this.data.images.map(image => [image.id, image]));
  this.regionById = new Map(this.data.regions.map(region => [region.id, region]));
  this.byImage.clear();
  for (const region of this.data.regions) {
   const list = this.byImage.get(region.imageId);
   if (list) list.push(region); else this.byImage.set(region.imageId, [region]);
  }
  this.names = imageCaptions(this.data.images, this.data.regions, this.data.edges);
  this.wholePositions = new Map(this.data.images.map(image => [image.id, copy(image)]));
  this.wholeIds = this.data.images.map(image => image.id);
  this.pruneSelection();
 }

 // ---- what is shown ----------------------------------------------------------------------

 /** The live layout. A drag writes into this map, so it is never replaced by a reader. */
 get positions(): Map<string, Rect> { return this.exploration?.positions ?? this.wholePositions; }
 shownIds(): readonly string[] { return this.exploration?.graph.ids ?? this.wholeIds; }
 shownEdges(): readonly EdgeRecord[] { return this.exploration?.graph.edges ?? this.data.edges; }

 /** The grid over the shown rectangles. Rebuilt when the layout changes, never per frame. */
 spatial(): SpatialIndex {
  const ids = this.shownIds(), positions = this.positions, held = this.index;
  if (held && held.ids === ids && held.positions === positions && held.version === this.version) return held.value;
  const value = new SpatialIndex(ids, positions);
  this.index = {ids, positions, version: this.version, value};
  this.routes.clear();
  return value;
 }

 /** Say a rectangle moved inside the current map, which neither identity check would notice. */
 moved(): void { this.version++; }

 /** Recompute an exploration's graph and layout against the snapshot last read. */
 rebuildExploration(): void {
  if (!this.exploration) return;
  this.exploration.rebuild(this.data);
  this.version++;
  this.pruneSelection();
 }

 // ---- selection --------------------------------------------------------------------------

 get selection(): Selection { return this.current; }
 /** The image ids a selection rings. Cached: the draw loop asks once per image. */
 get selectedImages(): ReadonlySet<string> { return this.currentImages; }
 get selectedRegion(): string | null { return this.current.kind === 'region' ? this.current.regionId : null; }
 get selectedEdge(): string | null { return this.current.kind === 'edge' ? this.current.id : null; }

 setSelection(next: Selection): void { this.current = next; this.currentImages = selectedImages(next); }

 /** Resolve a hit to a selection. Shift extends the image set; a region or edge stands alone. */
 select(hit: Hit | null, multiple = false): void {
  this.setSelection(selectTarget(this.current, hit && 'edge' in hit ? {edgeId: hit.edge.id} : hit, multiple));
 }

 /** Drop whatever the vault, or a rebuilt exploration, no longer holds. */
 pruneSelection(): void {
  const holds = this.exploration ? (id: string) => this.exploration!.positions.has(id) : (id: string) => this.byId.has(id);
  this.setSelection(prune(this.current, {
   image: holds,
   region: id => this.regionById.has(id),
   edge: id => this.data.edges.some(edge => edge.id === id),
  }));
 }

 /** The selection as something a menu or a keystroke can act on. */
 selectionHit(): Hit | null {
  const selection = this.current;
  if (selection.kind === 'edge') { const edge = this.data.edges.find(item => item.id === selection.id); return edge ? {edge} : null; }
  if (selection.kind === 'region') return {endpoint: {imageId: selection.imageId, regionId: selection.regionId}};
  const imageId = [...this.currentImages][0];
  return imageId ? {endpoint: {imageId}} : null;
 }

 // ---- what is under a point ---------------------------------------------------------------

 /** The topmost picture under `p`, and the region of it if the point is inside one. */
 endpointAt(p: Point): Endpoint | null {
  for (const id of this.spatial().at(p)) {
   const rect = this.positions.get(id);
   if (!rect) continue;
   const normalized = {x: (p.x - rect.x) / rect.width, y: (p.y - rect.y) / rect.height};
   for (const region of [...this.regionsOf(id)].reverse()) if (containsRegion(normalized, region.shape)) return {imageId: id, regionId: region.id};
   return {imageId: id};
  }
  return null;
 }

 /**
  * What the pointer is on, pictures and connections both.
  *
  * Runs on every pointer move, so a connection whose route the last frame did not compute is
  * rejected by its bounding box before its endpoints are resolved. A routed connection is
  * measured against the polyline the frame drew, never against the chord between its ends: the
  * two part company by a whole image.
  */
 hit(p: Point, scale: number, endpoints: (edge: EdgeRecord) => {source: Point; target: Point}): Hit | null {
  const endpoint = this.endpointAt(p);
  if (endpoint?.regionId) return {endpoint};
  const edges = this.shownEdges(), reach = REACH / scale;
  for (let i = edges.length - 1; i >= 0; i--) {
   const edge = edges[i];
   const route = this.routing ? this.routes.get(edge.id) : null;
   if (route) { if (distanceToPath(p, route) < reach) return {edge}; continue; }
   const source = this.positions.get(edge.source.imageId), target = this.positions.get(edge.target.imageId);
   if (!source || !target) continue;
   if (p.x < Math.min(source.x, target.x) - reach || p.x > Math.max(source.x + source.width, target.x + target.width) + reach) continue;
   if (p.y < Math.min(source.y, target.y) - reach || p.y > Math.max(source.y + source.height, target.y + target.height) + reach) continue;
   const {source: a, target: b} = endpoints(edge);
   if (distanceToPath(p, [a, b]) < reach) return {edge};
  }
  return endpoint ? {endpoint} : null;
 }

 /**
  * Whether the frame being drawn is routing. One expression owns it, so the flag the hit test
  * reads cannot drift from the condition the renderer used.
  */
 setRouting(on: boolean): void { this.routing = on; }
 get routed(): boolean { return this.routing; }

 /** The path a connection takes: around the images between its ends, or straight. Cached. */
 route(edge: EdgeRecord, a: Point, b: Point): Point[] {
  const held = this.routes.get(edge.id);
  if (held !== undefined) return held ?? [a, b];
  const area = {x: Math.min(a.x, b.x) - LANE * 2, y: Math.min(a.y, b.y) - LANE * 2, width: Math.abs(a.x - b.x) + LANE * 4, height: Math.abs(a.y - b.y) + LANE * 4};
  const obstacles: Rect[] = [];
  for (const id of this.spatial().query(area)) {
   if (id === edge.source.imageId || id === edge.target.imageId) continue;
   const rect = this.positions.get(id);
   if (rect) obstacles.push(rect);
  }
  const path = obstacles.length ? routeOrthogonal(a, b, obstacles) : null;
  this.routes.set(edge.id, path);
  return path ?? [a, b];
 }

 // ---- the layout -------------------------------------------------------------------------

 /** The derived whole-vault rows, which an export of the whole vault reads even while exploring. */
 get wholeLayout(): ReadonlyMap<string, Rect> { return this.wholePositions; }

 /** The rectangle holding every one of `ids`, or null when none of them is placed. */
 bounds(ids: Iterable<string>): Rect | null { return boundsOf(this.placed(ids)); }
 private *placed(ids: Iterable<string>): Generator<Rect> {
  for (const id of ids) { const rect = this.positions.get(id); if (rect) yield rect; }
 }
 /** Every shown rectangle, for a search that has no box to query. */
 *shownRects(): Generator<readonly [string, Rect]> {
  for (const id of this.shownIds()) { const rect = this.positions.get(id); if (rect) yield [id, rect] as const; }
 }

 /** The images a drag on `imageId` carries: the whole selection when it is part of it. */
 movable(imageId: string): Map<string, Rect> {
  const ids = this.currentImages.has(imageId) ? [...this.currentImages] : [imageId];
  const origins = new Map<string, Rect>();
  for (const id of ids) { const rect = this.positions.get(id); if (rect && !this.exploration?.isRoot(id)) origins.set(id, copy(rect)); }
  return origins;
 }

 /** Whole-vault positions snap to the grid; an explored layout is free and stays pinned. */
 place(id: string, x: number, y: number, size: Rect): void {
  // The drag carries a delta, not a size: a pixel size read while the pointer is down changes
  // the rectangle's width, and the drop must write the new width, not the old one.
  const held = this.positions.get(id) ?? size;
  const snap = (value: number) => this.exploration ? value : Math.round(value / GRID) * GRID;
  this.positions.set(id, {width: held.width, height: held.height, x: snap(x), y: snap(y)});
  this.exploration?.pin(id);
 }

 /**
  * Every moved rectangle, read before anything is written. A write notifies, `refresh` rebuilds
  * the layout from the snapshot, and a second read would then return the stored rectangle
  * rather than the dragged one — which moved only the first image.
  */
 movedRecords(ids: Iterable<string>): ImageRecord[] {
  const records: ImageRecord[] = [];
  for (const id of ids) {
   const image = this.byId.get(id), rect = this.positions.get(id);
   if (image && rect) records.push({...image, ...rect, pinned: true});
  }
  return records;
 }

 /** What to call an endpoint in a sentence. */
 describe(endpoint: Endpoint): string {
  const name = this.byId.get(endpoint.imageId)?.path.split('/').pop() ?? 'Missing image';
  return endpoint.regionId ? `${name} / ${this.regionById.get(endpoint.regionId)?.label ?? 'region'}` : name;
 }
}
