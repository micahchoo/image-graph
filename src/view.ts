import {ItemView, Menu, Modal, Notice, WorkspaceLeaf} from 'obsidian';
import type {Camera, Direction, EdgeRecord, Endpoint, GraphHost, GraphSnapshot, ImageRecord, Point, Properties, Rect, RegionRecord, RegionShape, ViewFrame} from './types';
import {newId} from './types';
import {containsRegion, edgeEndpoints, forceLayout, neighborhood, parseRegionShape, regionHandles, relationOf, resizeRegion, tracePath, type HandleId, type Neighborhood} from './graph';
import {renderPropertyBuilder} from './property-builder';
import {RESERVED_KEYS, propertyMessage} from './properties';
import {NOTHING, imageSelection, keepImages, prune, selectTarget, selectedImages, type Selection} from './selection';
import {SpatialIndex} from './spatial';
import {SHORTCUTS, commandFor, swallows, type Command} from './shortcuts';
import {detailSize} from './thumbnails';
import {detached} from './dom';

export const VIEW_TYPE='image-graph-view';
type Hit={endpoint:Endpoint}|{edge:EdgeRecord};
type Mode='select'|'rect'|'polygon'|'connect'|'move';
/** Work the owner began and has not committed. One field, so cancelling is one assignment. */
type Draft={kind:'polygon';imageId:string;points:Point[]}|{kind:'connect';source:Endpoint}|{kind:'region';imageId:string;start:Point;last:Point}
 |{kind:'resize';regionId:string;imageId:string;handle:HandleId;origin:RegionShape;shape:RegionShape};
interface Exploration {root:string;depth:number;filter:string;expanded:Set<string>;pinned:Set<string>;graph:Neighborhood;positions:Map<string,Rect>;savedCamera:Camera}
interface TileLayer {canvas:HTMLCanvasElement;doc:Document;camera:Camera;width:number;height:number;ratio:number;positions:Map<string,Rect>;version:number;card:string;bg:string}
interface Drag {pointer:number;kind:'waiting'|'pan'|'image'|'region'|'marquee'|'handle';start:Point;screen:Point;origin:Camera;hit:Hit|null;imageId?:string;origins?:Map<string,Rect>;marquee?:{base:ReadonlySet<string>;last:Point};forcePan:boolean;forceMove:boolean}
const clamp=(v:number,min:number,max:number)=>Math.max(min,Math.min(max,v));
const copy=(r:Rect):Rect=>({x:r.x,y:r.y,width:r.width,height:r.height});
const relation=(e:EdgeRecord)=>relationOf(e.properties)??'related to';
const distance=(p:Point,a:Point,b:Point)=>{const dx=b.x-a.x,dy=b.y-a.y,t=clamp(((p.x-a.x)*dx+(p.y-a.y)*dy)/(dx*dx+dy*dy||1),0,1);return Math.hypot(p.x-a.x-t*dx,p.y-a.y-t*dy);};

export class ImageGraphView extends ItemView {
 private canvas!:HTMLCanvasElement;
 private inspector!:HTMLElement;
 private status!:HTMLElement;
 private pathText!:HTMLElement;
 private explorationControls!:HTMLElement;
 private depthSelect!:HTMLSelectElement;
 private relationSelect!:HTMLSelectElement;
 private drawingControls!:HTMLElement;
 private finishButton!:HTMLButtonElement;
 private propertyBuilders:Array<{dispose():void}>=[];
 private snapshot:GraphSnapshot={images:[],regions:[],edges:[]};
 private images=new Map<string,ImageRecord>();
 private regions=new Map<string,RegionRecord>();
 private regionsByImage=new Map<string,RegionRecord[]>();
 private wholePositions=new Map<string,Rect>();
 private wholeIds:readonly string[]=[];
 private index:{ids:readonly string[];positions:Map<string,Rect>;version:number;value:SpatialIndex}|null=null;
 // Bumped where a position map is changed in place rather than replaced.
 private indexVersion=0;
 private camera:Camera={x:0,y:0,scale:1};
 private exploration:Exploration|null=null;
 private selection:Selection=NOTHING;
 private selectionImages:ReadonlySet<string>=selectedImages(NOTHING);
 private draft:Draft|null=null;
 private mode:Mode='select';
 private drag:Drag|null=null;
 // What the pointer is over, and where it last was. A pointer can report far more moves
 // than there are frames, so the hit test runs once per frame instead of once per move.
 // It is frozen while a gesture runs, so a target cannot flicker out from under a moving
 // pointer — Penpot holds hover-ids still during :move likewise.
 private hover:Hit|null=null;
 // Held in client coordinates, so panning under a still pointer resolves a new target.
 private hoverPoint:{clientX:number;clientY:number}|null=null;
 private hoverRead:{clientX:number;clientY:number;camera:Camera;mode:Mode}|null=null;
 private pointers=new Map<number,Point>();
 private pinch:{distance:number;center:Point}|null=null;
 private space=false;
 private longPress:number|undefined;
 private zoomTimer:number|undefined;
 private zoomCursor:'zoom-in'|'zoom-out'|null=null;
 private raf=0;
 private active=false;
 private initialized=false;
 private observer:ResizeObserver|null=null;
 private metadataTicket=0;
 private unsubscribe:(()=>void)|null=null;
 private stats={visible:0,drawMs:0,frameMs:0};
 private lastDraw=0;
 private layer:TileLayer|null=null;
 private layerVersion=0;
 // A thumbnail arriving changes what the cached layer should show; a redraw alone would keep the old one.
 private redraw=()=>{this.layerVersion++;this.schedule();};
 constructor(leaf:WorkspaceLeaf,private readonly host:GraphHost){super(leaf);}
 getViewType(){return VIEW_TYPE;}
 getDisplayText(){return 'Image graph';}
 getIcon(){return 'images';}
 get positions(){return this.exploration?.positions??this.wholePositions;}
 // Every reader of the old three fields asks one of these. Only setSelection writes.
 private get selected(){return this.selectionImages;}
 private get selectedRegion(){return this.selection.kind==='region'?this.selection.regionId:null;}
 private get selectedEdge(){return this.selection.kind==='edge'?this.selection.id:null;}
 private get polygon(){return this.draft?.kind==='polygon'?this.draft:null;}
 private get pending(){return this.draft?.kind==='connect'?this.draft.source:null;}
 // The set is cached because the draw loop asks it once per image.
 private setSelection(next:Selection){this.selection=next;this.selectionImages=selectedImages(next);}
 private pruneSelection(keepsImage:(imageId:string)=>boolean){this.setSelection(prune(this.selection,{image:keepsImage,region:id=>this.regions.has(id),edge:id=>this.snapshot.edges.some(e=>e.id===id)}));}
 private get win(){return this.containerEl.ownerDocument.defaultView??window;}
 private run(action:()=>Promise<unknown>){void action().catch((error:unknown)=>new Notice(`Image Graph: ${error instanceof Error?error.message:String(error)}`,8000));}

