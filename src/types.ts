import type {TFile} from 'obsidian';
import type {JobState} from './jobs';

/** Everything a companion note's frontmatter can hold. `properties.ts` is the only parser. */
export type PropertyValue = string | number | boolean | null | PropertyValue[] | {[key: string]: PropertyValue};
export type Properties = Record<string, PropertyValue>;
export interface Point {x:number;y:number}
export interface Rect {x:number;y:number;width:number;height:number}
export type RegionShape = ({type:'rect'} & Rect) | {type:'polygon';points:Point[]};
/** `pinned` is set where the owner placed the image. The whole-vault grid is otherwise
 * derived — one height, each width the picture's own — and repacks when a width changes. */
export interface ImageRecord extends Rect {id:string;path:string;metadataPath?:string;missing?:boolean;pinned?:boolean}
/** `origin` names the plugin that owns a region this one only shows. Never written to a shard. */
export interface RegionRecord {id:string;imageId:string;label:string;shape:RegionShape;properties:Properties;origin?:string}
export interface Endpoint {imageId:string;regionId?:string}
/** One note, or one paragraph of it, that Image Annotation attached a foreign region to. */
export interface Attachment {notePath:string;blockId?:string;captionPath:string}
export type Direction = 'none'|'forward'|'reverse'|'both';
export interface EdgeRecord {id:string;source:Endpoint;target:Endpoint;direction:Direction;properties:Properties}
export interface GraphSnapshot {images:ImageRecord[];regions:RegionRecord[];edges:EdgeRecord[]}
export interface Camera {x:number;y:number;scale:number}
export interface ViewFrame {imageIds:string[];edgeIds?:string[];positions:Record<string,Rect>;camera:Camera;width:number;height:number}
export interface GraphHost {
 getSnapshot():GraphSnapshot;
 subscribe(callback:()=>void):()=>void;
 /** Progress only. Never the graph: a redraw, not a reload. */
 subscribeJobs(callback:()=>void):()=>void;
 imageUrl(image:ImageRecord):string;
 thumbnail(image:ImageRecord,ready:()=>void,pixels?:number):CanvasImageSource|null;
 overviewThumbnail(image:ImageRecord,ready:()=>void):{source:CanvasImageSource;x:number;y:number;width:number;height:number}|null;
 jobState():JobState|null;
 stopJobs():void;
 resumeJobs():void;
 updateImage(image:ImageRecord):Promise<void>;
 updateImages(images:readonly ImageRecord[]):Promise<void>;
 unpinImages(ids?:readonly string[]):Promise<number>;
 /** Append a block to a note the owner picks. Returns the note, or '' if they cancelled. */
 insertNoteBlock(block:string):Promise<string>;
 saveRegion(region:RegionRecord):Promise<void>;
 deleteRegion(id:string):Promise<void>;
 saveEdge(edge:EdgeRecord):Promise<void>;
 deleteEdge(id:string):Promise<void>;
 readMetadata(imageId:string):Promise<Properties>;
 saveMetadata(imageId:string,properties:Properties):Promise<void>;
 openCompanion(imageId:string):Promise<void>;
 openImage(imageId:string):Promise<void>;
 extractRegion(regionId:string):Promise<void>;
 /** Where Image Annotation attached a foreign region. Empty for one of ours. */
 regionAttachments(regionId:string):readonly Attachment[];
 openAttachment(attachment:Attachment):Promise<void>;
 /** True while Image Annotation is loaded, so the view can offer its editor. */
 annotationAvailable():boolean;
 openInAnnotation(regionId:string):Promise<void>;
 annotateInAnnotation(imageId:string):Promise<void>;
 exportCanvas(frame:ViewFrame):Promise<TFile>;
 exportVisual(frame:ViewFrame,source?:HTMLCanvasElement):Promise<TFile>;
 seedDemo():Promise<void>;
 undo():Promise<void>;
 redo():Promise<void>;
 historyLabels():{undo:string|null;redo:string|null};
}
export function newId(prefix:string):string{return `${prefix}-${crypto.randomUUID()}`;}
