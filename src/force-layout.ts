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

/** Stable, capacity-aware radii used by the bounded exploration layout. */
export const hopRadii = (hop: number, count = 1, maxCard = 100): number => {
 const cards = Math.max(1, count);
 const clearance = Math.max(192, maxCard + 96);
 return Math.max(1, Math.floor(hop)) * 420 + Math.max(0, (cards * clearance) / (Math.PI * 2) - 420);
};

/** Above this the edge-node pass costs more than the tangle it removes, and a graph that
 * dense is unreadable whatever the routing. Measured in docs/PERFORMANCE.md. */
const CLEARANCE_BUDGET = 24000;

export function forceLayout(images: ImageRecord[], graph: Neighborhood, rootId: string | null, pinned: Set<string>, previous: Map<string, Rect>): Map<string, Rect> {
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
 // New nodes start on a stable ring around the root. This avoids the large,
 // biased seed cloud that otherwise takes many iterations to untangle.
 const initialRoot = rootId === null ? undefined : positions.get(rootId);
 const maxCard = graph.ids.reduce((size, id) => {
  const image = positions.get(id); return image ? Math.max(size, image.width, image.height) : size;
 }, 100);
 const rings = new Map<number, string[]>();
 for (const id of graph.ids) if (id !== rootId && positions.has(id) && !pinned.has(id)) {
  const hop = graph.distances.get(id) ?? 1;
  const ring=rings.get(hop)??[];ring.push(id);rings.set(hop,ring);
 }
 const ringCapacity = Math.max(1,...[...rings.values()].map(ids=>ids.length));
 if (initialRoot && rootId !== null) for(const [hop,ids] of [...rings.entries()].sort((a,b)=>a[0]-b[0])){
  const phase=seededAngle(rootId);
  const parentAngle=(id:string)=>{const parent=positions.get(graph.parents.get(id)?.imageId??rootId)!;return (Math.atan2(parent.y-initialRoot.y,parent.x-initialRoot.x)-phase+Math.PI*4)%(Math.PI*2);};
  ids.sort((a,b)=>parentAngle(a)-parentAngle(b)||a.localeCompare(b));
  // Allocate distinct slots over the entire hop, not per sibling group. Different
  // branches must never start at the same point on the ring.
  ids.forEach((id,slot)=>{
   const p=positions.get(id)!;
   const angle=phase+(slot+.5)/ids.length*Math.PI*2;
   const radius=hopRadii(hop,ringCapacity,maxCard);
   p.x=initialRoot.x+Math.cos(angle)*radius;
   p.y=initialRoot.y+Math.sin(angle)*radius;
  });
 }
 /* No root: one deterministic ring beats the seeded cloud, which the comment above says takes
  * many iterations to untangle. The force pass then does the whole job, as it did before the
  * hop rings existed. */
 if (!initialRoot) {
  const loose = graph.ids.filter((id) => !pinned.has(id) && !previous.has(id));
  const radius = Math.max(420, loose.length * Math.max(192, maxCard + 96) / (Math.PI * 2));
  const phase = seededAngle(graph.ids[0] ?? '');
  loose.forEach((id, slot) => {
   const p = positions.get(id)!;
   const angle = phase + (slot + .5) / loose.length * Math.PI * 2;
   p.x = Math.cos(angle) * radius; p.y = Math.sin(angle) * radius;
  });
 }
 const movable = graph.ids.filter((id) => !pinned.has(id));
 const edgePairs = graph.edges.map((edge) => [edge.source.imageId, edge.target.imageId] as const).filter(([a, b]) => positions.has(a) && positions.has(b));
 const rootPosition = rootId === null ? undefined : positions.get(rootId);
 const rootAnchor = rootPosition ? {x: rootPosition.x, y: rootPosition.y} : {x: 0, y: 0};
 for (let iteration = 0; iteration < 150; iteration++) {
  const force = new Map<string, Point>();
  for (const id of movable) force.set(id, {x: 0, y: 0});
  for (let i = 0; i < graph.ids.length; i++) for (let j = i + 1; j < graph.ids.length; j++) {
   const leftId = graph.ids[i]; const rightId = graph.ids[j]; const a = positions.get(leftId)!; const b = positions.get(rightId)!;
   const dx = a.x - b.x; const dy = a.y - b.y; const distance = Math.max(1, Math.hypot(dx, dy));
   // Leave room for the caption and its hit area, not only the image pixels.
   const halfDiagonal = Math.hypot(a.width, a.height) / 2 + Math.hypot(b.width, b.height) / 2 + 96;
   const requiredX = (a.width + b.width) / 2 + 96;
   const requiredY = (a.height + b.height) / 2 + 96;
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
  // A connection drawn across an unrelated image is the commonest way this layout becomes
  // unreadable, and nothing above knows a line exists: the node-node term only keeps
  // rectangles apart. Push each node clear of the segments that pass too near it, and let
  // the segment's ends give way in return, so a line bends around an image rather than
  // dragging it along.
  if (edgePairs.length * graph.ids.length <= CLEARANCE_BUDGET) for (const [aId, bId] of edgePairs) {
   const a = positions.get(aId); const b = positions.get(bId); if (!a || !b) continue;
   const ax = a.x + a.width / 2; const ay = a.y + a.height / 2;
   const dx = b.x + b.width / 2 - ax; const dy = b.y + b.height / 2 - ay;
   const lengthSquared = dx * dx + dy * dy || 1;
   for (const id of graph.ids) {
    if (id === aId || id === bId) continue;
    const c = positions.get(id); if (!c) continue;
    const cx = c.x + c.width / 2; const cy = c.y + c.height / 2;
    const along = Math.max(0, Math.min(1, ((cx - ax) * dx + (cy - ay) * dy) / lengthSquared));
    const offX = cx - (ax + along * dx); const offY = cy - (ay + along * dy);
    const gap = Math.max(1e-6, Math.hypot(offX, offY));
    const clearance = Math.hypot(c.width, c.height) / 2 + 96;
    if (gap >= clearance) continue;
    const push = Math.min(60, (clearance - gap) * 0.6);
    const pushX = offX / gap * push; const pushY = offY / gap * push;
    const node = force.get(id); if (node) { node.x += pushX; node.y += pushY; }
    // Each end yields by its share of the segment, so the nearer end moves more.
    const endA = force.get(aId); if (endA) { endA.x -= pushX * (1 - along) * 0.5; endA.y -= pushY * (1 - along) * 0.5; }
    const endB = force.get(bId); if (endB) { endB.x -= pushX * along * 0.5; endB.y -= pushY * along * 0.5; }
   }
  }
  // Keep each hop on a soft radial ring around the root. This makes a
  // 1/2/3-hop exploration readable while allowing overlap and edge forces to
  // settle the exact position.
  const root = rootId === null ? undefined : positions.get(rootId);
  if (root) for (const id of movable) {
   if (id === rootId) continue;
   const p = positions.get(id)!;
   const seededDirection = seeded(id);
   const dx = p.x - root.x; const dy = p.y - root.y;
   const distance = Math.hypot(dx, dy);
   const directionX = distance > 1e-6 ? dx / distance : seededDirection.x / Math.max(1, Math.hypot(seededDirection.x, seededDirection.y));
   const directionY = distance > 1e-6 ? dy / distance : seededDirection.y / Math.max(1, Math.hypot(seededDirection.x, seededDirection.y));
   const hop = graph.distances.get(id) ?? 1;
   const desired = hopRadii(hop, ringCapacity, maxCard);
   const radial = (desired - distance) * 0.08;
   force.get(id)!.x += directionX * radial;
   force.get(id)!.y += directionY * radial;
  }
  for (const id of movable) {
   const p = positions.get(id)!; const f = force.get(id)!;
   if (id === rootId) continue;
   p.x += Math.max(-12, Math.min(12, f.x)); p.y += Math.max(-12, Math.min(12, f.y));
  }
  // Root anchoring is exact and repeated so no accumulated force can drift it.
  if (rootPosition) { rootPosition.x = rootAnchor.x; rootPosition.y = rootAnchor.y; }
 }
 if (rootPosition) { rootPosition.x = rootAnchor.x; rootPosition.y = rootAnchor.y; }
 return positions;
}
