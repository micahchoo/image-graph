import {describe, expect, it, vi} from 'vitest';

const {MockTFile} = vi.hoisted(() => ({MockTFile: class MockTFile {constructor(public path: string) {}}}));
vi.mock('obsidian', () => ({TFile: MockTFile}));
type MockTFileInstance = {path: string};

import {GraphExporter} from '../src/export';
import type {GraphSnapshot, ImageRecord, ViewFrame} from '../src/types';

class MockVault {
 files = new Map<string, unknown>();
 getAbstractFileByPath(path: string): unknown {return this.files.get(path);}
 async createFolder(path: string): Promise<void> {this.files.set(path, {});}
 async create(path: string, data: string): Promise<MockTFileInstance> {this.files.set(path, data); return new MockTFile(path);}
 getResourcePath(file: MockTFileInstance): string {return `app://${file.path}`;}
 async createBinary(path: string, data: ArrayBuffer): Promise<MockTFileInstance> {this.files.set(path, data); return new MockTFile(path);}
}

const image = (id: string): ImageRecord => ({id, path: `${id}.png`, x: 0, y: 0, width: 100, height: 80});
const frame = (ids: string[]): ViewFrame => ({imageIds: ids, positions: Object.fromEntries(ids.map((id, index) => [id, {x: index * 120, y: 0, width: 100, height: 80}])), camera: {x: 0, y: 0, scale: 1}, width: 800, height: 600});

describe('GraphExporter.canvas', () => {
 it('serializes positions, relation labels, arrow ends, and excludes dangling/filtered images', async () => {
  const vault = new MockVault(); vault.files.set('a.png', new MockTFile('a.png')); vault.files.set('b.png', new MockTFile('b.png')); vault.files.set('c.png', new MockTFile('c.png'));
  const exporter = new GraphExporter({vault, workspace: {containerEl: {}}} as never);
  const snapshot: GraphSnapshot = {images: ['a', 'b', 'c'].map(image), regions: [], edges: [
   {id: 'forward', source: {imageId: 'a'}, target: {imageId: 'b'}, direction: 'forward', properties: {relation: 'references'}},
   {id: 'reverse', source: {imageId: 'b'}, target: {imageId: 'c'}, direction: 'reverse', properties: {}},
   {id: 'both', source: {imageId: 'a'}, target: {imageId: 'c'}, direction: 'both', properties: {relation: 'bidirectional'}},
   {id: 'dangling', source: {imageId: 'a'}, target: {imageId: 'missing'}, direction: 'forward', properties: {}},
  ]};
  const file = await exporter.canvas(snapshot, frame(['a', 'b'])); const json = JSON.parse(vault.files.get(file.path) as string) as {nodes: Array<{file:string;x:number}>;edges: Array<Record<string, string>>};
  expect(json.nodes.map((node) => node.file)).toEqual(['a.png', 'b.png']);
  expect(json.nodes[1].x).toBe(120);
  expect(json.edges).toHaveLength(1);
  expect(json.edges[0]).toMatchObject({fromEnd: 'none', toEnd: 'arrow', label: 'references'});
 });

 it('avoids overwriting export paths', async () => {
  const vault = new MockVault(); vault.files.set('_Image Graph', {}); vault.files.set('_Image Graph/Exports', {}); vault.files.set('_Image Graph/Exports/image-graph.canvas', 'old');
  for (const id of ['a', 'b']) vault.files.set(`${id}.png`, new MockTFile(`${id}.png`));
  const exporter = new GraphExporter({vault, workspace: {containerEl: {}}} as never); const snapshot: GraphSnapshot = {images: ['a', 'b'].map(image), regions: [], edges: []};
  const result = await exporter.canvas(snapshot, frame(['a', 'b']));
  expect(result.path).toBe('_Image Graph/Exports/image-graph-2.canvas');
 });
});
