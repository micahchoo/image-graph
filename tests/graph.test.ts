import {describe, expect, it, vi} from 'vitest';

vi.mock('obsidian', () => ({
 parseYaml: (text: string) => {
  if (text.trimStart().startsWith('{') || text.trimStart().startsWith('[')) return JSON.parse(text);
  const result: Record<string, unknown> = {};
  for (const line of text.split(/\r?\n/)) { const match = line.match(/^([\w-]+):\s*(.*)$/); if (match) result[match[1]] = match[2] === 'true' ? true : match[2] === 'false' ? false : /^-?\d+(\.\d+)?$/.test(match[2]) ? Number(match[2]) : match[2]; }
  return result;
 },
}));

import {containsRegion, edgeEndpoints, endpointPosition, forceLayout, neighborhood, parseProperties, tracePath} from '../src/graph';
import type {EdgeRecord, ImageRecord, Rect, RegionRecord} from '../src/types';

const image = (id: string): ImageRecord => ({id, path: `${id}.png`, x: 0, y: 0, width: 100, height: 80});
const edge = (id: string, source: string, target: string, relation = 'related'): EdgeRecord => ({id, source: {imageId: source}, target: {imageId: target}, direction: 'forward', properties: {relation}});

describe('image graph traversal', () => {
 it('traverses across regions without following arrow direction and keeps shortest parents', () => {
  const snapshot = {images: ['a', 'b', 'c', 'd'].map(image), edges: [edge('ab', 'a', 'b'), edge('ac', 'a', 'c'), edge('cd', 'c', 'd'), edge('bd', 'b', 'd')]};
  const result = neighborhood(snapshot, 'a', 3, new Set(), 'related');
  expect(result.ids).toEqual(['a', 'b', 'c', 'd']);
  expect(result.distances.get('d')).toBe(2);
  expect(tracePath('a', 'd', result).map((step) => step.edge.id)).toEqual(['ab', 'bd']);
 });

 it('selectively expands a frontier node and reports a cap', () => {
  const snapshot = {images: ['a', 'b', 'c'].map(image), edges: [edge('ab', 'a', 'b'), edge('bc', 'b', 'c')]};
  expect(neighborhood(snapshot, 'a', 1, new Set(), 'related').ids).toEqual(['a', 'b']);
  const expanded = neighborhood(snapshot, 'a', 1, new Set(['b']), 'related', 2);
  expect(expanded.ids).toEqual(['a', 'b']);
  expect(expanded.capped).toBe(true);
 });

 it('filters relations and ignores dangling edges', () => {
  const result = neighborhood({images: ['a', 'b'].map(image), edges: [edge('ok', 'a', 'b', 'keep'), edge('bad', 'a', 'missing', 'keep'), edge('other', 'a', 'b', 'skip')]}, 'a', 2, new Set(), 'keep');
  expect(result.edges.map((item) => item.id)).toEqual(['ok']);
 });

 it('treats an actual all relation as a literal filter', () => {
  const snapshot = {images: ['a', 'b', 'c'].map(image), edges: [edge('all', 'a', 'b', 'all'), edge('other', 'a', 'c', 'other')]};
  expect(neighborhood(snapshot, 'a', 1, new Set(), 'all').ids).toEqual(['a', 'b']);
 });
});

describe('graph geometry and layout', () => {
 it('keeps three hop bands ordered for mixed-size cards and reserves caption space',()=>{
  const images=Array.from({length:15},(_,i)=>({...image(String(i)),width:240,height:i%3===0?140:240}));
  const links=Array.from({length:14},(_,i)=>edge(`e${i}`,String(Math.floor(i/2)),String(i+1)));
  const graph=neighborhood({images,edges:links},'0',3,new Set(),'');
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
  const graph=neighborhood({images,edges:images.slice(1).map(i=>edge(`e${i.id}`,'0',i.id))},'0',1,new Set(),'');
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
  const images = ['a', 'b', 'c'].map(image); const graph = neighborhood({images, edges: [edge('ab', 'a', 'b'), edge('bc', 'b', 'c')]}, 'a', 3, new Set(), 'related');
  const previous = new Map<string, Rect>([['a', {x: 50, y: 60, width: 100, height: 80}], ['b', {x: 300, y: 60, width: 100, height: 80}], ['c', {x: 600, y: 60, width: 100, height: 80}]]);
  const first = forceLayout(images, graph, 'a', new Set(['a']), previous);
  const second = forceLayout(images, graph, 'a', new Set(['a']), first);
  expect(first.get('a')).toEqual(previous.get('a'));
  expect(second.get('a')).toEqual(first.get('a'));
  expect(Math.abs(second.get('b')!.x - first.get('b')!.x)).toBeLessThan(10);
 });

 it('anchors an unpinned root and separates hop rings without moving pins', () => {
  const images = ['root', 'one', 'two'].map(image);
  const graph = neighborhood({images, edges: [edge('r1', 'root', 'one'), edge('12', 'one', 'two')]}, 'root', 3, new Set(), 'related');
  const previous = new Map<string, Rect>([
   ['root', {x: 40, y: 50, width: 100, height: 80}],
   ['one', {x: 45, y: 50, width: 100, height: 80}],
   ['two', {x: 55, y: 50, width: 100, height: 80}],
  ]);
  const pinned = new Map(previous);
  const result = forceLayout(images, graph, 'root', new Set(['one']), previous);
  expect(result.get('root')!.x).toBe(40);
  expect(result.get('root')!.y).toBe(50);
  expect(result.get('one')).toEqual(pinned.get('one'));
  const root = result.get('root')!;
  const one = result.get('one')!;
  const two = result.get('two')!;
  const hopOne = Math.hypot(one.x - root.x, one.y - root.y);
  const hopTwo = Math.hypot(two.x - root.x, two.y - root.y);
  expect(Number.isFinite(hopOne) && Number.isFinite(hopTwo)).toBe(true);
  expect(hopTwo).toBeGreaterThan(hopOne);
 });

 it('keeps the twelve-card demo readable at three hops', () => {
  const images = Array.from({length: 12}, (_, index) => ({...image(String(index)),width:240,height:240}));
  const links: Array<[number, number]> = [[0, 1], [0, 2], [1, 3], [1, 4], [2, 5], [3, 6], [4, 7], [5, 8], [3, 4], [6, 9], [7, 10], [8, 11]];
  const graph = neighborhood({images, edges: links.map(([a, b], index) => edge(String(index), String(a), String(b)))}, '0', 3, new Set(), 'related');
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

describe('metadata parsing', () => {
 it('accepts normal mappings and rejects unsafe/non-mapping values', () => {
  expect(parseProperties('title: Example\ncount: 2')).toEqual({title: 'Example', count: 2});
  expect(() => parseProperties('[]')).toThrow();
  expect(() => parseProperties('{"__proto__": 1}')).toThrow();
 });
});
