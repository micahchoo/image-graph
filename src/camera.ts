import type {Camera, Point, Rect} from './types';

/**
 * Where the canvas is looking, and every way it moves.
 *
 * A camera is three numbers, and all of this is arithmetic over them — but it is the arithmetic
 * that is easy to get subtly wrong and impossible to see wrong: a zoom that drifts the point
 * under the pointer, a fit that clips the bottom row behind the status strip, a wheel that pans
 * the wrong way in Firefox. It lived as ten methods on a 1000-line `ItemView` that no test can
 * construct, next to a second, different answer to "what camera shows this box" in `embed.ts`.
 *
 * Screen coordinates here are relative to the canvas, never to the client. The caller subtracts
 * the element's own origin, because only the caller knows where the element is.
 */

/** Below this the whole vault is a texture; above it one picture fills the pane. */
export const MIN_SCALE = .002, MAX_SCALE = 8;
/** A fit never zooms past this: filling the pane with two images is not "show me everything". */
export const MAX_FIT_SCALE = 2;

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

export function toWorld(camera: Camera, x: number, y: number): Point {
 return {x: (x - camera.x) / camera.scale, y: (y - camera.y) / camera.scale};
}

export function toScreen(camera: Camera, point: Point): Point {
 return {x: point.x * camera.scale + camera.x, y: point.y * camera.scale + camera.y};
}

/** What the viewport covers, in world coordinates. */
export function viewportRect(camera: Camera, width: number, height: number): Rect {
 return {x: -camera.x / camera.scale, y: -camera.y / camera.scale, width: width / camera.scale, height: height / camera.scale};
}

/**
 * Zoom about a point on screen, leaving whatever is under it exactly where it is.
 *
 * That fixed point is the whole contract: zoom at the pointer and the thing you are pointing at
 * must not slide. The scale is clamped first and the shift is computed from the scale actually
 * taken, so a zoom that hits a limit stops rather than drifting.
 */
export function zoomAt(camera: Camera, factor: number, at: Point, min = MIN_SCALE, max = MAX_SCALE): Camera {
 const before = toWorld(camera, at.x, at.y);
 const scale = clamp(camera.scale * factor, min, max);
 return {scale, x: camera.x + (camera.scale - scale) * before.x, y: camera.y + (camera.scale - scale) * before.y};
}

/** Move the view by a screen-pixel delta. Positive `dx` scrolls the content leftwards. */
export function scrollBy(camera: Camera, dx: number, dy: number): Camera {
 return {...camera, x: camera.x - dx, y: camera.y - dy};
}

export interface FitOptions {
 /** Screen pixels kept clear across and down. */
 padX: number; padY: number;
 /** World units added to the box before it is measured, so captions and rings are not clipped. */
 margin?: number;
 /** Chrome along the bottom the picture is lifted clear of. */
 bottomInset?: number;
 minScale?: number; maxScale?: number;
}

/**
 * The camera that shows all of `box`.
 *
 * One answer, parameterised. There were two: the workspace's own and `embed.ts#fitCamera`, which
 * differed in padding, in the bottom inset and in how far each would zoom — reasonable
 * differences, but they were differences between two copies of the arithmetic rather than
 * arguments to one.
 */
export function fitBox(box: Rect, viewport: {width: number; height: number}, options: FitOptions): Camera {
 const {padX, padY, margin = 0, bottomInset = 0, minScale = MIN_SCALE, maxScale = MAX_FIT_SCALE} = options;
 // A viewport smaller than its own padding has no room; the scale must still be positive.
 const scale = clamp(Math.min(
  Math.max(1, viewport.width - padX) / Math.max(1, box.width + margin),
  Math.max(1, viewport.height - padY) / Math.max(1, box.height + margin),
 ), minScale, maxScale);
 return {
  scale,
  x: viewport.width / 2 - (box.x + box.width / 2) * scale,
  y: (viewport.height - bottomInset) / 2 - (box.y + box.height / 2) * scale,
 };
}

/**
 * The smallest box centred on `centre` that still holds `box`.
 *
 * Fitting a neighbourhood keeps its starting picture in the middle, which means the camera must
 * cover as far past the anchor as the furthest image is on the other side. Centring on the
 * anchor and sizing to the box would put half the graph off screen.
 */
export function boxAround(centre: Point, box: Rect): Rect {
 const width = 2 * Math.max(centre.x - box.x, box.x + box.width - centre.x);
 const height = 2 * Math.max(centre.y - box.y, box.y + box.height - centre.y);
 return {x: centre.x - width / 2, y: centre.y - height / 2, width, height};
}

/**
 * Scroll the least that brings `rect` fully into view, and keep the zoom.
 *
 * Flying to each image in turn is not travel: an arrow key that re-framed the canvas would lose
 * the reader's place every time. Returns the same camera when nothing has to move.
 */
export function scrollIntoView(camera: Camera, rect: Rect, viewport: {width: number; height: number}, pad = 48, bottomPad = pad): Camera {
 const scale = camera.scale;
 const left = camera.x + rect.x * scale, top = camera.y + rect.y * scale;
 const right = left + rect.width * scale, bottom = top + rect.height * scale;
 let {x, y} = camera;
 if (left < pad) x += pad - left; else if (right > viewport.width - pad) x -= right - (viewport.width - pad);
 if (top < pad) y += pad - top; else if (bottom > viewport.height - bottomPad) y -= bottom - (viewport.height - bottomPad);
 return x === camera.x && y === camera.y ? camera : {scale, x, y};
}

/** The part of a wheel event this canvas reads. Taken as data so it can be tested without a DOM. */
export interface WheelInput {deltaX: number; deltaY: number; deltaMode?: number; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean}
export type WheelGesture = {kind: 'zoom'; factor: number; into: boolean} | {kind: 'scroll'; dx: number; dy: number};

/**
 * What a wheel gesture asks for.
 *
 * Obsidian's own canvas and Penpot agree: the wheel scrolls and ctrl or the command key zooms.
 * Before that rule, every wheel gesture zoomed, `deltaX` did nothing, and a trackpad could not
 * pan at all. `deltaMode` is normalised because Firefox reports lines and a page-mode wheel
 * reports screens; a wheel with no horizontal axis pans sideways under shift, which a trackpad
 * does not need because it already sends `deltaX`.
 */
export function wheelGesture(event: WheelInput, viewportHeight: number): WheelGesture {
 const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewportHeight : 1;
 let dx = event.deltaX * unit, dy = event.deltaY * unit;
 if (event.ctrlKey || event.metaKey) return {kind: 'zoom', factor: Math.exp(-dy * .0015), into: dy < 0};
 if (event.shiftKey && !dx) { dx = dy; dy = 0; }
 return {kind: 'scroll', dx, dy};
}

/**
 * Does the span between two rectangles reach the viewport?
 *
 * A connection's ends sit inside its two image rectangles, so their union bounds the line. The
 * margin keeps a midpoint label that overhangs the edge. Written out rather than built from
 * `boundsOf`: this runs once per connection per frame and must allocate nothing.
 */
export function spansViewport(a: Rect, b: Rect, camera: Camera, width: number, height: number, margin = 0): boolean {
 const s = camera.scale;
 const left = Math.min(a.x, b.x) * s + camera.x, top = Math.min(a.y, b.y) * s + camera.y;
 const right = Math.max(a.x + a.width, b.x + b.width) * s + camera.x;
 const bottom = Math.max(a.y + a.height, b.y + b.height) * s + camera.y;
 return left <= width + margin && top <= height + margin && right >= -margin && bottom >= -margin;
}
