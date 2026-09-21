// The algebra of a region's shape: what a usable shape is, where its grips sit, how a grip moves
// it, and whether a point is inside. One of the four modules graph.ts held until 2026-09-21;
// its one reader outside the view is the store's validation.

import type {Point, RegionShape} from './types';

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const unit = (value: unknown): value is number => finite(value) && value >= 0 && value <= 1;

/**
 * Narrow an unknown value to a region shape, naming the field that is wrong.
 *
 * The geometry panel used to hand its value straight to `saveRegion` behind a double cast,
 * so the compiler could not see the one structured value an owner types by hand. This is the
 * single definition; storage and the panel both come through here.
 */
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
