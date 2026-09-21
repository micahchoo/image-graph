import type {ImageRecord, RegionShape} from './types';
import {overlaps} from './geometry';
import {EXTRACTED_ROOT, baseName, safeName} from './links';

const SNAP=40,STEP=280,BUCKET=280;
/** Canvas sizes past this fail on some devices, and no picture here needs one. */
export const MAX_EXTRACT_SIDE=4096;

/** Which pixels of the original to read, and how big a picture to write them into. */
export interface RegionCrop {
 sourceX:number;sourceY:number;sourceWidth:number;sourceHeight:number;
 width:number;height:number;
 /** Original pixels to output pixels. A polygon clip path is scaled by this. */
 scale:number;
}

/**
 * The part of a picture a region names, in that picture's own pixels.
 *
 * A shape is fractions of the image, and a polygon is bounded by the box around its corners:
 * the clip comes later, on the drawn pixels. Both are held inside the picture, so a shape
 * hand-edited past its edge reads the edge rather than transparent nothing, and a shape with
 * no area is refused here rather than producing a 1x1 png nobody asked for.
 *
 * Pure on purpose. It used to sit inside the method that decodes the original and writes the
 * file, where the 4096 cap and the empty-region refusal could not be tested at all.
 */
export function regionCrop(shape:RegionShape,naturalWidth:number,naturalHeight:number,maxSide=MAX_EXTRACT_SIDE):RegionCrop{
 const corners=shape.type==='polygon'?shape.points:[{x:shape.x,y:shape.y},{x:shape.x+shape.width,y:shape.y+shape.height}];
 const left=Math.max(0,Math.min(...corners.map(p=>p.x))),top=Math.max(0,Math.min(...corners.map(p=>p.y)));
 const right=Math.min(1,Math.max(...corners.map(p=>p.x))),bottom=Math.min(1,Math.max(...corners.map(p=>p.y)));
 const sourceWidth=(right-left)*naturalWidth,sourceHeight=(bottom-top)*naturalHeight;
 if(!(sourceWidth>0)||!(sourceHeight>0))throw new Error('The region has no area.');
 const scale=Math.min(1,maxSide/Math.max(sourceWidth,sourceHeight));
 return{
  sourceX:left*naturalWidth,sourceY:top*naturalHeight,sourceWidth,sourceHeight,
  width:Math.max(1,Math.round(sourceWidth*scale)),height:Math.max(1,Math.round(sourceHeight*scale)),scale,
 };
}

/**
 * Where an extracted picture goes: named after the region and the picture it came from, as
 * its companion note already was. A uuid was a name nobody could read in a file picker, and
 * Image Annotation's picker lists every image in the vault by name.
 */
export function extractionPath(label: string, parentPath: string, exists: (path: string) => boolean): string {
 const stem = `${safeName(label.trim() || 'Region')} · ${safeName(baseName(parentPath))}`;
 for (let n = 1; n <= 1000; n++) { const path = `${EXTRACTED_ROOT}/${stem}${n > 1 ? ` ${n}` : ''}.png`; if (!exists(path)) return path; }
 throw new Error(`No free name near ${stem}`);
}

/** Find a non-overlapping snapped location near a source image. */
export function findExtractionPosition(images:ImageRecord[],parent:ImageRecord,width:number,height:number,excludeId?:string):{x:number;y:number}{
 const buckets=new Map<string,ImageRecord[]>();
 const add=(image:ImageRecord)=>{if(image.id===excludeId)return;const x0=Math.floor(image.x/BUCKET),x1=Math.floor((image.x+image.width)/BUCKET),y0=Math.floor(image.y/BUCKET),y1=Math.floor((image.y+image.height)/BUCKET);for(let x=x0;x<=x1;x++)for(let y=y0;y<=y1;y++){const key=`${x},${y}`,items=buckets.get(key);if(items)items.push(image);else buckets.set(key,[image]);}};
 for(const image of images)add(image);
 const covered=(x:number,y:number)=>{const seen=new Set<string>(),x0=Math.floor(x/BUCKET)-1,x1=Math.floor((x+width)/BUCKET)+1,y0=Math.floor(y/BUCKET)-1,y1=Math.floor((y+height)/BUCKET)+1;for(let ix=x0;ix<=x1;ix++)for(let iy=y0;iy<=y1;iy++)for(const image of buckets.get(`${ix},${iy}`)??[]){if(seen.has(image.id))continue;seen.add(image.id);if(overlaps({x,y,width,height},image))return true;}return false;};
 const snap=(value:number)=>Math.round(value/SNAP)*SNAP;
 const origin={x:snap(parent.x+parent.width+SNAP),y:snap(parent.y)};
 for(let radius=0;radius<=200;radius++)for(let dx=-radius;dx<=radius;dx++)for(let dy=-radius;dy<=radius;dy++){if(radius&&Math.max(Math.abs(dx),Math.abs(dy))!==radius)continue;const x=origin.x+dx*STEP,y=origin.y+dy*STEP;if(!covered(x,y))return{x,y};}
 let maxRight=parent.x+parent.width;for(const image of images)if(image.id!==excludeId)maxRight=Math.max(maxRight,image.x+image.width);
 return{x:snap(maxRight+SNAP),y:origin.y};
}
