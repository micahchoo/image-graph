import type {Attachment, EdgeRecord, ImageRecord, RegionRecord} from './types';
import {relationOf} from './properties';

export const PLUGIN_ROOT = '_Image Graph';
export const NOTES_ROOT = `${PLUGIN_ROOT}/Notes`;
export const EXTRACTED_ROOT = `${PLUGIN_ROOT}/Extracted`;
/** The folder companion notes were kept in before they were named after their pictures. */
export const OLD_NOTES_ROOT = '_Image Graph/Images';
/** Obsidian reads these inside a note name, so a file that is legal on disk is not legal here. */
const UNSAFE = /[[\]#^|:\\/]/g;

/**
 * Where an image's companion note lives, whether or not the file exists yet.
 *
 * `metadataPath` wins whenever it is set. It is recorded the moment a note is created, so a
 * note keeps its address for good: renaming the picture, or changing this rule, never orphans
 * one. The rule below therefore only decides what a *new* note is called.
 */
export function companionPath(image: ImageRecord): string {
 return image.metadataPath ?? defaultCompanionPath(image.path);
}

/**
 * Named after the picture, and filed where the picture is.
 *
 * Mirroring the image's own folder is what makes the name safe to use: two pictures can both
 * be called `photo.png`, but they cannot both be at the same path, so the note paths cannot
 * collide either. Only two pictures in one folder differing by extension can still meet, and
 * `GraphStore` settles that at creation by trying the next free name.
 */
export function defaultCompanionPath(imagePath: string, displayName?: string): string {
 const parts = imagePath.split('/').filter(Boolean);
 const name = parts.pop() ?? imagePath;
 // An image the plugin made lives under its own folder; mirroring that would nest the folder
 // inside itself — `_Image Graph/Notes/_Image Graph/Extracted/…`.
 if (parts[0] === PLUGIN_ROOT) parts.shift();
 const stem = displayName?.trim() || name.replace(/\.[^.]+$/, '') || name;
 return [NOTES_ROOT, ...parts.map(safeName), `${safeName(stem)}.md`].join('/');
}

/** A name Obsidian can hold and link to. Never empty, never ending in a dot or a space. */
export function safeName(text: string): string {
 // Control characters cannot be matched inside the class without tripping the linter's
 // own rule, and they are stripped separately for the same reason.
 const cleaned = [...text].filter(ch => ch.codePointAt(0)! > 31).join('').replace(UNSAFE, '-').replace(/\s+/g, ' ').replace(/[. ]+$/, '').trim();
 return cleaned || 'Untitled';
}

/**
 * The wikilinks one image's companion note carries: one per connection, aimed at the other
 * end's companion note.
 *
 * The target need not exist. Obsidian resolves a link to a missing note as an unresolved
 * node and still draws the line, which is the only way a connection can reach the graph view
 * before both notes have been written. The list is sorted, so rewriting it when nothing has
 * changed produces the same text and the note is left alone.
 */
export function companionLinks(imageId: string, edges: readonly EdgeRecord[], images: ReadonlyMap<string, ImageRecord>): string[] {
 const links = new Set<string>();
 for (const edge of edges) {
  const mine = edge.source.imageId === imageId, theirs = mine ? edge.target : edge.target.imageId === imageId ? edge.source : null;
  // A connection from an image to itself has no other end to name.
  if (!theirs || theirs.imageId === imageId) continue;
  const other = images.get(theirs.imageId);
  if (!other) continue;
  const arrow = edge.direction === 'none' ? '' : edge.direction === 'both' ? '↔ ' : (edge.direction === 'forward') === mine ? '→ ' : '← ';
  const relation = relationOf(edge.properties) ?? 'related to';
  links.add(`[[${companionPath(other).replace(/\.md$/, '')}|${alias(`${arrow}${relation} · ${baseName(other.path)}`)}]]`);
 }
 return [...links].sort();
}

/**
 * The names a new companion note may take, in the order to try them.
 *
 * Mirroring the picture's own folder makes a clash all but impossible; the two that remain are
 * two pictures in one folder differing only by extension, and a note somebody else wrote at
 * that name. Both step aside rather than being claimed — the extension first, because it names
 * the difference, then a counter. The caller probes each and takes the first free one, or one
 * already carrying this image's id.
 */
export function companionCandidates(imagePath: string, displayName?: string): string[] {
 const wanted = defaultCompanionPath(imagePath, displayName);
 const extension = imagePath.split('.').pop() ?? '';
 const stem = wanted.slice(0, -3);
 return [wanted, `${stem} (${extension}).md`, ...Array.from({length: 20}, (_, n) => `${stem} ${n + 2}.md`)];
}

export function sameLinks(current: unknown, links: readonly string[]): boolean {
 if (!links.length) return current === undefined || (Array.isArray(current) && current.length === 0);
 return Array.isArray(current) && current.length === links.length && current.every((item, index) => item === links[index]);
}

/** A wikilink to the note, or the paragraph of it, that Image Annotation attached a region to. */
export function attachmentLink(attachment: Attachment, label: string): string {
 const target = attachment.notePath.replace(/\.md$/, '') + (attachment.blockId ? `#^${attachment.blockId}` : '');
 return `[[${target}|${alias(`${label} · ${baseName(attachment.notePath)}`)}]]`;
}

/**
 * The links one image's companion note carries for the notes Image Annotation attached its
 * regions to, keyed by image. Sorted and unique for the same reason `companionLinks` is: a
 * rewrite that changes nothing must produce the same text.
 */
export function annotationLinks(regions: readonly RegionRecord[], attachments: ReadonlyMap<string, readonly Attachment[]>): Map<string, string[]> {
 const byImage = new Map<string, Set<string>>();
 for (const region of regions) for (const attachment of attachments.get(region.id) ?? []) {
  const links = byImage.get(region.imageId) ?? new Set<string>();
  links.add(attachmentLink(attachment, region.label)); byImage.set(region.imageId, links);
 }
 return new Map([...byImage].map(([imageId, links]) => [imageId, [...links].sort()]));
}

export function baseName(path: string): string { return (path.split('/').pop() ?? path).replace(/\.[^.]+$/, ''); }
/** A relation is the owner's text, and `|` or `]]` inside an alias would end the link early. */
function alias(text: string): string { return text.replace(/[[\]|]/g, ' ').replace(/\s+/g, ' ').trim(); }
