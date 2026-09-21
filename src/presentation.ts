import type {EdgeRecord, ImageRecord, RegionRecord} from './types';

/**
 * Every colour a picture of the graph uses, and the font its labels are set in. One shape for
 * the live canvas and the still renderer; until 2026-09-21 each read the theme for itself, with
 * different fields, and the live canvas set its labels in a generic family the theme never chose.
 */
export interface Palette {bg: string; card: string; fg: string; accent: string; picked: string; region: string; regionHover: string; missing: string; font: string}

/** Readable without a document, and overridden by the theme wherever there is one. */
export const DEFAULT_PALETTE: Palette = {bg: '#181b20', card: '#333840', fg: '#dddddd', accent: '#7bbda8', picked: '#ffe0a0', region: '#69dfb0', regionHover: '#a6f5d2', missing: '#733c43', font: 'sans-serif'};

/** The palette the theme gives, read once per frame from a computed style. */
export function themePalette(style: CSSStyleDeclaration): Palette {
 const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
 return {
  bg: read('--background-primary', DEFAULT_PALETTE.bg),
  card: read('--background-secondary', DEFAULT_PALETTE.card),
  fg: read('--text-normal', DEFAULT_PALETTE.fg),
  accent: read('--interactive-accent', DEFAULT_PALETTE.accent),
  picked: read('--color-yellow', DEFAULT_PALETTE.picked),
  region: read('--color-green', DEFAULT_PALETTE.region),
  regionHover: read('--color-cyan', DEFAULT_PALETTE.regionHover),
  missing: read('--background-modifier-error', DEFAULT_PALETTE.missing),
  // The computed family, already resolved. A canvas font string cannot hold `var()`: the
  // canvas rejects the whole assignment and keeps 10px sans-serif, which is what every
  // export and embed drew with until 2026-09-21.
  font: style.fontFamily.trim() || DEFAULT_PALETTE.font,
 };
}

export interface ConnectionFocus {
 selected: ReadonlySet<string>;
 selectedEdge: string | null;
 hoveredImage: string | null;
 hoveredEdge: string | null;
 path: ReadonlySet<string>;
 filter: string;
 exploring: boolean;
}

/** Focus changes presentation only: every connection remains in the graph. */
export function connectionStyle(edge: EdgeRecord, relation: string, focus: ConnectionFocus) {
 const direct = edge.id === focus.selectedEdge || edge.id === focus.hoveredEdge;
 const path = focus.path.has(edge.id);
 const adjacent = focus.selected.has(edge.source.imageId) || focus.selected.has(edge.target.imageId)
  || edge.source.imageId === focus.hoveredImage || edge.target.imageId === focus.hoveredImage;
 const matching = Boolean(focus.filter) && relation === focus.filter;
 const relevant = direct || path || adjacent || matching;
 const mismatch = Boolean(focus.filter) && !matching;
 return {
  emphasized: direct || path,
  relevant,
  label: direct || path || (!mismatch && (adjacent || matching)),
  alpha: direct || path ? 1 : mismatch ? .09 : relevant ? .8 : focus.exploring ? .14 : .3,
  width: direct || path ? 2.5 : relevant ? 1.5 : 1,
 };
}

/** Display names never rename files or replace the full path in Properties. */
export function imageCaptions(images: readonly ImageRecord[], regions: readonly RegionRecord[], edges: readonly EdgeRecord[]): Map<string,string> {
 const names = new Map(images.map(image => [image.id, (image.path.split('/').pop() ?? image.path).replace(/\.[^.]+$/, '')]));
 const regionMap = new Map(regions.map(region => [region.id, region]));
 const extracted = new Set(images.filter(image => image.path.includes('/Extracted/')).map(image => image.id));
 for (const edge of edges) {
  if (edge.properties.relation !== 'derived from' || !extracted.has(edge.source.imageId)) continue;
  const region = edge.target.regionId ? regionMap.get(edge.target.regionId) : undefined;
  const parent = names.get(edge.target.imageId) ?? 'Image';
  names.set(edge.source.imageId, `${region?.label.trim() || 'Region'} · ${parent}`);
 }
 for (const image of images) if (extracted.has(image.id) && /^region-[a-f\d-]+$/i.test(names.get(image.id) ?? '')) names.set(image.id, 'Extracted region');
 return names;
}

export function shortenLabel(text: string, width: number, measure: (text: string) => number): string {
 if (measure(text) <= width) return text;
 if (measure('…') > width) return '';
 let low = 0, high = text.length;
 while (low < high) {const middle = Math.ceil((low + high) / 2);if (measure(text.slice(0,middle)+'…') <= width) low = middle;else high = middle - 1;}
 return text.slice(0,low).trimEnd()+'…';
}
