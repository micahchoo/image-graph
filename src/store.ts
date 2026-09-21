import {parseYaml} from 'obsidian';
import type {App, TAbstractFile, TFile} from 'obsidian';
import type {EdgeRecord, GraphSnapshot, ImageRecord, Properties, RegionRecord} from './types';

const ROOT = '_Image Graph';
const DATA = `${ROOT}/Data`;
const NOTES = `${ROOT}/Images`;
const VERSION = 1;
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'tif', 'tiff', 'avif']);
type Kind = 'images' | 'regions' | 'edges';
type Stored = ImageRecord | RegionRecord | EdgeRecord;
type Shard = {version: number; kind: Kind; records: Stored[]};

export class GraphStore {
  private images = new Map<string, ImageRecord>();
  private regions = new Map<string, RegionRecord>();
  private edges = new Map<string, EdgeRecord>();
  private snapshot?: GraphSnapshot;
  private loaded = false;
  private persistedImages = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly app: App, private readonly changed: () => void) {}

  async load(): Promise<void> { await this.enqueue(async () => {
    const images = new Map<string, ImageRecord>(), regions = new Map<string, RegionRecord>(), edges = new Map<string, EdgeRecord>();
    for (const file of this.app.vault.getFiles()) {
      const parsed = parseShardName(file.path);
      if (!parsed) continue;
      const records = await this.readShard(file, parsed.kind, parsed.index);
      for (const record of records) {
        if (parsed.kind === 'images') images.set(record.id, record as ImageRecord);
        else if (parsed.kind === 'regions') regions.set(record.id, record as RegionRecord);
        else edges.set(record.id, record as EdgeRecord);
      }
    }
    this.persistedImages = new Set(images.keys());
    this.images = images; this.regions = regions; this.edges = edges; this.snapshot = undefined;
    this.loaded = true;
    await this.refreshCatalogInternal(false);
  }); }

  async refreshCatalog(): Promise<void> { await this.mutate(() => this.refreshCatalogInternal(true)); }

  private async refreshCatalogInternal(persist: boolean): Promise<void> {
    const files = this.app.vault.getFiles().filter(file => isCatalogImage(file.path)).sort((a, b) => a.path.localeCompare(b.path));
    const paths = new Set(files.map(file => file.path));
    const byPath = new Map([...this.images.values()].map(image => [image.path, image]));
    const next = new Map<string, ImageRecord>();
    const columns = Math.max(1, Math.ceil(Math.sqrt(files.length)));
    for (const [index, file] of files.entries()) {
      const prior = byPath.get(file.path);
      const image = prior ? {...prior, path: file.path, missing: false} : {
        id: stableId(file.path), path: file.path, x: (index % columns) * 280, y: Math.floor(index / columns) * 280, width: 240, height: 240,
      };
      next.set(image.id, image);
    }
    for (const old of this.images.values()) if (!paths.has(old.path)) next.set(old.id, {...old, missing: true});
    const changed = [...next.values()].filter(image => JSON.stringify(this.images.get(image.id)) !== JSON.stringify(image));
    if (persist) for (const image of changed) if (this.persistedImages.has(image.id)) await this.writeOne('images', image);
    this.images = next;
    if (changed.length) { this.snapshot = undefined; this.changed(); }
  }

  getSnapshot(): GraphSnapshot { return this.snapshot ??= {images: clone([...this.images.values()]), regions: clone([...this.regions.values()]), edges: clone([...this.edges.values()])}; }

  async upsertImage(image: ImageRecord): Promise<void> { await this.upsert('images', image); }
  async upsertRegion(region: RegionRecord): Promise<void> { await this.upsert('regions', region); }
  async upsertEdge(edge: EdgeRecord): Promise<void> { await this.upsert('edges', edge); }
  async removeRegion(id: string): Promise<void> { await this.mutate(async () => {
    if (!this.regions.has(id)) return;
    const incident = [...this.edges.values()].filter(edge => edge.source.regionId === id || edge.target.regionId === id).map(edge => edge.id);
    try {
      for (const edgeId of incident) { await this.writeDelete('edges', edgeId); this.edges.delete(edgeId); this.snapshot = undefined; }
      await this.writeDelete('regions', id); this.regions.delete(id); this.snapshot = undefined;
    } finally { this.changed(); }
  }); }
  async removeEdge(id: string): Promise<void> { await this.remove('edges', id); }

  async ensureCompanion(imageId: string): Promise<TFile> {
    return this.mutate(() => this.ensureCompanionInternal(imageId));
  }

  async readMetadata(imageId: string): Promise<Properties> {
    const image = this.images.get(imageId); if (!image) throw new Error(`Unknown image: ${imageId}`);
    const metadataPath = image.metadataPath ?? `${NOTES}/${encodeURIComponent(image.id)}.md`;
    const file = this.app.vault.getAbstractFileByPath(metadataPath);
    if (!file || !isFile(file)) return {};
    const text = await this.app.vault.read(file);
    const match = text.match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/);
    let frontmatter: unknown;
    try { frontmatter = match ? parseYaml(match[1]) : undefined; } catch { throw new Error(`Invalid YAML in companion note: ${metadataPath}`); }
    if (!isRecord(frontmatter)) return {};
    return cleanProperties(frontmatter);
  }

  async writeMetadata(imageId: string, properties: Properties): Promise<void> {
    await this.mutate(async () => {
      const image = this.images.get(imageId); if (!image) throw new Error(`Unknown image: ${imageId}`);
      const safe = validateProperties(properties); const file = await this.ensureCompanionInternal(imageId);
      await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
        for (const key of Object.keys(frontmatter)) if (key !== 'image' && key !== 'image_graph_id' && !(key in safe)) delete frontmatter[key];
        Object.assign(frontmatter, safe, {image: `[[${image.path}]]`, image_graph_id: image.id});
      });
      this.changed();
    });
  }

  async renamePath(oldPath: string, newPath: string): Promise<void> { await this.mutate(async () => {
    if (oldPath === newPath) return;
    const replace = (path: string) => path === oldPath || path.startsWith(`${oldPath}/`) ? `${newPath}${path.slice(oldPath.length)}` : path;
    const updates = [...this.images.values()].map(image => ({image, path: replace(image.path), metadataPath: image.metadataPath ? replace(image.metadataPath) : undefined})).filter(item => item.path !== item.image.path || item.metadataPath !== item.image.metadataPath);
    for (const item of updates) {
      const updated = {...item.image, path: item.path, ...(item.metadataPath ? {metadataPath: item.metadataPath} : {})};
      await this.writeOne('images', updated); this.images.set(updated.id, updated);
      if (updated.metadataPath) { const file = this.app.vault.getAbstractFileByPath(updated.metadataPath); if (file && isFile(file)) await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => { fm.image = `[[${updated.path}]]`; fm.image_graph_id = updated.id; }); }
    }
    if (!updates.length) return;
    this.snapshot = undefined;
    this.changed();
  }); }

  async flush(): Promise<void> { await this.queue; }

  private async upsert(kind: Kind, record: Stored): Promise<void> { await this.mutate(async () => {
    record = clone(record); validateRecord(kind, record);
    if (kind === 'edges') { const edge = record as EdgeRecord; for (const endpoint of [edge.source, edge.target]) if (endpoint.regionId && this.regions.get(endpoint.regionId)?.imageId !== endpoint.imageId) throw new Error('The connection refers to an unknown region.'); }
    if (kind === 'regions') await this.ensureCompanionInternal((record as RegionRecord).imageId);
    if (kind === 'edges') { const edge = record as EdgeRecord; await this.ensureCompanionInternal(edge.source.imageId); await this.ensureCompanionInternal(edge.target.imageId); }
    await this.writeOne(kind, record); this.putMemory(kind, record); this.changed();
  }); }
  private async remove(kind: Kind, id: string): Promise<void> { await this.mutate(async () => {
    const map = this.map(kind); if (!map.has(id)) return; await this.writeDelete(kind, id); map.delete(id); this.snapshot = undefined; this.changed();
  }); }
  private async writeOne(kind: Kind, record: Stored): Promise<void> {
    await this.ensureFolder(DATA); const path = shardPath(kind, shardIndex(record.id)); const file = this.app.vault.getAbstractFileByPath(path);
    if (file && isFile(file)) await this.app.vault.process(file, current => { const records = parseShard(current, kind, shardIndex(record.id)).filter(item => item.id !== record.id); records.push(record); return JSON.stringify({version: VERSION, kind, records}, null, 2) + '\n'; });
    else if (file) throw new Error(`Storage shard is not a file: ${path}`);
    else await this.app.vault.create(path, JSON.stringify({version: VERSION, kind, records: [record]}, null, 2) + '\n');
    if (kind === 'images') this.persistedImages.add(record.id);
  }
  private async writeDelete(kind: Kind, id: string): Promise<void> {
    const path = shardPath(kind, shardIndex(id)); const file = this.app.vault.getAbstractFileByPath(path); if (!file || !isFile(file)) return;
    await this.app.vault.process(file, current => { const records = parseShard(current, kind, shardIndex(id)).filter(item => item.id !== id); return JSON.stringify({version: VERSION, kind, records}, null, 2) + '\n'; });
  }
  private async ensureCompanionInternal(imageId: string): Promise<TFile> {
    const image = this.images.get(imageId); if (!image) throw new Error(`Unknown image: ${imageId}`);
    const path = image.metadataPath ?? `${NOTES}/${encodeURIComponent(imageId)}.md`;
    let file = this.app.vault.getAbstractFileByPath(path);
    if (file && !isFile(file)) throw new Error(`Companion is not a file: ${path}`);
    if (file && isFile(file)) {
      const existing = await this.app.vault.read(file), match = existing.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|$)/);
      const frontmatter: unknown = match ? parseYaml(match[1]) : undefined;
      if (!isRecord(frontmatter) || frontmatter.image_graph_id !== image.id) throw new Error(`Refusing to claim existing note: ${path}`);
    }
    if (!file) { await this.ensureFolder(NOTES); file = await this.app.vault.create(path, `---\nimage: ${yamlScalar(`[[${image.path}]]`)}\nimage_graph_id: ${yamlScalar(image.id)}\n---\n`); }
    if (!isFile(file)) throw new Error(`Companion is not a file: ${path}`);
    else await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => { frontmatter.image = `[[${image.path}]]`; frontmatter.image_graph_id = image.id; });
    if (image.metadataPath !== path || !this.persistedImages.has(imageId)) { const updated = {...image, metadataPath: path}; await this.writeOne('images', updated); this.images.set(imageId, updated); this.snapshot = undefined; }
    return file;
  }
  private async readShard(file: TFile, kind: Kind, index: number): Promise<Stored[]> { return parseShard(await this.app.vault.read(file), kind, index); }
  private map(kind: Kind): Map<string, Stored> { return kind === 'images' ? this.images : kind === 'regions' ? this.regions : this.edges; }
  private putMemory(kind: Kind, record: Stored): void { validateRecord(kind, record); this.map(kind).set(record.id, record); this.snapshot = undefined; }
  private async mutate<T>(fn: () => Promise<T>): Promise<T> { return this.enqueue(async () => { if (!this.loaded) throw new Error('GraphStore.load() must be awaited before mutation'); return fn(); }); }
  private enqueue<T>(fn: () => Promise<T>): Promise<T> { const result = this.queue.then(fn, fn); this.queue = result.then(() => undefined, () => undefined); return result; }
  private async ensureFolder(path: string): Promise<void> { const parts = path.split('/'); let current = ''; for (const part of parts) { current = current ? `${current}/${part}` : part; if (!this.app.vault.getAbstractFileByPath(current)) await this.app.vault.createFolder(current); } }
}

