import type {EdgeRecord, ImageRecord, RegionRecord} from './types';

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
