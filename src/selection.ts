import type {Endpoint} from './types';

/** One selection, never three fields kept in step by hand. A region carries its image, and a
 * connection carries no image, so the ring, the Properties panel and Delete cannot disagree.
 * Both states the audit found — an image ringed while a connection was edited, and a region
 * edited while its image was deselected — are unrepresentable here. */
export type Selection={kind:'none'}|{kind:'images';ids:Set<string>}|{kind:'region';imageId:string;regionId:string}|{kind:'edge';id:string};
/** What a pointer press, a menu or a keystroke resolved to. */
export type SelectionTarget={endpoint:Endpoint}|{edgeId:string}|null;
/** What still exists after a vault change. */
export interface Existing {image(id:string):boolean;region(id:string):boolean;edge(id:string):boolean}

export const NOTHING:Selection={kind:'none'};
const NO_IMAGES:ReadonlySet<string>=new Set();

/** The images a selection rings. A region rings its own image; a connection rings none. */
export function selectedImages(selection:Selection):ReadonlySet<string>{
 if(selection.kind==='images')return selection.ids;
 if(selection.kind==='region')return new Set([selection.imageId]);
 return NO_IMAGES;
}
/** An empty image set is `none`, so no caller has to test for both. */
export function imageSelection(ids:Iterable<string>):Selection{const set=new Set(ids);return set.size?{kind:'images',ids:set}:NOTHING;}

/** Shift extends the image selection and ignores regions, so a second click cannot collapse it.
 * Without shift, a region or a connection is selected on its own. */
export function selectTarget(current:Selection,target:SelectionTarget,multiple=false):Selection{
 if(target&&'edgeId'in target)return{kind:'edge',id:target.edgeId};
 if(target&&multiple){const id=target.endpoint.imageId,ids=new Set(selectedImages(current));if(!ids.delete(id))ids.add(id);return imageSelection(ids);}
 if(target){const e=target.endpoint;return e.regionId?{kind:'region',imageId:e.imageId,regionId:e.regionId}:{kind:'images',ids:new Set([e.imageId])};}
 return multiple?current:NOTHING;
}
/** Keep the images and drop whatever else was selected with them. */
export function keepImages(current:Selection):Selection{return current.kind==='images'?current:imageSelection(selectedImages(current));}

/** Drop a selection whose record went away. Returns the same value when everything survives. */
export function prune(current:Selection,exists:Existing):Selection{
 if(current.kind==='images'){const ids=[...current.ids].filter(id=>exists.image(id));return ids.length===current.ids.size?current:imageSelection(ids);}
 if(current.kind==='region')return exists.image(current.imageId)&&exists.region(current.regionId)?current:NOTHING;
 if(current.kind==='edge')return exists.edge(current.id)?current:NOTHING;
 return current;
}
