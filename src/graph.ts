import {parseYaml} from 'obsidian';
import type {EdgeRecord, Endpoint, ImageRecord, Point, Properties, Rect, RegionRecord, RegionShape} from './types';

export interface Neighborhood {
 ids: string[];
 edges: EdgeRecord[];
 distances: Map<string, number>;
 parents: Map<string, {imageId: string; edge: EdgeRecord}>;
 capped: boolean;
}


function endpoints(edge: EdgeRecord): string[] {
 return [edge.source.imageId, edge.target.imageId];
}

/** Breadth-first image traversal. Edge direction is deliberately ignored for exploration. */
export function neighborhood(snapshot: {images: ImageRecord[]; edges: EdgeRecord[]}, rootId: string, depth: number, expanded: Set<string>, relationFilter: string, limit = Number.POSITIVE_INFINITY): Neighborhood {
 const maxDepth = Math.max(0, Math.floor(depth));
 const ids: string[] = [];
 const distances = new Map<string, number>();
 const parents = new Map<string, {imageId: string; edge: EdgeRecord}>();
 const edgesByImage = new Map<string, EdgeRecord[]>();
 const imageIds = new Set(snapshot.images.map((image) => image.id));
 for (const edge of snapshot.edges) {
  if (relationFilter !== '' && (relationOf(edge.properties) ?? '') !== relationFilter) continue;
  const [a, b] = endpoints(edge);
  if (!imageIds.has(a) || !imageIds.has(b)) continue;
  (edgesByImage.get(a) ?? (edgesByImage.set(a, []), edgesByImage.get(a)!)).push(edge);
  if (b !== a) (edgesByImage.get(b) ?? (edgesByImage.set(b, []), edgesByImage.get(b)!)).push(edge);
 }
 if (!imageIds.has(rootId)) return {ids, edges: [], distances, parents, capped: false};
 const queue: string[] = [rootId];
 distances.set(rootId, 0); ids.push(rootId);
 let capped = false;
 while (queue.length) {
  const current = queue.shift()!;
  const distance = distances.get(current)!;
  if (distance >= maxDepth && !expanded.has(current)) continue;
  for (const edge of edgesByImage.get(current) ?? []) {
   const other = edge.source.imageId === current ? edge.target.imageId : edge.source.imageId;
   if (distances.has(other)) continue;
   if (ids.length >= limit) { capped = true; continue; }
   distances.set(other, distance + 1);
   parents.set(other, {imageId: current, edge});
   ids.push(other);
   queue.push(other);
  }
 }
 const included = new Set(ids);
 const resultEdges = snapshot.edges.filter((edge) => included.has(edge.source.imageId) && included.has(edge.target.imageId) && (relationFilter === '' || (relationOf(edge.properties) ?? '') === relationFilter));
 return {ids, edges: resultEdges, distances, parents, capped};
}

export function tracePath(rootId: string, targetId: string, neighborhood: Neighborhood): Array<{from: string; to: string; edge: EdgeRecord}> {
 const path: Array<{from: string; to: string; edge: EdgeRecord}> = [];
 let current = targetId;
 const seen = new Set<string>();
 while (current !== rootId) {
  if (seen.has(current)) return [];
  seen.add(current);
  const parent = neighborhood.parents.get(current);
  if (!parent) return [];
  path.push({from: parent.imageId, to: current, edge: parent.edge});
  current = parent.imageId;
 }
 return path.reverse();
}

const seeded = (id: string): Point => {
 let n = 2166136261;
 for (let i = 0; i < id.length; i++) n = Math.imul(n ^ id.charCodeAt(i), 16777619);
 return {x: ((n >>> 0) % 1000) - 500, y: ((Math.imul(n, 31) >>> 0) % 1000) - 500};
};

const seededAngle = (id: string): number => {
 let n = 2166136261;
 for (let i = 0; i < id.length; i++) n = Math.imul(n ^ id.charCodeAt(i), 16777619);
 return (n >>> 0) / 0xffffffff * Math.PI * 2;
};

