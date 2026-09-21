import type {Camera, GraphSnapshot, Rect} from './types';
import {forceLayout} from './force-layout';
import {neighborhoodFrom, relationNeighborhood, type Neighborhood} from './traversal';

/** Above this a neighbourhood is a wall rather than an answer, and the status line says so. */
export const EXPLORE_LIMIT = 150;

/**
 * What is on screen instead of the vault.
 *
 * The traversal, the layout and the clamp are each tested on their own. What was not tested is
 * how they are *called*: that a depth change forgets the images expanded under the old depth,
 * that a pin may not take a starting image out of the layout, that a relation has no anchor
 * however many images it joins, that the cap is one number and not three. Every defect this
 * plugin has found lived in that kind of seam, so it gets a module and a test rather than
 * eleven methods spread through a thousand-line view.
 *
 * Mutable on purpose. `positions` is the map the canvas writes into while an image is dragged,
 * and `rebuild` hands the same map back to `forceLayout` as the previous layout, so a
 * neighbourhood that grows settles from where it already was rather than springing apart.
 */
export class Exploration {
 /** The pictures it grew from: one for an image, two for a connection, none for a relation. */
 readonly roots: readonly string[];
 /** Set when the whole exploration IS one relation. Null when it is a neighbourhood. */
 readonly relation: string | null;
 /** Dims the connections that do not match. Presentation only — never narrows the traversal. */
 filter = '';
 readonly expanded = new Set<string>();
 readonly pinned = new Set<string>();
 depth = 1;
 graph: Neighborhood;
 positions = new Map<string, Rect>();

 private constructor(roots: readonly string[], relation: string | null, graph: Neighborhood, readonly savedCamera: Camera) {
  this.roots = roots; this.relation = relation; this.graph = graph;
 }

 /**
  * One picture, or the two a connection joins. Unknown ids are dropped; none left is no
  * exploration at all, because a view of nothing is not a view.
  */
 static fromImages(snapshot: GraphSnapshot, imageIds: readonly string[], savedCamera: Camera): Exploration | null {
  const known = new Set(snapshot.images.map(image => image.id));
  const roots = imageIds.filter(id => known.has(id));
  if (!roots.length) return null;
  return new Exploration(roots, null, neighborhoodFrom(snapshot, roots, 1, new Set(), EXPLORE_LIMIT), savedCamera);
 }

 /**
  * Everything one relation joins. There is no starting image and no hop count: a relation is
  * a shape the whole vault has, not a view from one picture. Null when it joins nothing, so
  * the caller can say so and leave the current view standing.
  */
 static fromRelation(snapshot: GraphSnapshot, relation: string, savedCamera: Camera): Exploration | null {
  if (!relation) return null;
  const graph = relationNeighborhood(snapshot, relation, EXPLORE_LIMIT);
  if (!graph.ids.length) return null;
  return new Exploration([], relation, graph, savedCamera);
 }

 /** The single picture a layout may anchor. Two roots anchor neither: the pair is the subject. */
 get anchor(): string | null { return this.roots.length === 1 ? this.roots[0] : null; }

 /** A relation is a subgraph, so hops mean nothing in one and the control is hidden. */
 get countsHops(): boolean { return this.relation === null; }

 /**
  * A new depth re-asks the question, so the images expanded under the old one are forgotten:
  * they were answers to it. Leaving them would make two hops show more than three did.
  */
 setDepth(depth: number): void {
  this.depth = Math.max(1, Math.min(3, Math.floor(depth) || 1));
  this.expanded.clear();
 }

 /** Reach one hop past the depth, for this image only. */
 expand(imageId: string): void { this.expanded.add(imageId); }

 /** A starting picture is the subject, so it is never moved, nudged, laid out or pinned. */
 isRoot(imageId: string): boolean { return this.roots.includes(imageId); }

 /** Hold an image where it is. A starting image is already held, so it never takes a pin. */
 togglePin(imageId: string): void {
  if (this.isRoot(imageId)) return;
  if (!this.pinned.delete(imageId)) this.pinned.add(imageId);
 }

 /** Whoever drags an image has placed it, and a placed image keeps its place. */
 pin(imageId: string): void { if (!this.isRoot(imageId)) this.pinned.add(imageId); }

 /**
  * Recompute the graph and lay it out again. The filter is deliberately not passed to the
  * traversal: dimming is what it does, and a filtered traversal would drop the context that
  * makes a dimmed connection mean anything.
  */
 rebuild(snapshot: GraphSnapshot): void {
  this.graph = this.relation !== null
   ? relationNeighborhood(snapshot, this.relation, EXPLORE_LIMIT)
   : neighborhoodFrom(snapshot, this.roots, this.depth, this.expanded, EXPLORE_LIMIT);
  this.positions = forceLayout(snapshot.images, this.graph, this.anchor, this.pinned, this.positions);
 }
}
