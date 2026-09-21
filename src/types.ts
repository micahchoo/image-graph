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
/**
 * What the workspace may ask of the plugin, in six roles rather than one list of thirty-three.
 *
 * `GraphHost` was a single interface that grew a member for every capability, and it had come
 * to mirror the plugin's public surface rather than the workspace's need: `imageUrl`,
 * `resumeJobs` and `updateImage` were on it although nothing across the seam ever called them.
 * A feature cost a member here, a method in `main.ts` and a call in the view before any of it
 * did anything.
 *
 * Split by what a collaborator is FOR, so a part of the workspace can take the one role it
 * needs and be handed a stub in a test. The roles are disjoint, and `GraphHost` is still their
 * union, so the plugin implements one thing and nothing downstream had to move.
 */

/** Reading the graph, and hearing when it changes. */
export interface GraphData {
 getSnapshot():GraphSnapshot;
 subscribe(callback:()=>void):()=>void;
}

/** Changing it. Every one of these is a vault write, and every one is undoable. */
export interface GraphEdits {
 updateImages(images:readonly ImageRecord[]):Promise<void>;
 unpinImages(ids?:readonly string[]):Promise<number>;
 saveRegion(region:RegionRecord):Promise<void>;
 deleteRegion(id:string):Promise<void>;
 saveEdge(edge:EdgeRecord):Promise<void>;
 deleteEdge(id:string):Promise<void>;
 readMetadata(imageId:string):Promise<Properties>;
 saveMetadata(imageId:string,properties:Properties):Promise<void>;
 undo():Promise<void>;
 redo():Promise<void>;
 historyLabels():{undo:string|null;redo:string|null};
}

/** Pixels to draw with. Neither loads: they answer with what is cached and call back later. */
export interface ImageAssets {
 thumbnail(image:ImageRecord,ready:()=>void,pixels?:number):CanvasImageSource|null;
 overviewThumbnail(image:ImageRecord,ready:()=>void):{source:CanvasImageSource;x:number;y:number;width:number;height:number}|null;
}

/** Long work, watched and stoppable. Progress only — never the graph: a redraw, not a reload. */
export interface BackgroundJobs {
 subscribeJobs(callback:()=>void):()=>void;
 jobState():JobState|null;
 stopJobs():void;
}

/** Ways out of the canvas and into the vault. All of them open or create something. */
export interface VaultDoors {
 openCompanion(imageId:string):Promise<void>;
 openImage(imageId:string):Promise<void>;
 extractRegion(regionId:string):Promise<void>;
 /** Append a block to a note the owner picks. Returns the note, or '' if they cancelled. */
 insertNoteBlock(block:string):Promise<string>;
 exportCanvas(frame:ViewFrame):Promise<TFile>;
 exportVisual(frame:ViewFrame,source?:HTMLCanvasElement):Promise<TFile>;
 seedDemo():Promise<void>;
}

/** Image Annotation, which may not be installed. Every door here is checked before it is shown. */
export interface AnnotationBridge {
 /** Where Image Annotation attached a foreign region. Empty for one of ours. */
 regionAttachments(regionId:string):readonly Attachment[];
 openAttachment(attachment:Attachment):Promise<void>;
 /** True while Image Annotation is loaded, so the view can offer its editor. */
 annotationAvailable():boolean;
 openInAnnotation(regionId:string):Promise<void>;
 annotateInAnnotation(imageId:string):Promise<void>;
}

export interface GraphHost extends GraphData,GraphEdits,ImageAssets,BackgroundJobs,VaultDoors,AnnotationBridge {}

export function newId(prefix:string):string{return `${prefix}-${crypto.randomUUID()}`;}