export function forceLayout(images: ImageRecord[], graph: Neighborhood, rootId: string, pinned: Set<string>, previous: Map<string, Rect>): Map<string, Rect> {
 const byId = new Map(images.map((image) => [image.id, image]));
 const positions = new Map<string, Rect>();
 for (const id of graph.ids) {
  const image = byId.get(id);
  if (!image) continue;
  const old = previous.get(id);
  positions.set(id, old ? {...old} : {...image, x: seeded(id).x, y: seeded(id).y});
 }
 // New nodes start on a stable ring around the root. This avoids the large,
 // biased seed cloud that otherwise takes many iterations to untangle.
 const initialRoot = positions.get(rootId);
 if (initialRoot) for (const id of graph.ids) {
  if (previous.has(id) || id === rootId) continue;
  const p = positions.get(id); if (!p) continue;
  const angle = seededAngle(id);
  const radius = Math.max(1, graph.distances.get(id) ?? 1) * 400;
  p.x = initialRoot.x + Math.cos(angle) * radius;
  p.y = initialRoot.y + Math.sin(angle) * radius;
 }
 const movable = graph.ids.filter((id) => !pinned.has(id));
 const edgePairs = graph.edges.map((edge) => [edge.source.imageId, edge.target.imageId] as const).filter(([a, b]) => positions.has(a) && positions.has(b));
 const rootPosition = positions.get(rootId);
 const rootAnchor = rootPosition ? {x: rootPosition.x, y: rootPosition.y} : {x: 0, y: 0};
 for (let iteration = 0; iteration < 150; iteration++) {
  const force = new Map<string, Point>();
  for (const id of movable) force.set(id, {x: 0, y: 0});
  for (let i = 0; i < graph.ids.length; i++) for (let j = i + 1; j < graph.ids.length; j++) {
   const leftId = graph.ids[i]; const rightId = graph.ids[j]; const a = positions.get(leftId)!; const b = positions.get(rightId)!;
   const dx = a.x - b.x; const dy = a.y - b.y; const distance = Math.max(1, Math.hypot(dx, dy));
   const halfDiagonal = Math.hypot(a.width, a.height) / 2 + Math.hypot(b.width, b.height) / 2 + 48;
   const requiredX = (a.width + b.width) / 2 + 48;
   const requiredY = (a.height + b.height) / 2 + 48;
   const overlap = Math.max(0, Math.min(requiredX - Math.abs(dx), requiredY - Math.abs(dy)));
   const required = Math.max(halfDiagonal, Math.min(requiredX, requiredY));
   const push = distance < required || overlap > 0 ? Math.min(100, Math.max((required - distance) * 0.28, overlap * 0.12)) : Math.min(12, 5000 / (distance * distance));
   const fx = dx / distance * push; const fy = dy / distance * push;
   if (force.has(leftId)) { force.get(leftId)!.x += fx; force.get(leftId)!.y += fy; }
   if (force.has(rightId)) { force.get(rightId)!.x -= fx; force.get(rightId)!.y -= fy; }
  }
  for (const [aId, bId] of edgePairs) {
   const a = positions.get(aId)!; const b = positions.get(bId)!; const dx = b.x - a.x; const dy = b.y - a.y; const distance = Math.max(1, Math.hypot(dx, dy));
   const pull = (distance - 400) * 0.01; const fx = dx / distance * pull; const fy = dy / distance * pull;
   if (force.has(aId)) { force.get(aId)!.x += fx; force.get(aId)!.y += fy; }
   if (force.has(bId)) { force.get(bId)!.x -= fx; force.get(bId)!.y -= fy; }
  }
  // Keep each hop on a soft radial ring around the root. This makes a
  // 1/2/3-hop exploration readable while allowing overlap and edge forces to
  // settle the exact position.
  const root = positions.get(rootId);
  if (root) for (const id of movable) {
   if (id === rootId) continue;
   const p = positions.get(id)!;
   const seededDirection = seeded(id);
   const dx = p.x - root.x; const dy = p.y - root.y;
   const distance = Math.hypot(dx, dy);
   const directionX = distance > 1e-6 ? dx / distance : seededDirection.x / Math.max(1, Math.hypot(seededDirection.x, seededDirection.y));
   const directionY = distance > 1e-6 ? dy / distance : seededDirection.y / Math.max(1, Math.hypot(seededDirection.x, seededDirection.y));
   const desired = Math.max(1, graph.distances.get(id) ?? 1) * 420;
   const radial = (desired - distance) * 0.025;
   force.get(id)!.x += directionX * radial;
   force.get(id)!.y += directionY * radial;
  }
  for (const id of movable) {
   const p = positions.get(id)!; const f = force.get(id)!;
   const old = previous.get(id); if (old) { f.x += (old.x - p.x) * 0.8; f.y += (old.y - p.y) * 0.8; }
   if (id === rootId) continue;
   p.x += Math.max(-12, Math.min(12, f.x)); p.y += Math.max(-12, Math.min(12, f.y));
  }
  // Root anchoring is exact and repeated so no accumulated force can drift it.
  if (rootPosition) { rootPosition.x = rootAnchor.x; rootPosition.y = rootAnchor.y; }
 }
 if (rootPosition) { rootPosition.x = rootAnchor.x; rootPosition.y = rootAnchor.y; }
 return positions;
}

