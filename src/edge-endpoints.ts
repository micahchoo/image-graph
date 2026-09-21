// Where a connection attaches: the centre of a picture or of one of its regions, clipped to the
// card's or the polygon's boundary so the line starts at the edge, not under the thumbnail.
// One of the four modules graph.ts held until 2026-09-21.

import type {EdgeRecord, Endpoint, Point, Rect, RegionRecord} from './types';

export function endpointPosition(endpoint: Endpoint, images: ReadonlyMap<string, Rect>, regions: ReadonlyMap<string, RegionRecord>): Point {
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

function endpointBoundary(endpoint: Endpoint, toward: Point, images: ReadonlyMap<string, Rect>, regions: ReadonlyMap<string, RegionRecord>): Point {
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
export function edgeEndpoints(edge: EdgeRecord, images: ReadonlyMap<string, Rect>, regions: ReadonlyMap<string, RegionRecord>): {source: Point; target: Point} {
 const sourceCenter = endpointPosition(edge.source, images, regions);
 const targetCenter = endpointPosition(edge.target, images, regions);
 return {source: endpointBoundary(edge.source, targetCenter, images, regions), target: endpointBoundary(edge.target, sourceCenter, images, regions)};
}
