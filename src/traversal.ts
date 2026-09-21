// Which images a question reaches: breadth-first from one or several roots, or every image one
// relation joins. Pure over a snapshot. One of the four modules graph.ts held until 2026-09-21.

import type {EdgeRecord, ImageRecord} from './types';
import {relationOf} from './properties';

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
export function neighborhood(snapshot: {images: ImageRecord[]; edges: EdgeRecord[]}, rootId: string, depth: number, expanded: Set<string>, limit = Number.POSITIVE_INFINITY): Neighborhood {
 return neighborhoodFrom(snapshot, [rootId], depth, expanded, limit);
}

/**
 * The same traversal from several starting images at once.
 *
 * Choosing a connection means choosing the two pictures it joins — a line drawn across the
 * whole vault is a thing a person points at, and what they want is both of its ends in
 * context, not every other line that shares its relation.
 *
 * No relation filter: a relation is shown by dimming the others (`presentation.ts`), and a
 * traversal that dropped them would drop the context the dimming needs. One relation on its
 * own is `relationNeighborhood`.
 */
export function neighborhoodFrom(snapshot: {images: ImageRecord[]; edges: EdgeRecord[]}, rootIds: readonly string[], depth: number, expanded: Set<string>, limit = Number.POSITIVE_INFINITY): Neighborhood {
 const maxDepth = Math.max(0, Math.floor(depth));
 const ids: string[] = [];
 const distances = new Map<string, number>();
 const parents = new Map<string, {imageId: string; edge: EdgeRecord}>();
 const edgesByImage = new Map<string, EdgeRecord[]>();
 const imageIds = new Set(snapshot.images.map((image) => image.id));
 for (const edge of snapshot.edges) {
  const [a, b] = endpoints(edge);
  if (!imageIds.has(a) || !imageIds.has(b)) continue;
  (edgesByImage.get(a) ?? (edgesByImage.set(a, []), edgesByImage.get(a)!)).push(edge);
  if (b !== a) (edgesByImage.get(b) ?? (edgesByImage.set(b, []), edgesByImage.get(b)!)).push(edge);
 }
 const roots = rootIds.filter((id) => imageIds.has(id));
 if (!roots.length) return {ids, edges: [], distances, parents, capped: false};
 const queue: string[] = [];
 for (const id of roots) if (!distances.has(id)) { distances.set(id, 0); ids.push(id); queue.push(id); }
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
 const resultEdges = snapshot.edges.filter((edge) => included.has(edge.source.imageId) && included.has(edge.target.imageId));
 return {ids, edges: resultEdges, distances, parents, capped};
}

/**
 * Every image an edge of this relation touches, and those edges.
 *
 * A relation has no root. It is a subgraph of the whole vault rather than the neighbourhood of
 * one picture, so there are no hops to count and nothing to anchor: `distances` is 0 for every
 * image and `parents` is empty, which is what tells `forceLayout` to lay it out as a graph.
 */
export function relationNeighborhood(snapshot: {images: ImageRecord[]; edges: EdgeRecord[]}, relation: string, limit = Number.POSITIVE_INFINITY): Neighborhood {
 const imageIds = new Set(snapshot.images.map((image) => image.id));
 const ids: string[] = [];
 const distances = new Map<string, number>();
 let capped = false;
 for (const edge of snapshot.edges) {
  if ((relationOf(edge.properties) ?? '') !== relation) continue;
  const [a, b] = endpoints(edge);
  if (!imageIds.has(a) || !imageIds.has(b)) continue;
  for (const id of a === b ? [a] : [a, b]) {
   if (distances.has(id)) continue;
   if (ids.length >= limit) { capped = true; continue; }
   distances.set(id, 0); ids.push(id);
  }
 }
 const included = new Set(ids);
 const edges = snapshot.edges.filter((edge) => (relationOf(edge.properties) ?? '') === relation && included.has(edge.source.imageId) && included.has(edge.target.imageId));
 return {ids, edges, distances, parents: new Map(), capped};
}

/** Every relation the vault uses, in the order a list should show them. */
export function relationNames(snapshot: {edges: EdgeRecord[]}): string[] {
 return [...new Set(snapshot.edges.map((edge) => relationOf(edge.properties) ?? '').filter(Boolean))].sort();
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