export function endpointPosition(endpoint: Endpoint, images: Map<string, Rect>, regions: Map<string, RegionRecord>): Point {
 const image = images.get(endpoint.imageId); if (!image) return {x: 0, y: 0};
 const region = endpoint.regionId ? regions.get(endpoint.regionId) : undefined;
 if (!region || region.imageId !== endpoint.imageId) return {x: image.x + image.width / 2, y: image.y + image.height / 2};
 const shape = region.shape;
 if (shape.type === 'rect') return {x: image.x + (shape.x + shape.width / 2) * image.width, y: image.y + (shape.y + shape.height / 2) * image.height};
 const bounds = shape.points.reduce((r, p) => ({minX: Math.min(r.minX, p.x), minY: Math.min(r.minY, p.y), maxX: Math.max(r.maxX, p.x), maxY: Math.max(r.maxY, p.y)}), {minX: 1, minY: 1, maxX: 0, maxY: 0});
 return {x: image.x + (bounds.minX + bounds.maxX) / 2 * image.width, y: image.y + (bounds.minY + bounds.maxY) / 2 * image.height};
}

const clipToRect = (center: Point, toward: Point, rect: Rect): Point => {
 const dx = toward.x - center.x; const dy = toward.y - center.y;
 if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return {x: center.x + rect.width / 2, y: center.y};
 const tx = Math.abs(dx) < 1e-9 ? Number.POSITIVE_INFINITY : rect.width / 2 / Math.abs(dx);
 const ty = Math.abs(dy) < 1e-9 ? Number.POSITIVE_INFINITY : rect.height / 2 / Math.abs(dy);
 const t = Math.min(tx, ty);
 return {x: center.x + dx * t, y: center.y + dy * t};
};

function clipToPolygon(center: Point, toward: Point, points: Point[]): Point | undefined {
 if (points.length < 3) return undefined;
 let dx = toward.x - center.x; let dy = toward.y - center.y;
 if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) { dx = 1; dy = 0; }
 let best = Number.POSITIVE_INFINITY; let hit: Point | undefined;
 const cross = (a: Point, b: Point) => a.x * b.y - a.y * b.x;
 for (let i = 0; i < points.length; i++) {
  const a = points[i]; const b = points[(i + 1) % points.length];
  const segment = {x: b.x - a.x, y: b.y - a.y};
  const denominator = cross({x: dx, y: dy}, segment);
  if (Math.abs(denominator) < 1e-9) continue;
  const fromCenter = {x: a.x - center.x, y: a.y - center.y};
  const t = cross(fromCenter, segment) / denominator;
  const u = cross(fromCenter, {x: dx, y: dy}) / denominator;
  if (t >= -1e-9 && u >= -1e-9 && u <= 1 + 1e-9 && t < best) {
   best = t; hit = {x: center.x + dx * t, y: center.y + dy * t};
  }
 }
 return hit;
}

