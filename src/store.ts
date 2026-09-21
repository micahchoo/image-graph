import {parseYaml} from 'obsidian';
import type {App, TAbstractFile, TFile} from 'obsidian';
import type {EdgeRecord, GraphSnapshot, ImageRecord, Properties, RegionRecord} from './types';
import {ANNOTATIONS_KEY, LINKS_KEY, RESERVED_KEYS, parseProperties} from './properties';
import {NOTES_ROOT, OLD_NOTES_ROOT, PLUGIN_ROOT, baseName, companionLinks, companionPath, defaultCompanionPath, sameLinks} from './links';
import {History, type Entry} from './history';
import {parseRegionShape, relationOf} from './graph';
import {isForeignRegion, type ImageSource} from './annotations';
import {gridSize, packRows, rowWidth} from './layout';
import type {PixelSize} from './dimensions';

const ROOT = '_Image Graph';
const DATA = `${ROOT}/Data`;
const VERSION = 1;
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'tif', 'tiff', 'avif']);
type Kind = 'images' | 'regions' | 'edges';
type Stored = ImageRecord | RegionRecord | EdgeRecord;
type Shard = {version: number; kind: Kind; records: Stored[]};

export class GraphStore {
  private images = new Map<string, ImageRecord>();
  private regions = new Map<string, RegionRecord>();
  /** Regions another plugin owns. Shown beside our own, never written to a shard, never
   * journaled: they are replaced whole from their file, so a reload keeps them. */
  private foreign = new Map<string, RegionRecord>();
  /** Where Image Annotation says a picture came from, by image id. Read with the regions. */
  private foreignSources = new Map<string, ImageSource>();
  private edges = new Map<string, EdgeRecord>();
  private snapshot?: GraphSnapshot;
  private loaded = false;
  private persistedImages = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly history = new History();
  /** Collecting while a labelled mutation runs, null otherwise. */
  private journal: Entry[] | null = null;

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

  async refreshCatalog(): Promise<void> { await this.mutate(null, () => this.refreshCatalogInternal(true)); }

  /**
   * The whole-vault grid is derived, not stored: every thumbnail is one height, each is as
   * wide as its own picture, and the rows wrap in path order. A width is only as true as the
   * pixel size read so far, so this runs again whenever `applyPixelSizes` learns more.
   *
   * An image the owner placed carries `pinned` and keeps its position. It gives up its place
   * in the rows to do so, which is the whole meaning of having placed it.
   */
  private async refreshCatalogInternal(persist: boolean): Promise<void> {
    const files = this.app.vault.getFiles().filter(file => isCatalogImage(file.path)).sort((a, b) => a.path.localeCompare(b.path));
    const paths = new Set(files.map(file => file.path));
    const byPath = new Map([...this.images.values()].map(image => [image.path, image]));
    const catalogued: ImageRecord[] = files.map(file => {
      const prior = byPath.get(file.path);
      return prior ? {...prior, path: file.path, missing: false} : {id: stableId(file.path), path: file.path, x: 0, y: 0, ...gridSize(undefined)};
    });
    const placed = packRows(catalogued.filter(image => !image.pinned), rowWidth(catalogued.length));
    const next = new Map<string, ImageRecord>(catalogued.map(image => { const at = placed.get(image.id); return [image.id, at ? {...image, ...at} : image]; }));
    for (const old of this.images.values()) if (!paths.has(old.path)) next.set(old.id, {...old, missing: true});
    const changed = [...next.values()].filter(image => JSON.stringify(this.images.get(image.id)) !== JSON.stringify(image));
    this.images = next;
    if (persist) await this.writeMany('images', changed.filter(image => this.persistedImages.has(image.id)));
    if (changed.length) { this.snapshot = undefined; this.changed(); }
  }

