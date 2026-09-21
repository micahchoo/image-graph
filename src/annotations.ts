/**
 * Regions another plugin drew. Image Annotation keeps its index at `Image Annotation/index.json`
 * and marks image regions in the same terms this graph does: a rectangle or a polygon, in
 * fractions of the image, on an image named by its vault path. This module reads that file
 * into region records so the graph can show them, and shows them only. Nothing here writes,
 * and nothing in this plugin writes a foreign region back: the record carries `origin`, the
 * store refuses to save or delete one, and Image Annotation stays the sole owner of its file.
 *
 * The join is the image path. A region whose image the catalog does not hold is skipped and
 * counted, never invented. One malformed record is skipped the same way, because a foreign
 * file must never stop the graph loading; a file that is not an index at all throws, and the
 * caller names it once.
 */
import type {App} from 'obsidian';
import type {Attachment, RegionRecord} from './types';
import {parseRegionShape} from './region-shape';
import {isRecord} from './properties';

export const ANNOTATION_ROOT = 'Image Annotation';
export const ANNOTATION_INDEX = `${ANNOTATION_ROOT}/index.json`;
/** Written on every region read from the index. A record without it is this plugin's own. */
export const ANNOTATION_ORIGIN = 'image-annotation';
const PREFIX = 'ia-';

/** What Image Annotation knows about where a picture came from. Set for the web images it saved. */
export interface ImageSource {originalUrl?: string; articlePath?: string}
export interface ForeignRegions {
 regions: RegionRecord[];
 /** Keyed by the graph's region id, in index order. */
 attachments: Map<string, Attachment[]>;
 /** Keyed by image id. The first region to say wins; they all describe the same picture. */
 sources: Map<string, ImageSource>;
 skipped: {missingImage: number; invalid: number};
}

/** The graph's id for an Image Annotation region. Two id spaces meet here and must not collide. */
export function annotationRegionId(id: string): string { return `${PREFIX}${id}`; }
/** Image Annotation's own id, or null when the region is not one of theirs. */
export function annotationId(regionId: string): string | null { return regionId.startsWith(PREFIX) ? regionId.slice(PREFIX.length) : null; }
export function isForeignRegion(region: Pick<RegionRecord, 'origin'>): boolean { return region.origin === ANNOTATION_ORIGIN; }

export function readAnnotationIndex(text: string, imageIdByPath: ReadonlyMap<string, string>): ForeignRegions {
 let value: unknown;
 try { value = JSON.parse(text); } catch { throw new Error(`Corrupt Image Annotation index: ${ANNOTATION_INDEX}`); }
 if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.regions) || !Array.isArray(value.connections)) throw new Error(`Unsupported Image Annotation index: ${ANNOTATION_INDEX}`);
 const result: ForeignRegions = {regions: [], attachments: new Map(), sources: new Map(), skipped: {missingImage: 0, invalid: 0}};
 for (const item of value.regions) {
  if (!isRecord(item) || typeof item.id !== 'string' || !item.id || typeof item.title !== 'string' || !isRecord(item.source) || typeof item.source.path !== 'string') { result.skipped.invalid++; continue; }
  const imageId = imageIdByPath.get(item.source.path);
  if (!imageId) { result.skipped.missingImage++; continue; }
  let shape;
  try { shape = parseRegionShape(item.geometry); } catch { result.skipped.invalid++; continue; }
  const id = annotationRegionId(item.id);
  result.regions.push({id, imageId, label: item.title.trim() || 'Region', shape, properties: {}, origin: ANNOTATION_ORIGIN});
  result.attachments.set(id, []);
  if (!result.sources.has(imageId)) {
   const source: ImageSource = {};
   if (typeof item.source.originalUrl === 'string' && item.source.originalUrl) source.originalUrl = item.source.originalUrl;
   if (typeof item.source.articlePath === 'string' && item.source.articlePath) source.articlePath = item.source.articlePath;
   if (source.originalUrl || source.articlePath) result.sources.set(imageId, source);
  }
 }
 for (const item of value.connections) {
  if (!isRecord(item) || typeof item.regionId !== 'string' || typeof item.notePath !== 'string' || typeof item.captionPath !== 'string') continue;
  const list = result.attachments.get(annotationRegionId(item.regionId));
  if (!list) continue;
  list.push({notePath: item.notePath, ...(typeof item.blockId === 'string' && item.blockId ? {blockId: item.blockId} : {}), captionPath: item.captionPath});
 }
 return result;
}

/**
 * The two doors Image Annotation leaves open on its plugin instance: its region editor, by
 * its own region id, and its image picker, by vault path. Neither is a documented API, so
 * both are checked at runtime, and absent means the graph offers nothing rather than a
 * broken menu item. The plugin instance is asked for only at the moment of a click.
 */
export interface AnnotationPlugin {openRegion(id: string): void; openImage(candidate: {value: string; label: string}): Promise<unknown>}
export function annotationPlugin(app: App): AnnotationPlugin | null {
 const plugins = (app as unknown as {plugins?: {getPlugin?(id: string): unknown}}).plugins;
 const plugin = plugins?.getPlugin?.('image-annotation');
 if (!isRecord(plugin) || typeof plugin.openRegion !== 'function' || typeof plugin.openImage !== 'function') return null;
 return plugin as unknown as AnnotationPlugin;
}

