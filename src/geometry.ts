import type {Camera, Rect} from './types';

/**
 * The three questions every surface here asks about a rectangle.
 *
 * Each had grown its own copy — the culling test three times, the overlap test three times,
 * the enclosing box twice — and a copy is where two answers start to differ. The interactive
 * canvas, the note embed, the PNG export and the still renderer must agree about what is on
 * screen, or an export shows a picture the view culled.
 *
 * Every function here is total and allocation-free but for the one that returns a rectangle.
 * A caller on a per-frame path builds no garbage by asking.
 */

/** Do two rectangles share any area? Touching edges do not count. */
export function overlaps(a: Rect, b: Rect): boolean {
 return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * Does a world rectangle reach the viewport?
 *
 * `margin` is in screen pixels and admits what is just outside, for a label that overhangs
 * or a cached bitmap that covers more than the window.
 */
export function onScreen(rect: Rect, camera: Camera, width: number, height: number, margin = 0): boolean {
 const left = rect.x * camera.scale + camera.x, top = rect.y * camera.scale + camera.y;
 return left <= width + margin && top <= height + margin
  && left + rect.width * camera.scale >= -margin && top + rect.height * camera.scale >= -margin;
}

/** The smallest rectangle holding every one of them, or null when there are none. */
export function boundsOf(rects: Iterable<Rect>): Rect | null {
 let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
 for (const rect of rects) {
  left = Math.min(left, rect.x); top = Math.min(top, rect.y);
  right = Math.max(right, rect.x + rect.width); bottom = Math.max(bottom, rect.y + rect.height);
 }
 return Number.isFinite(left) ? {x: left, y: top, width: right - left, height: bottom - top} : null;
}
