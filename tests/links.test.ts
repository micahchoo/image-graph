import {describe, expect, it, vi} from 'vitest';
vi.mock('obsidian', () => ({parseYaml: () => ({})}));
import {annotationLinks, attachmentLink, companionCandidates, companionLinks, companionPath, defaultCompanionPath, safeName, sameLinks} from '../src/links';
import type {EdgeRecord, ImageRecord} from '../src/types';

const image = (id: string, path: string, metadataPath?: string): ImageRecord => ({id, path, x: 0, y: 0, width: 240, height: 240, ...(metadataPath ? {metadataPath} : {})});
const images = new Map([
 ['a', image('a', 'Photos/Harbour at dusk.png')],
 ['b', image('b', 'Photos/Crane.jpg')],
 ['c', image('c', 'Photos/Rope.jpg', 'Notes/rope.md')],
]);
const edge = (id: string, source: string, target: string, relation: unknown, direction: EdgeRecord['direction'] = 'none'): EdgeRecord =>
 ({id, source: {imageId: source}, target: {imageId: target}, direction, properties: {relation} as never});

describe('companion note connection links', () => {
 it('names the other end and its relation', () => {
  expect(companionLinks('a', [edge('e', 'a', 'b', 'resembles')], images)).toEqual(['[[_Image Graph/Notes/Photos/Crane|resembles · Crane]]']);
 });
 it('points the arrow from the reader, whichever end it is', () => {
  const forward = edge('e', 'a', 'b', 'derived from', 'forward');
  expect(companionLinks('a', [forward], images)).toEqual(['[[_Image Graph/Notes/Photos/Crane|→ derived from · Crane]]']);
  expect(companionLinks('b', [forward], images)).toEqual(['[[_Image Graph/Notes/Photos/Harbour at dusk|← derived from · Harbour at dusk]]']);
  expect(companionLinks('a', [edge('e', 'a', 'b', 'x', 'both')], images)[0]).toContain('↔ x');
 });
 it('follows a renamed companion note', () => {
  expect(companionLinks('a', [edge('e', 'a', 'c', 'cites')], images)).toEqual(['[[Notes/rope|cites · Rope]]']);
  expect(companionPath(images.get('c')!)).toBe('Notes/rope.md');
  expect(companionPath(images.get('a')!)).toBe('_Image Graph/Notes/Photos/Harbour at dusk.md');
 });
 it('links an image whose note does not exist yet', () => {
  // The target is a path, not a file: an unresolved link still draws in the graph view.
  expect(companionLinks('a', [edge('e', 'a', 'b', 'resembles')], images)[0]).toContain('_Image Graph/Notes/Photos/Crane');
 });
 it('keeps an owner-written relation from ending the link early', () => {
  expect(companionLinks('a', [edge('e', 'a', 'b', 'a|b ]] c')], images)).toEqual(['[[_Image Graph/Notes/Photos/Crane|a b c · Crane]]']);
 });
 it('falls back when a relation is unusable, and skips an unknown or self end', () => {
  expect(companionLinks('a', [edge('e', 'a', 'b', 42)], images)).toEqual(['[[_Image Graph/Notes/Photos/Crane|related to · Crane]]']);
  expect(companionLinks('a', [edge('e', 'a', 'a', 'loops'), edge('f', 'a', 'gone', 'x')], images)).toEqual([]);
 });
 it('sorts, and writes one entry for a repeated connection', () => {
  const links = companionLinks('a', [edge('e', 'a', 'c', 'cites'), edge('f', 'a', 'b', 'resembles'), edge('g', 'b', 'a', 'resembles')], images);
  expect(links).toEqual(['[[Notes/rope|cites · Rope]]', '[[_Image Graph/Notes/Photos/Crane|resembles · Crane]]']);
 });
 it('names a note after its picture, and files it where the picture is', () => {
  expect(defaultCompanionPath('Photos/Harbour at dusk.png')).toBe('_Image Graph/Notes/Photos/Harbour at dusk.md');
  expect(defaultCompanionPath('holiday.jpeg')).toBe('_Image Graph/Notes/holiday.md');
  // Two pictures may share a name; they cannot share a path, so the notes cannot meet either.
  expect(defaultCompanionPath('a/photo.png')).not.toBe(defaultCompanionPath('b/photo.png'));
 });

 it('keeps a name Obsidian can link to', () => {
  // Legal on disk, and unusable inside a wikilink.
  expect(safeName('a[b]c#d^e|f')).toBe('a-b-c-d-e-f');
  expect(safeName('  spaced  out  ')).toBe('spaced out');
  expect(safeName('trailing dot.')).toBe('trailing dot');
  expect(safeName('###')).toBe('---');
  expect(safeName('   ')).toBe('Untitled');
  expect(defaultCompanionPath('Scans/1972 #3/photo|raw.tif')).toBe('_Image Graph/Notes/Scans/1972 -3/photo-raw.md');
 });

 it('does not nest the plugin folder inside its own notes folder', () => {
  expect(defaultCompanionPath('_Image Graph/Extracted/region-00e6.png')).toBe('_Image Graph/Notes/Extracted/region-00e6.md');
 });

 it('prefers the name the workspace shows to the name on disk', () => {
  // An extracted region is a uuid on disk, which is the name nobody can read.
  expect(defaultCompanionPath('_Image Graph/Extracted/region-00e6.png', 'Dark water · Harbour')).toBe('_Image Graph/Notes/Extracted/Dark water · Harbour.md');
  expect(defaultCompanionPath('a.png', '   ')).toBe('_Image Graph/Notes/a.md');
 });

 it('knows when a note is already right', () => {
  expect(sameLinks(['x', 'y'], ['x', 'y'])).toBe(true);
  expect(sameLinks(['y', 'x'], ['x', 'y'])).toBe(false);
  expect(sameLinks(undefined, [])).toBe(true);
  expect(sameLinks([], [])).toBe(true);
  expect(sameLinks('x', ['x'])).toBe(false);
  expect(sameLinks(['x'], [])).toBe(false);
 });
 it('links an attachment to its note or paragraph, and gathers them per image, sorted and unique',()=>{
  expect(attachmentLink({notePath:'Essays/Light.md',captionPath:'c'},'Sky')).toBe('[[Essays/Light|Sky · Light]]');
  expect(attachmentLink({notePath:'Light.md',blockId:'ab12',captionPath:'c'},'Sky | [x]')).toBe('[[Light#^ab12|Sky x · Light]]');
  const regions=[{id:'ia-1',imageId:'a',label:'Sky',shape:{type:'rect' as const,x:0,y:0,width:1,height:1},properties:{},origin:'image-annotation'},{id:'ia-2',imageId:'a',label:'Sea',shape:{type:'rect' as const,x:0,y:0,width:1,height:1},properties:{},origin:'image-annotation'},{id:'ia-3',imageId:'b',label:'Sea',shape:{type:'rect' as const,x:0,y:0,width:1,height:1},properties:{},origin:'image-annotation'}];
  const attachments=new Map([['ia-1',[{notePath:'Z.md',captionPath:'c1'},{notePath:'A.md',captionPath:'c2'}]],['ia-2',[{notePath:'Z.md',captionPath:'c3'}]],['ia-3',[]]]);
  const links=annotationLinks(regions,attachments);
  expect(links.get('a')).toEqual(['[[A|Sky · A]]','[[Z|Sea · Z]]','[[Z|Sky · Z]]']);
  expect(links.has('b')).toBe(false);
 });

});

