import {describe, expect, it} from 'vitest';
import {DEFAULT_PALETTE, renderScene, themePalette} from '../src/render';
import {recordingContext} from './fake-canvas';
import type {EdgeRecord, ImageRecord, Rect, RegionRecord} from '../src/types';

const image = (id: string, missing = false): ImageRecord => ({id, path: `${id}.png`, x: 0, y: 0, width: 100, height: 100, ...(missing ? {missing} : {})});
const rect = (x: number, y: number, width = 100, height = 100): Rect => ({x, y, width, height});
const edge = (id: string, source: string, target: string, direction: EdgeRecord['direction'] = 'forward'): EdgeRecord => ({id, source: {imageId: source}, target: {imageId: target}, direction, properties: {relation: 'resembles'}});
const region = (id: string, imageId: string, origin?: string): RegionRecord => ({id, imageId, label: id, shape: {type: 'rect', x: .1, y: .1, width: .5, height: .5}, properties: {}, ...(origin ? {origin} : {})});
const view = (scale = 1) => ({camera: {x: 0, y: 0, scale}, width: 1000, height: 600, palette: DEFAULT_PALETTE, thumbnail: () => null});

describe('the still renderer draws what the view draws', () => {
 it('sets a font the canvas can parse, at a size that follows the zoom', () => {
  const {ctx, calls, font} = recordingContext();
  renderScene(ctx, {images: [image('a')], positions: new Map([['a', rect(0, 0)]]), edges: [], regions: [], captions: new Map([['a', 'Harbour']])}, view());
  expect(calls.some(call => call.startsWith('font=REJECTED'))).toBe(false);
  expect(font()).toBe('12px sans-serif');
  expect(calls).toContain('fillText("Harbour",0,104)');
 });
 it('takes the interface font from the computed style, not from a variable the canvas cannot resolve', () => {
  const palette = themePalette({getPropertyValue: () => '', fontFamily: '"Inter", sans-serif'} as unknown as CSSStyleDeclaration);
  expect(palette.font).toBe('"Inter", sans-serif');
  expect(themePalette({getPropertyValue: () => '', fontFamily: ''} as unknown as CSSStyleDeclaration).font).toBe('sans-serif');
 });
 it('paints a missing image in the missing colour, as the view does', () => {
  const {ctx, calls} = recordingContext();
  renderScene(ctx, {images: [image('a'), image('b', true)], positions: new Map([['a', rect(0, 0)], ['b', rect(200, 0)]]), edges: [], regions: []}, view());
  const fills = calls.filter(call => call.startsWith('fillStyle=') || call.startsWith('fillRect('));
  expect(fills).toContain(`fillStyle=${JSON.stringify(DEFAULT_PALETTE.missing)}`);
  expect(fills.indexOf(`fillStyle=${JSON.stringify(DEFAULT_PALETTE.missing)}`)).toBe(fills.indexOf('fillRect(200,0,100,100)') - 1);
 });
 it('dashes a region another plugin drew, and only that one', () => {
  const {ctx, calls} = recordingContext();
  renderScene(ctx, {images: [image('a')], positions: new Map([['a', rect(0, 0)]]), edges: [], regions: [region('own', 'a'), region('ia-1', 'a', 'image-annotation')]}, view());
  const strokes = calls.map((call, index) => [call, index] as const).filter(([call]) => call === 'stroke()').map(([, index]) => index);
  expect(strokes).toHaveLength(2);
  const dashedBefore = (index: number) => calls.slice(0, index).filter(call => call.startsWith('setLineDash(')).at(-1);
  expect(dashedBefore(strokes[0])).toBeUndefined();
  expect(dashedBefore(strokes[1])).toBe('setLineDash([6,4])');
  expect(calls.at(-2)).not.toBe('setLineDash([6,4])');
 });
 it('routes a connection around the image between its ends, as the view does', () => {
  const positions = new Map([['a', rect(0, 0)], ['between', rect(200, 0)], ['b', rect(400, 0)]]);
  const straight = recordingContext(), routed = recordingContext();
  renderScene(straight.ctx, {images: [image('a'), image('b')], positions: new Map([['a', rect(0, 0)], ['b', rect(400, 0)]]), edges: [edge('e', 'a', 'b')], regions: []}, view());
  renderScene(routed.ctx, {images: [image('a'), image('between'), image('b')], positions, edges: [edge('e', 'a', 'b')], regions: []}, view());
  const turns = (calls: string[]) => calls.filter(call => call.startsWith('arcTo(')).length;
  expect(turns(straight.calls)).toBe(0);
  expect(turns(routed.calls)).toBeGreaterThan(0);
  // The arrowhead points along the last segment, so it does not aim through the obstacle.
  const fillsAfterRoute = routed.calls.filter(call => call === 'fill()').length;
  expect(fillsAfterRoute).toBe(1);
 });
 it('draws straight lines when zoomed far out, where the view does too', () => {
  const positions = new Map([['a', rect(0, 0)], ['between', rect(200, 0)], ['b', rect(400, 0)]]);
  const {ctx, calls} = recordingContext();
  renderScene(ctx, {images: [image('a'), image('between'), image('b')], positions, edges: [edge('e', 'a', 'b')], regions: []}, view(.05));
  expect(calls.filter(call => call.startsWith('arcTo(')).length).toBe(0);
 });
});