  /**
   * Give images back to the derived grid.
   *
   * `pinned` is set by a drag and is otherwise invisible and permanent: an image moved once
   * leaves the rows for good, and nothing could put it back. A flag a person cannot see and
   * cannot clear is a trap, so clearing it is an action like any other — named, undoable, and
   * reachable from the menu.
   */
  async unpinImages(ids?: Iterable<string>): Promise<number> { return this.mutate('return images to the grid', async () => {
    const wanted = ids ? new Set(ids) : null;
    const records = [...this.images.values()]
      .filter(image => image.pinned && (!wanted || wanted.has(image.id)))
      .map(image => { const released: ImageRecord = {...image}; delete released.pinned; return released; });
    if (!records.length) return 0;
    await this.writeMany('images', records);
    for (const record of records) this.putMemory('images', record);
    await this.refreshCatalogInternal(true);
    return records.length;
  }); }

  /**
   * Take the pixel sizes `SizeIndex` has read and give each image its own width. Nothing is
   * written for an image that was never persisted: the grid is derived, so it is enough that
   * the sizes themselves are remembered.
   */
  async applyPixelSizes(sizes: ReadonlyMap<string, PixelSize>): Promise<void> { await this.mutate(null, async () => {
    let touched = false;
    for (const image of this.images.values()) {
      const size = sizes.get(image.path); if (!size) continue;
      const fit = gridSize(size);
      if (image.width === fit.width && image.height === fit.height) continue;
      this.images.set(image.id, {...image, ...fit}); touched = true;
    }
    if (touched) await this.refreshCatalogInternal(true);
  }); }

  getSnapshot(): GraphSnapshot { return this.snapshot ??= {images: clone([...this.images.values()]), regions: clone([...this.regions.values(), ...this.foreign.values()]), edges: clone([...this.edges.values()])}; }

  /**
   * Replace the regions another plugin owns. Not a mutation: nothing is written and nothing
   * goes in the history, because their file is the record and this is only a reading of it.
   */
  setForeignRegions(regions: readonly RegionRecord[], sources: ReadonlyMap<string, ImageSource> = new Map()): void {
    const next = new Map<string, RegionRecord>();
    for (const region of regions) { if (!isForeignRegion(region)) throw new Error('A foreign region must name its origin.'); validateRecord('regions', region); next.set(region.id, clone(region)); }
    this.foreignSources = new Map(sources);
    if (sameRecords(this.foreign, next)) return;
    this.foreign = next; this.snapshot = undefined; this.changed();
  }