describe('the names a new companion note may take', () => {
 it('offers the mirrored path first', () => {
  expect(companionCandidates('Photos/Harbour.png')[0]).toBe('_Image Graph/Notes/Photos/Harbour.md');
 });

 it('falls back to the extension before a counter, because it names the difference', () => {
  const [, second, third] = companionCandidates('Photos/Harbour.png');
  expect(second).toBe('_Image Graph/Notes/Photos/Harbour (png).md');
  expect(third).toBe('_Image Graph/Notes/Photos/Harbour 2.md');
 });

 it('separates two pictures that differ only by extension', () => {
  const png = companionCandidates('Photos/Harbour.png'), jpg = companionCandidates('Photos/Harbour.jpg');
  expect(png[0]).toBe(jpg[0]);
  expect(png[1]).not.toBe(jpg[1]);
 });

 it('uses a display name where one was worked out, and every candidate follows it', () => {
  const named = companionCandidates('_Image Graph/Extracted/region-00e6.png', 'The mast · Harbour');
  expect(named[0]).toBe('_Image Graph/Notes/Extracted/The mast · Harbour.md');
  expect(named.every(path => path.includes('The mast'))).toBe(true);
 });

 it('always offers more than one, so a clash is never a dead end', () => {
  expect(companionCandidates('a.png').length).toBeGreaterThan(20);
  expect(new Set(companionCandidates('a.png')).size).toBe(companionCandidates('a.png').length);
 });
});
