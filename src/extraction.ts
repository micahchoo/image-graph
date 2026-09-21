import type {ImageRecord} from './types';

const SNAP=40,STEP=280,BUCKET=280;

/** Find a non-overlapping snapped location near a source image. */
export function findExtractionPosition(images:ImageRecord[],parent:ImageRecord,width:number,height:number,excludeId?:string):{x:number;y:number}{
 const buckets=new Map<string,ImageRecord[]>();
 const add=(image:ImageRecord)=>{if(image.id===excludeId)return;const x0=Math.floor(image.x/BUCKET),x1=Math.floor((image.x+image.width)/BUCKET),y0=Math.floor(image.y/BUCKET),y1=Math.floor((image.y+image.height)/BUCKET);for(let x=x0;x<=x1;x++)for(let y=y0;y<=y1;y++){const key=`${x},${y}`,items=buckets.get(key);if(items)items.push(image);else buckets.set(key,[image]);}};
 for(const image of images)add(image);
 const overlaps=(x:number,y:number)=>{const seen=new Set<string>(),x0=Math.floor(x/BUCKET)-1,x1=Math.floor((x+width)/BUCKET)+1,y0=Math.floor(y/BUCKET)-1,y1=Math.floor((y+height)/BUCKET)+1;for(let ix=x0;ix<=x1;ix++)for(let iy=y0;iy<=y1;iy++)for(const image of buckets.get(`${ix},${iy}`)??[]){if(seen.has(image.id))continue;seen.add(image.id);if(x<image.x+image.width&&x+width>image.x&&y<image.y+image.height&&y+height>image.y)return true;}return false;};
 const snap=(value:number)=>Math.round(value/SNAP)*SNAP;
 const origin={x:snap(parent.x+parent.width+SNAP),y:snap(parent.y)};
 for(let radius=0;radius<=200;radius++)for(let dx=-radius;dx<=radius;dx++)for(let dy=-radius;dy<=radius;dy++){if(radius&&Math.max(Math.abs(dx),Math.abs(dy))!==radius)continue;const x=origin.x+dx*STEP,y=origin.y+dy*STEP;if(!overlaps(x,y))return{x,y};}
 let maxRight=parent.x+parent.width;for(const image of images)if(image.id!==excludeId)maxRight=Math.max(maxRight,image.x+image.width);
 return{x:snap(maxRight+SNAP),y:origin.y};
}
