import {describe, expect, it} from 'vitest';
import {PropertyError, RESERVED_KEYS, parseProperties, parsePropertyValue, propertyMessage} from '../src/properties';
import {parseRegionShape, regionHandles, relationOf, resizeRegion, type HandleId} from '../src/graph';
import type {RegionShape} from '../src/types';

describe('property value contract', () => {
 it('keeps every value a companion note can hold', () => {
  const value = {title: 'x', count: 2, ok: true, empty: null, tags: ['a', 'b'], nested: {deep: [1, null]}};
  expect(parseProperties(value)).toEqual(value);
 });

 it('rejects what a JSON copy used to change silently', () => {
  // Storage cloned before validating, so a Date arrived as a string and an undefined
  // arrived as a missing key. Both are now refused where the owner can still fix them.
  expect(() => parsePropertyValue(new Date('2026-09-20'))).toThrow('as text');
  expect(() => parsePropertyValue(undefined)).toThrow('Give this property a value');
  expect(() => parsePropertyValue(Number.NaN)).toThrow('finite');
  expect(() => parsePropertyValue(() => 1)).toThrow('cannot hold a function');
 });

 it('names the field inside a nested value', () => {
  try { parseProperties({sources: [{url: 'ok'}, {url: undefined}]}); expect.unreachable(); }
  catch (error) {
   expect(error).toBeInstanceOf(PropertyError);
   expect((error as PropertyError).where).toBe('sources / 2 / url');
   expect(propertyMessage(error)).toContain('sources / 2 / url');
  }
 });

 it('refuses unsafe, reserved, blank and repeated names', () => {
  expect(() => parseProperties({meta: {constructor: 'x'}})).toThrow('constructor');
  expect(() => parseProperties({'': 'x'})).toThrow('Enter a property name');
  for (const key of RESERVED_KEYS) expect(() => parseProperties({[key]: 'x'}, [...RESERVED_KEYS])).toThrow('reserved');
  expect(() => parseProperties({image: 'x'})).not.toThrow();
 });
});

describe('region shape contract', () => {
 const rect = {type: 'rect', x: 0.1, y: 0.2, width: 0.3, height: 0.4};

 it('parses a rectangle and a polygon, dropping anything else on the object', () => {
  expect(parseRegionShape(rect)).toEqual(rect);
  expect(parseRegionShape({...rect, radius: 5})).toEqual(rect);
  const polygon = {type: 'polygon', points: [{x: 0, y: 0}, {x: 1, y: 0}, {x: .5, y: 1}]};
  expect(parseRegionShape({...polygon, points: polygon.points.map(p => ({...p, z: 9}))})).toEqual(polygon);
 });

 it('names the field rather than reporting an invalid record', () => {
  expect(() => parseRegionShape({...rect, type: 'circle'})).toThrow('rectangle or a polygon');
  expect(() => parseRegionShape({...rect, width: '0.2'})).toThrow('Enter a number for width');
  expect(() => parseRegionShape({...rect, width: 0})).toThrow('above 0');
  expect(() => parseRegionShape({...rect, x: 0.9, width: 0.5})).toThrow('inside the image');
  expect(() => parseRegionShape({type: 'polygon', points: [{x: 0, y: 0}, {x: 1, y: 1}]})).toThrow('three polygon corners');
  expect(() => parseRegionShape({type: 'polygon', points: [{x: 0, y: 0}, {x: 2, y: 0}, {x: 0, y: 1}]})).toThrow('corner 2');
  expect(() => parseRegionShape(null)).toThrow('needs a shape');
 });
});

describe('connection relation', () => {
 it('is one definition for storage, filtering and the label', () => {
  expect(relationOf({relation: 'resembles'})).toBe('resembles');
  for (const bad of [{relation: 42}, {relation: ''}, {relation: '  '}, {relation: null}, {}, null, ['relation']]) {
   expect(relationOf(bad)).toBeNull();
  }
 });
});

describe('region handles', () => {
 const rect:RegionShape={type:'rect',x:.2,y:.2,width:.4,height:.4};
 const polygon:RegionShape={type:'polygon',points:[{x:0,y:0},{x:1,y:0},{x:.5,y:1}]};
 // Fractions of an image accumulate float noise; six places is finer than any pixel.
 const tidy=(shape:RegionShape):RegionShape=>shape.type==='rect'
  ?{type:'rect',x:+shape.x.toFixed(6),y:+shape.y.toFixed(6),width:+shape.width.toFixed(6),height:+shape.height.toFixed(6)}
  :{type:'polygon',points:shape.points.map(p=>({x:+p.x.toFixed(6),y:+p.y.toFixed(6)}))};
 const move=(shape:RegionShape,handle:HandleId,x:number,y:number)=>tidy(resizeRegion(shape,handle,{x,y}));

 it('puts a grip on every corner and every side', () => {
  expect(regionHandles(rect).map(h=>h.id)).toEqual(['nw','n','ne','e','se','s','sw','w']);
  expect(regionHandles(rect).map(h=>[h.id,+h.x.toFixed(6),+h.y.toFixed(6)])).toEqual(
   [['nw',.2,.2],['n',.4,.2],['ne',.6,.2],['e',.6,.4],['se',.6,.6],['s',.4,.6],['sw',.2,.6],['w',.2,.4]]);
  expect(regionHandles(polygon)).toEqual([{id:0,x:0,y:0},{id:1,x:1,y:0},{id:2,x:.5,y:1}]);
 });

 it('moves one side and leaves the others', () => {
  expect(move(rect,'e',.9,.9)).toEqual({type:'rect',x:.2,y:.2,width:.7,height:.4});
  expect(move(rect,'nw',.1,.05)).toEqual({type:'rect',x:.1,y:.05,width:.5,height:.55});
  expect(move(rect,'s',.9,.9)).toEqual({type:'rect',x:.2,y:.2,width:.4,height:.7});
 });

 it('never leaves the image, inverts, or shrinks past a grip', () => {
  const flat=move(rect,'e',.1,.5);
  expect(flat.type==='rect'&&flat.width).toBeGreaterThan(0);
  expect(move(rect,'w',-2,.5)).toEqual({type:'rect',x:0,y:.2,width:.6,height:.4});
  expect(move(rect,'se',5,5)).toEqual({type:'rect',x:.2,y:.2,width:.8,height:.8});
  // Applied to the shape the drag began with, a side that bottomed out comes back.
  expect(move(resizeRegion(rect,'e',{x:0,y:.5}),'e',.9,.5)).not.toEqual(move(rect,'e',.9,.5));
 });

 it('drags one polygon corner and keeps it inside', () => {
  expect(move(polygon,2,1.4,-.3)).toEqual({type:'polygon',points:[{x:0,y:0},{x:1,y:0},{x:1,y:0}]});
  expect(move(polygon,0,.25,.25)).toEqual({type:'polygon',points:[{x:.25,y:.25},{x:1,y:0},{x:.5,y:1}]});
 });
});