  /**
   * Write the notes Image Annotation attached each image's regions to into the image's
   * companion note, so Obsidian's graph joins the two. Only into a note that already exists:
   * a foreign region is not a reason to give a picture a note it never had. Web snapshots
   * also learn where they came from, once, and an owner's edit of that is kept.
   */
  async syncAnnotationLinks(links: ReadonlyMap<string, readonly string[]>): Promise<void> { await this.mutate(null, async () => {
    for (const image of this.images.values()) {
      if (!image.metadataPath) continue;
      const file = this.app.vault.getAbstractFileByPath(image.metadataPath);
      if (!file || !isFile(file)) continue;
      const wanted = links.get(image.id) ?? [], source = this.foreignSources.get(image.id);
      const current = this.app.metadataCache.getFileCache(file)?.frontmatter;
      const sourceMissing = !!source && ((!!source.originalUrl && current?.source_url === undefined) || (!!source.articlePath && current?.source_note === undefined));
      if (sameLinks(current?.[ANNOTATIONS_KEY], wanted) && !sourceMissing) continue;
      try {
        await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
          if (wanted.length) frontmatter[ANNOTATIONS_KEY] = wanted; else delete frontmatter[ANNOTATIONS_KEY];
          if (source?.originalUrl && frontmatter.source_url === undefined) frontmatter.source_url = source.originalUrl;
          if (source?.articlePath && frontmatter.source_note === undefined) frontmatter.source_note = `[[${source.articlePath.replace(/\.md$/, '')}]]`;
        });
      } catch (error) { console.warn('Image Graph annotation links:', error); }
    }
  }); }

  /** A region by id, ours or foreign. Every lookup that can meet either goes through here. */
  private regionOf(id: string): RegionRecord | undefined { return this.regions.get(id) ?? this.foreign.get(id); }

  /**
   * Delete every connection whose region end no longer exists. Our own regions take their
   * connections with them when deleted, so only a foreign region can leave one behind: its
   * owner deleted it in their plugin, and this plugin was never told.
   */
  async removeDanglingRegionEdges(): Promise<number> { return this.mutate('remove connections to deleted regions', async () => {
    const dangling = [...this.edges.values()].filter(edge => [edge.source, edge.target].some(end => end.regionId && this.regionOf(end.regionId)?.imageId !== end.imageId));
    if (!dangling.length) return 0;
    const touched = dangling.flatMap(edge => [edge.source.imageId, edge.target.imageId]);
    try { for (const edge of dangling) { await this.writeDelete('edges', edge.id); this.note('edges', edge.id); this.edges.delete(edge.id); this.snapshot = undefined; } }
    finally { this.changed(); }
    await this.syncLinksInternal(touched);
    return dangling.length;
  }); }

  async upsertImage(image: ImageRecord): Promise<void> { await this.upsertImages([image]); }

  /**
   * Write several images as one mutation. Every write notifies, and a view rebuilds its
   * position map from the snapshot when it does, so a loop of single writes reads the
   * second rectangle back from storage before it was ever saved: moving four images moved
   * only the first. One call, one notification, no interleaving.
   */
  async upsertImages(images: readonly ImageRecord[]): Promise<void> { await this.mutate(images.length === 1 ? 'change an image' : `change ${images.length} images`, async () => {
    if (!images.length) return;
    const records: ImageRecord[] = [];
    for (const image of images) { validateRecord('images', image, true); records.push(clone(image)); }
    await this.writeMany('images', records);
    for (const record of records) this.putMemory('images', record);
    this.changed();
  }); }
  async upsertRegion(region: RegionRecord): Promise<void> { refuseForeign(region.id, this.foreign, region); await this.upsert('regions', region, this.regions.has(region.id) ? 'edit a region' : 'draw a region'); }
  async upsertEdge(edge: EdgeRecord): Promise<void> { await this.upsert('edges', edge, this.edges.has(edge.id) ? 'edit a connection' : 'make a connection'); }
  async removeRegion(id: string): Promise<void> { refuseForeign(id, this.foreign); await this.mutate('delete a region', async () => {
    if (!this.regions.has(id)) return;
    const incident = [...this.edges.values()].filter(edge => edge.source.regionId === id || edge.target.regionId === id);
    const touched = incident.flatMap(edge => [edge.source.imageId, edge.target.imageId]);
    try {
      for (const edge of incident) { await this.writeDelete('edges', edge.id); this.note('edges', edge.id); this.edges.delete(edge.id); this.snapshot = undefined; }
      await this.writeDelete('regions', id); this.note('regions', id); this.regions.delete(id); this.snapshot = undefined;
    } finally { this.changed(); }
    await this.syncLinksInternal(touched);
  }); }
  async removeEdge(id: string): Promise<void> { await this.remove('edges', id, 'delete a connection'); }

  async ensureCompanion(imageId: string): Promise<TFile> {
    return this.mutate(null, () => this.ensureCompanionInternal(imageId));
  }

  async readMetadata(imageId: string): Promise<Properties> {
    const image = this.images.get(imageId); if (!image) throw new Error(`Unknown image: ${imageId}`);
    const metadataPath = companionPath(image);
    const file = this.app.vault.getAbstractFileByPath(metadataPath);
    if (!file || !isFile(file)) return {};
    const frontmatter = await this.readFrontmatter(file);
    if (!frontmatter) return {};
    // A note is the owner's; a value the panel cannot edit must not stop the panel opening.
    try { return parseProperties(cleanProperties(frontmatter)); } catch { return readable(cleanProperties(frontmatter)); }
  }

  async writeMetadata(imageId: string, properties: Properties): Promise<void> {
    await this.mutate(null, async () => {
      const image = this.images.get(imageId); if (!image) throw new Error(`Unknown image: ${imageId}`);
      const safe = parseProperties(properties, RESERVED_KEYS); const file = await this.ensureCompanionInternal(imageId);
      await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
        const reserved: readonly string[] = RESERVED_KEYS;
        for (const key of Object.keys(frontmatter)) if (!reserved.includes(key) && !(key in safe)) delete frontmatter[key];
        Object.assign(frontmatter, safe, {image: `[[${image.path}]]`, image_graph_id: image.id});
      });
      this.changed();
    });
  }

  async renamePath(oldPath: string, newPath: string): Promise<void> { await this.mutate(null, async () => {
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
    await this.syncLinksInternal();
  }); }

  async flush(): Promise<void> { await this.queue; }

  /** Reconcile companion-note connection links. See `syncLinksInternal`. */
  async syncCompanionLinks(imageIds?: Iterable<string>): Promise<void> { await this.mutate(null, () => this.syncLinksInternal(imageIds)); }

  private async upsert(kind: Kind, record: Stored, label: string): Promise<void> { await this.mutate(label, async () => {
    validateRecord(kind, record, true); record = clone(record);
    if (kind === 'edges') { const edge = record as EdgeRecord; for (const endpoint of [edge.source, edge.target]) if (endpoint.regionId && this.regionOf(endpoint.regionId)?.imageId !== endpoint.imageId) throw new Error('The connection refers to an unknown region.'); }
    if (kind === 'regions') await this.ensureCompanionInternal((record as RegionRecord).imageId);
    if (kind === 'edges') { const edge = record as EdgeRecord; await this.ensureCompanionInternal(edge.source.imageId); await this.ensureCompanionInternal(edge.target.imageId); }
    await this.writeOne(kind, record); this.putMemory(kind, record); this.changed();
    if (kind === 'edges') { const edge = record as EdgeRecord; await this.syncLinksInternal([edge.source.imageId, edge.target.imageId]); }
  }); }
  private async remove(kind: Kind, id: string, label: string): Promise<void> { await this.mutate(label, async () => {
    const map = this.map(kind); if (!map.has(id)) return;
    const edge = kind === 'edges' ? this.edges.get(id) : undefined;
    await this.writeDelete(kind, id); this.note(kind, id); map.delete(id); this.snapshot = undefined; this.changed();
    if (edge) await this.syncLinksInternal([edge.source.imageId, edge.target.imageId]);
  }); }
  private async writeOne(kind: Kind, record: Stored): Promise<void> { await this.writeMany(kind, [record]); }
  /** One rewrite per shard whatever the batch size, still inside `process`, so a concurrent
   * write to the same shard is merged rather than lost. */
  private async writeMany(kind: Kind, records: readonly Stored[]): Promise<void> {
    if (!records.length) return;
    await this.ensureFolder(DATA);
    const shards = new Map<number, Stored[]>();
    for (const record of records) { const index = shardIndex(record.id); const batch = shards.get(index); if (batch) batch.push(record); else shards.set(index, [record]); }
    for (const [index, batch] of shards) {
      const path = shardPath(kind, index), file = this.app.vault.getAbstractFileByPath(path), replaced = new Set(batch.map(item => item.id));
      if (file && isFile(file)) await this.app.vault.process(file, current => JSON.stringify({version: VERSION, kind, records: [...parseShard(current, kind, index).filter(item => !replaced.has(item.id)), ...batch]}, null, 2) + '\n');
      else if (file) throw new Error(`Storage shard is not a file: ${path}`);
      else await this.app.vault.create(path, JSON.stringify({version: VERSION, kind, records: batch}, null, 2) + '\n');
    }
    if (kind === 'images') for (const record of records) this.persistedImages.add(record.id);
  }
  private async writeDelete(kind: Kind, id: string): Promise<void> {
    const path = shardPath(kind, shardIndex(id)); const file = this.app.vault.getAbstractFileByPath(path); if (!file || !isFile(file)) return;
    await this.app.vault.process(file, current => { const records = parseShard(current, kind, shardIndex(id)).filter(item => item.id !== id); return JSON.stringify({version: VERSION, kind, records}, null, 2) + '\n'; });
  }
  private async ensureCompanionInternal(imageId: string): Promise<TFile> {
    const image = this.images.get(imageId); if (!image) throw new Error(`Unknown image: ${imageId}`);
    const path = image.metadataPath ?? await this.freeCompanionPath(image);
    let file = this.app.vault.getAbstractFileByPath(path);
    if (file && !isFile(file)) throw new Error(`Companion is not a file: ${path}`);
    if (file && isFile(file)) {
      const frontmatter = await this.readFrontmatter(file);
      if (frontmatter?.image_graph_id !== image.id) throw new Error(`Refusing to claim existing note: ${path}`);
    }
    if (!file) { await this.ensureFolder(path.split('/').slice(0, -1).join('/')); file = await this.app.vault.create(path, `---\nimage: ${yamlScalar(`[[${image.path}]]`)}\nimage_graph_id: ${yamlScalar(image.id)}\n---\n`); }
    if (!isFile(file)) throw new Error(`Companion is not a file: ${path}`);
    else await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => { frontmatter.image = `[[${image.path}]]`; frontmatter.image_graph_id = image.id; });
    if (image.metadataPath !== path || !this.persistedImages.has(imageId)) { const updated = {...image, metadataPath: path}; await this.writeOne('images', updated); this.images.set(imageId, updated); this.snapshot = undefined; }
    return file;
  }
  /**
   * Write each named image's connections into its companion note as wikilinks to the notes at
   * the other ends, so Obsidian's graph view draws the connection. A note that is already
   * right is not rewritten; an image with no connections and no note stays without one.
   *
   * With no argument this reconciles every connected image, which is what load() wants: a
   * vault connected by an earlier version has the connections but none of the links.
   */
  private async syncLinksInternal(imageIds?: Iterable<string>): Promise<void> {
    const byImage = new Map<string, EdgeRecord[]>();
    for (const edge of this.edges.values()) for (const id of new Set([edge.source.imageId, edge.target.imageId])) {
      const list = byImage.get(id); if (list) list.push(edge); else byImage.set(id, [edge]);
    }
    for (const id of new Set(imageIds ?? byImage.keys())) {
      const image = this.images.get(id); if (!image) continue;
      const links = companionLinks(id, byImage.get(id) ?? [], this.images);
      const path = companionPath(image);
      const file = this.app.vault.getAbstractFileByPath(path);
      // Nothing to say and nowhere said: an unconnected image does not earn a note.
      if (!links.length && (!file || !isFile(file))) continue;
      try {
        if (file && isFile(file) && sameLinks((await this.readFrontmatter(file))?.[LINKS_KEY], links)) continue;
        const note = await this.ensureCompanionInternal(id);
        await this.app.fileManager.processFrontMatter(note, (frontmatter: Record<string, unknown>) => {
          if (links.length) frontmatter[LINKS_KEY] = links; else delete frontmatter[LINKS_KEY];
        });
      } catch (error) { console.warn('Image Graph connection links:', error); }
    }
  }
  /** The one reader of a companion note's frontmatter. A note the owner edits may be CRLF. */
  private async readFrontmatter(file: TFile): Promise<Record<string, unknown> | undefined> {
    const text = await this.app.vault.read(file), match = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|$)/);
    if (!match) return undefined;
    let value: unknown;
    try { value = parseYaml(match[1]); } catch { throw new Error(`Invalid YAML in companion note: ${file.path}`); }
    return isRecord(value) ? value : undefined;
  }
  /**
   * The name a new note takes. Mirroring the image's folder makes a clash all but impossible;
   * the two that remain are two pictures in one folder differing only by extension, and a note
   * somebody else wrote at that name. Both step aside rather than being claimed.
   */
  private async freeCompanionPath(image: ImageRecord): Promise<string> {
    const wanted = defaultCompanionPath(image.path, this.displayName(image));
    const extension = image.path.split('.').pop() ?? '';
    const stem = wanted.slice(0, -3);
    for (const candidate of [wanted, `${stem} (${extension}).md`, ...Array.from({length: 20}, (_, n) => `${stem} ${n + 2}.md`)]) {
      const file = this.app.vault.getAbstractFileByPath(candidate);
      if (!file) return candidate;
      if (!isFile(file)) continue;
      if ((await this.readFrontmatter(file))?.image_graph_id === image.id) return candidate;
    }
    throw new Error(`No free companion name near ${wanted}`);
  }

  /** What the workspace calls this picture. An extracted region's file name is a uuid, and a
   * note called `region-00e6a95d-…` is exactly the name nobody can read. */
  private displayName(image: ImageRecord): string | undefined {
    // A web image Image Annotation saved is a hash on disk; the note it was clipped from is its name.
    const article = this.foreignSources.get(image.id)?.articlePath;
    if (article) return baseName(article);
    if (!image.path.startsWith(`${PLUGIN_ROOT}/Extracted/`)) return undefined;
    const edge = [...this.edges.values()].find(item => item.source.imageId === image.id && relationOf(item.properties) === 'derived from');
    if (!edge) return undefined;
    const label = (edge.target.regionId ? this.regionOf(edge.target.regionId)?.label : '')?.trim() || 'Region';
    const parent = this.images.get(edge.target.imageId);
    const parentName = parent ? (parent.path.split('/').pop() ?? '').replace(/\.[^.]+$/, '') : '';
    return parentName ? `${label} · ${parentName}` : label;
  }

  /**
   * Move the notes an earlier version filed under an opaque id into names anybody can read.
   *
   * `fileManager.renameFile` is what moves them, so Obsidian rewrites every link that points
   * at one. `syncCompanionLinks` then rebuilds the plugin's own `connections` links from the
   * records, which is what makes this safe whether or not the owner has Obsidian's link
   * updating switched on.
   */
  async migrateCompanions(): Promise<number> { return this.mutate('rename companion notes', async () => {
    // Both roots, because a note the plugin filed badly is the plugin's to correct. A note
    // moved anywhere else is the owner's placement and is never touched.
    const stale = [...this.images.values()].filter(image => image.metadataPath?.startsWith(`${OLD_NOTES_ROOT}/`) || image.metadataPath?.startsWith(`${NOTES_ROOT}/`));
    let moved = 0;
    for (const image of stale) {
      const from = this.app.vault.getAbstractFileByPath(image.metadataPath!);
      if (!from || !isFile(from)) { this.note('images', image.id, {...image, metadataPath: undefined}); const cleared = {...image}; delete cleared.metadataPath; this.images.set(image.id, cleared); await this.writeOne('images', cleared); continue; }
      try {
        const to = await this.freeCompanionPath(image);
        if (to === image.metadataPath) continue;
        await this.ensureFolder(to.split('/').slice(0, -1).join('/'));
        await this.app.fileManager.renameFile(from, to);
        const updated = {...image, metadataPath: to};
        this.note('images', image.id, updated);
        this.images.set(image.id, updated);
        await this.writeOne('images', updated);
        moved++;
      } catch (error) { console.warn('Image Graph companion rename:', error); }
    }
    if (moved) { this.snapshot = undefined; this.changed(); await this.syncLinksInternal(); }
    return moved;
  }); }

  private async readShard(file: TFile, kind: Kind, index: number): Promise<Stored[]> { return parseShard(await this.app.vault.read(file), kind, index); }
  private map(kind: Kind): Map<string, Stored> { return kind === 'images' ? this.images : kind === 'regions' ? this.regions : this.edges; }
  private putMemory(kind: Kind, record: Stored): void { validateRecord(kind, record); this.note(kind, record.id, record); this.map(kind).set(record.id, record); this.snapshot = undefined; }
  /**
   * Remember one record on both sides of a change. Called from the two places memory changes
   * — `putMemory` and each `delete` — so a mutation added later is recorded without anybody
   * remembering to record it. The derived whole-vault layout goes around both and is
   * therefore never in the history, which is right: nobody asked for it.
   */
  private note(kind: Kind, id: string, after?: Stored): void {
    if (!this.journal) return;
    const before = this.map(kind).get(id);
    this.journal.push({kind, id, before: before ? clone(before) : undefined, after: after ? clone(after) : undefined});
  }
  private async mutate<T>(label: string | null, fn: () => Promise<T>): Promise<T> { return this.enqueue(async () => {
    if (!this.loaded) throw new Error('GraphStore.load() must be awaited before mutation');
    const outer = this.journal;
    this.journal = label === null ? null : [];
    try {
      const result = await fn();
      const entries = this.journal;
      if (label !== null && entries?.length) this.history.push({label, entries});
      return result;
    } finally { this.journal = outer; }
  }); }

  /** Undo or redo one step, and name what moved. Nothing to do returns null. */
  async undo(): Promise<string | null> { return this.travel('undo'); }
  async redo(): Promise<string | null> { return this.travel('redo'); }
  historyLabels(): {undo: string | null; redo: string | null} { return this.history.labels; }
  private async travel(direction: 'undo' | 'redo'): Promise<string | null> { return this.mutate(null, async () => {
    const step = direction === 'undo' ? this.history.undo() : this.history.redo();
    if (!step) return null;
    const touched: string[] = [];
    for (const item of this.history.plan(step, direction)) {
      if (item.record) { await this.writeOne(item.kind, item.record); this.map(item.kind).set(item.id, clone(item.record)); }
      else { await this.writeDelete(item.kind, item.id); this.map(item.kind).delete(item.id); }
    }
    for (const entry of step.entries) if (entry.kind === 'edges') { const edge = (entry.before ?? entry.after) as EdgeRecord | undefined; if (edge) touched.push(edge.source.imageId, edge.target.imageId); }
    this.snapshot = undefined; this.changed();
    if (touched.length) await this.syncLinksInternal(touched);
    return step.label;
  }); }
  private enqueue<T>(fn: () => Promise<T>): Promise<T> { const result = this.queue.then(fn, fn); this.queue = result.then(() => undefined, () => undefined); return result; }
  private async ensureFolder(path: string): Promise<void> { const parts = path.split('/'); let current = ''; for (const part of parts) { current = current ? `${current}/${part}` : part; if (!this.app.vault.getAbstractFileByPath(current)) await this.app.vault.createFolder(current); } }
}

