import type {Point, Rect} from './types';

/** A connection that runs across an unrelated image is read as passing behind it. An
 * orthogonal path around the obstacles says plainly which two things are joined.
 *
 * The grid is the standard one: every interesting coordinate is an obstacle edge, so a path
 * that exists at all exists on this grid, and it has at most a few hundred nodes rather than
 * a pixel lattice. A* then walks it with a penalty per turn, so a route with fewer corners
 * wins over a marginally shorter one. */
const TURN=90, MAX_OBSTACLES=20;
/** A detour longer than this multiple of the direct distance reads as a worse answer than
 * simply crossing the image. The caller draws a straight line instead. */
const MAX_DETOUR=2.4;

/** Room left between a path and an image, in world units. */
export const LANE=26;

const inside=(r:Rect,x:number,y:number)=>x>r.x&&x<r.x+r.width&&y>r.y&&y<r.y+r.height;

/** Does the axis-aligned segment enter any obstacle? Endpoints touching a border do not count. */
function blocked(obstacles:readonly Rect[],ax:number,ay:number,bx:number,by:number):boolean{
 const left=Math.min(ax,bx),right=Math.max(ax,bx),top=Math.min(ay,by),bottom=Math.max(ay,by);
 for(const r of obstacles)if(left<r.x+r.width&&r.x<right&&top<r.y+r.height&&r.y<bottom)return true;
 return false;
}

/** Smallest-first queue over node indexes. A linear scan would cost more than the search. */
class Heap {
 private readonly items:number[]=[];private readonly keys:number[]=[];
 get size(){return this.items.length;}
 push(item:number,key:number){
  this.items.push(item);this.keys.push(key);
  let i=this.items.length-1;
  while(i>0){const parent=(i-1)>>1;if(this.keys[parent]<=this.keys[i])break;this.swap(parent,i);i=parent;}
 }
 pop():number{
  const top=this.items[0],lastItem=this.items.pop(),lastKey=this.keys.pop();
  if(this.items.length&&lastItem!==undefined&&lastKey!==undefined){
   this.items[0]=lastItem;this.keys[0]=lastKey;
   for(let i=0;;){
    const left=i*2+1,right=left+1;let small=i;
    if(left<this.items.length&&this.keys[left]<this.keys[small])small=left;
    if(right<this.items.length&&this.keys[right]<this.keys[small])small=right;
    if(small===i)break;this.swap(small,i);i=small;
   }
  }
  return top;
 }
 private swap(a:number,b:number){
  [this.items[a],this.items[b]]=[this.items[b],this.items[a]];
  [this.keys[a],this.keys[b]]=[this.keys[b],this.keys[a]];
 }
}

const axis=(values:number[])=>{const sorted=[...new Set(values)].sort((a,b)=>a-b);return sorted;};

/** An orthogonal path from `from` to `to` that enters no obstacle, or null when none exists.
 * Obstacles must already exclude the two rectangles the connection joins. */
export function routeOrthogonal(from:Point,to:Point,obstacles:readonly Rect[],lane=LANE,maxDetour=MAX_DETOUR):Point[]|null{
 if(!obstacles.length)return null;
 const near=obstacles.slice(0,MAX_OBSTACLES).map(r=>({x:r.x-lane,y:r.y-lane,width:r.width+lane*2,height:r.height+lane*2}));
 const xs=axis([from.x,to.x,...near.flatMap(r=>[r.x,r.x+r.width])]);
 const ys=axis([from.y,to.y,...near.flatMap(r=>[r.y,r.y+r.height])]);
 const columns=xs.length,nodes=columns*ys.length;
 const open=new Uint8Array(nodes);
 for(let j=0;j<ys.length;j++)for(let i=0;i<columns;i++){
  let free=1;
  for(const r of near)if(inside(r,xs[i],ys[j])){free=0;break;}
  open[j*columns+i]=free;
 }
 const start=ys.indexOf(from.y)*columns+xs.indexOf(from.x),goal=ys.indexOf(to.y)*columns+xs.indexOf(to.x);
 if(start<0||goal<0||!open[start]||!open[goal])return null;
 const best=new Float64Array(nodes).fill(Infinity),cameFrom=new Int32Array(nodes).fill(-1);
 const guess=(node:number)=>Math.abs(xs[node%columns]-to.x)+Math.abs(ys[(node/columns)|0]-to.y);
 const queue=new Heap();
 best[start]=0;queue.push(start,guess(start));
 while(queue.size){
  const node=queue.pop();
  if(node===goal)break;
  const i=node%columns,j=(node/columns)|0,previous=cameFrom[node];
  const wasVertical=previous>=0&&(previous%columns)===i;
  for(const [di,dj] of [[1,0],[-1,0],[0,1],[0,-1]]){
   const ni=i+di,nj=j+dj;
   if(ni<0||nj<0||ni>=columns||nj>=ys.length)continue;
   const next=nj*columns+ni;
   if(!open[next]||blocked(near,xs[i],ys[j],xs[ni],ys[nj]))continue;
   const vertical=di===0;
   const step=Math.abs(xs[ni]-xs[i])+Math.abs(ys[nj]-ys[j])+(previous>=0&&vertical!==wasVertical?TURN:0);
   const cost=best[node]+step;
   if(cost>=best[next])continue;
   best[next]=cost;cameFrom[next]=node;queue.push(next,cost+guess(next));
  }
 }
 if(!Number.isFinite(best[goal]))return null;
 const path:Point[]=[];
 for(let node=goal;node>=0;node=cameFrom[node])path.push({x:xs[node%columns],y:ys[(node/columns)|0]});
 path.reverse();
 // Measured on the path, not on the search cost: that carries the turn penalty, which is a
 // tie-breaker between routes and says nothing about how far the line actually travels.
 const direct=Math.abs(to.x-from.x)+Math.abs(to.y-from.y);
 let travelled=0;
 for(let i=1;i<path.length;i++)travelled+=Math.abs(path[i].x-path[i-1].x)+Math.abs(path[i].y-path[i-1].y);
 if(travelled>Math.max(direct,lane*4)*maxDetour)return null;
 return simplify(path);
}

/** Drop the middle of any three points on one line; a bend is the only point worth keeping. */
export function simplify(path:readonly Point[]):Point[]{
 const out:Point[]=[];
 for(const point of path){
  const last=out[out.length-1],before=out[out.length-2];
  if(last&&last.x===point.x&&last.y===point.y)continue;
  if(before&&last&&((before.x===last.x&&last.x===point.x)||(before.y===last.y&&last.y===point.y)))out.pop();
  out.push(point);
 }
 return out;
}

/** The point half way along by length, and the direction there, for placing a label. */
export function midpointOf(path:readonly Point[]):{a:Point;b:Point}{
 let total=0;
 for(let i=1;i<path.length;i++)total+=Math.hypot(path[i].x-path[i-1].x,path[i].y-path[i-1].y);
 let walked=0;
 for(let i=1;i<path.length;i++){
  const length=Math.hypot(path[i].x-path[i-1].x,path[i].y-path[i-1].y);
  if(walked+length>=total/2||i===path.length-1)return{a:path[i-1],b:path[i]};
  walked+=length;
 }
 return{a:path[0],b:path[path.length-1]};
}
