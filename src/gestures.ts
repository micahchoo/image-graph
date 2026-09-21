import type {Point, Rect, RegionShape} from './types';
import type {HandleId} from './region-shape';

/** The five tools. What a drag means depends on which one is holding the pointer. */
export type Mode = 'select' | 'rect' | 'polygon' | 'connect' | 'move';

/**
 * What a pointer is asking for.
 *
 * A press is ambiguous until it moves: the same button down can become a pan, a band, a region,
 * a move or nothing at all, and which it becomes depends on the tool, the modifiers, what is
 * under the pointer and how far it has travelled. That decision was a six-branch tree inside
 * `pointerMove` on a view no test can construct, and the defects this canvas has had were in it
 * — shift-drag doing nothing in Move mode, a drag while connecting being tracked and ignored.
 *
 * Every function here is a decision and nothing else: no DOM, no camera, no records.
 */

/** Screen pixels a pointer must travel before a press becomes a drag rather than a click. */
export const DRAG_THRESHOLD = 6;

/** Has the pointer left the slack around the press? Below this it is still a click. */
export function movedEnough(from: Point, to: Point, threshold = DRAG_THRESHOLD): boolean {
 return Math.hypot(to.x - from.x, to.y - from.y) >= threshold;
}

export interface PressInput {
 shift: boolean;
 /** Space is held, which pans from anywhere. */
 space: boolean;
 button: number;
 mode: Mode;
 /** The press landed on a grip of the selected region. */
 onGrip: boolean;
}

/**
 * What a press sets up before anything moves.
 *
 * Shift already means extend, so shift-drag draws the band; a plain drag still pans, because
 * this canvas is a map before it is an editor. Move bands too — a selection a drag carries has
 * to be makeable in the mode that carries it, which it was not until 2026-09-21.
 */
export function pressIntent(input: PressInput): 'marquee' | 'handle' | 'plain' {
 const primary = input.button === 0 && !input.space;
 if (input.shift && primary && (input.mode === 'select' || input.mode === 'move')) return 'marquee';
 if (input.onGrip && primary) return 'handle';
 return 'plain';
}

export interface DragInput {
 /** A band was armed at press time. */
 marquee: boolean;
 /** Space, or the middle button. */
 forcePan: boolean;
 /** Alt, or the Move tool. */
 forceMove: boolean;
 /** What the press landed on. A connection cannot be dragged, so it pans. */
 over: 'image' | 'edge' | null;
 mode: Mode;
}

/**
 * What a press becomes once it has moved far enough.
 *
 * `pan` is the answer to everything unclaimed, deliberately: an unrecognised drag on a map
 * should move the map, never nothing. Connect and Polygon pan for the same reason — the owner
 * has to reach an off-screen target without putting the tool down.
 */
export function dragBecomes(input: DragInput): 'marquee' | 'pan' | 'region' | 'image' {
 if (input.marquee) return 'marquee';
 if (input.forcePan || input.over !== 'image') return 'pan';
 if (input.mode === 'rect') return 'region';
 if (input.mode === 'connect' || input.mode === 'polygon') return 'pan';
 return input.forceMove ? 'image' : 'pan';
}

export interface Pinch {distance: number; center: Point}

export function pinchFrom(a: Point, b: Point): Pinch {
 return {distance: Math.hypot(a.x - b.x, a.y - b.y), center: {x: (a.x + b.x) / 2, y: (a.y + b.y) / 2}};
}

/**
 * One step of a two-finger gesture: how much it spread, and how far it slid.
 *
 * Both at once, because fingers do both at once. The zoom is about the *previous* centre —
 * zooming about the new one would fight the slide the same gesture is asking for. A pinch that
 * starts from a zero distance cannot report a ratio, so it reports no change rather than
 * infinity.
 */
export function pinchStep(previous: Pinch, a: Point, b: Point): {next: Pinch; factor: number; dx: number; dy: number} {
 const next = pinchFrom(a, b);
 return {
  next,
  factor: next.distance / (previous.distance || 1),
  dx: next.center.x - previous.center.x,
  dy: next.center.y - previous.center.y,
 };
}

/**
 * Work the owner began and has not committed. One field, so cancelling is one assignment.
 *
 * Lives here rather than in the view because two sides read it: the pointer handlers advance
 * it and the renderer draws it. `resize` carries the shape as it was when the drag started, so
 * a side that hits its minimum and comes back lands where the pointer is.
 */
export type Draft =
 | {kind: 'polygon'; imageId: string; points: Point[]}
 | {kind: 'connect'; source: {imageId: string; regionId?: string}}
 | {kind: 'region'; imageId: string; start: Point; last: Point}
 | {kind: 'resize'; regionId: string; imageId: string; handle: HandleId; origin: RegionShape; shape: RegionShape};

/** A drag across a picture, as a rectangle in fractions of it. Held inside the picture. */
export function regionFromDrag(a: Point, b: Point, rect: Rect): RegionShape & {type: 'rect'} {
 const unit = (value: number) => Math.max(0, Math.min(1, value));
 const x1 = unit((a.x - rect.x) / rect.width), x2 = unit((b.x - rect.x) / rect.width);
 const y1 = unit((a.y - rect.y) / rect.height), y2 = unit((b.y - rect.y) / rect.height);
 return {type: 'rect', x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1)};
}
