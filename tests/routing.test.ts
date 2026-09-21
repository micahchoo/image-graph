import {describe, expect, it} from 'vitest';
import {LANE, midpointOf, routeOrthogonal, simplify} from '../src/routing';
import type {Point, Rect} from '../src/types';

const box=(x:number,y:number,width=100,height=100):Rect=>({x,y,width,height});
const enters=(path:Point[],r:Rect,lane=LANE)=>{
 const grown={x:r.x-lane,y:r.y-lane,width:r.width+lane*2,height:r.height+lane*2};
 for(let i=1;i<path.length;i++){
  const a=path[i-1],b=path[i];
  const left=Math.min(a.x,b.x),right=Math.max(a.x,b.x),top=Math.min(a.y,b.y),bottom=Math.max(a.y,b.y);
  if(left<grown.x+grown.width&&grown.x<right&&top<grown.y+grown.height&&grown.y<bottom)return true;
 }
 return false;
};
const orthogonal=(path:Point[])=>path.every((p,i)=>i===0||p.x===path[i-1].x||p.y===path[i-1].y);

describe('orthogonal routing', () => {
 it('goes around an image standing between the two ends', () => {
  const wall=box(200,-50,100,200);
  const path=routeOrthogonal({x:0,y:50},{x:500,y:50},[wall]);
  expect(path).not.toBeNull();
  expect(orthogonal(path!)).toBe(true);
  expect(enters(path!,wall)).toBe(false);
  expect(path![0]).toEqual({x:0,y:50});
  expect(path!.at(-1)).toEqual({x:500,y:50});
  expect(path!.length).toBeGreaterThan(2);   // a straight line would not clear it
 });

 it('prefers fewer corners when two ways round cost the same', () => {
  const path=routeOrthogonal({x:0,y:0},{x:400,y:400},[box(150,150)]);
  expect(path).not.toBeNull();
  expect(path!.length).toBeLessThanOrEqual(4);
 });

 it('refuses a detour longer than crossing would be', () => {
  // The way round this wall exists, and it is a million units long. A straight line through
  // the image reads better than that, so the router declines and the caller draws one.
  expect(routeOrthogonal({x:0,y:0},{x:300,y:0},[box(100,-1e6,100,2e6)])).toBeNull();
  // The same wall at a workable height is routed.
  expect(routeOrthogonal({x:0,y:0},{x:300,y:0},[box(100,-150,100,300)])).not.toBeNull();
  expect(routeOrthogonal({x:0,y:0},{x:10,y:10},[])).toBeNull();
 });

 it('keeps only the bends', () => {
  expect(simplify([{x:0,y:0},{x:5,y:0},{x:9,y:0},{x:9,y:4}])).toEqual([{x:0,y:0},{x:9,y:0},{x:9,y:4}]);
  expect(simplify([{x:1,y:1},{x:1,y:1}])).toEqual([{x:1,y:1}]);
 });

 it('finds the segment half way along by length, not by count', () => {
  // Three segments of 10, 90 and 10: the middle one holds the half-way point.
  const path=[{x:0,y:0},{x:10,y:0},{x:100,y:0},{x:110,y:0}];
  expect(midpointOf(path)).toEqual({a:{x:10,y:0},b:{x:100,y:0}});
 });

 it('answers a crowded field quickly enough for a frame', () => {
  const obstacles=Array.from({length:20},(_,i)=>box((i%5)*220+120,Math.floor(i/5)*220+120,120,120));
  const started=performance.now();
  for(let i=0;i<30;i++)routeOrthogonal({x:0,y:i*7},{x:1300,y:900},obstacles);
  expect((performance.now()-started)/30).toBeLessThan(6);
 });
});
