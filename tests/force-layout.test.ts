import {describe, expect, it} from 'vitest';

import {containsRegion} from '../src/region-shape';
import {edgeEndpoints, endpointPosition} from '../src/edge-endpoints';
import {forceLayout} from '../src/force-layout';
import {neighborhood, relationNames, relationNeighborhood} from '../src/traversal';
import type {EdgeRecord, ImageRecord, Rect, RegionRecord} from '../src/types';
import {EXPLORE_BOX, exploreSize} from '../src/layout';

const image = (id: string): ImageRecord => ({id, path: `${id}.png`, x: 0, y: 0, width: 100, height: 80});
const edge = (id: string, source: string, target: string, relation = 'related'): EdgeRecord => ({id, source: {imageId: source}, target: {imageId: target}, direction: 'forward', properties: {relation}});

describe('graph geometry and layout', () => {
 it('keeps three hop bands ordered for mixed-size cards and reserves caption space',()=>{
  const images=Array.from({length:15},(_,i)=>({...image(String(i)),width:240,height:i%3===0?140:240}));
  const links=Array.from({length:14},(_,i)=>edge(`e${i}`,String(Math.floor(i/2)),String(i+1)));
  const graph=neighborhood({images,edges:links},'0',3,new Set());
  const result=forceLayout(images,graph,'0',new Set(),new Map());
  const root=result.get('0')!;
  const bands=new Map<number,number[]>();
  for(const [id,r] of result){const hop=graph.distances.get(id)!;const radius=Math.hypot(r.x+r.width/2-root.x-root.width/2,r.y+r.height/2-root.y-root.height/2);bands.set(hop,[...(bands.get(hop)??[]),radius]);}
  for(let hop=1;hop<3;hop++)expect(Math.max(...bands.get(hop)!)).toBeLessThan(Math.min(...bands.get(hop+1)!));
  const cards=[...result.values()];
  for(let i=0;i<cards.length;i++)for(let j=i+1;j<cards.length;j++){const a=cards[i],b=cards[j];expect(a.x+a.width+24<=b.x||b.x+b.width+24<=a.x||a.y+a.height+60<=b.y||b.y+b.height+60<=a.y).toBe(true);}
 });

 it('keeps a 150-image first-hop neighborhood finite and non-overlapping',()=>{
  const images=Array.from({length:150},(_,i)=>({...image(String(i)),width:240,height:240}));
  const graph=neighborhood({images,edges:images.slice(1).map(i=>edge(`e${i.id}`,'0',i.id))},'0',1,new Set());
  const result=forceLayout(images,graph,'0',new Set(),new Map());
  const cards=[...result.values()];
  for(const r of cards)expect(Number.isFinite(r.x)&&Number.isFinite(r.y)).toBe(true);
  for(let i=0;i<cards.length;i++)for(let j=i+1;j<cards.length;j++){const a=cards[i],b=cards[j];expect(a.x+a.width<=b.x||b.x+b.width<=a.x||a.y+a.height+30<=b.y||b.y+b.height+30<=a.y).toBe(true);}
 });

 it('handles rectangle/polygon boundaries and normalized endpoints', () => {
  expect(containsRegion({x: .5, y: .5}, {type: 'rect', x: .2, y: .2, width: .5, height: .5})).toBe(true);
  expect(containsRegion({x: 0, y: 0}, {type: 'polygon', points: [{x: 0, y: 0}, {x: 1, y: 0}, {x: .5, y: 1}]})).toBe(true);
  const rect: Rect = {x: 10, y: 20, width: 200, height: 100};
  const region: RegionRecord = {id: 'r', imageId: 'a', label: '', shape: {type: 'rect', x: .25, y: .2, width: .5, height: .4}, properties: {}};
  expect(endpointPosition({imageId: 'a', regionId: 'r'}, new Map([['a', rect]]), new Map([['r', region]]))).toEqual({x: 110, y: 60});
 });

 it('clips edge endpoints to image and region boundaries', () => {
  const images = new Map([['a', {x: 0, y: 0, width: 100, height: 80}], ['b', {x: 200, y: 0, width: 100, height: 80}]] as Array<[string, Rect]>);
  const regions = new Map([['r', {id: 'r', imageId: 'a', label: '', shape: {type: 'rect', x: .2, y: .25, width: .4, height: .5}, properties: {}} as RegionRecord]]);
  const points = edgeEndpoints({id: 'e', source: {imageId: 'a', regionId: 'r'}, target: {imageId: 'b'}, direction: 'forward', properties: {}}, images, regions);
  expect(points.source).toEqual({x: 60, y: 40});
  expect(points.target).toEqual({x: 200, y: 40});
  const polygonRegions = new Map([['p', {id: 'p', imageId: 'a', label: '', shape: {type: 'polygon', points: [{x: 0, y: .5}, {x: .5, y: 0}, {x: 1, y: .5}, {x: .5, y: 1}]}, properties: {}} as RegionRecord]]);
  const polygonPoints = edgeEndpoints({id: 'p', source: {imageId: 'a', regionId: 'p'}, target: {imageId: 'b'}, direction: 'forward', properties: {}}, images, polygonRegions);
  expect(polygonPoints.source.x).toBeGreaterThan(45);
  expect(polygonPoints.source.x).toBeLessThanOrEqual(100);
  expect(polygonPoints.target.x).toBe(200);
 });

 it('preserves pinned/root positions and converges repeatably from previous positions', () => {
  const images = ['a', 'b', 'c'].map(image); const graph = neighborhood({images, edges: [edge('ab', 'a', 'b'), edge('bc', 'b', 'c')]}, 'a', 3, new Set());
  const previous = new Map<string, Rect>([['a', {x: 50, y: 60, width: 100, height: 80}], ['b', {x: 300, y: 60, width: 100, height: 80}], ['c', {x: 600, y: 60, width: 100, height: 80}]]);
  const first = forceLayout(images, graph, 'a', new Set(['a']), previous);
  const second = forceLayout(images, graph, 'a', new Set(['a']), first);
  expect(first.get('a')).toEqual({...previous.get('a'), ...exploreSize(images[0])});
  expect(second.get('a')).toEqual(first.get('a'));
  expect(Math.abs(second.get('b')!.x - first.get('b')!.x)).toBeLessThan(10);
 });

 it('anchors an unpinned root and separates hop rings without moving pins', () => {
  const images = ['root', 'one', 'two'].map(image);
  const graph = neighborhood({images, edges: [edge('r1', 'root', 'one'), edge('12', 'one', 'two')]}, 'root', 3, new Set());
  const previous = new Map<string, Rect>([
   ['root', {x: 40, y: 50, width: 100, height: 80}],
   ['one', {x: 45, y: 50, width: 100, height: 80}],
   ['two', {x: 55, y: 50, width: 100, height: 80}],
  ]);
  const pinned = new Map(previous);
  const result = forceLayout(images, graph, 'root', new Set(['one']), previous);
  expect(result.get('root')!.x).toBe(40);
  expect(result.get('root')!.y).toBe(50);
  expect(result.get('one')).toEqual({...pinned.get('one'), ...exploreSize(images[1])});
  const root = result.get('root')!;
  const one = result.get('one')!;
  const two = result.get('two')!;
  const hopOne = Math.hypot(one.x - root.x, one.y - root.y);
  const hopTwo = Math.hypot(two.x - root.x, two.y - root.y);
  expect(Number.isFinite(hopOne) && Number.isFinite(hopTwo)).toBe(true);
  expect(hopTwo).toBeGreaterThan(hopOne);
 });

 it('contains an explored thumbnail in one box, whatever its proportions', () => {
  const images = [{...image('wide'), width: 960, height: 240}, {...image('tall'), width: 240, height: 960}];
  const graph = neighborhood({images, edges: [edge('wt', 'wide', 'tall')]}, 'wide', 3, new Set());
  const result = forceLayout(images, graph, 'wide', new Set(), new Map());
  for (const id of ['wide', 'tall']) {
   const fit = result.get(id)!;
   expect(Math.max(fit.width, fit.height)).toBe(EXPLORE_BOX);
   expect(Math.min(fit.width, fit.height)).toBe(EXPLORE_BOX / 4);
  }
  expect(result.get('wide')!.width).toBeGreaterThan(result.get('wide')!.height);
  expect(result.get('tall')!.height).toBeGreaterThan(result.get('tall')!.width);
 });

 it('gathers every image one relation joins, with no root and no hops', () => {
  const images = ['a', 'b', 'c', 'd', 'e'].map(image);
  const edges = [edge('ab', 'a', 'b', 'resembles'), edge('cd', 'c', 'd', 'resembles'), edge('de', 'd', 'e', 'contrasts')];
  const graph = relationNeighborhood({images, edges}, 'resembles');
  expect(graph.ids.sort()).toEqual(['a', 'b', 'c', 'd']);
  expect(graph.edges.map(e => e.id)).toEqual(['ab', 'cd']);
  // Two components, no root: every image is at the same distance and nothing has a parent.
  expect([...new Set(graph.distances.values())]).toEqual([0]);
  expect(graph.parents.size).toBe(0);
  expect(graph.capped).toBe(false);
  expect(relationNames({edges})).toEqual(['contrasts', 'resembles']);
 });

 it('caps a relation and says so', () => {
  const images = ['a', 'b', 'c', 'd'].map(image);
  const edges = [edge('ab', 'a', 'b'), edge('cd', 'c', 'd')];
  const graph = relationNeighborhood({images, edges}, 'related', 2);
  expect(graph.ids).toHaveLength(2);
  expect(graph.capped).toBe(true);
  // An edge whose far end was cut is not drawn.
  expect(graph.edges.map(e => e.id)).toEqual(['ab']);
 });

 it('lays a rootless graph out without overlap', () => {
  const images = ['a', 'b', 'c', 'd', 'e', 'f'].map(image);
  const edges = [edge('ab', 'a', 'b'), edge('cd', 'c', 'd'), edge('ef', 'e', 'f')];
  const graph = relationNeighborhood({images, edges}, 'related');
  const result = forceLayout(images, graph, null, new Set(), new Map());
  expect(result.size).toBe(6);
  for (const left of graph.ids) for (const right of graph.ids) {
   if (left >= right) continue;
   const a = result.get(left)!, b = result.get(right)!;
   const apart = a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
   expect(apart, `${left} and ${right}`).toBe(true);
  }
 });

 it('keeps the twelve-card demo readable at three hops', () => {
  const images = Array.from({length: 12}, (_, index) => ({...image(String(index)),width:240,height:240}));
  const links: Array<[number, number]> = [[0, 1], [0, 2], [1, 3], [1, 4], [2, 5], [3, 6], [4, 7], [5, 8], [3, 4], [6, 9], [7, 10], [8, 11]];
  const graph = neighborhood({images, edges: links.map(([a, b], index) => edge(String(index), String(a), String(b)))}, '0', 3, new Set());
  const result = forceLayout(images, graph, '0', new Set(), new Map());
  const root=result.get('0')!;
  for(const id of graph.ids){const r=result.get(id)!;expect(Math.hypot(r.x-root.x,r.y-root.y)).toBeLessThan(1800);}
  for (let i = 0; i < graph.ids.length; i++) for (let j = i + 1; j < graph.ids.length; j++) {
   const a = result.get(graph.ids[i])!; const b = result.get(graph.ids[j])!;
   const separatedX = Math.abs(a.x - b.x) >= (a.width + b.width) / 2 + 40;
   const separatedY = Math.abs(a.y - b.y) >= (a.height + b.height) / 2 + 40;
   expect(separatedX || separatedY).toBe(true);
  }
 });
});
