import type {Point, Rect} from './types';

/** A uniform grid over the shown image rectangles, so the renderer and the hit test ask the
 * viewport rather than the vault. Penpot keeps the same thing as `TileHashMap`
 * (render-wasm/src/tiles.rs): tile to shape ids, rebuilt when the layout changes.
 *
 * Ordinals are the paint order. Every answer is sorted by ordinal, so an index lookup draws and
 * hit-tests in the same order as a full scan of the id list. */
const TARGET_PER_CELL=4, MAX_CELLS_PER_RECT=64;

export class SpatialIndex {
 private readonly ids:readonly string[];
 private readonly rects:readonly Rect[];
 private readonly cells=new Map<number,number[]>();
 /** A rectangle covering more cells than it is worth indexing. Read on every query. */
 private readonly wide:number[]=[];
 private readonly stamp:Uint32Array;
 private readonly found:number[]=[];
 private generation=0;
 readonly cell:number;
 private readonly minX:number;private readonly minY:number;
 private readonly maxX:number;private readonly maxY:number;
 private readonly columns:number;private readonly rows:number;

 constructor(order:readonly string[],positions:ReadonlyMap<string,Rect>){
  const ids:string[]=[],rects:Rect[]=[];
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  for(const id of order){
   const r=positions.get(id);if(!r)continue;
   ids.push(id);rects.push(r);
   minX=Math.min(minX,r.x);minY=Math.min(minY,r.y);maxX=Math.max(maxX,r.x+r.width);maxY=Math.max(maxY,r.y+r.height);
  }
  this.ids=ids;this.rects=rects;this.stamp=new Uint32Array(ids.length);
  if(!ids.length){this.cell=1;this.minX=0;this.minY=0;this.maxX=0;this.maxY=0;this.columns=1;this.rows=1;return;}
  this.minX=minX;this.minY=minY;this.maxX=maxX;this.maxY=maxY;
  const area=Math.max(1,(maxX-minX)*(maxY-minY));
  this.cell=Math.max(1,Math.sqrt(area/ids.length*TARGET_PER_CELL));
  this.columns=Math.floor((maxX-minX)/this.cell)+1;this.rows=Math.floor((maxY-minY)/this.cell)+1;
  for(let i=0;i<rects.length;i++){
   const r=rects[i],c0=this.column(r.x),c1=this.column(r.x+r.width),r0=this.row(r.y),r1=this.row(r.y+r.height);
   if((c1-c0+1)*(r1-r0+1)>MAX_CELLS_PER_RECT){this.wide.push(i);continue;}
   for(let c=c0;c<=c1;c++)for(let row=r0;row<=r1;row++){
    const key=row*this.columns+c,bucket=this.cells.get(key);
    if(bucket)bucket.push(i);else this.cells.set(key,[i]);
   }
  }
 }
 get size(){return this.ids.length;}
 private column(x:number){return Math.min(this.columns-1,Math.max(0,Math.floor((x-this.minX)/this.cell)));}
 private row(y:number){return Math.min(this.rows-1,Math.max(0,Math.floor((y-this.minY)/this.cell)));}

 /** Ids whose rectangle meets `area`, in paint order. Do not modify the result. */
 query(area:Rect):readonly string[]{
  const right=area.x+area.width,bottom=area.y+area.height;
  // A window holding the whole layout is the common one — the first sight of a vault. It reads
  // the id list itself: no bucket walk, no sort, and nothing allocated.
  if(!this.ids.length||(area.x<=this.minX&&area.y<=this.minY&&right>=this.maxX&&bottom>=this.maxY))return this.ids;
  const keep=(r:Rect)=>r.x<=right&&r.y<=bottom&&r.x+r.width>=area.x&&r.y+r.height>=area.y;
  const c0=this.column(area.x),c1=this.column(right),r0=this.row(area.y),r1=this.row(bottom);
  // Once a window reaches into most of the grid, one pass over every rectangle beats walking
  // the buckets and sorting what they return back into paint order.
  if((c1-c0+1)*(r1-r0+1)*2>=this.cells.size)return this.name(this.scan(keep));
  return this.name(this.gather(c0,c1,r0,r1,keep).sort((a,b)=>a-b));
 }
 /** Ids whose rectangle contains `point`, topmost first. */
 at(point:Point):string[]{
  const keep=(r:Rect)=>point.x>=r.x&&point.x<=r.x+r.width&&point.y>=r.y&&point.y<=r.y+r.height;
  const c=this.column(point.x),r=this.row(point.y);
  return this.name(this.gather(c,c,r,r,keep).sort((a,b)=>b-a));
 }
 private name(ordinals:readonly number[]):string[]{return ordinals.map(i=>this.ids[i]);}
 /** Every rectangle, in paint order already. */
 private scan(keep:(r:Rect)=>boolean):number[]{
  const found=this.found;found.length=0;
  for(let i=0;i<this.rects.length;i++)if(keep(this.rects[i]))found.push(i);
  return found;
 }
 private gather(c0:number,c1:number,r0:number,r1:number,keep:(r:Rect)=>boolean):number[]{
  const generation=++this.generation,found=this.found;found.length=0;
  for(const i of this.wide){this.stamp[i]=generation;if(keep(this.rects[i]))found.push(i);}
  for(let c=c0;c<=c1;c++)for(let row=r0;row<=r1;row++){
   const bucket=this.cells.get(row*this.columns+c);if(!bucket)continue;
   for(const i of bucket){if(this.stamp[i]===generation)continue;this.stamp[i]=generation;if(keep(this.rects[i]))found.push(i);}
  }
  return found;
 }
}
