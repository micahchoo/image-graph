import {describe, expect, it, vi} from 'vitest';
vi.mock('obsidian', () => ({parseYaml: () => ({})}));
import {fitCamera, parseEmbed} from '../src/embed';
import {noteBlock} from '../src/blocks';

const spec = (source: string) => { const result = parseEmbed(source); if (!result.ok) throw new Error(result.problem); return result.spec; };
const problem = (source: string) => { const result = parseEmbed(source); return result.ok ? null : result.problem; };

describe('what a note asked to see', () => {
 it('takes one wikilink and nothing else', () => {
  expect(spec('[[Photos/Harbour at dusk.png]]')).toEqual({path: 'Photos/Harbour at dusk.png', depth: 1, relation: null, height: 360});
 });

 it('ignores an alias and a heading, which name no other file', () => {
  expect(spec('[[Photos/Harbour.png|The harbour]]').path).toBe('Photos/Harbour.png');
  expect(spec('![[Photos/Harbour.png#top]]').path).toBe('Photos/Harbour.png');
  expect(spec('Photos/Harbour.png').path).toBe('Photos/Harbour.png');
  expect(spec('image: Photos/Harbour.png').path).toBe('Photos/Harbour.png');
 });

 it('reads the three settings', () => {
  expect(spec('[[a.png]]\ndepth: 3\nrelation: resembles\nheight: 420px')).toEqual({path: 'a.png', depth: 3, relation: 'resembles', height: 420});
 });

 it('skips blank lines and comments, and keeps the first link', () => {
  expect(spec('\n# a note to self\n[[a.png]]\n\n[[b.png]]\n').path).toBe('a.png');
 });

 it('names a setting it does not know, rather than ignoring it', () => {
  // Nothing writes back to the block, so a silent typo leaves somebody adjusting a dead key.
  expect(problem('[[a.png]]\ndeapth: 2')).toContain('deapth');
  expect(problem('[[a.png]]\ndepth: 9')).toContain('1 to 3');
  expect(problem('[[a.png]]\nheight: 4000')).toContain('120 to 900');
  expect(problem('depth: 2')).toContain('wikilink');
  expect(problem('')).toContain('wikilink');
 });

 it('names a relation with no image, because a relation belongs to none', () => {
  expect(spec('relation: resembles')).toEqual({path: null, depth: 1, relation: 'resembles', height: 360});
 });

 it('reads back exactly what the menu writes', () => {
  // One writer, one reader. The round trip is what stops them drifting apart.
  for (const view of [
   {path: 'Photos/Harbour.png', relation: null, depth: 1},
   {path: 'Photos/Harbour.png', relation: null, depth: 3},
   {path: null, relation: 'resembles', depth: 2},
   {path: 'a b/c d.png', relation: null, depth: 2, height: 240},
  ]) {
   const text = noteBlock(view);
   const body = text.split('\n').slice(1, -1).join('\n');
   expect(parseEmbed(body)).toEqual({ok: true, spec: {path: view.path, relation: view.relation, depth: view.relation ? 1 : view.depth, height: view.height ?? 360}});
   expect(text.startsWith('```image-graph')).toBe(true);
  }
 });

 it('writes only what differs from the default', () => {
  expect(noteBlock({path: 'a.png', relation: null, depth: 1})).toBe('```image-graph\n[[a.png]]\n```');
 });

 it('fits the whole neighbourhood inside the block, whatever its shape', () => {
  for (const box of [{x: 0, y: 0, width: 2000, height: 300}, {x: -500, y: -900, width: 200, height: 2400}, {x: 0, y: 0, width: 1, height: 1}]) {
   const camera = fitCamera(box, 640, 300);
   const left = box.x * camera.scale + camera.x, top = box.y * camera.scale + camera.y;
   expect(left).toBeGreaterThanOrEqual(-0.5);
   expect(top).toBeGreaterThanOrEqual(-0.5);
   expect(left + box.width * camera.scale).toBeLessThanOrEqual(640.5);
   expect(top + box.height * camera.scale).toBeLessThanOrEqual(300.5);
   expect(camera.scale).toBeLessThanOrEqual(1.2);
  }
 });
});