 async onOpen():Promise<void>{
  this.active=true;this.contentEl.empty();this.contentEl.addClass('image-graph-view');
  const root=this.contentEl.createDiv({cls:'image-graph-root'}),bar=root.createDiv({cls:'image-graph-toolbar'});
  const button=(text:string,action:()=>void)=>{const b=bar.createEl('button',{text});this.registerDomEvent(b,'click',action);return b;};
  button('Whole vault',()=>{if(this.exploration)this.exitExploration();else this.fit();});
  button('Explore',()=>this.exploreSelection());
  button('Navigate',()=>this.setMode('select'));
  button('Move images',()=>this.setMode('move'));
  const actions=button('Actions',()=>{const r=actions.getBoundingClientRect();this.menu({clientX:r.left,clientY:r.bottom},this.selectionHit());});
  button('Properties',()=>this.openInspector());
  const exports=button('Export',()=>{const r=exports.getBoundingClientRect(),menu=new Menu();this.exportMenu(menu);menu.showAtPosition({x:r.left,y:r.bottom});});
  button('Example connections',()=>this.run(()=>this.host.seedDemo()));
  this.explorationControls=root.createDiv({cls:'image-graph-exploration is-hidden'});
  this.explorationControls.createSpan({text:'Connection depth '});this.depthSelect=this.explorationControls.createEl('select',{attr:{'aria-label':'Connection depth'}});for(const n of [1,2,3])this.depthSelect.createEl('option',{attr:{value:String(n)},text:`${n} hop${n===1?'':'s'}`});
  this.registerDomEvent(this.depthSelect,'change',()=>this.setDepth(Number(this.depthSelect.value)));
  this.relationSelect=this.explorationControls.createEl('select',{attr:{'aria-label':'Relation filter'}});this.registerDomEvent(this.relationSelect,'change',()=>this.setRelationFilter(this.relationSelect.value));
  const fit=this.explorationControls.createEl('button',{text:'Fit connections'});this.registerDomEvent(fit,'click',()=>this.fit());
  const focus=this.explorationControls.createEl('button',{text:'Focus selected'});this.registerDomEvent(focus,'click',()=>{const id=[...this.selected][0];if(id)this.focusImage(id);});
  this.drawingControls=root.createDiv({cls:'image-graph-drawing-controls is-hidden'});this.drawingControls.createSpan({text:'Click polygon corners. Click the first corner or Finish to close.'});
  this.finishButton=this.drawingControls.createEl('button',{text:'Finish polygon'});this.registerDomEvent(this.finishButton,'click',()=>this.finishPolygon());
  const undo=this.drawingControls.createEl('button',{text:'Undo point'});this.registerDomEvent(undo,'click',()=>{this.polygon?.points.pop();this.canvas.focus();this.schedule();});
  const cancel=this.drawingControls.createEl('button',{text:'Cancel'});this.registerDomEvent(cancel,'click',()=>this.setMode('select'));
  const body=root.createDiv({cls:'image-graph-body'}),stage=body.createDiv({cls:'image-graph-stage'});
  this.canvas=stage.createEl('canvas',{cls:'image-graph-canvas',attr:{tabindex:'0','aria-label':'Image graph. Scroll to pan, ctrl and scroll to zoom. R draws a rectangle. C connects. E explores. Question mark lists every shortcut.'}});
  this.status=body.createDiv({cls:'image-graph-status',attr:{role:'status'}});this.pathText=body.createDiv({cls:'image-graph-path is-hidden'});
  this.inspector=body.createDiv({cls:'image-graph-inspector is-hidden'});
  this.registerDomEvent(this.canvas,'pointerdown',event=>this.pointerDown(event));
  this.registerDomEvent(this.canvas,'pointermove',event=>this.pointerMove(event));
  this.registerDomEvent(this.canvas,'pointerup',event=>this.pointerUp(event));
  this.registerDomEvent(this.canvas,'pointercancel',()=>this.cancel());
  this.registerDomEvent(this.canvas,'pointerleave',()=>{this.hoverPoint=null;this.hoverRead=null;this.hover=null;this.grip=null;this.schedule();});
  this.registerDomEvent(this.canvas,'contextmenu',event=>{event.preventDefault();this.clearLongPress();this.drag=null;const hit=this.hit(this.world(event));if(hit)this.select(hit,false);this.menu(event,hit,event);});
  this.registerDomEvent(this.canvas,'dblclick',event=>{if(this.mode==='polygon'){event.preventDefault();this.finishPolygon();}});
  this.registerDomEvent(this.canvas,'wheel',event=>this.wheel(event),{passive:false});
  this.registerDomEvent(this.canvas,'keydown',event=>this.keydown(event));this.registerDomEvent(this.canvas,'keyup',event=>{if(event.code==='Space')this.space=false;});
  this.registerDomEvent(this.win,'blur',()=>this.cancel());
  this.observer=new ResizeObserver(()=>{const ratio=this.win.devicePixelRatio||1;this.canvas.width=Math.max(1,Math.round(this.canvas.clientWidth*ratio));this.canvas.height=Math.max(1,Math.round(this.canvas.clientHeight*ratio));if(!this.initialized&&this.images.size){this.initialized=true;this.fit();}this.schedule();});this.observer.observe(stage);
  // A theme change alters every colour the canvas reads, and nothing else redraws it.
  this.registerEvent(this.app.workspace.on('css-change',()=>{this.layerVersion++;this.schedule();}));
  this.unsubscribe=this.host.subscribe(()=>this.refresh());this.refresh();
 }
 async onClose():Promise<void>{this.active=false;this.metadataTicket++;this.clearLongPress();this.win.clearTimeout(this.zoomTimer);for(const builder of this.propertyBuilders)builder.dispose();this.propertyBuilders=[];this.unsubscribe?.();this.unsubscribe=null;this.observer?.disconnect();this.observer=null;this.win.cancelAnimationFrame(this.raf);this.raf=0;this.pointers.clear();this.releaseLayer();}
 private refresh(){
  if(!this.active)return;this.snapshot=this.host.getSnapshot();this.images=new Map(this.snapshot.images.map(i=>[i.id,i]));this.regions=new Map(this.snapshot.regions.map(r=>[r.id,r]));this.regionsByImage.clear();
  for(const r of this.snapshot.regions){const list=this.regionsByImage.get(r.imageId)??[];list.push(r);this.regionsByImage.set(r.imageId,list);}
  this.wholePositions=new Map(this.snapshot.images.map(i=>[i.id,copy(i)]));this.wholeIds=this.snapshot.images.map(i=>i.id);
  this.pruneSelection(id=>this.images.has(id));this.hoverRead=null;
  if(this.draft?.kind==='resize'&&!this.regions.has(this.draft.regionId))this.draft=null;
  const value=this.exploration?.filter??'';this.relationSelect.empty();this.relationSelect.createEl('option',{attr:{value:''},text:'All relations'});for(const label of [...new Set(this.snapshot.edges.map(relation))].filter(Boolean).sort())this.relationSelect.createEl('option',{attr:{value:label},text:label});this.relationSelect.value=value;
  if(this.exploration)this.rebuild(false);this.schedule();
 }
 private shownIds():readonly string[]{return this.exploration?.graph.ids??this.wholeIds;}
 /** The grid over the shown rectangles. Rebuilt when the layout changes, not per frame. */
 private spatial():SpatialIndex{
  const ids=this.shownIds(),positions=this.positions,current=this.index;
  if(current&&current.ids===ids&&current.positions===positions&&current.version===this.indexVersion)return current.value;
  const value=new SpatialIndex(ids,positions);this.index={ids,positions,version:this.indexVersion,value};return value;
 }
 /** What the viewport covers in world coordinates. */
 private viewRect(w:number,h:number,camera:Camera=this.camera):Rect{return{x:-camera.x/camera.scale,y:-camera.y/camera.scale,width:w/camera.scale,height:h/camera.scale};}
 private shownEdges(){return this.exploration?.graph.edges??this.snapshot.edges;}
 private schedule(){if(!this.active||this.raf)return;this.raf=this.win.requestAnimationFrame(()=>{this.raf=0;this.draw();});}
 private draw(){
  const ctx=this.canvas.getContext('2d');if(!ctx)return;this.readHover();const start=performance.now(),w=this.canvas.clientWidth,h=this.canvas.clientHeight,ratio=this.win.devicePixelRatio||1;
  const css=this.win.getComputedStyle(this.contentEl),bg=css.getPropertyValue('--background-primary').trim()||'#181b20',card=css.getPropertyValue('--background-secondary').trim()||'#333840',fg=css.getPropertyValue('--text-normal').trim()||'#ddd',accent=css.getPropertyValue('--interactive-accent').trim()||'#7bbda8';
  ctx.setTransform(ratio,0,0,ratio,0,0);ctx.fillStyle=bg;ctx.fillRect(0,0,w,h);const s=this.camera.scale;let visible=0;
  // Limit demand as well as cache size: otherwise a dense viewport can repeatedly
  // evict and re-request its own thumbnails on every completion redraw.
  const detailed:string[]=[],shown=this.spatial().query(this.viewRect(w,h));visible=shown.length;
  for(const id of shown){const r=this.positions.get(id);if(r&&r.width*s>=32)detailed.push(id);}
  const center={x:(w/2-this.camera.x)/s,y:(h/2-this.camera.y)/s};
  if(detailed.length>120)detailed.sort((a,b)=>{const ar=this.positions.get(a)!,br=this.positions.get(b)!;return Math.hypot(ar.x+ar.width/2-center.x,ar.y+ar.height/2-center.y)-Math.hypot(br.x+br.width/2-center.x,br.y+br.height/2-center.y);});
  const thumbnailIds=new Set<string>();let detailBytes=0;
  for(const id of detailed){const r=this.positions.get(id)!,size=detailSize(Math.max(r.width,r.height)*s*ratio);if(detailBytes+size*size*4>64*1024*1024||thumbnailIds.size>=120)continue;thumbnailIds.add(id);detailBytes+=size*size*4;}
  // Below the detail threshold every image is one atlas tile, so a bitmap of the viewport
  // and its margin stands in for tens of thousands of draw calls while the camera pans.
  const layer=!detailed.length&&!this.zoomCursor&&!this.pinch&&this.drag?.kind!=='image'?this.tileLayer(w,h,ratio,card,bg):null;
  // Blit in device pixels: a fractional offset would resample the whole mosaic and soften it.
  if(layer){ctx.setTransform(1,0,0,1,0,0);ctx.drawImage(layer.canvas,Math.round((this.camera.x-layer.camera.x)*ratio),Math.round((this.camera.y-layer.camera.y)*ratio));ctx.setTransform(ratio,0,0,ratio,0,0);}
  ctx.save();ctx.translate(this.camera.x,this.camera.y);ctx.scale(this.camera.scale,this.camera.scale);
  if(this.mode==='move'&&!this.exploration&&40*s>=12){const left=Math.floor(-this.camera.x/s/40)*40,top=Math.floor(-this.camera.y/s/40)*40;ctx.beginPath();let points=0;for(let x=left;x<(w-this.camera.x)/s&&points<20000;x+=40)for(let y=top;y<(h-this.camera.y)/s&&points<20000;y+=40){ctx.moveTo(x+1/s,y);ctx.arc(x,y,1/s,0,Math.PI*2);points++;}ctx.fillStyle=fg;ctx.globalAlpha=.2;ctx.fill();ctx.globalAlpha=1;}
  // Rings stay live so a selection never rebuilds the layer. Labels need 60 screen pixels
  // of image width, which no image reaches while the layer is in use.
  const hovered=this.hover&&'endpoint'in this.hover?this.hover.endpoint:null,hoverEdge=this.hover&&'edge'in this.hover?this.hover.edge.id:null;
  // A group reads as a group: each member keeps a thinner ring and one band holds them all.
  const many=this.selectionImages.size>1;
  const ring=(r:Rect,style:string,width:number)=>{ctx.strokeStyle=style;ctx.lineWidth=width/s;ctx.strokeRect(r.x,r.y,r.width,r.height);};
  const outline=(id:string,r:Rect)=>{
   if(this.selected.has(id))ring(r,'#ffe0a0',many?1.5:2);
   else if(this.exploration?.root===id)ring(r,accent,2);
   else if(id===hovered?.imageId){ctx.globalAlpha=.55;ring(r,accent,1.5);ctx.globalAlpha=1;}
  };
  if(layer){const ringed=new Set(this.selected);if(this.exploration)ringed.add(this.exploration.root);if(hovered)ringed.add(hovered.imageId);
   for(const id of ringed){const r=this.positions.get(id);if(r&&this.visible(r,w,h))outline(id,r);}
  }else for(const id of shown){
   const image=this.images.get(id),r=this.positions.get(id);if(!image||!r)continue;
   ctx.fillStyle=image.missing?'#733c43':card;ctx.fillRect(r.x,r.y,r.width,r.height);
   const thumb=thumbnailIds.has(id)?this.host.thumbnail(image,this.redraw,Math.max(r.width,r.height)*s*ratio):null;
   if(thumb)ctx.drawImage(thumb,r.x,r.y,r.width,r.height);
   else{const tile=this.host.overviewThumbnail(image,this.redraw);if(tile)ctx.drawImage(tile.source,tile.x,tile.y,tile.width,tile.height,r.x,r.y,r.width,r.height);}
   outline(id,r);
   if(r.width*s>60){ctx.font=`${12/s}px sans-serif`;ctx.fillStyle=fg;const label=image.path.split('/').pop()??image.path;ctx.fillText(label+(this.exploration?.pinned.has(id)?' · pinned':''),r.x,r.y+r.height+16/s);}
  }
  if(many){const band=this.bounds(this.selected);if(band){ctx.save();ctx.setLineDash([7/s,5/s]);ring({x:band.x-6/s,y:band.y-6/s,width:band.width+12/s,height:band.height+12/s},'#ffe0a0',1);ctx.restore();}}
  const resizing=this.draft?.kind==='resize'?this.draft:null;
  if(s>.06)for(const id of shown){const r=this.positions.get(id);if(!r)continue;for(const region of this.regionsByImage.get(id)??[]){
   const chosen=region.id===this.selectedRegion,shape=resizing?.regionId===region.id?resizing.shape:region.shape;
   ctx.strokeStyle=chosen?'#ffe0a0':region.id===hovered?.regionId?'#a6f5d2':'#69dfb0';ctx.lineWidth=(chosen?3:1.5)/s;this.shape(ctx,r,shape);ctx.stroke();
   // Grips appear only where they can be gripped: eight of them inside 24 screen pixels is a smear.
   if(chosen&&Math.min(r.width,r.height)*s>48){ctx.fillStyle='#ffe0a0';const size=4/s;
    for(const grip of regionHandles(shape))ctx.fillRect(r.x+grip.x*r.width-size,r.y+grip.y*r.height-size,size*2,size*2);}
  }}
  const steps=this.path(),highlight=new Set(steps.map(step=>step.edge.id)),filter=this.exploration?.filter??'';
  for(const edge of this.shownEdges()){
   const source=this.positions.get(edge.source.imageId),target=this.positions.get(edge.target.imageId);
   if(!source||!target||!this.spans(source,target,w,h))continue;
   const{source:a,target:b}=edgeEndpoints(edge,this.positions,this.regions),bright=edge.id===this.selectedEdge||highlight.has(edge.id),warm=edge.id===hoverEdge;
   const matches=!filter||relation(edge)===filter;
   ctx.globalAlpha=filter&&!matches?.12:highlight.size&&!bright?.22:1;ctx.strokeStyle=ctx.fillStyle=bright||warm?'#ffe0a0':accent;ctx.lineWidth=(bright||filter&&matches?3:warm?2.6:1.4)/s;ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();
   const arrow=(from:Point,to:Point)=>{const angle=Math.atan2(to.y-from.y,to.x-from.x),size=9/s;ctx.beginPath();ctx.moveTo(to.x,to.y);ctx.lineTo(to.x-size*Math.cos(angle-.45),to.y-size*Math.sin(angle-.45));ctx.lineTo(to.x-size*Math.cos(angle+.45),to.y-size*Math.sin(angle+.45));ctx.closePath();ctx.fill();};
   if(s>.06){if(edge.direction==='forward'||edge.direction==='both')arrow(a,b);if(edge.direction==='reverse'||edge.direction==='both')arrow(b,a);const label=relation(edge);ctx.font=`${12/s}px sans-serif`;const x=(a.x+b.x)/2,y=(a.y+b.y)/2;ctx.fillStyle=bg;ctx.fillRect(x-4/s,y-14/s,ctx.measureText(label).width+8/s,20/s);ctx.fillStyle=fg;ctx.fillText(label,x,y);}
  }ctx.globalAlpha=1;
  const drag=this.drag;
  if(drag?.kind==='marquee'&&drag.marquee){const band=this.band(drag.start,drag.marquee.last);ctx.save();ctx.setLineDash([6/s,4/s]);ctx.strokeStyle='#ffe0a0';ctx.lineWidth=1/s;ctx.strokeRect(band.x,band.y,band.width,band.height);ctx.restore();}
  const draft=this.draft;
  if(draft?.kind==='region'){const r=this.positions.get(draft.imageId);if(r){ctx.strokeStyle='#ffe0a0';ctx.lineWidth=2/s;this.shape(ctx,r,this.rectangle(draft.start,draft.last,r));ctx.stroke();}}
  if(draft?.kind==='polygon'){const r=this.positions.get(draft.imageId);if(r){ctx.strokeStyle='#ffe0a0';ctx.lineWidth=2/s;this.shape(ctx,r,{type:'polygon',points:draft.points});ctx.stroke();for(const [index,p]of draft.points.entries()){ctx.beginPath();ctx.arc(r.x+p.x*r.width,r.y+p.y*r.height,(index===0?6:4)/s,0,Math.PI*2);ctx.fillStyle=index===0?'#69dfb0':'#ffe0a0';ctx.fill();}}}
  ctx.restore();this.stats={visible,drawMs:performance.now()-start,frameMs:this.lastDraw?start-this.lastDraw:0};this.lastDraw=start;
  const ex=this.exploration;this.explorationControls.toggleClass('is-hidden',!ex);
  this.drawingControls.toggleClass('is-hidden',this.mode!=='polygon');this.finishButton.disabled=(this.polygon?.points.length??0)<3;
  this.canvas.dataset.mode=this.drag?.kind==='pan'?'panning':this.zoomCursor??this.mode;
  this.canvas.dataset.over=this.drag?'':this.grip?'grip':this.hover?'target':'';
  const progress=this.host.thumbnailProgress();
  this.status.setText(`${ex?`${ex.graph.ids.length} connected / `:''}${this.images.size.toLocaleString()} images · ${visible.toLocaleString()} visible · ${this.mode==='select'?'Drag to pan · shift-drag selects · ? lists the shortcuts':this.mode==='move'?'Drag an image to move · whole-vault positions snap to the 40px grid · Escape to pan':this.mode==='connect'?(this.pending?'Choose target':'Choose source'):`Draw ${this.mode}`} ${ex?.graph.capped?'· Neighborhood limit: 150':''}${filter?` · ${this.shownEdges().filter(e=>relation(e)===filter).length} matching links; context dimmed`:''}${progress.ready<progress.total?` · Overview thumbnails ${progress.ready.toLocaleString()}/${progress.total.toLocaleString()}`:''}`);
  this.pathText.toggleClass('is-hidden',!ex);if(ex){const target=[...this.selected][0];this.pathText.setText(target&&target!==ex.root&&steps.length?`One shortest path · ${steps.length} hops\n`+steps.map(step=>{const e=step.edge,forward=e.source.imageId===step.from,from=forward?e.source:e.target,to=forward?e.target:e.source,arrow=e.direction==='both'?'↔':e.direction==='none'?'—':(e.direction==='forward')===forward?'→':'←';return `${this.describe(from)} ${arrow} ${relation(e)} ${arrow} ${this.describe(to)}`;}).join('\n'):'Starting image anchored · select an image to trace its path. Links can be traversed either way.');}
 }
 /** Atlas tiles for the whole shown set, rendered once into a bitmap that covers the viewport
  * and a margin. Reused until the scale, the data, or the camera leaves that margin. Selection
  * rings and labels stay outside it so a click never rebuilds it. */
 private tileLayer(w:number,h:number,ratio:number,card:string,bg:string):TileLayer|null{
  const margin=Math.round(Math.min(w,h)*.25*ratio)/ratio,width=w+margin*2,height=h+margin*2,doc=this.contentEl.ownerDocument;
  const current=this.layer?.doc===doc?this.layer:this.releaseLayer();
  if(current&&current.ratio===ratio&&current.width===width&&current.height===height&&current.camera.scale===this.camera.scale&&current.positions===this.positions&&current.version===this.layerVersion&&current.card===card&&current.bg===bg){
   const dx=this.camera.x-current.camera.x,dy=this.camera.y-current.camera.y;
   if(dx<=0&&dy<=0&&dx+width>=w&&dy+height>=h)return current;
  }
  const canvas=current?.canvas??detached(doc,'canvas');
  canvas.width=Math.max(1,Math.round(width*ratio));canvas.height=Math.max(1,Math.round(height*ratio));
  const ctx=canvas.getContext('2d');if(!ctx)return null;
  const camera:Camera={scale:this.camera.scale,x:this.camera.x+margin,y:this.camera.y+margin};
  ctx.setTransform(ratio,0,0,ratio,0,0);ctx.fillStyle=bg;ctx.fillRect(0,0,width,height);ctx.translate(camera.x,camera.y);ctx.scale(camera.scale,camera.scale);
  for(const id of this.spatial().query(this.viewRect(width,height,camera))){
   const image=this.images.get(id),r=this.positions.get(id);if(!image||!r)continue;
   ctx.fillStyle=image.missing?'#733c43':card;ctx.fillRect(r.x,r.y,r.width,r.height);
   const tile=this.host.overviewThumbnail(image,this.redraw);
   if(tile)ctx.drawImage(tile.source,tile.x,tile.y,tile.width,tile.height,r.x,r.y,r.width,r.height);
  }
  this.layer={canvas,doc,camera,width,height,ratio,positions:this.positions,version:this.layerVersion,card,bg};
  return this.layer;
 }
 /** Drop the cached bitmap and its backing store. Returns null so a caller can rebuild. */
 private releaseLayer():null{const canvas=this.layer?.canvas;if(canvas){canvas.width=0;canvas.height=0;}this.layer=null;return null;}
 private shape(ctx:CanvasRenderingContext2D,r:Rect,shape:RegionShape){ctx.beginPath();if(shape.type==='rect')ctx.rect(r.x+shape.x*r.width,r.y+shape.y*r.height,shape.width*r.width,shape.height*r.height);else{shape.points.forEach((p,i)=>{if(i)ctx.lineTo(r.x+p.x*r.width,r.y+p.y*r.height);else ctx.moveTo(r.x+p.x*r.width,r.y+p.y*r.height);});if(shape.points.length>2)ctx.closePath();}}
 private visible(r:Rect,w:number,h:number,camera:Camera=this.camera){const x=r.x*camera.scale+camera.x,y=r.y*camera.scale+camera.y;return x<=w&&y<=h&&x+r.width*camera.scale>=0&&y+r.height*camera.scale>=0;}
 /** A connection's endpoints sit inside its two image rectangles, so their union bounds the line.
  * The margin keeps a midpoint label that overhangs the viewport, without drawing every distant edge. */
 private spans(a:Rect,b:Rect,w:number,h:number){
  const s=this.camera.scale,margin=240;
  const left=Math.min(a.x,b.x)*s+this.camera.x,top=Math.min(a.y,b.y)*s+this.camera.y;
  const right=Math.max(a.x+a.width,b.x+b.width)*s+this.camera.x,bottom=Math.max(a.y+a.height,b.y+b.height)*s+this.camera.y;
  return left<=w+margin&&top<=h+margin&&right>=-margin&&bottom>=-margin;
 }
 private world(event:{clientX:number;clientY:number}):Point{const r=this.canvas.getBoundingClientRect();return{x:(event.clientX-r.left-this.camera.x)/this.camera.scale,y:(event.clientY-r.top-this.camera.y)/this.camera.scale};}
 private endpointAt(p:Point):Endpoint|null{
  for(const id of this.spatial().at(p)){
   const r=this.positions.get(id);if(!r)continue;
   const normalized={x:(p.x-r.x)/r.width,y:(p.y-r.y)/r.height};
   for(const region of [...(this.regionsByImage.get(id)??[])].reverse())if(containsRegion(normalized,region.shape))return{imageId:id,regionId:region.id};
   return{imageId:id};
  }
  return null;
 }
 /** Runs on every pointer move now, so each connection is rejected by its bounding box
  * before the endpoints are resolved and the distance is measured. */
 private hit(p:Point):Hit|null{
  const endpoint=this.endpointAt(p);if(endpoint?.regionId)return{endpoint};
  const edges=this.shownEdges(),reach=7/this.camera.scale;
  for(let i=edges.length-1;i>=0;i--){
   const edge=edges[i],source=this.positions.get(edge.source.imageId),target=this.positions.get(edge.target.imageId);
   if(!source||!target)continue;
   if(p.x<Math.min(source.x,target.x)-reach||p.x>Math.max(source.x+source.width,target.x+target.width)+reach)continue;
   if(p.y<Math.min(source.y,target.y)-reach||p.y>Math.max(source.y+source.height,target.y+target.height)+reach)continue;
   const{source:a,target:b}=edgeEndpoints(edge,this.positions,this.regions);
   if(distance(p,a,b)<reach)return{edge};
  }
  return endpoint?{endpoint}:null;
 }
 private select(hit:Hit|null,multiple=false){
  this.metadataTicket++;this.setSelection(selectTarget(this.selection,hit&&'edge'in hit?{edgeId:hit.edge.id}:hit,multiple));
  if(!this.inspector.hasClass('is-hidden'))this.renderInspector();this.schedule();
 }
 private selectionHit():Hit|null{const s=this.selection;
  if(s.kind==='edge'){const edge=this.snapshot.edges.find(e=>e.id===s.id);return edge?{edge}:null;}
  if(s.kind==='region')return{endpoint:{imageId:s.imageId,regionId:s.regionId}};
  const imageId=[...this.selectionImages][0];return imageId?{endpoint:{imageId}}:null;
 }
 private describe(e:Endpoint){return `${this.images.get(e.imageId)?.path.split('/').pop()??'Missing image'}${e.regionId?' / '+(this.regions.get(e.regionId)?.label??'region'):''}`;}
 private path(){const ex=this.exploration,target=[...this.selected][0];return ex&&target?tracePath(ex.root,target,ex.graph):[];}
 private clearLongPress(){this.win.clearTimeout(this.longPress);this.longPress=undefined;}
 /** Read what the pointer rests on. Called from the frame, so it costs once per frame
  * whatever the pointer's report rate, and never while a gesture owns the pointer. */
 private readHover(){
  const at=this.hoverPoint;
  if(!at||(this.drag&&this.drag.kind!=='waiting')||this.pinch){this.grip=null;return;}
  const last=this.hoverRead;
  if(last&&last.clientX===at.clientX&&last.clientY===at.clientY&&last.mode===this.mode
   &&last.camera.x===this.camera.x&&last.camera.y===this.camera.y&&last.camera.scale===this.camera.scale)return;
  this.hoverRead={...at,camera:{...this.camera},mode:this.mode};
  const p=this.world(at);
  this.grip=this.gripAt(p);
  if(this.grip){this.hover=null;return;}
  if(this.mode==='select'){this.hover=this.hit(p);return;}
  const endpoint=this.endpointAt(p);this.hover=endpoint?{endpoint}:null;
 }
 private pointerDown(event:PointerEvent){
  if(event.button!==0&&event.button!==1)return;this.canvas.focus();this.canvas.setPointerCapture(event.pointerId);this.pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});this.clearLongPress();
  if(this.pointers.size>1){const [a,b]=[...this.pointers.values()];this.pinch={distance:Math.hypot(a.x-b.x,a.y-b.y),center:{x:(a.x+b.x)/2,y:(a.y+b.y)/2}};this.drag=null;return;}
  // Read fresh rather than trusting the last frame's hover: a fast pointer can arrive
  // between frames, and a press must land on what is under it now.
  const p=this.world(event),grip=this.gripAt(p),endpoint=this.endpointAt(p),hit=this.mode!=='select'||event.altKey?(endpoint?{endpoint}:null):this.hit(p);
  this.drag={pointer:event.pointerId,kind:'waiting',start:p,screen:{x:event.clientX,y:event.clientY},origin:{...this.camera},hit,forcePan:this.space||event.button===1,forceMove:event.altKey||this.mode==='move'};
  // Shift already means extend, so shift-drag draws the band. Plain drag still pans,
  // because this canvas is a map before it is an editor.
  if(event.shiftKey&&!this.space&&event.button===0&&this.mode==='select')this.drag.marquee={base:this.selectionImages,last:p};
  else if(grip&&!this.space&&event.button===0){this.drag.kind='handle';this.draft={kind:'resize',...grip,shape:grip.origin};}
  if(event.pointerType==='touch')this.longPress=this.win.setTimeout(()=>{if(this.drag?.kind==='waiting'){const target=this.drag.hit;this.drag=null;this.select(target);this.menu(event,target);}},550);
 }
 private pointerMove(event:PointerEvent){
  // Hover comes first: most moves carry no button, and the guard below drops those.
  if(!this.drag||this.drag.kind==='waiting'){this.hoverPoint={clientX:event.clientX,clientY:event.clientY};this.schedule();}
  if(!this.pointers.has(event.pointerId))return;this.pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});
  if(this.pointers.size>1){this.clearLongPress();const [a,b]=[...this.pointers.values()],center={x:(a.x+b.x)/2,y:(a.y+b.y)/2},length=Math.hypot(a.x-b.x,a.y-b.y);if(this.pinch){this.zoomAt(length/(this.pinch.distance||1),this.pinch.center);this.camera.x+=center.x-this.pinch.center.x;this.camera.y+=center.y-this.pinch.center.y;}this.pinch={distance:length,center};this.schedule();return;}
  const p=this.world(event),drag=this.drag;
  if(!drag||drag.pointer!==event.pointerId)return;
  if(drag.kind==='waiting'){
   if(Math.hypot(event.clientX-drag.screen.x,event.clientY-drag.screen.y)<6)return;this.clearLongPress();
   if(drag.marquee)drag.kind='marquee';
   else if(drag.forcePan||!drag.hit||'edge'in drag.hit)drag.kind='pan';
   else if(this.mode==='rect'){drag.kind='region';drag.imageId=drag.hit.endpoint.imageId;this.draft={kind:'region',imageId:drag.imageId,start:drag.start,last:p};this.select(drag.hit);}
   // Dragging while connecting or drawing a polygon pans, so the owner can reach an
   // off-screen target without leaving the tool. It was a tracked gesture that did nothing.
   else if(this.mode==='connect'||this.mode==='polygon')drag.kind='pan';
   else if(drag.forceMove){drag.kind='image';drag.imageId=drag.hit.endpoint.imageId;if(!this.selected.has(drag.imageId))this.select(drag.hit);drag.origins=this.movable(drag.imageId);}
   else drag.kind='pan';
  }
  if(drag.kind==='pan'){this.camera.x=drag.origin.x+event.clientX-drag.screen.x;this.camera.y=drag.origin.y+event.clientY-drag.screen.y;}
  else if(drag.kind==='image'&&drag.origins){const dx=p.x-drag.start.x,dy=p.y-drag.start.y;
   for(const [id,rect] of drag.origins)this.place(id,rect.x+dx,rect.y+dy,rect);this.indexVersion++;}
  else if(drag.kind==='marquee'&&drag.marquee){drag.marquee.last=p;this.setSelection(imageSelection([...drag.marquee.base,...this.spatial().query(this.band(drag.start,p))]));}
  else if(drag.kind==='handle'&&this.draft?.kind==='resize'){const resize=this.draft,r=this.positions.get(resize.imageId);
   if(r)resize.shape=resizeRegion(resize.origin,resize.handle,{x:(p.x-r.x)/r.width,y:(p.y-r.y)/r.height});}
  else if(drag.kind==='region'&&this.draft?.kind==='region')this.draft.last=p;this.schedule();
 }
 private pointerUp(event:PointerEvent){
  this.clearLongPress();this.pointers.delete(event.pointerId);if(this.canvas.hasPointerCapture(event.pointerId))this.canvas.releasePointerCapture(event.pointerId);
  if(this.pinch){if(!this.pointers.size)this.pinch=null;this.drag=null;return;}const drag=this.drag;this.drag=null;if(!drag)return;
  if(drag.kind==='waiting'&&!drag.forcePan){
   if(this.mode==='connect'&&drag.hit&&'endpoint'in drag.hit)this.connect(drag.hit.endpoint);
   else if(this.mode==='polygon'&&drag.hit&&'endpoint'in drag.hit){const imageId=drag.hit.endpoint.imageId,r=this.positions.get(imageId)!;if(!this.draft)this.draft={kind:'polygon',imageId,points:[]};const polygon=this.polygon;if(polygon?.imageId===imageId){const p=this.world(event),point={x:clamp((p.x-r.x)/r.width,0,1),y:clamp((p.y-r.y)/r.height,0,1)},first=polygon.points[0],last=polygon.points.at(-1);if(first&&polygon.points.length>=3&&Math.hypot((point.x-first.x)*r.width,(point.y-first.y)*r.height)*this.camera.scale<10)this.finishPolygon();else if(!last||Math.hypot((point.x-last.x)*r.width,(point.y-last.y)*r.height)*this.camera.scale>3)polygon.points.push(point);this.setSelection(imageSelection([imageId]));}}
   else this.select(drag.hit,event.shiftKey);
  }else if(drag.kind==='image'&&drag.origins){const moved=[...drag.origins.keys()];this.layerVersion++;
   if(!this.exploration)this.run(async()=>{for(const id of moved){const image=this.images.get(id),r=this.positions.get(id);if(image&&r)await this.host.updateImage({...image,...r});}});}
  else if(drag.kind==='marquee'&&!this.inspector.hasClass('is-hidden'))this.renderInspector();
  else if(drag.kind==='handle'&&this.draft?.kind==='resize'){const resize=this.draft;this.draft=null;const region=this.regions.get(resize.regionId);
   if(region&&JSON.stringify(region.shape)!==JSON.stringify(resize.shape))this.run(()=>this.host.saveRegion({...region,shape:resize.shape}));}
  else if(drag.kind==='region'&&this.draft?.kind==='region'){const d=this.draft,r=this.positions.get(d.imageId)!;this.draft=null;const shape=this.rectangle(d.start,d.last,r);if(shape.width*r.width*this.camera.scale>4&&shape.height*r.height*this.camera.scale>4)this.createRegion(d.imageId,shape);}
  this.schedule();
 }
 /** The images a drag on `imageId` carries: the whole selection when it is part of it. */
 private movable(imageId:string):Map<string,Rect>{
  const ids=this.selected.has(imageId)?[...this.selected]:[imageId],origins=new Map<string,Rect>();
  for(const id of ids){const r=this.positions.get(id);if(r&&this.exploration?.root!==id)origins.set(id,copy(r));}
  return origins;
 }
 /** Whole-vault positions snap to the 40px grid; an explored layout is free and stays pinned. */
 private place(id:string,x:number,y:number,size:Rect){
  this.positions.set(id,{...size,x:this.exploration?x:Math.round(x/40)*40,y:this.exploration?y:Math.round(y/40)*40});
  if(this.exploration)this.exploration.pinned.add(id);
 }
 /** The rectangle holding every one of `ids`, or null when none of them is placed. */
 private bounds(ids:Iterable<string>):Rect|null{
  let left=Infinity,top=Infinity,right=-Infinity,bottom=-Infinity;
  for(const id of ids){const r=this.positions.get(id);if(!r)continue;left=Math.min(left,r.x);top=Math.min(top,r.y);right=Math.max(right,r.x+r.width);bottom=Math.max(bottom,r.y+r.height);}
  return Number.isFinite(left)?{x:left,y:top,width:right-left,height:bottom-top}:null;
 }
 /** The grip of the selected region under `p`, if the pointer is close enough to one. */
 private grip:{regionId:string;imageId:string;handle:HandleId;origin:RegionShape}|null=null;
 private gripAt(p:Point){
  const selection=this.selection;if(selection.kind!=='region'||this.mode!=='select')return null;
  const region=this.regions.get(selection.regionId),r=this.positions.get(selection.imageId);if(!region||!r)return null;
  if(Math.min(r.width,r.height)*this.camera.scale<=48)return null;
  const reach=8/this.camera.scale;
  for(const grip of regionHandles(region.shape)){
   if(Math.abs(p.x-(r.x+grip.x*r.width))<=reach&&Math.abs(p.y-(r.y+grip.y*r.height))<=reach)
    return{regionId:region.id,imageId:selection.imageId,handle:grip.id,origin:region.shape};
  }
  return null;
 }
 private band(a:Point,b:Point):Rect{return{x:Math.min(a.x,b.x),y:Math.min(a.y,b.y),width:Math.abs(a.x-b.x),height:Math.abs(a.y-b.y)};}
 private rectangle(a:Point,b:Point,r:Rect):RegionShape&{type:'rect'}{const x1=clamp((a.x-r.x)/r.width,0,1),x2=clamp((b.x-r.x)/r.width,0,1),y1=clamp((a.y-r.y)/r.height,0,1),y2=clamp((b.y-r.y)/r.height,0,1);return{type:'rect',x:Math.min(x1,x2),y:Math.min(y1,y2),width:Math.abs(x2-x1),height:Math.abs(y2-y1)};}
 private createRegion(imageId:string,shape:RegionShape){const region:RegionRecord={id:newId('region'),imageId,label:'Region',shape,properties:{}};this.mode='select';this.draft=null;this.run(async()=>{await this.host.saveRegion(region);this.select({endpoint:{imageId,regionId:region.id}});this.openInspector();});}
 private finishPolygon(){const polygon=this.polygon;if(polygon&&polygon.points.length>=3){const points=polygon.points,area=Math.abs(points.reduce((sum,p,i)=>{const q=points[(i+1)%points.length];return sum+p.x*q.y-q.x*p.y;},0))/2;if(area<.00001){new Notice('Choose polygon corners that enclose an area.');return;}this.createRegion(polygon.imageId,{type:'polygon',points:[...points]});}else new Notice('Select at least three polygon points.');}
 private connect(endpoint:Endpoint){const source=this.pending;if(!source){this.draft={kind:'connect',source:endpoint};this.schedule();return;}if(source.imageId===endpoint.imageId&&source.regionId===endpoint.regionId){new Notice('Choose a different endpoint.');return;}const edge:EdgeRecord={id:newId('edge'),source,target:endpoint,direction:'none',properties:{relation:'related to'}};this.draft=null;this.mode='select';this.run(async()=>{await this.host.saveEdge(edge);this.select({edge});this.openInspector();});}
 private beginConnect(endpoint?:Endpoint){this.cancel();this.mode='connect';this.draft=endpoint?{kind:'connect',source:endpoint}:null;this.schedule();}
 private setMode(mode:Mode){this.cancel();this.mode=mode;this.canvas.focus();this.schedule();}
 private cancel(){this.clearLongPress();this.drag=null;this.draft=null;this.hover=null;this.hoverPoint=null;this.hoverRead=null;this.grip=null;this.mode='select';this.space=false;this.pointers.clear();this.pinch=null;this.schedule();}
 /** Obsidian's own canvas and Penpot agree: the wheel scrolls and ctrl or the command key
  * zooms. Before this, every wheel gesture zoomed, deltaX did nothing, and a trackpad
  * could not pan at all. deltaMode is normalised: Firefox reports lines, not pixels. */
 private wheel(event:WheelEvent){
  event.preventDefault();
  const unit=event.deltaMode===1?16:event.deltaMode===2?this.canvas.clientHeight:1;
  let dx=event.deltaX*unit,dy=event.deltaY*unit;
  if(event.ctrlKey||event.metaKey){
   this.zoomCursor=dy<0?'zoom-in':'zoom-out';this.win.clearTimeout(this.zoomTimer);
   this.zoomTimer=this.win.setTimeout(()=>{this.zoomCursor=null;this.schedule();},180);
   this.zoomAt(Math.exp(-dy*.0015),{x:event.clientX,y:event.clientY});return;
  }
  // A wheel with no horizontal axis pans sideways while shift is held. A trackpad already
  // sends deltaX there, so only the wheel needs the remap.
  if(event.shiftKey&&!dx){dx=dy;dy=0;}
  this.camera.x-=dx;this.camera.y-=dy;this.schedule();
 }
 private zoomAt(factor:number,client:Point){const before=this.world({clientX:client.x,clientY:client.y}),old=this.camera.scale;this.camera.scale=clamp(old*factor,.002,8);this.camera.x+=(old-this.camera.scale)*before.x;this.camera.y+=(old-this.camera.scale)*before.y;this.schedule();}
 private keydown(event:KeyboardEvent){
  if(event.code==='Space'){this.space=true;event.preventDefault();return;}
  const command=commandFor(event);if(!command)return;
  if(swallows(command))event.preventDefault();
  this.obey(command);this.schedule();
 }
 /** Exhaustive on purpose: a command with no branch here fails to compile. */
 private obey(command:Command){
  const imageId=[...this.selected][0];
  switch(command.kind){
   case'cancel':return this.cancel();
   case'mode':return this.setMode(command.mode);
   case'connect':{const hit=this.selectionHit();return this.beginConnect(hit&&'endpoint'in hit?hit.endpoint:undefined);}
   case'explore':return this.exploreSelection();
   case'expand':if(imageId)this.expandImage(imageId);return;
   case'pin':if(imageId)this.pinImage(imageId);return;
   case'properties':return this.openInspector();
   case'home':return this.exploration?this.exitExploration():this.fit();
   case'zoom':return this.zoomPreset(command.to);
   case'finish':if(this.mode==='polygon')this.finishPolygon();return;
   case'delete':if(this.mode==='polygon'){this.polygon?.points.pop();this.schedule();}else this.removeSelected();return;
   case'menu':{const r=this.canvas.getBoundingClientRect();return this.menu({clientX:r.left+40,clientY:r.top+40},this.selectionHit());}
   case'help':return this.showShortcuts();
   case'nudge':return this.nudge(command.dx,command.dy);
  }
 }
 /** Move every selected image by one step, and write the new whole-vault positions. */
 private nudge(dx:number,dy:number){
  const origins=[...this.selected];
  // With nothing selected the arrows walk the camera, which is what a map should do.
  if(!origins.length){this.camera.x-=dx;this.camera.y-=dy;this.schedule();return;}
  for(const id of origins){const r=this.positions.get(id);if(r&&this.exploration?.root!==id)this.place(id,r.x+dx,r.y+dy,r);}
  this.indexVersion++;this.layerVersion++;
  if(!this.exploration)this.run(async()=>{for(const id of origins){const image=this.images.get(id),r=this.positions.get(id);if(image&&r)await this.host.updateImage({...image,...r});}});
  this.schedule();
 }
 private zoomPreset(to:'reset'|'all'|'selection'){
  if(to==='all')return this.fit();
  if(to==='selection'){const band=this.bounds(this.selected);if(!band)return void new Notice('Select an image to zoom to it.');return this.fit(band);}
  const r=this.canvas.getBoundingClientRect();this.zoomAt(1/this.camera.scale,{x:r.left+r.width/2,y:r.top+r.height/2});
 }
 private showShortcuts(){
  const modal=new Modal(this.app);modal.titleEl.setText('Image graph shortcuts');
  modal.contentEl.addClass('image-graph-shortcuts');
  for(const {group,rows} of SHORTCUTS){
   modal.contentEl.createEl('h4',{text:group});
   const table=modal.contentEl.createEl('table').createEl('tbody');
   for(const [keys,what] of rows){const row=table.createEl('tr');row.createEl('td').createEl('kbd',{text:keys});row.createEl('td',{text:what});}
  }
  modal.open();
 }

 private menu(point:{clientX:number;clientY:number},hit:Hit|null,event?:MouseEvent){
  const menu=event?Menu.forEvent(event):new Menu(),item=(label:string,callback:()=>void)=>menu.addItem(i=>i.setTitle(label).onClick(callback));
  if(hit&&'endpoint'in hit){const e=hit.endpoint;item('Explore connections',()=>this.exploreImage(e.imageId));if(this.exploration){item('Expand neighbors',()=>this.expandImage(e.imageId));item(this.exploration.pinned.has(e.imageId)?'Unpin image':'Pin image',()=>this.pinImage(e.imageId));}
   item('Move image',()=>{this.select(hit);this.setMode('move');});item('Connect from here',()=>this.beginConnect(e));item('Properties',()=>this.openInspector());item('Open image',()=>this.run(()=>this.host.openImage(e.imageId)));item('Open companion note',()=>this.run(()=>this.host.openCompanion(e.imageId)));
   if(e.regionId){item('Create image from region',()=>this.run(()=>this.host.extractRegion(e.regionId!)));item('Delete region and its connections',()=>this.run(()=>this.host.deleteRegion(e.regionId!)));}
  }else if(hit){item('Connection properties',()=>this.openInspector());item('Delete connection',()=>this.run(()=>this.host.deleteEdge(hit.edge.id)));}
  item('Pan / select',()=>this.setMode('select'));item('Draw rectangle region',()=>this.setMode('rect'));item('Draw polygon region',()=>this.setMode('polygon'));if(this.mode==='polygon'&&this.polygon)item('Finish polygon',()=>this.finishPolygon());
  menu.addSeparator();this.exportMenu(menu);menu.showAtPosition({x:point.clientX,y:point.clientY});
 }
 private exportMenu(menu:Menu){const action=(label:string,visual:boolean,scope:'current'|'selected'|'whole')=>menu.addItem(i=>i.setTitle(label).onClick(()=>this.run(async()=>{const frame=this.frame(scope);if(!frame.imageIds.length)throw new Error('Select at least one image.');await(visual?this.host.exportVisual(frame,this.canvas):this.host.exportCanvas(frame));})));
  action('Save current graph as editable Canvas',false,'current');action('Save selected images as editable Canvas',false,'selected');action('Save whole vault as editable Canvas',false,'whole');action('Save viewport as visual snapshot',true,'current');}
 private removeSelected(){const s=this.selection;if(s.kind==='edge')this.run(()=>this.host.deleteEdge(s.id));else if(s.kind==='region')this.run(()=>this.host.deleteRegion(s.regionId));else new Notice('Select a region or connection to delete. Images are kept.');}
 private openInspector(){this.inspector.removeClass('is-hidden');this.renderInspector();}
 private renderInspector(){
  const ticket=++this.metadataTicket;for(const builder of this.propertyBuilders)builder.dispose();this.propertyBuilders=[];this.inspector.empty();const head=this.inspector.createDiv({cls:'image-graph-inspector-head'});head.createSpan({text:'Properties'});const close=head.createEl('button',{text:'×',attr:{'aria-label':'Close properties'}});close.onclick=()=>{this.metadataTicket++;this.inspector.addClass('is-hidden');};
  const edge=this.snapshot.edges.find(e=>e.id===this.selectedEdge);if(edge){this.inspector.createEl('p',{text:`${this.describe(edge.source)} → ${this.describe(edge.target)}`});this.inspector.createEl('label',{text:'Arrow direction'});const select=this.inspector.createEl('select');for(const [value,text]of [['none','None'],['forward','Source → target'],['reverse','Source ← target'],['both','Both directions']])select.createEl('option',{attr:{value},text});select.value=edge.direction;this.inspector.createEl('p',{text:'Describe the connection in relation, for example “resembles”. This text appears beside the line.'});this.propertyEditor('Connection details',edge.properties,async props=>{if(!relationOf(props))throw new Error('Describe the connection in relation, as text, for example “resembles”.');await this.host.saveEdge({...edge,direction:select.value as Direction,properties:props});});return;}
  const region=this.selectedRegion?this.regions.get(this.selectedRegion):undefined;if(region){this.inspector.createEl('label',{text:'Region label'});const label=this.inspector.createEl('input');label.value=region.label;const geometry=this.inspector.createEl('details');geometry.createEl('summary',{text:'Region geometry'});const shape=this.geometryEditor(geometry,region.shape);this.propertyEditor('Region properties',region.properties,async props=>{await this.host.saveRegion({...region,label:label.value,shape:shape.getShape(),properties:props});});return;}
  const imageId=[...this.selected][0],image=imageId?this.images.get(imageId):undefined;if(!image){this.inspector.createEl('p',{text:'Select an image, region, or connection.'});return;}this.inspector.createEl('p',{text:image.path});const open=this.inspector.createEl('button',{text:'Open companion note'});open.onclick=()=>this.run(()=>this.host.openCompanion(imageId));
  const loading=this.inspector.createEl('p',{text:'Loading properties…'});this.run(async()=>{const props=await this.host.readMetadata(imageId);if(!this.active||ticket!==this.metadataTicket)return;loading.remove();this.propertyEditor('Image details and tags',props,p=>this.host.saveMetadata(imageId,p));});
 }
 /** Named fields for the one structured value an owner edits by hand, parsed rather than cast. */
 private geometryEditor(parent:HTMLElement,shape:RegionShape):{getShape:()=>RegionShape}{
  const number=(host:HTMLElement,caption:string,value:number)=>{
   const field=host.createEl('label',{cls:'image-graph-property-field'});field.createSpan({text:caption});
   const input=field.createEl('input',{attr:{type:'number',step:'0.001',min:'0',max:'1','aria-label':caption}});input.value=String(value);return input;
  };
  const read=(input:HTMLInputElement)=>input.value.trim()===''?Number.NaN:Number(input.value);
  if(shape.type==='rect'){
   const row=parent.createDiv({cls:'image-graph-property-row'});
   const x=number(row,'x',shape.x),y=number(row,'y',shape.y),width=number(row,'Width',shape.width),height=number(row,'Height',shape.height);
   parent.createEl('p',{cls:'image-graph-property-help',text:'Fractions of the image, measured from its top-left corner.'});
   return {getShape:()=>parseRegionShape({type:'rect',x:read(x),y:read(y),width:read(width),height:read(height)})};
  }
  parent.createEl('p',{cls:'image-graph-property-help',text:'Corners as fractions of the image, in order.'});
  const corners=shape.points.map((point,index)=>{const row=parent.createDiv({cls:'image-graph-property-row'});row.createSpan({text:`Corner ${index+1}`});return{x:number(row,'x',point.x),y:number(row,'y',point.y)};});
  return {getShape:()=>parseRegionShape({type:'polygon',points:corners.map(corner=>({x:read(corner.x),y:read(corner.y)}))})};
 }
 private propertyEditor(label:string,properties:Properties,save:(properties:Properties)=>Promise<void>){
  this.inspector.createEl('h4',{text:label});
  const feedback=this.inspector.createEl('p',{attr:{role:'status','aria-live':'polite'}});
  // Each field reports itself as it is typed. Saving stays the boundary, not the first warning.
  const report=(count:number)=>{feedback.textContent=count?`${count} ${count===1?'property needs':'properties need'} attention.`:'';};
  const builder=renderPropertyBuilder(this.inspector,properties,{reservedKeys:label.startsWith('Image')?[...RESERVED_KEYS]:[],onChange:()=>report(0)});
  this.propertyBuilders.push(builder);
  this.inspector.insertBefore(feedback,this.inspector.lastElementChild);
  const button=this.inspector.createEl('button',{text:'Save properties'});
  const recheck=()=>report(builder.check());
  this.registerDomEvent(this.inspector,'input',recheck);this.registerDomEvent(this.inspector,'change',recheck);
  button.onclick=()=>{this.run(async()=>{
   feedback.textContent='';button.disabled=true;
   try{await save(builder.getValue());feedback.textContent='Properties saved.';new Notice('Properties saved.');this.schedule();}
   catch(error){const message=propertyMessage(error);feedback.textContent=message||'Unable to save properties. Try again.';builder.check();}
   finally{button.disabled=false;}
  });};
 }

 focusImage(imageId:string){const r=this.positions.get(imageId)??this.images.get(imageId);if(!r)return;this.setSelection(imageSelection([imageId]));const scale=Math.min(1.8,(this.canvas.clientWidth-80)/r.width,(this.canvas.clientHeight-100)/r.height);this.camera={scale:Math.max(.01,scale),x:this.canvas.clientWidth/2-(r.x+r.width/2)*scale,y:this.canvas.clientHeight/2-(r.y+r.height/2)*scale};this.schedule();}
 revealExtracted(imageId:string,parentImageId:string){this.refresh();if(this.exploration){this.exploration.expanded.add(parentImageId);this.rebuild(false);}this.focusImage(imageId);}
 private exploreSelection(){const id=[...this.selected][0];if(id)this.exploreImage(id);else new Notice('Select an image, or create example connections.');}
 exploreImage(imageId:string){if(!this.images.has(imageId))return;this.cancel();const savedCamera=this.exploration?.savedCamera??{...this.camera};this.exploration={root:imageId,depth:1,filter:'',expanded:new Set(),pinned:new Set(),graph:neighborhood(this.snapshot,imageId,1,new Set(),'',150),positions:new Map(),savedCamera};this.setSelection(imageSelection([imageId]));this.depthSelect.value='1';this.relationSelect.value='';this.rebuild(true);}
 setDepth(depth:number){if(!this.exploration)return;this.exploration.depth=clamp(Math.floor(depth),1,3);this.depthSelect.value=String(this.exploration.depth);this.exploration.expanded.clear();this.rebuild(true);}
 setRelationFilter(value:string){if(!this.exploration)return;this.exploration.filter=value;this.relationSelect.value=value;this.schedule();}
 expandImage(imageId:string){if(!this.exploration){this.exploreImage(imageId);return;}this.exploration.expanded.add(imageId);this.rebuild(true);}
 pinImage(imageId:string){const ex=this.exploration;if(!ex||imageId===ex.root)return;if(ex.pinned.has(imageId))ex.pinned.delete(imageId);else ex.pinned.add(imageId);this.schedule();}
 private rebuild(refit:boolean){const ex=this.exploration;if(!ex)return;ex.graph=neighborhood(this.snapshot,ex.root,ex.depth,ex.expanded,'',150);ex.positions=forceLayout(this.snapshot.images,ex.graph,ex.root,ex.pinned,ex.positions);this.indexVersion++;this.pruneSelection(id=>ex.positions.has(id));if(refit)this.fit();this.schedule();}
 exitExploration(){const ex=this.exploration;if(!ex)return;this.camera={...ex.savedCamera};this.exploration=null;this.setSelection(keepImages(this.selection));this.cancel();this.schedule();}
 private fit(box:Rect|null=this.bounds(this.positions.keys())){
  if(!box)return;
  const w=this.canvas.clientWidth||800,h=this.canvas.clientHeight||600;
  const scale=clamp(Math.min((w-80)/(box.width+100),(h-150)/(box.height+100)),.002,2);
  this.camera={scale,x:w/2-(box.x+box.width/2)*scale,y:(h-35)/2-(box.y+box.height/2)*scale};this.schedule();
 }
 frame(scope:'current'|'selected'|'whole'='current'):ViewFrame{const imageIds=scope==='whole'?this.snapshot.images.map(i=>i.id):scope==='selected'?[...this.selected]:[...this.shownIds()],ids=new Set(imageIds),positions:Record<string,Rect>={};for(const imageId of imageIds){const r=scope==='whole'?this.wholePositions.get(imageId):this.positions.get(imageId);if(r)positions[imageId]=copy(r);}const edgeIds=(scope==='whole'?this.snapshot.edges:this.shownEdges()).filter(e=>ids.has(e.source.imageId)&&ids.has(e.target.imageId)).map(e=>e.id);return{imageIds,edgeIds,positions,camera:{...this.camera},width:this.canvas.clientWidth,height:this.canvas.clientHeight};}
 debugState(){return{camera:{...this.camera},selection:this.selection.kind,selected:[...this.selected],selectedRegion:this.selectedRegion,selectedEdge:this.selectedEdge,mode:this.mode,draft:this.draft?.kind??null,pending:this.pending,imageCount:this.images.size,stats:{...this.stats},exploration:this.exploration?{rootId:this.exploration.root,depth:this.exploration.depth,ids:this.exploration.graph.ids,pinned:[...this.exploration.pinned],capped:this.exploration.graph.capped}:null,frame:this.frame()};}
}