function isFile(file: TAbstractFile): file is TFile { return 'extension' in file && 'stat' in file; }
/** A foreign region is edited where it was drawn. Refusing here keeps every write path honest at once. */
function refuseForeign(id: string, foreign: ReadonlyMap<string, RegionRecord>, record?: RegionRecord): void { if (foreign.has(id) || (record && isForeignRegion(record))) throw new Error('This region belongs to Image Annotation. Edit or delete it there.'); }
function sameRecords(a: ReadonlyMap<string, RegionRecord>, b: ReadonlyMap<string, RegionRecord>): boolean { if (a.size !== b.size) return false; for (const [id, record] of a) { const other = b.get(id); if (!other || JSON.stringify(record) !== JSON.stringify(other)) return false; } return true; }
function isCatalogImage(path: string): boolean { if (path.startsWith(`${ROOT}/`)) return path.startsWith(`${ROOT}/Extracted/`) && IMAGE_EXTENSIONS.has(path.split('.').pop()?.toLowerCase() ?? ''); return IMAGE_EXTENSIONS.has(path.split('.').pop()?.toLowerCase() ?? ''); }
function stableId(path: string): string { let a = 2166136261, b = 5381; for (const char of path) { a = Math.imul(a ^ char.charCodeAt(0), 16777619); b = Math.imul(b,33) ^ char.charCodeAt(0); } return `img-${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`; }
function shardIndex(id: string): number { let hash = 0; for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) | 0; return (hash >>> 0) % 64; }
function shardPath(kind: Kind, index: number): string { return `${DATA}/${kind}-${index.toString(16).padStart(2, '0')}.json`; }
function parseShardName(path: string): {kind: Kind; index: number} | undefined { const match = path.match(new RegExp(`^${DATA}/(images|regions|edges)-([0-9a-f]{2})\\.json$`)); return match ? {kind: match[1] as Kind, index: Number.parseInt(match[2], 16)} : undefined; }
function parseShard(text: string, kind: Kind, index: number): Stored[] { let value: unknown; try { value = JSON.parse(text); } catch { throw new Error(`Corrupt Image Graph shard: ${shardPath(kind, index)}`); } if (!value || typeof value !== 'object' || (value as Shard).version !== VERSION || (value as Shard).kind !== kind || !Array.isArray((value as Shard).records)) throw new Error(`Invalid Image Graph shard: ${shardPath(kind, index)}`); const records = (value as Shard).records; records.forEach(record => validateRecord(kind, record)); return records; }
/**
 * `strict` is for writes. A shard read from the vault is accepted more liberally, because one
 * hand-edited field should not stop a whole shard loading; the write path is where the rules bite.
 */
