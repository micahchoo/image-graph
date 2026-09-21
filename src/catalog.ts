import type {ImageRecord} from './types';
import {gridSize, packRows, rowWidth} from './layout';
import {PLUGIN_ROOT, EXTRACTED_ROOT} from './links';

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'tif', 'tiff', 'avif']);

/**
 * Which pictures the graph holds, and where they sit when nobody has placed them.
 *
 * The whole-vault layout is DERIVED, not stored: one record per image file, each as wide as
 * its own picture and all the same height, wrapped into rows in path order. A width is only as
 * true as the pixel size read so far, so this runs again whenever `SizeIndex` learns more —
 * which is why nothing here may depend on the order it is called in.
 *
 * Pure, so the rules that actually bite can be tested: that a picture the owner placed keeps
 * its position and gives up its place in the rows, that a file that has gone is kept and marked
 * missing rather than dropped, and that an id is a function of the path and never renumbered.
 */
export function nextCatalog(paths: readonly string[], existing: readonly ImageRecord[]): ImageRecord[] {
 const present = new Set(paths);
 const byPath = new Map(existing.map(image => [image.path, image]));
 const catalogued: ImageRecord[] = paths.map(path => {
  const prior = byPath.get(path);
  return prior ? {...prior, path, missing: false} : {id: stableId(path), path, x: 0, y: 0, ...gridSize(undefined)};
 });
 // A placed image keeps its position, which is the whole meaning of having placed it, and so
 // it takes no slot in the rows the others wrap into.
 const placed = packRows(catalogued.filter(image => !image.pinned), rowWidth(catalogued.length));
 const next = new Map<string, ImageRecord>(catalogued.map(image => {
  const at = placed.get(image.id);
  return [image.id, at ? {...image, ...at} : image];
 }));
 // A record whose file has gone is marked, never dropped: its regions and connections are
 // still the owner's, and the file may come back.
 for (const old of existing) if (!present.has(old.path)) next.set(old.id, {...old, missing: true});
 return [...next.values()];
}

/** Every image outside the plugin's own folder, plus the regions it extracted into it. */
export function isCatalogImage(path: string): boolean {
 const extension = path.split('.').pop()?.toLowerCase() ?? '';
 if (!IMAGE_EXTENSIONS.has(extension)) return false;
 return path.startsWith(`${PLUGIN_ROOT}/`) ? path.startsWith(`${EXTRACTED_ROOT}/`) : true;
}

/**
 * An id derived from the path, so the same picture is the same record across sessions without
 * anything being written down. Two hashes, because one 32-bit hash collides at this scale.
 */
export function stableId(path: string): string {
 let a = 2166136261, b = 5381;
 for (const char of path) { a = Math.imul(a ^ char.charCodeAt(0), 16777619); b = Math.imul(b, 33) ^ char.charCodeAt(0); }
 return `img-${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`;
}
