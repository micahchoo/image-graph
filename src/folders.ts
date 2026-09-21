import type {App, TAbstractFile, TFile} from 'obsidian';
import {PLUGIN_ROOT} from './links';

/** Did this vault path resolve to a file rather than a folder? `instanceof TFile` needs the
 * real class, which a test does not have; these two fields are what the plugin actually reads. */
export function isFile(file: TAbstractFile): file is TFile { return 'extension' in file && 'stat' in file; }

/** Atlas pages and `sizes.json`. Two caches write here, and they run at the same time. */
export const THUMBNAILS_ROOT = `${PLUGIN_ROOT}/Thumbnails`;
/** Canvases and PNGs the owner asked for. */
export const EXPORTS_ROOT = `${PLUGIN_ROOT}/Exports`;
/** The record shards. A write here means the graph changed under us and must be reloaded. */
export const DATA_ROOT = `${PLUGIN_ROOT}/Data`;

/**
 * Make sure a folder and its parents exist, whoever else is asking at the same moment.
 *
 * `vault.createFolder` refuses a path that already exists, and the check before it is a
 * separate await, so two callers can both find the folder missing and both try to make it.
 * One of them then throws. This was written out five times — in the store, the exporter, the
 * atlas, the size index and region extraction — and four of those five did the unguarded
 * check-then-create. The atlas and the size index both build `Thumbnails`, both start from
 * `onload`, and both swallow what they catch: on a fresh vault the losing one silently failed
 * to save, so the next session read every image header or decoded every original again — the
 * exact cost those caches exist to remove.
 *
 * Losing the race is not a failure: the folder is there, which is all the caller asked for.
 * A folder that is still missing afterwards is a real failure and is reported.
 */
export async function ensureFolder(app: App, path: string): Promise<void> {
 let current = '';
 for (const part of path.split('/').filter(Boolean)) {
  current = current ? `${current}/${part}` : part;
  if (app.vault.getAbstractFileByPath(current)) continue;
  try { await app.vault.createFolder(current); }
  catch (error) { if (!app.vault.getAbstractFileByPath(current)) throw error; }
 }
}