function validateRecord(kind: Kind, record: unknown, strict = false): asserts record is Stored {
 if (!isRecord(record) || typeof record.id !== 'string' || !record.id) throw new Error(`Invalid ${kind} record`);
 if (kind === 'images' && (typeof record.path !== 'string' || !record.path || !finite(record.x) || !finite(record.y) || !finite(record.width) || record.width <= 0 || !finite(record.height) || record.height <= 0)) throw new Error('Invalid image record');
 if (kind === 'regions') {
  if (typeof record.imageId !== 'string' || !record.imageId) throw new Error('A region must belong to an image.');
  if (typeof record.label !== 'string') throw new Error('Give the region a label.');
  record.shape = parseRegionShape(record.shape);
 }
 if (kind === 'edges') {
  if (!validEndpoint(record.source) || !validEndpoint(record.target)) throw new Error('A connection needs a source and a target.');
  if (!['none', 'forward', 'reverse', 'both'].includes(record.direction as string)) throw new Error('Choose an arrow direction.');
  // A connection without a relation has simply not been described yet. One that carries an
  // unusable relation is corrupt, and the renderer used to hide that behind its own fallback.
  if (strict && isRecord(record.properties) && 'relation' in record.properties && !relationOf(record.properties)) {
   throw new Error('Describe the connection in relation, as text, for example “resembles”.');
  }
 }
 if (kind !== 'images') record.properties = parseProperties(record.properties);
}
function validEndpoint(value: unknown): boolean { return isRecord(value) && typeof value.imageId === 'string' && value.imageId.length > 0 && (!('regionId' in value) || typeof value.regionId === 'string' && value.regionId.length > 0); }
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function cleanProperties(properties: Record<string, unknown>): Record<string, unknown> { const result = {...properties}; for (const key of RESERVED_KEYS) delete result[key]; return result; }
/** Keep every value the panel can show and drop the rest, so one odd field is not a dead end. */
function readable(properties: Record<string, unknown>): Properties {
 const result: Properties = {};
 for (const [key, value] of Object.entries(properties)) { try { result[key] = parseProperties({[key]: value})[key]; } catch { /* shown in the note, not here */ } }
 return result;
}
function yamlScalar(value: string): string { return JSON.stringify(value); }