function endpointBoundary(endpoint: Endpoint, toward: Point, images: Map<string, Rect>, regions: Map<string, RegionRecord>): Point {
 const image = images.get(endpoint.imageId);
 const center = endpointPosition(endpoint, images, regions);
 if (!image) return center;
 const region = endpoint.regionId ? regions.get(endpoint.regionId) : undefined;
 if (!region || region.imageId !== endpoint.imageId) return clipToRect(center, toward, image);
 if (region.shape.type === 'rect') {
  const rect = {x: image.x + region.shape.x * image.width, y: image.y + region.shape.y * image.height, width: region.shape.width * image.width, height: region.shape.height * image.height};
  return clipToRect(center, toward, rect);
 }
 const points = region.shape.points.map((point) => ({x: image.x + point.x * image.width, y: image.y + point.y * image.height}));
 return clipToPolygon(center, toward, points) ?? clipToRect(center, toward, image);
}

/** Return edge attachment points on image/region boundaries rather than centers. */
export function edgeEndpoints(edge: EdgeRecord, images: Map<string, Rect>, regions: Map<string, RegionRecord>): {source: Point; target: Point} {
 const sourceCenter = endpointPosition(edge.source, images, regions);
 const targetCenter = endpointPosition(edge.target, images, regions);
 return {source: endpointBoundary(edge.source, targetCenter, images, regions), target: endpointBoundary(edge.target, sourceCenter, images, regions)};
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const unit = (value: unknown): value is number => finite(value) && value >= 0 && value <= 1;

/**
 * Narrow an unknown value to a region shape, naming the field that is wrong.
 *
 * The geometry panel used to hand its value straight to `saveRegion` behind a double cast,
 * so the compiler could not see the one structured value an owner types by hand. This is the
 * single definition; storage and the panel both come through here.
 */
/** The one definition of a usable relation: the label a connection shows, or nothing. */
export function relationOf(properties: unknown): string | null {
 if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return null;
 const value = (properties as Record<string, unknown>).relation;
 return typeof value === 'string' && value.trim() ? value : null;
}

export function parseRegionShape(value: unknown): RegionShape {
 if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('A region needs a shape.');
 const shape = value as Record<string, unknown>;
 if (shape.type === 'rect') {
  for (const key of ['x', 'y', 'width', 'height'] as const) if (!finite(shape[key])) throw new Error(`Enter a number for ${key}.`);
  const {x, y, width, height} = shape as {x: number; y: number; width: number; height: number};
  if (!unit(x) || !unit(y)) throw new Error('Keep x and y between 0 and 1; they are fractions of the image.');
  if (width <= 0 || height <= 0) throw new Error('Give the rectangle a width and height above 0.');
  if (x + width > 1.000001 || y + height > 1.000001) throw new Error('Keep the rectangle inside the image: x plus width, and y plus height, cannot pass 1.');
  return {type: 'rect', x, y, width, height};
 }
 if (shape.type === 'polygon') {
  const points = shape.points;
  if (!Array.isArray(points)) throw new Error('A polygon needs a list of points.');
  if (points.length < 3) throw new Error('Choose at least three polygon corners.');
  return {type: 'polygon', points: points.map((point, index) => {
   const p = point as Record<string, unknown> | null;
   if (!p || typeof p !== 'object' || !unit(p.x) || !unit(p.y)) throw new Error(`Give corner ${index + 1} an x and y between 0 and 1.`);
   return {x: p.x, y: p.y};
  })};
 }
 throw new Error('Choose either a rectangle or a polygon.');
}

/** A grip on a region outline. A rectangle offers eight; a polygon offers one per corner,
 * addressed by its index. Penpot splits these into resize-point and resize-side handlers;
 * one list is enough here because every grip does the same thing. */
export type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | number;
export interface Handle {id: HandleId; x: number; y: number}
const GRIPS: Array<[Exclude<HandleId, number>, number, number]> = [['nw', 0, 0], ['n', .5, 0], ['ne', 1, 0], ['e', 1, .5], ['se', 1, 1], ['s', .5, 1], ['sw', 0, 1], ['w', 0, .5]];
/** Below this a region would be too small to grip again. */
const MIN_SIDE = .004;
const inside = (value: number) => Math.max(0, Math.min(1, value));

/** Grip positions as fractions of the image, in the same space as the shape itself. */
export function regionHandles(shape: RegionShape): Handle[] {
 if (shape.type === 'rect') return GRIPS.map(([id, fx, fy]) => ({id, x: shape.x + shape.width * fx, y: shape.y + shape.height * fy}));
 return shape.points.map((point, index) => ({id: index, x: point.x, y: point.y}));
}

/** Put one grip at `point` and keep the shape legal: inside the image, never inverted, never
 * too small to grip. Always applied to the shape as it was when the drag started, so a side
 * that hits the minimum and comes back lands where the pointer is. */
export function resizeRegion(shape: RegionShape, handle: HandleId, point: Point): RegionShape {
 const x = inside(point.x), y = inside(point.y);
 if (shape.type === 'polygon') return parseRegionShape({type: 'polygon', points: shape.points.map((corner, index) => index === handle ? {x, y} : corner)});
 if (typeof handle === 'number') return shape;
 let left = shape.x, right = shape.x + shape.width, top = shape.y, bottom = shape.y + shape.height;
 if (handle.includes('w')) left = x; else if (handle.includes('e')) right = x;
 if (handle.startsWith('n')) top = y; else if (handle.startsWith('s')) bottom = y;
 const width = Math.max(MIN_SIDE, Math.abs(right - left)), height = Math.max(MIN_SIDE, Math.abs(bottom - top));
 return parseRegionShape({type: 'rect', x: Math.min(Math.min(left, right), 1 - width), y: Math.min(Math.min(top, bottom), 1 - height), width, height});
}

export function containsRegion(point: Point, shape: RegionShape): boolean {
 if (shape.type === 'rect') return point.x >= shape.x && point.x <= shape.x + shape.width && point.y >= shape.y && point.y <= shape.y + shape.height;
 let inside = false;
 for (let i = 0, j = shape.points.length - 1; i < shape.points.length; j = i++) {
  const a = shape.points[i]; const b = shape.points[j];
  const cross = (point.x - a.x) * (b.y - a.y) - (point.y - a.y) * (b.x - a.x);
  if (Math.abs(cross) < 1e-9 && point.x >= Math.min(a.x, b.x) && point.x <= Math.max(a.x, b.x) && point.y >= Math.min(a.y, b.y) && point.y <= Math.max(a.y, b.y)) return true;
  if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
 }
 return inside;
}

function safeValue(value: unknown): unknown {
 if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
 if (typeof value === 'number') { if (!Number.isFinite(value)) throw new Error('Invalid metadata number'); return value; }
 if (Array.isArray(value)) return value.map(safeValue);
 if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) { if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new Error('Unsafe metadata key'); result[key] = safeValue(item); }
  return result;
 }
 throw new Error('Invalid metadata value');
}

export function parseProperties(text: string): Properties {
 let value: unknown;
 try { value = parseYaml(text); } catch (error) { throw new Error(`Invalid YAML metadata: ${error instanceof Error ? error.message : String(error)}`); }
 if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('Metadata must be a mapping');
 return safeValue(value) as Properties;
}
