// Where an explored neighbourhood's cards go: hop rings around the root, pins and the root kept
// where they are, the rest settled from wherever they were last frame. One of the four modules
// graph.ts held until 2026-09-21.

import type {ImageRecord, Point, Rect} from './types';
import {exploreSize} from './layout';
import type {Neighborhood} from './traversal';

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

/** The middle of some rectangles' corners; the origin when there are none. */
const centroid = (rects: readonly Point[]): Point => rects.length
 ? {x: rects.reduce((sum, r) => sum + r.x, 0) / rects.length, y: rects.reduce((sum, r) => sum + r.y, 0) / rects.length}
 : {x: 0, y: 0};

/** Stable, capacity-aware radii used by the bounded exploration layout. */
export const hopRadii = (hop: number, count = 1, maxCard = 100): number => {
 const cards = Math.max(1, count);
 const clearance = Math.max(192, maxCard + 96);
 return Math.max(1, Math.floor(hop)) * 420 + Math.max(0, (cards * clearance) / (Math.PI * 2) - 420);
};

/** Above this the edge-node pass costs more than the tangle it removes, and a graph that
 * dense is unreadable whatever the routing. Measured in docs/PERFORMANCE.md. */
const CLEARANCE_BUDGET = 24000;
/** How many steps a settle may take. The last `COOLING` of them bring the step to nothing. */
const ITERATIONS = 150;
const COOLING = 50;
/** The furthest an image moves in one step, at full heat. */
const STEP = 12;
/** A step this small is a settled layout, and the rest of the iterations are skipped. */
const SETTLED = 0.05;

/**
 * Lay a neighbourhood out. `held` images keep the rectangle `previous` gives them; every other
 * image is settled by the forces, from where `previous` had it or from a fresh ring slot when
 * it had nothing. The anchor (`rootId`) is held whatever the set says.
 *
 * The step cools from `STEP` to nothing over the iterations. Without that the pass never
 * settles: the overlap and clearance pushes are step functions, several of them on one image
 * sum past the stable stiffness, and the image rattles at the full clamp forever — measured
 * 2026-09-21 at 17px per iteration after 1,500 iterations on a rootless tree. The result was
 * then whatever iteration 150 happened to hold, and a rebuild from it moved every image by
 * hundreds of pixels.
 */
