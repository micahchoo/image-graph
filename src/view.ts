import {ItemView, Menu, Notice, WorkspaceLeaf} from 'obsidian';
import type {Camera, Direction, EdgeRecord, Endpoint, GraphHost, GraphSnapshot, ImageRecord, Point, Properties, Rect, RegionRecord, RegionShape, ViewFrame} from './types';
import {newId} from './types';
import {containsRegion, edgeEndpoints, forceLayout, neighborhood, tracePath, type Neighborhood} from './graph';
import {renderPropertyBuilder} from './property-builder';
import {detailSize} from './thumbnails';
import {detached} from './dom';

export const VIEW_TYPE='image-graph-view';
type Hit={endpoint:Endpoint}|{edge:EdgeRecord};
type Mode='select'|'rect'|'polygon'|'connect'|'move';
interface Exploration {root:string;depth:number;filter:string;expanded:Set<string>;pinned:Set<string>;graph:Neighborhood;positions:Map<string,Rect>;savedCamera:Camera}
interface TileLayer {canvas:HTMLCanvasElement;camera:Camera;width:number;height:number;ratio:number;positions:Map<string,Rect>;version:number}
interface Drag {pointer:number;kind:'waiting'|'pan'|'image'|'region'|'ignore';start:Point;last:Point;screen:Point;origin:Camera;hit:Hit|null;imageId?:string;rect?:Rect;forcePan:boolean;forceMove:boolean}
const clamp=(v:number,min:number,max:number)=>Math.max(min,Math.min(max,v));
const copy=(r:Rect):Rect=>({x:r.x,y:r.y,width:r.width,height:r.height});
const relation=(e:EdgeRecord)=>typeof e.properties.relation==='string'?e.properties.relation:'related to';
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
 private camera:Camera={x:0,y:0,scale:1};
 private exploration:Exploration|null=null;
 private selected=new Set<string>();
 private selectedRegion:string|null=null;
 private selectedEdge:string|null=null;
 private pending:Endpoint|null=null;
 private mode:Mode='select';
 private polygon:{imageId:string;points:Point[]}|null=null;
 private drag:Drag|null=null;
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
  this.canvas=stage.createEl('canvas',{cls:'image-graph-canvas',attr:{tabindex:'0','aria-label':'Image graph. R draws a rectangle. C connects. E explores. Right click or long press for actions.'}});
  this.status=body.createDiv({cls:'image-graph-status',attr:{role:'status'}});this.pathText=body.createDiv({cls:'image-graph-path is-hidden'});
  this.inspector=body.createDiv({cls:'image-graph-inspector is-hidden'});
  this.registerDomEvent(this.canvas,'pointerdown',event=>this.pointerDown(event));
  this.registerDomEvent(this.canvas,'pointermove',event=>this.pointerMove(event));
  this.registerDomEvent(this.canvas,'pointerup',event=>this.pointerUp(event));
  this.registerDomEvent(this.canvas,'pointercancel',()=>this.cancel());
  this.registerDomEvent(this.canvas,'contextmenu',event=>{event.preventDefault();this.clearLongPress();this.drag=null;const hit=this.hit(this.world(event));if(hit)this.select(hit,false);this.menu(event,hit,event);});
  this.registerDomEvent(this.canvas,'dblclick',event=>{if(this.mode==='polygon'){event.preventDefault();this.finishPolygon();}});
  this.registerDomEvent(this.canvas,'wheel',event=>{event.preventDefault();this.zoomCursor=event.deltaY<0?'zoom-in':'zoom-out';this.win.clearTimeout(this.zoomTimer);this.zoomTimer=this.win.setTimeout(()=>{this.zoomCursor=null;this.schedule();},180);this.zoomAt(Math.exp(-event.deltaY*.0015),{x:event.clientX,y:event.clientY});},{passive:false});
  this.registerDomEvent(this.canvas,'keydown',event=>this.keydown(event));this.registerDomEvent(this.canvas,'keyup',event=>{if(event.code==='Space')this.space=false;});
  this.registerDomEvent(this.win,'blur',()=>this.cancel());
  this.observer=new ResizeObserver(()=>{const ratio=this.win.devicePixelRatio||1;this.canvas.width=Math.max(1,Math.round(this.canvas.clientWidth*ratio));this.canvas.height=Math.max(1,Math.round(this.canvas.clientHeight*ratio));if(!this.initialized&&this.images.size){this.initialized=true;this.fit();}this.schedule();});this.observer.observe(stage);
  this.unsubscribe=this.host.subscribe(()=>this.refresh());this.refresh();
 }
 async onClose():Promise<void>{this.active=false;this.metadataTicket++;this.clearLongPress();this.win.clearTimeout(this.zoomTimer);for(const builder of this.propertyBuilders)builder.dispose();this.propertyBuilders=[];this.unsubscribe?.();this.unsubscribe=null;this.observer?.disconnect();this.observer=null;this.win.cancelAnimationFrame(this.raf);this.raf=0;this.pointers.clear();this.layer=null;}
 private refresh(){
  if(!this.active)return;this.snapshot=this.host.getSnapshot();this.images=new Map(this.snapshot.images.map(i=>[i.id,i]));this.regions=new Map(this.snapshot.regions.map(r=>[r.id,r]));this.regionsByImage.clear();
  for(const r of this.snapshot.regions){const list=this.regionsByImage.get(r.imageId)??[];list.push(r);this.regionsByImage.set(r.imageId,list);}
  this.wholePositions=new Map(this.snapshot.images.map(i=>[i.id,copy(i)]));
  for(const id of this.selected)if(!this.images.has(id))this.selected.delete(id);
  if(this.selectedRegion&&!this.regions.has(this.selectedRegion))this.selectedRegion=null;if(this.selectedEdge&&!this.snapshot.edges.some(e=>e.id===this.selectedEdge))this.selectedEdge=null;
  const value=this.exploration?.filter??'';this.relationSelect.empty();this.relationSelect.createEl('option',{attr:{value:''},text:'All relations'});for(const label of [...new Set(this.snapshot.edges.map(relation))].filter(Boolean).sort())this.relationSelect.createEl('option',{attr:{value:label},text:label});this.relationSelect.value=value;
  if(this.exploration)this.rebuild(false);this.schedule();
 }
 private shownIds(){return this.exploration?.graph.ids??this.snapshot.images.map(i=>i.id);}
 private shownEdges(){return this.exploration?.graph.edges??this.snapshot.edges;}
 private schedule(){if(!this.active||this.raf)return;this.raf=this.win.requestAnimationFrame(()=>{this.raf=0;this.draw();});}
 private draw(){
  const ctx=this.canvas.getContext('2d');if(!ctx)return;const start=performance.now(),w=this.canvas.clientWidth,h=this.canvas.clientHeight,ratio=this.win.devicePixelRatio||1;
  const css=this.win.getComputedStyle(this.contentEl),bg=css.getPropertyValue('--background-primary').trim()||'#181b20',card=css.getPropertyValue('--background-secondary').trim()||'#333840',fg=css.getPropertyValue('--text-normal').trim()||'#ddd',accent=css.getPropertyValue('--interactive-accent').trim()||'#7bbda8';
  ctx.setTransform(ratio,0,0,ratio,0,0);ctx.fillStyle=bg;ctx.fillRect(0,0,w,h);const s=this.camera.scale;let visible=0;
  // Limit demand as well as cache size: otherwise a dense viewport can repeatedly
  // evict and re-request its own thumbnails on every completion redraw.
  const detailed:string[]=[];
  for(const id of this.shownIds()){const r=this.positions.get(id);if(!r||!this.visible(r,w,h))continue;visible++;if(r.width*s>=32)detailed.push(id);}
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
  if(layer){const ringed=new Set(this.selected);if(this.exploration)ringed.add(this.exploration.root);
   for(const id of ringed){const r=this.positions.get(id);if(!r||!this.visible(r,w,h))continue;ctx.strokeStyle=this.selected.has(id)?'#ffe0a0':accent;ctx.lineWidth=2/s;ctx.strokeRect(r.x,r.y,r.width,r.height);}
  }else for(const id of this.shownIds()){
   const image=this.images.get(id),r=this.positions.get(id);if(!image||!r||!this.visible(r,w,h))continue;
   ctx.fillStyle=image.missing?'#733c43':card;ctx.fillRect(r.x,r.y,r.width,r.height);
   const thumb=thumbnailIds.has(id)?this.host.thumbnail(image,this.redraw,Math.max(r.width,r.height)*s*ratio):null;
   if(thumb)ctx.drawImage(thumb,r.x,r.y,r.width,r.height);
   else{const tile=this.host.overviewThumbnail(image,this.redraw);if(tile)ctx.drawImage(tile.source,tile.x,tile.y,tile.width,tile.height,r.x,r.y,r.width,r.height);}
   if(this.selected.has(id)||this.exploration?.root===id){ctx.strokeStyle=this.selected.has(id)?'#ffe0a0':accent;ctx.lineWidth=2/s;ctx.strokeRect(r.x,r.y,r.width,r.height);}
   if(r.width*s>60){ctx.font=`${12/s}px sans-serif`;ctx.fillStyle=fg;const label=image.path.split('/').pop()??image.path;ctx.fillText(label+(this.exploration?.pinned.has(id)?' · pinned':''),r.x,r.y+r.height+16/s);}
  }
  if(s>.06)for(const region of this.snapshot.regions){const r=this.positions.get(region.imageId);if(!r||!this.visible(r,w,h))continue;ctx.strokeStyle=region.id===this.selectedRegion?'#ffe0a0':'#69dfb0';ctx.lineWidth=(region.id===this.selectedRegion?3:1.5)/s;this.shape(ctx,r,region.shape);ctx.stroke();}
  const steps=this.path(),highlight=new Set(steps.map(step=>step.edge.id)),filter=this.exploration?.filter??'';
  for(const edge of this.shownEdges()){
   const source=this.positions.get(edge.source.imageId),target=this.positions.get(edge.target.imageId);
   if(!source||!target||!this.spans(source,target,w,h))continue;
   const{source:a,target:b}=edgeEndpoints(edge,this.positions,this.regions),bright=edge.id===this.selectedEdge||highlight.has(edge.id);
   const matches=!filter||relation(edge)===filter;
   ctx.globalAlpha=filter&&!matches?.12:highlight.size&&!bright?.22:1;ctx.strokeStyle=ctx.fillStyle=bright?'#ffe0a0':accent;ctx.lineWidth=(bright||filter&&matches?3:1.4)/s;ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();
   const arrow=(from:Point,to:Point)=>{const angle=Math.atan2(to.y-from.y,to.x-from.x),size=9/s;ctx.beginPath();ctx.moveTo(to.x,to.y);ctx.lineTo(to.x-size*Math.cos(angle-.45),to.y-size*Math.sin(angle-.45));ctx.lineTo(to.x-size*Math.cos(angle+.45),to.y-size*Math.sin(angle+.45));ctx.closePath();ctx.fill();};
   if(s>.06){if(edge.direction==='forward'||edge.direction==='both')arrow(a,b);if(edge.direction==='reverse'||edge.direction==='both')arrow(b,a);const label=relation(edge);ctx.font=`${12/s}px sans-serif`;const x=(a.x+b.x)/2,y=(a.y+b.y)/2;ctx.fillStyle=bg;ctx.fillRect(x-4/s,y-14/s,ctx.measureText(label).width+8/s,20/s);ctx.fillStyle=fg;ctx.fillText(label,x,y);}
  }ctx.globalAlpha=1;
  if(this.drag?.kind==='region'&&this.drag.imageId){const r=this.positions.get(this.drag.imageId);if(r){const shape=this.rectangle(this.drag.start,this.drag.last,r);ctx.strokeStyle='#ffe0a0';ctx.lineWidth=2/s;this.shape(ctx,r,shape);ctx.stroke();}}
  if(this.polygon){const r=this.positions.get(this.polygon.imageId);if(r){ctx.strokeStyle='#ffe0a0';ctx.lineWidth=2/s;this.shape(ctx,r,{type:'polygon',points:this.polygon.points});ctx.stroke();for(const [index,p]of this.polygon.points.entries()){ctx.beginPath();ctx.arc(r.x+p.x*r.width,r.y+p.y*r.height,(index===0?6:4)/s,0,Math.PI*2);ctx.fillStyle=index===0?'#69dfb0':'#ffe0a0';ctx.fill();}}}
  ctx.restore();this.stats={visible,drawMs:performance.now()-start,frameMs:this.lastDraw?start-this.lastDraw:0};this.lastDraw=start;
  const ex=this.exploration;this.explorationControls.toggleClass('is-hidden',!ex);
  this.drawingControls.toggleClass('is-hidden',this.mode!=='polygon');this.finishButton.disabled=(this.polygon?.points.length??0)<3;
  this.canvas.dataset.mode=this.drag?.kind==='pan'?'panning':this.zoomCursor??this.mode;
  const progress=this.host.thumbnailProgress();
  this.status.setText(`${ex?`${ex.graph.ids.length} connected / `:''}${this.images.size.toLocaleString()} images · ${visible.toLocaleString()} visible · ${this.mode==='select'?'Drag to pan · M moves images · right click / long press for actions':this.mode==='move'?'Drag an image to move · whole-vault positions snap to the 40px grid · Escape to pan':this.mode==='connect'?(this.pending?'Choose target':'Choose source'):`Draw ${this.mode}`} ${ex?.graph.capped?'· Neighborhood limit: 150':''}${filter?` · ${this.shownEdges().filter(e=>relation(e)===filter).length} matching links; context dimmed`:''}${progress.ready<progress.total?` · Overview thumbnails ${progress.ready.toLocaleString()}/${progress.total.toLocaleString()}`:''}`);
  this.pathText.toggleClass('is-hidden',!ex);if(ex){const target=[...this.selected][0];this.pathText.setText(target&&target!==ex.root&&steps.length?`One shortest path · ${steps.length} hops\n`+steps.map(step=>{const e=step.edge,forward=e.source.imageId===step.from,from=forward?e.source:e.target,to=forward?e.target:e.source,arrow=e.direction==='both'?'↔':e.direction==='none'?'—':(e.direction==='forward')===forward?'→':'←';return `${this.describe(from)} ${arrow} ${relation(e)} ${arrow} ${this.describe(to)}`;}).join('\n'):'Starting image anchored · select an image to trace its path. Links can be traversed either way.');}
 }
 /** Atlas tiles for the whole shown set, rendered once into a bitmap that covers the viewport
  * and a margin. Reused until the scale, the data, or the camera leaves that margin. Selection
  * rings and labels stay outside it so a click never rebuilds it. */
 private tileLayer(w:number,h:number,ratio:number,card:string,bg:string):TileLayer|null{
  const margin=Math.round(Math.min(w,h)*.25*ratio)/ratio,width=w+margin*2,height=h+margin*2,current=this.layer;
  if(current&&current.ratio===ratio&&current.width===width&&current.height===height&&current.camera.scale===this.camera.scale&&current.positions===this.positions&&current.version===this.layerVersion){
   const dx=this.camera.x-current.camera.x,dy=this.camera.y-current.camera.y;
   if(dx<=0&&dy<=0&&dx+width>=w&&dy+height>=h)return current;
  }
  const canvas=current?.canvas??detached(this.contentEl.ownerDocument,'canvas');
  canvas.width=Math.max(1,Math.round(width*ratio));canvas.height=Math.max(1,Math.round(height*ratio));
  const ctx=canvas.getContext('2d');if(!ctx)return null;
  const camera:Camera={scale:this.camera.scale,x:this.camera.x+margin,y:this.camera.y+margin};
  ctx.setTransform(ratio,0,0,ratio,0,0);ctx.fillStyle=bg;ctx.fillRect(0,0,width,height);ctx.translate(camera.x,camera.y);ctx.scale(camera.scale,camera.scale);
  for(const id of this.shownIds()){
   const image=this.images.get(id),r=this.positions.get(id);if(!image||!r||!this.visible(r,width,height,camera))continue;
   ctx.fillStyle=image.missing?'#733c43':card;ctx.fillRect(r.x,r.y,r.width,r.height);
   const tile=this.host.overviewThumbnail(image,this.redraw);
   if(tile)ctx.drawImage(tile.source,tile.x,tile.y,tile.width,tile.height,r.x,r.y,r.width,r.height);
  }
  this.layer={canvas,camera,width,height,ratio,positions:this.positions,version:this.layerVersion};
  return this.layer;
 }
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
 private endpointAt(p:Point):Endpoint|null{const ids=this.shownIds();for(let i=ids.length-1;i>=0;i--){const id=ids[i],r=this.positions.get(id);if(!r||p.x<r.x||p.x>r.x+r.width||p.y<r.y||p.y>r.y+r.height)continue;const normalized={x:(p.x-r.x)/r.width,y:(p.y-r.y)/r.height};for(const region of [...(this.regionsByImage.get(id)??[])].reverse())if(containsRegion(normalized,region.shape))return{imageId:id,regionId:region.id};return{imageId:id};}return null;}
 private hit(p:Point):Hit|null{const endpoint=this.endpointAt(p);if(endpoint?.regionId)return{endpoint};for(const edge of [...this.shownEdges()].reverse()){const{source:a,target:b}=edgeEndpoints(edge,this.positions,this.regions);if(distance(p,a,b)*this.camera.scale<7)return{edge};}return endpoint?{endpoint}:null;}
 private select(hit:Hit|null,multiple=false){this.metadataTicket++;this.selectedEdge=null;this.selectedRegion=null;if(hit&&'edge'in hit){this.selectedEdge=hit.edge.id;if(!multiple)this.selected.clear();}else if(hit){const e=hit.endpoint;if(!multiple)this.selected.clear();if(multiple&&this.selected.has(e.imageId))this.selected.delete(e.imageId);else this.selected.add(e.imageId);this.selectedRegion=e.regionId??null;}else if(!multiple)this.selected.clear();if(!this.inspector.hasClass('is-hidden'))this.renderInspector();this.schedule();}
 private selectionHit():Hit|null{const edge=this.snapshot.edges.find(e=>e.id===this.selectedEdge);if(edge)return{edge};const imageId=[...this.selected][0];return imageId?{endpoint:{imageId,...(this.selectedRegion?{regionId:this.selectedRegion}:{})}}:null;}
 private describe(e:Endpoint){return `${this.images.get(e.imageId)?.path.split('/').pop()??'Missing image'}${e.regionId?' / '+(this.regions.get(e.regionId)?.label??'region'):''}`;}
 private path(){const ex=this.exploration,target=[...this.selected][0];return ex&&target?tracePath(ex.root,target,ex.graph):[];}
 private clearLongPress(){this.win.clearTimeout(this.longPress);this.longPress=undefined;}
 private pointerDown(event:PointerEvent){
  if(event.button!==0&&event.button!==1)return;this.canvas.focus();this.canvas.setPointerCapture(event.pointerId);this.pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});this.clearLongPress();
  if(this.pointers.size>1){const [a,b]=[...this.pointers.values()];this.pinch={distance:Math.hypot(a.x-b.x,a.y-b.y),center:{x:(a.x+b.x)/2,y:(a.y+b.y)/2}};this.drag=null;return;}
  const p=this.world(event),endpoint=this.endpointAt(p),hit=this.mode!=='select'||event.altKey?(endpoint?{endpoint}:null):this.hit(p);
  this.drag={pointer:event.pointerId,kind:'waiting',start:p,last:p,screen:{x:event.clientX,y:event.clientY},origin:{...this.camera},hit,forcePan:this.space||event.button===1,forceMove:event.altKey||this.mode==='move'};
  if(event.pointerType==='touch')this.longPress=this.win.setTimeout(()=>{if(this.drag?.kind==='waiting'){const target=this.drag.hit;this.drag=null;this.select(target);this.menu(event,target);}},550);
 }
 private pointerMove(event:PointerEvent){
  if(!this.pointers.has(event.pointerId))return;this.pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});
  if(this.pointers.size>1){this.clearLongPress();const [a,b]=[...this.pointers.values()],center={x:(a.x+b.x)/2,y:(a.y+b.y)/2},length=Math.hypot(a.x-b.x,a.y-b.y);if(this.pinch){this.zoomAt(length/(this.pinch.distance||1),this.pinch.center);this.camera.x+=center.x-this.pinch.center.x;this.camera.y+=center.y-this.pinch.center.y;}this.pinch={distance:length,center};this.schedule();return;}
  const drag=this.drag;if(!drag||drag.pointer!==event.pointerId)return;const p=this.world(event);
  if(drag.kind==='waiting'){
   if(Math.hypot(event.clientX-drag.screen.x,event.clientY-drag.screen.y)<6)return;this.clearLongPress();
   if(drag.forcePan||!drag.hit||'edge'in drag.hit)drag.kind='pan';
   else if(this.mode==='rect'){drag.kind='region';drag.imageId=drag.hit.endpoint.imageId;this.select(drag.hit);}
   else if(this.mode==='connect'||this.mode==='polygon'){drag.kind='ignore';return;}
   else if(drag.forceMove){drag.kind='image';drag.imageId=drag.hit.endpoint.imageId;drag.rect=copy(this.positions.get(drag.imageId)!);this.select(drag.hit);}
   else drag.kind='pan';
  }
  if(drag.kind==='pan'){this.camera.x=drag.origin.x+event.clientX-drag.screen.x;this.camera.y=drag.origin.y+event.clientY-drag.screen.y;}
  else if(drag.kind==='image'&&drag.imageId&&drag.rect&&this.exploration?.root!==drag.imageId){const x=drag.rect.x+p.x-drag.start.x,y=drag.rect.y+p.y-drag.start.y;this.positions.set(drag.imageId,{...drag.rect,x:this.exploration?x:Math.round(x/40)*40,y:this.exploration?y:Math.round(y/40)*40});if(this.exploration)this.exploration.pinned.add(drag.imageId);}
  else if(drag.kind==='region')drag.last=p;this.schedule();
 }
 private pointerUp(event:PointerEvent){
  this.clearLongPress();this.pointers.delete(event.pointerId);if(this.canvas.hasPointerCapture(event.pointerId))this.canvas.releasePointerCapture(event.pointerId);
  if(this.pinch){if(!this.pointers.size)this.pinch=null;this.drag=null;return;}const drag=this.drag;this.drag=null;if(!drag)return;
  if(drag.kind==='waiting'&&!drag.forcePan){
   if(this.mode==='connect'&&drag.hit&&'endpoint'in drag.hit)this.connect(drag.hit.endpoint);
   else if(this.mode==='polygon'&&drag.hit&&'endpoint'in drag.hit){const imageId=drag.hit.endpoint.imageId,r=this.positions.get(imageId)!;if(!this.polygon)this.polygon={imageId,points:[]};if(this.polygon.imageId===imageId){const p=this.world(event),point={x:clamp((p.x-r.x)/r.width,0,1),y:clamp((p.y-r.y)/r.height,0,1)},first=this.polygon.points[0],last=this.polygon.points.at(-1);if(first&&this.polygon.points.length>=3&&Math.hypot((point.x-first.x)*r.width,(point.y-first.y)*r.height)*this.camera.scale<10)this.finishPolygon();else if(!last||Math.hypot((point.x-last.x)*r.width,(point.y-last.y)*r.height)*this.camera.scale>3)this.polygon.points.push(point);this.selected=new Set([imageId]);}}
   else this.select(drag.hit,event.shiftKey);
  }else if(drag.kind==='image'&&drag.imageId){this.layerVersion++;if(!this.exploration){const image=this.images.get(drag.imageId),r=this.positions.get(drag.imageId);if(image&&r)this.run(()=>this.host.updateImage({...image,...r}));}}
  else if(drag.kind==='region'&&drag.imageId){const r=this.positions.get(drag.imageId)!;const shape=this.rectangle(drag.start,drag.last,r);if(shape.width*r.width*this.camera.scale>4&&shape.height*r.height*this.camera.scale>4)this.createRegion(drag.imageId,shape);}
  this.schedule();
 }
 private rectangle(a:Point,b:Point,r:Rect):RegionShape&{type:'rect'}{const x1=clamp((a.x-r.x)/r.width,0,1),x2=clamp((b.x-r.x)/r.width,0,1),y1=clamp((a.y-r.y)/r.height,0,1),y2=clamp((b.y-r.y)/r.height,0,1);return{type:'rect',x:Math.min(x1,x2),y:Math.min(y1,y2),width:Math.abs(x2-x1),height:Math.abs(y2-y1)};}
 private createRegion(imageId:string,shape:RegionShape){const region:RegionRecord={id:newId('region'),imageId,label:'Region',shape,properties:{}};this.mode='select';this.polygon=null;this.run(async()=>{await this.host.saveRegion(region);this.select({endpoint:{imageId,regionId:region.id}});this.openInspector();});}
 private finishPolygon(){if(this.polygon&&this.polygon.points.length>=3){const points=this.polygon.points,area=Math.abs(points.reduce((sum,p,i)=>{const q=points[(i+1)%points.length];return sum+p.x*q.y-q.x*p.y;},0))/2;if(area<.00001){new Notice('Choose polygon corners that enclose an area.');return;}this.createRegion(this.polygon.imageId,{type:'polygon',points:[...points]});}else new Notice('Select at least three polygon points.');}
 private connect(endpoint:Endpoint){if(!this.pending){this.pending=endpoint;this.schedule();return;}if(this.pending.imageId===endpoint.imageId&&this.pending.regionId===endpoint.regionId){new Notice('Choose a different endpoint.');return;}const edge:EdgeRecord={id:newId('edge'),source:this.pending,target:endpoint,direction:'none',properties:{relation:'related to'}};this.pending=null;this.mode='select';this.run(async()=>{await this.host.saveEdge(edge);this.select({edge});this.openInspector();});}
 private beginConnect(endpoint?:Endpoint){this.cancel();this.mode='connect';this.pending=endpoint??null;this.schedule();}
 private setMode(mode:Mode){this.cancel();this.mode=mode;this.canvas.focus();this.schedule();}
 private cancel(){this.clearLongPress();this.drag=null;this.polygon=null;this.pending=null;this.mode='select';this.space=false;this.pointers.clear();this.pinch=null;this.schedule();}
 private zoomAt(factor:number,client:Point){const before=this.world({clientX:client.x,clientY:client.y}),old=this.camera.scale;this.camera.scale=clamp(old*factor,.002,8);this.camera.x+=(old-this.camera.scale)*before.x;this.camera.y+=(old-this.camera.scale)*before.y;this.schedule();}
 private keydown(event:KeyboardEvent){if(event.ctrlKey||event.metaKey||event.altKey)return;const key=event.key.toLowerCase();if(event.code==='Space'){this.space=true;event.preventDefault();}else if(key==='escape'||key==='v')this.cancel();else if(key==='r')this.setMode('rect');else if(key==='g')this.setMode('polygon');else if(key==='m')this.setMode('move');else if(key==='c'){const hit=this.selectionHit();this.beginConnect(hit&&'endpoint'in hit?hit.endpoint:undefined);}else if(key==='e')this.exploreSelection();else if(key==='x'){const imageId=[...this.selected][0];if(imageId)this.expandImage(imageId);}else if(key==='p'){const imageId=[...this.selected][0];if(imageId)this.pinImage(imageId);}else if(key==='i')this.openInspector();else if(key==='0'){if(this.exploration)this.exitExploration();else this.fit();}else if(key==='enter'&&this.mode==='polygon')this.finishPolygon();else if(key==='delete'||key==='backspace'){event.preventDefault();if(this.mode==='polygon'){this.polygon?.points.pop();this.schedule();}else this.removeSelected();}else if(key==='contextmenu'||(event.shiftKey&&key==='f10')){event.preventDefault();const r=this.canvas.getBoundingClientRect();this.menu({clientX:r.left+40,clientY:r.top+40},this.selectionHit());}this.schedule();}

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
 private removeSelected(){if(this.selectedEdge)this.run(()=>this.host.deleteEdge(this.selectedEdge!));else if(this.selectedRegion)this.run(()=>this.host.deleteRegion(this.selectedRegion!));else new Notice('Select a region or connection to delete. Images are kept.');}
 private openInspector(){this.inspector.removeClass('is-hidden');this.renderInspector();}
 private renderInspector(){
  const ticket=++this.metadataTicket;for(const builder of this.propertyBuilders)builder.dispose();this.propertyBuilders=[];this.inspector.empty();const head=this.inspector.createDiv({cls:'image-graph-inspector-head'});head.createSpan({text:'Properties'});const close=head.createEl('button',{text:'×',attr:{'aria-label':'Close properties'}});close.onclick=()=>{this.metadataTicket++;this.inspector.addClass('is-hidden');};
  const edge=this.snapshot.edges.find(e=>e.id===this.selectedEdge);if(edge){this.inspector.createEl('p',{text:`${this.describe(edge.source)} → ${this.describe(edge.target)}`});this.inspector.createEl('label',{text:'Arrow direction'});const select=this.inspector.createEl('select');for(const [value,text]of [['none','None'],['forward','Source → target'],['reverse','Source ← target'],['both','Both directions']])select.createEl('option',{attr:{value},text});select.value=edge.direction;this.inspector.createEl('p',{text:'Describe the connection in relation, for example “resembles”. This text appears beside the line.'});this.propertyEditor('Connection details',edge.properties,async props=>{if(typeof props.relation!=='string'||!props.relation.trim())throw new Error('Add a description to relation and choose the Text format.');await this.host.saveEdge({...edge,direction:select.value as Direction,properties:props});});return;}
  const region=this.selectedRegion?this.regions.get(this.selectedRegion):undefined;if(region){this.inspector.createEl('label',{text:'Region label'});const label=this.inspector.createEl('input');label.value=region.label;const geometry=this.inspector.createEl('details');geometry.createEl('summary',{text:'Region geometry'});const shapeBuilder=renderPropertyBuilder(geometry,{...region.shape});this.propertyBuilders.push(shapeBuilder);this.propertyEditor('Region properties',region.properties,async props=>{await this.host.saveRegion({...region,label:label.value,shape:shapeBuilder.getValue() as unknown as RegionShape,properties:props});});return;}
  const imageId=[...this.selected][0],image=imageId?this.images.get(imageId):undefined;if(!image){this.inspector.createEl('p',{text:'Select an image, region, or connection.'});return;}this.inspector.createEl('p',{text:image.path});const open=this.inspector.createEl('button',{text:'Open companion note'});open.onclick=()=>this.run(()=>this.host.openCompanion(imageId));
  const loading=this.inspector.createEl('p',{text:'Loading properties…'});this.run(async()=>{const props=await this.host.readMetadata(imageId);if(!this.active||ticket!==this.metadataTicket)return;loading.remove();this.propertyEditor('Image details and tags',props,p=>this.host.saveMetadata(imageId,p));});
 }
 private propertyEditor(label:string,properties:Properties,save:(properties:Properties)=>Promise<void>){
  this.inspector.createEl('h4',{text:label});
  const builder=renderPropertyBuilder(this.inspector,properties,{reservedKeys:label.startsWith('Image')?['image','image_graph_id']:[]});
  this.propertyBuilders.push(builder);
  const feedback=this.inspector.createEl('p',{attr:{role:'status','aria-live':'polite'}});
  const button=this.inspector.createEl('button',{text:'Save properties'});
  button.onclick=()=>{this.run(async()=>{
   feedback.textContent='';button.disabled=true;
   try{await save(builder.getValue());feedback.textContent='Properties saved.';new Notice('Properties saved.');this.schedule();}
   catch(error){feedback.textContent=error instanceof Error?error.message:'Unable to save properties. Try again.';}
   finally{button.disabled=false;}
  });};
 }

 focusImage(imageId:string){const r=this.positions.get(imageId)??this.images.get(imageId);if(!r)return;this.selected=new Set([imageId]);this.selectedEdge=null;this.selectedRegion=null;const scale=Math.min(1.8,(this.canvas.clientWidth-80)/r.width,(this.canvas.clientHeight-100)/r.height);this.camera={scale:Math.max(.01,scale),x:this.canvas.clientWidth/2-(r.x+r.width/2)*scale,y:this.canvas.clientHeight/2-(r.y+r.height/2)*scale};this.schedule();}
 revealExtracted(imageId:string,parentImageId:string){this.refresh();if(this.exploration){this.exploration.expanded.add(parentImageId);this.rebuild(false);}this.focusImage(imageId);}
 private exploreSelection(){const id=[...this.selected][0];if(id)this.exploreImage(id);else new Notice('Select an image, or create example connections.');}
 exploreImage(imageId:string){if(!this.images.has(imageId))return;this.cancel();const savedCamera=this.exploration?.savedCamera??{...this.camera};this.exploration={root:imageId,depth:1,filter:'',expanded:new Set(),pinned:new Set(),graph:neighborhood(this.snapshot,imageId,1,new Set(),'',150),positions:new Map(),savedCamera};this.selected=new Set([imageId]);this.selectedRegion=null;this.selectedEdge=null;this.depthSelect.value='1';this.relationSelect.value='';this.rebuild(true);}
 setDepth(depth:number){if(!this.exploration)return;this.exploration.depth=clamp(Math.floor(depth),1,3);this.depthSelect.value=String(this.exploration.depth);this.exploration.expanded.clear();this.rebuild(true);}
 setRelationFilter(value:string){if(!this.exploration)return;this.exploration.filter=value;this.relationSelect.value=value;this.schedule();}
 expandImage(imageId:string){if(!this.exploration){this.exploreImage(imageId);return;}this.exploration.expanded.add(imageId);this.rebuild(true);}
 pinImage(imageId:string){const ex=this.exploration;if(!ex||imageId===ex.root)return;if(ex.pinned.has(imageId))ex.pinned.delete(imageId);else ex.pinned.add(imageId);this.schedule();}
 private rebuild(refit:boolean){const ex=this.exploration;if(!ex)return;ex.graph=neighborhood(this.snapshot,ex.root,ex.depth,ex.expanded,'',150);ex.positions=forceLayout(this.snapshot.images,ex.graph,ex.root,ex.pinned,ex.positions);for(const id of this.selected)if(!ex.positions.has(id))this.selected.delete(id);if(refit)this.fit();this.schedule();}
 exitExploration(){const ex=this.exploration;if(!ex)return;this.camera={...ex.savedCamera};this.exploration=null;this.selectedRegion=null;this.selectedEdge=null;this.cancel();this.schedule();}
 private fit(){let left=Infinity,top=Infinity,right=-Infinity,bottom=-Infinity;for(const r of this.positions.values()){left=Math.min(left,r.x);top=Math.min(top,r.y);right=Math.max(right,r.x+r.width);bottom=Math.max(bottom,r.y+r.height);}if(!Number.isFinite(left))return;const w=this.canvas.clientWidth||800,h=this.canvas.clientHeight||600,scale=clamp(Math.min((w-80)/(right-left+100),(h-150)/(bottom-top+100)),.002,2);this.camera={scale,x:w/2-(left+right)/2*scale,y:(h-35)/2-(top+bottom)/2*scale};this.schedule();}
 frame(scope:'current'|'selected'|'whole'='current'):ViewFrame{const imageIds=scope==='whole'?this.snapshot.images.map(i=>i.id):scope==='selected'?[...this.selected]:this.shownIds(),ids=new Set(imageIds),positions:Record<string,Rect>={};for(const imageId of imageIds){const r=scope==='whole'?this.wholePositions.get(imageId):this.positions.get(imageId);if(r)positions[imageId]=copy(r);}const edgeIds=(scope==='whole'?this.snapshot.edges:this.shownEdges()).filter(e=>ids.has(e.source.imageId)&&ids.has(e.target.imageId)).map(e=>e.id);return{imageIds,edgeIds,positions,camera:{...this.camera},width:this.canvas.clientWidth,height:this.canvas.clientHeight};}
 debugState(){return{camera:{...this.camera},selected:[...this.selected],selectedRegion:this.selectedRegion,selectedEdge:this.selectedEdge,mode:this.mode,pending:this.pending,imageCount:this.images.size,stats:{...this.stats},exploration:this.exploration?{rootId:this.exploration.root,depth:this.exploration.depth,ids:this.exploration.graph.ids,pinned:[...this.exploration.pinned],capped:this.exploration.graph.capped}:null,frame:this.frame()};}
}