function isFile(file: TAbstractFile): file is TFile { return 'extension' in file && 'stat' in file; }
function isCatalogImage(path: string): boolean { if (path.startsWith(`${ROOT}/`)) return path.startsWith(`${ROOT}/Extracted/`) && IMAGE_EXTENSIONS.has(path.split('.').pop()?.toLowerCase() ?? ''); return IMAGE_EXTENSIONS.has(path.split('.').pop()?.toLowerCase() ?? ''); }
function stableId(path: string): string { let a = 2166136261, b = 5381; for (const char of path) { a = Math.imul(a ^ char.charCodeAt(0), 16777619); b = Math.imul(b,33) ^ char.charCodeAt(0); } return `img-${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`; }
function shardIndex(id: string): number { let hash = 0; for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) | 0; return (hash >>> 0) % 64; }
function shardPath(kind: Kind, index: number): string { return `${DATA}/${kind}-${index.toString(16).padStart(2, '0')}.json`; }
function parseShardName(path: string): {kind: Kind; index: number} | undefined { const match = path.match(new RegExp(`^${DATA}/(images|regions|edges)-([0-9a-f]{2})\\.json$`)); return match ? {kind: match[1] as Kind, index: Number.parseInt(match[2], 16)} : undefined; }
function parseShard(text: string, kind: Kind, index: number): Stored[] { let value: unknown; try { value = JSON.parse(text); } catch { throw new Error(`Corrupt Image Graph shard: ${shardPath(kind, index)}`); } if (!value || typeof value !== 'object' || (value as Shard).version !== VERSION || (value as Shard).kind !== kind || !Array.isArray((value as Shard).records)) throw new Error(`Invalid Image Graph shard: ${shardPath(kind, index)}`); const records = (value as Shard).records; records.forEach(record => validateRecord(kind, record)); return records; }
function validateRecord(kind: Kind, record: unknown): asserts record is Stored {
 if (!isRecord(record) || typeof record.id !== 'string' || !record.id) throw new Error(`Invalid ${kind} record`);
 if (kind === 'images' && (typeof record.path !== 'string' || !record.path || !finite(record.x) || !finite(record.y) || !finite(record.width) || record.width <= 0 || !finite(record.height) || record.height <= 0)) throw new Error('Invalid image record');
 if (kind === 'regions' && (typeof record.imageId !== 'string' || !record.imageId || typeof record.label !== 'string' || !validShape(record.shape) || !isRecord(record.properties))) throw new Error('Invalid region record');
 if (kind === 'edges' && (!validEndpoint(record.source) || !validEndpoint(record.target) || !['none', 'forward', 'reverse', 'both'].includes(record.direction as string) || !isRecord(record.properties))) throw new Error('Invalid edge record');
 if (kind !== 'images') validateYamlValue(record.properties);
}
function validShape(value: unknown): boolean {
 if (!isRecord(value) || (value.type !== 'rect' && value.type !== 'polygon')) return false;
 const normalized = (n:unknown):n is number => finite(n) && n >= 0 && n <= 1;
 if (value.type === 'rect') return normalized(value.x) && normalized(value.y) && finite(value.width) && value.width > 0 && value.x+value.width <= 1.000001 && finite(value.height) && value.height > 0 && value.y+value.height <= 1.000001;
 return Array.isArray(value.points) && value.points.length >= 3 && value.points.every(point => isRecord(point) && normalized(point.x) && normalized(point.y));
}
function validEndpoint(value: unknown): boolean { return isRecord(value) && typeof value.imageId === 'string' && value.imageId.length > 0 && (!('regionId' in value) || typeof value.regionId === 'string' && value.regionId.length > 0); }
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function validateProperties(properties: Properties): Properties { if (!isRecord(properties)) throw new Error('Metadata must be a mapping'); for (const key of Object.keys(properties)) { if (key === 'image' || key === 'image_graph_id' || key === '__proto__' || key === 'constructor' || key === 'prototype') throw new Error(`Invalid metadata property: ${key}`); validateYamlValue(properties[key]); } return clone(properties); }
function validateYamlValue(value: unknown): void {
 if (value === null || typeof value === 'string' || typeof value === 'boolean' || finite(value)) return;
 if (Array.isArray(value)) { value.forEach(validateYamlValue); return; }
 if (isRecord(value) && Object.getPrototypeOf(value) === Object.prototype) { for (const key of Object.keys(value)) { if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new Error(`Invalid metadata property: ${key}`); validateYamlValue(value[key]); } return; }
 throw new Error('Metadata contains an unsupported value');
}
function cleanProperties(properties: Properties): Properties { const result = {...properties}; delete result.image; delete result.image_graph_id; return result; }
function yamlScalar(value: string): string { return JSON.stringify(value); }