export function forceLayout(images: ImageRecord[], graph: Neighborhood, rootId: string | null, held: Set<string>, previous: Map<string, Rect>): Map<string, Rect> {
 const byId = new Map(images.map((image) => [image.id, image]));
 const positions = new Map<string, Rect>();
 for (const id of graph.ids) {
  const image = byId.get(id);
  if (!image) continue;
  const old = previous.get(id);
  // Explored thumbnails are contained rather than height-constrained: a tall picture and a
  // wide one are both wholly visible, and neither costs the ring a whole row of width.
  const fit = exploreSize(image);
  positions.set(id, old ? {...old, ...fit} : {...image, ...fit, x: seeded(id).x, y: seeded(id).y});
 }
 const movable = graph.ids.filter((id) => positions.has(id) && id !== rootId && !held.has(id));
 const fresh = new Set(movable.filter((id) => !previous.has(id)));
 // New nodes start on a stable ring. Around the anchor when there is one; otherwise around a
 // point that stands in for it — the middle of where the starting images already were, or the
 // origin — with the starting images themselves on the innermost ring and their neighbours
 // outside, so a rootless neighbourhood reads the same way an anchored one does. This avoids
 // the large, biased seed cloud that otherwise takes many iterations to untangle. A node that
 // already had a place starts from it: a neighbourhood that grows settles from where it was
 // rather than springing apart.
 const initialRoot = rootId === null ? undefined : positions.get(rootId);
 const centre = initialRoot ? {x: initialRoot.x, y: initialRoot.y} : centroid(graph.ids.filter((id) => (graph.distances.get(id) ?? 0) === 0 && previous.has(id)).map((id) => positions.get(id)!));
 // Without an anchor the starting images are hop 0 and take the first ring themselves.
 const ringOf = (id: string) => (graph.distances.get(id) ?? 1) + (initialRoot ? 0 : 1);
 const maxCard = graph.ids.reduce((size, id) => {
  const image = positions.get(id); return image ? Math.max(size, image.width, image.height) : size;
 }, 100);
 const rings = new Map<number, string[]>();
 for (const id of graph.ids) if (id !== rootId && positions.has(id) && !held.has(id)) {
  const ring=rings.get(ringOf(id))??[];ring.push(id);rings.set(ringOf(id),ring);
 }
 const ringCapacity = Math.max(1,...[...rings.values()].map(ids=>ids.length));
 const phase=seededAngle(rootId ?? graph.ids[0] ?? '');
 for(const [hop,ids] of [...rings.entries()].sort((a,b)=>a[0]-b[0])){
  // Order a ring by where each node's parent sits, so a branch stays together. A node with no
  // parent — a starting image, or every image of a relation — keeps the order the graph gave
  // it, which for a relation puts the two ends of each connection side by side.
  const parentAngle=(id:string)=>{const parent=graph.parents.get(id);if(!parent)return 0;const p=positions.get(parent.imageId);return p?(Math.atan2(p.y-centre.y,p.x-centre.x)-phase+Math.PI*4)%(Math.PI*2):0;};
  ids.sort((a,b)=>parentAngle(a)-parentAngle(b));
  // Allocate distinct slots over the entire hop, not per sibling group. Different
  // branches must never start at the same point on the ring.
  ids.forEach((id,slot)=>{
   if(!fresh.has(id))return;
   const p=positions.get(id)!;
   const angle=phase+(slot+.5)/ids.length*Math.PI*2;
   const radius=hopRadii(hop,ringCapacity,maxCard);
   p.x=centre.x+Math.cos(angle)*radius;
   p.y=centre.y+Math.sin(angle)*radius;
  });
 }
 const edgePairs = graph.edges.map((edge) => [edge.source.imageId, edge.target.imageId] as const).filter(([a, b]) => positions.has(a) && positions.has(b));
 const rootPosition = rootId === null ? undefined : positions.get(rootId);
 const rootAnchor = rootPosition ? {x: rootPosition.x, y: rootPosition.y} : {x: 0, y: 0};
 const clearance = edgePairs.length * graph.ids.length <= CLEARANCE_BUDGET;
 // A relation has no hops: every image is at distance 0 and nothing has a parent. Its ring is
 // only a starting shape, and holding it there would jam cards that the springs and the
 // repulsion would otherwise spread — measured 2026-09-21: 26 overlaps among 150 pairs held,
 // none free.
 const layered = rootId !== null || graph.parents.size > 0;
 const force = new Map<string, Point>();
 for (let iteration = 0; iteration < ITERATIONS && movable.length; iteration++) {
  const heat = Math.min(STEP, STEP * (ITERATIONS - iteration) / COOLING);
  for (const id of movable) force.set(id, {x: 0, y: 0});
  // Only a movable image feels a force, so each is measured against every other and the
  // held ones cost nothing. A rebuild that holds everything but one newcomer is O(n).
  for (const leftId of movable) {
   const a = positions.get(leftId)!, f = force.get(leftId)!;
   for (const rightId of graph.ids) {
    if (rightId === leftId) continue;
    const b = positions.get(rightId); if (!b) continue;
    const dx = a.x - b.x; const dy = a.y - b.y; const distance = Math.max(1, Math.hypot(dx, dy));
    // Leave room for the caption and its hit area, not only the image pixels.
    const halfDiagonal = Math.hypot(a.width, a.height) / 2 + Math.hypot(b.width, b.height) / 2 + 96;
    const requiredX = (a.width + b.width) / 2 + 96;
    const requiredY = (a.height + b.height) / 2 + 96;
    const overlap = Math.max(0, Math.min(requiredX - Math.abs(dx), requiredY - Math.abs(dy)));
    const required = Math.max(halfDiagonal, Math.min(requiredX, requiredY));
    const push = distance < required || overlap > 0 ? Math.min(100, Math.max((required - distance) * 0.28, overlap * 0.12)) : Math.min(12, 5000 / (distance * distance));
    f.x += dx / distance * push; f.y += dy / distance * push;
   }
  }
  for (const [aId, bId] of edgePairs) {
   const endA = force.get(aId), endB = force.get(bId);
   if (!endA && !endB) continue;
   const a = positions.get(aId)!; const b = positions.get(bId)!; const dx = b.x - a.x; const dy = b.y - a.y; const distance = Math.max(1, Math.hypot(dx, dy));
   const pull = (distance - 400) * 0.01; const fx = dx / distance * pull; const fy = dy / distance * pull;
   if (endA) { endA.x += fx; endA.y += fy; }
   if (endB) { endB.x -= fx; endB.y -= fy; }
  }
  // A connection drawn across an unrelated image is the commonest way this layout becomes
  // unreadable, and nothing above knows a line exists: the node-node term only keeps
  // rectangles apart. Push each node clear of the segments that pass too near it, and let
  // the segment's ends give way in return, so a line bends around an image rather than
  // dragging it along. A held image still bends the lines that cross it.
  if (clearance) for (const [aId, bId] of edgePairs) {
   const a = positions.get(aId); const b = positions.get(bId); if (!a || !b) continue;
   const endA = force.get(aId), endB = force.get(bId);
   const ax = a.x + a.width / 2; const ay = a.y + a.height / 2;
   const dx = b.x + b.width / 2 - ax; const dy = b.y + b.height / 2 - ay;
   const lengthSquared = dx * dx + dy * dy || 1;
   for (const id of endA || endB ? graph.ids : movable) {
    if (id === aId || id === bId) continue;
    const c = positions.get(id); if (!c) continue;
    const cx = c.x + c.width / 2; const cy = c.y + c.height / 2;
    const along = Math.max(0, Math.min(1, ((cx - ax) * dx + (cy - ay) * dy) / lengthSquared));
    const offX = cx - (ax + along * dx); const offY = cy - (ay + along * dy);
    const gap = Math.max(1e-6, Math.hypot(offX, offY));
    const clear = Math.hypot(c.width, c.height) / 2 + 96;
    if (gap >= clear) continue;
    const push = Math.min(60, (clear - gap) * 0.6);
    const pushX = offX / gap * push; const pushY = offY / gap * push;
    const node = force.get(id); if (node) { node.x += pushX; node.y += pushY; }
    // Each end yields by its share of the segment, so the nearer end moves more.
    if (endA) { endA.x -= pushX * (1 - along) * 0.5; endA.y -= pushY * (1 - along) * 0.5; }
    if (endB) { endB.x -= pushX * along * 0.5; endB.y -= pushY * along * 0.5; }
   }
  }
  // Keep each hop on a soft radial ring around the centre. This makes a 1/2/3-hop exploration
  // readable while allowing overlap and edge forces to settle the exact position, and it is
  // what makes the pass settle at all: the springs alone are too weak to.
  if (layered) for (const id of movable) {
   const p = positions.get(id)!;
   const seededDirection = seeded(id);
   const dx = p.x - centre.x; const dy = p.y - centre.y;
   const distance = Math.hypot(dx, dy);
   const directionX = distance > 1e-6 ? dx / distance : seededDirection.x / Math.max(1, Math.hypot(seededDirection.x, seededDirection.y));
   const directionY = distance > 1e-6 ? dy / distance : seededDirection.y / Math.max(1, Math.hypot(seededDirection.x, seededDirection.y));
   const desired = hopRadii(ringOf(id), ringCapacity, maxCard);
   const radial = (desired - distance) * 0.08;
   force.get(id)!.x += directionX * radial;
   force.get(id)!.y += directionY * radial;
  }
  let furthest = 0;
  for (const id of movable) {
   const p = positions.get(id)!; const f = force.get(id)!;
   const stepX = Math.max(-heat, Math.min(heat, f.x)), stepY = Math.max(-heat, Math.min(heat, f.y));
   p.x += stepX; p.y += stepY;
   furthest = Math.max(furthest, Math.abs(stepX), Math.abs(stepY));
  }
  // Root anchoring is exact and repeated so no accumulated force can drift it.
  if (rootPosition) { rootPosition.x = rootAnchor.x; rootPosition.y = rootAnchor.y; }
  if (furthest < SETTLED) break;
 }
 if (rootPosition) { rootPosition.x = rootAnchor.x; rootPosition.y = rootAnchor.y; }
 return positions;
}
