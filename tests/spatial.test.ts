import {describe, expect, it} from 'vitest';
import {SpatialIndex} from '../src/spatial';
import type {Point, Rect} from '../src/types';

const meets=(r:Rect,a:Rect)=>r.x<=a.x+a.width&&r.y<=a.y+a.height&&r.x+r.width>=a.x&&r.y+r.height>=a.y;
const holds=(r:Rect,p:Point)=>p.x>=r.x&&p.x<=r.x+r.width&&p.y>=r.y&&p.y<=r.y+r.height;
const scan=(order:string[],positions:Map<string,Rect>,area:Rect)=>order.filter(id=>meets(positions.get(id)!,area));

function grid(columns:number,rows:number){
 const order:string[]=[],positions=new Map<string,Rect>();
 for(let y=0;y<rows;y++)for(let x=0;x<columns;x++){const id=`i${x}-${y}`;order.push(id);positions.set(id,{x:x*40,y:y*40,width:32,height:32});}
 return {order,positions};
}

describe('spatial index', () => {
 it('answers a window with what a full scan answers, in the same order', () => {
  const {order,positions}=grid(40,40);
  const index=new SpatialIndex(order,positions);
  // Windows that take the fast whole-layout path, the one-pass path and the bucket path.
  for(const area of [{x:0,y:0,width:100,height:100},{x:410,y:730,width:220,height:90},
                     {x:-500,y:-500,width:200,height:200},{x:-1e4,y:-1e4,width:2e4,height:2e4},
                     {x:0,y:0,width:1200,height:1200},{x:-5,y:-5,width:1610,height:1610}]){
   expect(index.query(area)).toEqual(scan(order,positions,area));
  }
 });

 it('reads a point topmost first', () => {
  const order=['under','over'],positions=new Map<string,Rect>([['under',{x:0,y:0,width:100,height:100}],['over',{x:10,y:10,width:20,height:20}]]);
  const index=new SpatialIndex(order,positions);
  expect(index.at({x:15,y:15})).toEqual(['over','under']);
  expect(index.at({x:60,y:60})).toEqual(['under']);
  expect(index.at({x:500,y:500})).toEqual([]);
 });

 it('keeps a rectangle too wide to bucket', () => {
  // A backdrop spanning the whole layout would otherwise own thousands of cells.
  const {order,positions}=grid(30,30);
  order.unshift('backdrop');positions.set('backdrop',{x:-100,y:-100,width:4000,height:4000});
  const index=new SpatialIndex(order,positions);
  const area={x:500,y:500,width:50,height:50};
  expect(index.query(area)).toEqual(scan(order,positions,area));
  expect(index.at({x:505,y:505})[index.at({x:505,y:505}).length-1]).toBe('backdrop');
 });

 it('holds an empty layout and one with no extent', () => {
  expect(new SpatialIndex([],new Map()).query({x:0,y:0,width:10,height:10})).toEqual([]);
  const one=new Map<string,Rect>([['a',{x:5,y:5,width:0,height:0}]]);
  expect(new SpatialIndex(['a'],one).at({x:5,y:5})).toEqual(['a']);
  expect(new SpatialIndex(['a','missing'],one).size).toBe(1);
 });

 it('repeats an answer, so a stale stamp cannot hide a hit', () => {
  const {order,positions}=grid(12,12);
  const index=new SpatialIndex(order,positions);
  const area={x:0,y:0,width:60,height:60};
  const first=index.query(area);
  index.query({x:300,y:300,width:60,height:60});
  expect(index.query(area)).toEqual(first);
 });
});
