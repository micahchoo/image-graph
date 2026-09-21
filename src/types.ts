import type {TFile} from 'obsidian';

/** Everything a companion note's frontmatter can hold. `properties.ts` is the only parser. */
export type PropertyValue = string | number | boolean | null | PropertyValue[] | {[key: string]: PropertyValue};
export type Properties = Record<string, PropertyValue>;
export interface Point {x:number;y:number}
export interface Rect {x:number;y:number;width:number;height:number}
export type RegionShape = ({type:'rect'} & Rect) | {type:'polygon';points:Point[]};
export interface ImageRecord extends Rect {id:string;path:string;metadataPath?:string;missing?:boolean}
export interface RegionRecord {id:string;imageId:string;label:string;shape:RegionShape;properties:Properties}
export interface Endpoint {imageId:string;regionId?:string}
export type Direction = 'none'|'forward'|'reverse'|'both';
export interface EdgeRecord {id:string;source:Endpoint;target:Endpoint;direction:Direction;properties:Properties}
export interface GraphSnapshot {images:ImageRecord[];regions:RegionRecord[];edges:EdgeRecord[]}
export interface Camera {x:number;y:number;scale:number}
export interface ViewFrame {imageIds:string[];edgeIds?:string[];positions:Record<string,Rect>;camera:Camera;width:number;height:number}
export interface GraphHost {
 getSnapshot():GraphSnapshot;
 subscribe(callback:()=>void):()=>void;
 imageUrl(image:ImageRecord):string;
 thumbnail(image:ImageRecord,ready:()=>void,pixels?:number):CanvasImageSource|null;
 overviewThumbnail(image:ImageRecord,ready:()=>void):{source:CanvasImageSource;x:number;y:number;width:number;height:number}|null;
 thumbnailProgress():{ready:number;total:number};
 updateImage(image:ImageRecord):Promise<void>;
 saveRegion(region:RegionRecord):Promise<void>;
 deleteRegion(id:string):Promise<void>;
 saveEdge(edge:EdgeRecord):Promise<void>;
 deleteEdge(id:string):Promise<void>;
 readMetadata(imageId:string):Promise<Properties>;
 saveMetadata(imageId:string,properties:Properties):Promise<void>;
 openCompanion(imageId:string):Promise<void>;
 openImage(imageId:string):Promise<void>;
 extractRegion(regionId:string):Promise<void>;
 exportCanvas(frame:ViewFrame):Promise<TFile>;
 exportVisual(frame:ViewFrame,source?:HTMLCanvasElement):Promise<TFile>;
 seedDemo():Promise<void>;
}
export function newId(prefix:string):string{return `${prefix}-${crypto.randomUUID()}`;}
