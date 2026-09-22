import {FuzzySuggestModal, ItemView, Menu, Modal, Notice, WorkspaceLeaf, setIcon} from 'obsidian';
import type {App} from 'obsidian';
import type {Camera, Direction, EdgeRecord, Endpoint, GraphHost, GraphSnapshot, ImageRecord, Point, Properties, Rect, RegionRecord, RegionShape, ViewFrame} from './types';
import {newId} from './types';
import {edgeEndpoints} from './edge-endpoints';
import {parseRegionShape, regionHandles, resizeRegion, type HandleId} from './region-shape';
import {relationNames} from './traversal';
import {relationOf, RESERVED_KEYS, propertyMessage} from './properties';
import {isForeignRegion} from './annotations';
import {renderPropertyBuilder} from './property-builder';
import {EXPLORE_LIMIT, Exploration} from './exploration';
import {NOTHING, imageSelection, keepImages, type Selection} from './selection';
import {neighbourInDirection} from './spatial';
import {GraphScene, type Hit} from './scene';
import {CanvasRenderer} from './canvas-renderer';
import {SHORTCUTS, commandFor, swallows, type Command} from './shortcuts';
import {noteBlock} from './blocks';
import {themePalette} from './presentation';
import {MAX_FIT_SCALE, boxAround, fitBox, scrollBy, scrollIntoView, toWorld, viewportRect, wheelGesture, zoomAt as zoomCameraAt} from './camera';
import {rectBetween} from './geometry';
import {type Draft, type Mode, type Pinch, dragBecomes, movedEnough, pinchFrom, pinchStep, pressIntent, regionFromDrag} from './gestures';

export const VIEW_TYPE='image-graph-view';

/** Obsidian's own fuzzy picker, so finding an image uses the keys every other search does. */
class ImagePicker extends FuzzySuggestModal<ImageRecord>{
 constructor(app:App,private images:ImageRecord[],private label:(image:ImageRecord)=>string,private chosen:(image:ImageRecord)=>void){
  super(app);this.setPlaceholder('Find an image by name or folder');
 }
 getItems(){return this.images;}
 getItemText(image:ImageRecord){return this.label(image);}
 onChooseItem(image:ImageRecord){this.chosen(image);}
}

/** The relations the vault uses, with how much each one joins, so the list is worth reading. */
class RelationPicker extends FuzzySuggestModal<string>{
 private counts:Map<string,number>;
 constructor(app:App,private names:string[],snapshot:GraphSnapshot,private chosen:(name:string)=>void){
  super(app);this.setPlaceholder('Explore every connection of one relation');
  this.counts=new Map();
  for(const edge of snapshot.edges){const name=relationOf(edge.properties);if(name)this.counts.set(name,(this.counts.get(name)??0)+1);}
 }
 getItems(){return this.names;}
 getItemText(name:string){const count=this.counts.get(name)??0;return `${name} — ${count} connection${count===1?'':'s'}`;}
 onChooseItem(name:string){this.chosen(name);}
}
/** Work the owner began and has not committed. One field, so cancelling is one assignment. */
interface Drag {pointer:number;kind:'waiting'|'pan'|'image'|'region'|'marquee'|'handle';start:Point;screen:Point;origin:Camera;hit:Hit|null;imageId?:string;origins?:Map<string,Rect>;marquee?:{base:ReadonlySet<string>;last:Point};forcePan:boolean;forceMove:boolean}
const clamp=(v:number,min:number,max:number)=>Math.max(min,Math.min(max,v));
/** World units added to a box before fitting, so captions and rings are not clipped. */
const FIT_MARGIN=100;
/** The zoom and status strip along the bottom, which a fit lifts the picture clear of. */
const FOOTER_BAND=35;
/** Narrower than this and the pane is not laid out yet, whatever the observer says. */
const MIN_VIEWPORT=200;
const copy=(r:Rect):Rect=>({x:r.x,y:r.y,width:r.width,height:r.height});
const relation=(e:EdgeRecord)=>relationOf(e.properties)??'related to';

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
 private undoPointButton!:HTMLButtonElement;
 private drawingText!:HTMLElement;
 private announcer!:HTMLElement;
 private zoomBar!:HTMLElement;
 private zoomLabel!:HTMLButtonElement;
 private vaultButton!:HTMLButtonElement;
 private exploreButton!:HTMLButtonElement;
 private renderedWhere:boolean|null=null;
 // Written only when they change: the status is read every frame and writing it every frame
 // both costs a layout and, as a live region, talked over the gesture.
 private statusText='';
 private renderedZoom='';
 private renderedJob='';
 private jobChip!:HTMLElement;
 private jobText!:HTMLElement;
 private jobStop!:HTMLButtonElement;
 private announced='';
 private propertyBuilders:Array<{dispose():void}>=[];
 /** What is on screen, where it is, and what is under a point. Needs no DOM. */
 private readonly scene:GraphScene;
 /** One frame of canvas. Owns the tile mosaic; reads the scene and the frame's state. */
 private renderer!:CanvasRenderer;
 private camera:Camera={x:0,y:0,scale:1};
 private draft:Draft|null=null;
 private mode:Mode='select';
 // The toolbar says which mode is on. Mode is also assigned outside setMode, so the
 // buttons follow the field from the frame and write to the DOM only when it changes.
 private modeButtons:Array<{button:HTMLButtonElement;mode:Mode}>=[];
 private renderedMode:Mode|null=null;
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
 private pinch:Pinch|null=null;
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
 private unsubscribeJobs:(()=>void)|null=null;
 private stats={visible:0,drawMs:0,frameMs:0};
 private lastDraw=0;
 // A thumbnail arriving changes what the cached mosaic should show; a redraw alone keeps the old one.
 private redraw=()=>{this.renderer?.invalidate();this.schedule();};
 constructor(leaf:WorkspaceLeaf,private readonly host:GraphHost){super(leaf);this.scene=new GraphScene(host);}
 getViewType(){return VIEW_TYPE;}
 getDisplayText(){return 'Image graph';}
 getIcon(){return 'images';}
 get positions(){return this.scene.positions;}
 private get snapshot(){return this.scene.snapshot;}
 private get exploration(){return this.scene.exploration;}
 private set exploration(next:Exploration|null){this.scene.exploration=next;}
 private get selection(){return this.scene.selection;}
 private get selected(){return this.scene.selectedImages;}
 private get selectedRegion(){return this.scene.selectedRegion;}
 private get selectedEdge(){return this.scene.selectedEdge;}
 private get polygon(){return this.draft?.kind==='polygon'?this.draft:null;}
 private get pending(){return this.draft?.kind==='connect'?this.draft.source:null;}
 /** The image the explorer was last pointed at, so a marquee redrawn over the same one image
  * does not ask again; null whenever the selection is not exactly one image. */
 private mirrored:string|null=null;
 private setSelection(next:Selection){this.scene.setSelection(next);this.followSelection();}
 /** One image chosen is one file, and the explorer follows it as it follows the open note.
  * Both writers of the selection — `setSelection` and `select` — end here. */
 private followSelection(){
  const images=this.scene.selectedImages,single=images.size===1?[...images][0]:null;
  if(single===this.mirrored)return;
  this.mirrored=single;if(single)this.host.showInExplorer(single);
 }
 /** Connections are measured against the polyline the last frame drew. See `scene.hit`. */
 private hit(p:Point){return this.scene.hit(p,this.camera.scale,edge=>edgeEndpoints(edge,this.positions,this.scene.regions));}
 private get win(){return this.containerEl.ownerDocument.defaultView??window;}
 private run(action:()=>Promise<unknown>){void action().catch((error:unknown)=>new Notice(`Image Graph: ${error instanceof Error?error.message:String(error)}`,8000));}

 async onOpen():Promise<void>{
  this.active=true;this.contentEl.empty();this.contentEl.addClass('image-graph-view');
  this.renderer=new CanvasRenderer(this.contentEl.ownerDocument,this.host,this.redraw);
  const root=this.contentEl.createDiv({cls:'image-graph-root'}),bar=root.createDiv({cls:'image-graph-toolbar'});
  const button=(host:HTMLElement,text:string,action:()=>void)=>{const b=host.createEl('button',{text});this.registerDomEvent(b,'click',action);return b;};
  /* One fixed row. Everything that comes and goes floats over the canvas instead, because a
   * row that appears pushes the canvas down: entering an exploration used to move the picture
   * under the pointer. Measured before this: 45px of chrome in the vault, 88px exploring. */
  const where=bar.createDiv({cls:'image-graph-tools',attr:{role:'group','aria-label':'View'}});
  this.vaultButton=button(where,'Vault',()=>{if(this.exploration)this.exitExploration();});
  this.exploreButton=button(where,'Explore',()=>this.exploreSelection());
  this.vaultButton.addClass('image-graph-tool');this.exploreButton.addClass('image-graph-tool');
  /* A relation is not an object on the canvas, so it cannot be clicked the way a picture can.
   * Without a list of its own it could only be reached by pressing Explore with nothing
   * chosen, which nothing on screen said. The caret is that list, in both views. */
  const caret=where.createEl('button',{cls:'image-graph-tool image-graph-caret',attr:{'aria-label':'Explore a relation','aria-haspopup':'menu'}});
  setIcon(caret,'chevron-down');
  this.registerDomEvent(caret,'click',()=>{
   const names=relationNames(this.snapshot);
   const rect=caret.getBoundingClientRect(),menu=new Menu();
   if(!names.length)menu.addItem(item=>item.setTitle('No connection carries a relation yet').setDisabled(true));
   else{
    const counts=new Map<string,number>();
    for(const edge of this.snapshot.edges){const name=relationOf(edge.properties);if(name)counts.set(name,(counts.get(name)??0)+1);}
    for(const name of names.slice(0,12))menu.addItem(item=>item.setTitle(`${name} — ${counts.get(name)??0}`).setChecked(this.exploration?.relation===name).onClick(()=>this.exploreRelation(name)));
    if(names.length>12)menu.addItem(item=>item.setTitle(`All ${names.length} relations…`).onClick(()=>this.exploreRelationPicker()));
   }
   menu.showAtPosition({x:rect.left,y:rect.bottom});
  });
  button(bar,'Find',()=>this.findImage());
  /* One group for the five tools. Rectangle, polygon and connect had no button at all, so
   * somebody who never pressed R and never right-clicked could not draw a region. The label
   * is beside the icon on a wide pane and hidden on a narrow one; an icon that fails to
   * resolve therefore still leaves a readable button. */
  const tools=bar.createDiv({cls:'image-graph-tools',attr:{role:'group','aria-label':'Tool'}});
  const tool=(mode:Mode,icon:string,name:string,keys:string,action:()=>void)=>{
   const b=tools.createEl('button',{cls:'image-graph-tool',attr:{'aria-label':`${name} (${keys})`}});
   const glyph=b.createSpan({cls:'image-graph-tool-icon'});setIcon(glyph,icon);
   b.createSpan({cls:'image-graph-tool-label',text:name});
   this.registerDomEvent(b,'click',action);return{button:b,mode};
  };
  this.modeButtons=[
   tool('select','mouse-pointer','Navigate','V',()=>this.setMode('select')),
   tool('move','move','Move','M',()=>this.setMode('move')),
   tool('rect','square','Region','R',()=>this.setMode('rect')),
   tool('polygon','pen-tool','Polygon','G',()=>this.setMode('polygon')),
   tool('connect','git-fork','Connect','C',()=>{const hit=this.scene.selectionHit();this.beginConnect(hit&&'endpoint'in hit?hit.endpoint:undefined);}),
  ];
  const right=bar.createDiv({cls:'image-graph-toolbar-end'});
  /* The Export button was a strict duplicate: `menu()` already ends with `exportMenu`. */
  const actions=right.createEl('button',{cls:'image-graph-icon-button',attr:{'aria-label':'Actions, export and undo'}});setIcon(actions,'more-horizontal');
  this.registerDomEvent(actions,'click',()=>{const r=actions.getBoundingClientRect();this.menu({clientX:r.left,clientY:r.bottom},this.scene.selectionHit(),undefined,true);});
  const properties=right.createEl('button',{cls:'image-graph-icon-button',attr:{'aria-label':'Properties panel'}});setIcon(properties,'panel-right');
  this.registerDomEvent(properties,'click',()=>this.toggleInspector());
  const body=root.createDiv({cls:'image-graph-body'}),stage=body.createDiv({cls:'image-graph-stage'});
  /* Obsidian renders `aria-label` as a hover tooltip, so a sentence here parked a tooltip
   * over the status line for as long as the pointer was on the canvas. The words are the
   * same; they now reach a screen reader and not the eye. */
  const id=`image-graph-${Math.random().toString(36).slice(2,10)}`;
  this.canvas=stage.createEl('canvas',{cls:'image-graph-canvas',attr:{tabindex:'0','aria-labelledby':`${id}-name`,'aria-describedby':`${id}-help`}});
  stage.createSpan({cls:'image-graph-sr-only',attr:{id:`${id}-name`},text:'Image graph'});
  stage.createSpan({cls:'image-graph-sr-only',attr:{id:`${id}-help`},text:'Scroll to pan, ctrl and scroll to zoom. R draws a rectangle. C connects. E explores. Question mark lists every shortcut.'});
  /* The counts are read, not announced. They change on every frame of a pan, and a live
   * region that says so is a screen reader talking over the gesture. */
  /* One strip, at the bottom left. The bottom right is Obsidian's own status bar, which
   * draws over the leaf: a zoom control there is half hidden behind the word count. */
  const footer=body.createDiv({cls:'image-graph-footer'});
  this.announcer=body.createDiv({cls:'image-graph-sr-only',attr:{role:'status','aria-live':'polite'}});
  this.zoomBar=footer.createDiv({cls:'image-graph-zoom',attr:{role:'group','aria-label':'Zoom'}});
  const zoomOut=this.zoomBar.createEl('button',{text:'\u2212',attr:{'aria-label':'Zoom out'}});this.registerDomEvent(zoomOut,'click',()=>this.zoomStep(1/1.25));
  this.zoomLabel=this.zoomBar.createEl('button',{cls:'image-graph-zoom-level',attr:{'aria-label':'Zoom to fit everything'}});this.registerDomEvent(this.zoomLabel,'click',()=>this.zoomPreset('all'));
  const zoomIn=this.zoomBar.createEl('button',{text:'+',attr:{'aria-label':'Zoom in'}});this.registerDomEvent(zoomIn,'click',()=>this.zoomStep(1.25));
  /* Depth and relation are view state, the same family as "60%", so they live beside it
   * rather than in a row of their own that the canvas has to make room for. */
  this.explorationControls=footer.createDiv({cls:'image-graph-exploration is-hidden',attr:{role:'group','aria-label':'Exploration'}});
  this.depthSelect=this.explorationControls.createEl('select',{attr:{'aria-label':'Connection depth'}});for(const n of [1,2,3])this.depthSelect.createEl('option',{attr:{value:String(n)},text:`${n} hop${n===1?'':'s'}`});
  this.registerDomEvent(this.depthSelect,'change',()=>this.setDepth(Number(this.depthSelect.value)));
  this.relationSelect=this.explorationControls.createEl('select',{attr:{'aria-label':'Relation filter'}});this.registerDomEvent(this.relationSelect,'change',()=>this.setRelationFilter(this.relationSelect.value));
  this.jobChip=footer.createDiv({cls:'image-graph-job is-hidden'});
  this.jobText=this.jobChip.createSpan();
  this.jobStop=this.jobChip.createEl('button',{text:'\u2715',attr:{'aria-label':'Stop background work'}});
  this.registerDomEvent(this.jobStop,'click',()=>{this.host.stopJobs();new Notice('Background work stopped. Nothing is lost; it resumes when you ask.');});
  this.status=footer.createDiv({cls:'image-graph-status'});
  // Every mode that takes over the pointer says so and offers a way out. Only polygon had
  // one before, so rectangle and connect could be entered with no visible way back.
  this.drawingControls=body.createDiv({cls:'image-graph-drawing-controls is-hidden'});
  this.drawingText=this.drawingControls.createSpan();
  this.finishButton=this.drawingControls.createEl('button',{text:'Finish polygon'});this.registerDomEvent(this.finishButton,'click',()=>this.finishPolygon());
  this.undoPointButton=this.drawingControls.createEl('button',{text:'Undo point'});this.registerDomEvent(this.undoPointButton,'click',()=>{this.polygon?.points.pop();this.canvas.focus();this.schedule();});
  const cancel=this.drawingControls.createEl('button',{text:'Cancel'});this.registerDomEvent(cancel,'click',()=>this.setMode('select'));
  this.pathText=body.createDiv({cls:'image-graph-path is-hidden'});
  this.inspector=body.createDiv({cls:'image-graph-inspector is-hidden'});
  this.registerDomEvent(this.canvas,'pointerdown',event=>this.pointerDown(event));
  this.registerDomEvent(this.canvas,'pointermove',event=>this.pointerMove(event));
  this.registerDomEvent(this.canvas,'pointerup',event=>this.pointerUp(event));
  this.registerDomEvent(this.canvas,'pointercancel',()=>this.cancel());
  this.registerDomEvent(this.canvas,'pointerleave',()=>{this.hoverPoint=null;this.hoverRead=null;this.hover=null;this.grip=null;this.schedule();});
  this.registerDomEvent(this.canvas,'contextmenu',event=>{event.preventDefault();this.clearLongPress();this.drag=null;const hit=this.hit(this.world(event));this.pointAt(hit);this.menu(event,hit,event);});
  this.registerDomEvent(this.canvas,'dblclick',event=>{if(this.mode==='polygon'){event.preventDefault();this.finishPolygon();}});
  this.registerDomEvent(this.canvas,'wheel',event=>this.wheel(event),{passive:false});
  this.registerDomEvent(this.canvas,'keydown',event=>this.keydown(event));this.registerDomEvent(this.canvas,'keyup',event=>{if(event.code==='Space')this.space=false;});
  this.registerDomEvent(this.win,'blur',()=>this.cancel());
  this.observer=new ResizeObserver(()=>{const ratio=this.win.devicePixelRatio||1;this.canvas.width=Math.max(1,Math.round(this.canvas.clientWidth*ratio));this.canvas.height=Math.max(1,Math.round(this.canvas.clientHeight*ratio));this.fitOnce();this.schedule();});this.observer.observe(stage);
  // A theme change alters every colour the canvas reads, and nothing else redraws it.
  this.registerEvent(this.app.workspace.on('css-change',()=>{this.renderer.invalidate();this.schedule();}));
  this.unsubscribe=this.host.subscribe(()=>this.refresh());
  this.unsubscribeJobs=this.host.subscribeJobs(()=>this.schedule());
  this.refresh();
 }
 async onClose():Promise<void>{this.active=false;this.metadataTicket++;this.clearLongPress();this.win.clearTimeout(this.zoomTimer);for(const builder of this.propertyBuilders)builder.dispose();this.propertyBuilders=[];this.unsubscribe?.();this.unsubscribe=null;this.unsubscribeJobs?.();this.unsubscribeJobs=null;this.observer?.disconnect();this.observer=null;this.win.cancelAnimationFrame(this.raf);this.raf=0;this.pointers.clear();this.renderer.release();}
 private refresh(){
  if(!this.active)return;
  this.scene.refresh();this.hoverRead=null;
  if(this.draft?.kind==='resize'&&!this.scene.regions.has(this.draft.regionId))this.draft=null;
  const value=this.exploration?.relation??this.exploration?.filter??'';this.relationSelect.empty();this.relationSelect.createEl('option',{attr:{value:''},text:this.exploration?.relation?'Leave this relation':'All relations'});for(const label of [...new Set(this.snapshot.edges.map(relation))].filter(Boolean).sort())this.relationSelect.createEl('option',{attr:{value:label},text:label});this.relationSelect.value=value;
  if(this.exploration)this.rebuild(false);this.fitOnce();this.schedule();
 }
 /**
  * The first fit, once there is something to fit and somewhere to fit it. Two things arrive
  * in either order: the images, through `refresh` when the store has loaded, and the pane's
  * size, through the resize observer. After a plugin reload the observer fired first, while
  * the pane was a few pixels wide: a fit against a viewport smaller than its own padding
  * clamps to the minimum scale, which reads 0% at the top-left corner, and the flag then
  * kept the real size from fitting again. The other order left the camera at 100% on the
  * origin. So both callers ask here, and neither claims the fit until both halves are in.
  */
 private fitOnce(){
  if(this.initialized||!this.scene.images.size)return;
  if(this.canvas.clientWidth<MIN_VIEWPORT||this.canvas.clientHeight<MIN_VIEWPORT)return;
  this.initialized=true;this.fit();
 }
 /** What the viewport covers in world coordinates. */
 private viewRect(w:number,h:number,camera:Camera=this.camera):Rect{return viewportRect(camera,w,h);}
 private schedule(){if(!this.active||this.raf)return;this.raf=this.win.requestAnimationFrame(()=>{this.raf=0;this.draw();});}
 private draw(){
  const ctx=this.canvas.getContext('2d');if(!ctx)return;
  this.readHover();
  const start=performance.now();
  const drag=this.drag;
  const {visible}=this.renderer.paint(ctx,this.scene,{
   camera:this.camera,width:this.canvas.clientWidth,height:this.canvas.clientHeight,ratio:this.win.devicePixelRatio||1,
   palette:this.palette(),mode:this.mode,
   hovered:this.hover&&'endpoint'in this.hover?this.hover.endpoint:null,
   hoveredEdge:this.hover&&'edge'in this.hover?this.hover.edge.id:null,
   dragKind:drag?.kind??null,
   marquee:drag?.kind==='marquee'&&drag.marquee?{start:drag.start,last:drag.marquee.last}:null,
   draft:this.draft,
   zooming:Boolean(this.zoomCursor||this.pinch),
   highlight:new Set(this.path().map(step=>step.edge.id)),
  });
  this.stats={visible,drawMs:performance.now()-start,frameMs:this.lastDraw?start-this.lastDraw:0};this.lastDraw=start;
  const filter=this.exploration?.filter??'',steps=this.path();
  const ex=this.exploration;this.explorationControls.toggleClass('is-hidden',!ex);
  this.depthSelect.toggleClass('is-hidden',!ex?.countsHops);
  if(this.renderedWhere!==!!ex){this.renderedWhere=!!ex;
   this.vaultButton.toggleClass('is-active',!ex);this.vaultButton.setAttribute('aria-pressed',String(!ex));
   this.exploreButton.toggleClass('is-active',!!ex);this.exploreButton.setAttribute('aria-pressed',String(!!ex));}
  this.syncModeBar();
  this.canvas.dataset.mode=this.drag?.kind==='pan'?'panning':this.zoomCursor??this.mode;
  this.syncModeButtons();
  this.canvas.dataset.over=this.drag?'':this.grip?'grip':this.hover?'target':'';
  this.syncStatus(visible,filter);this.announce();
  this.pathText.toggleClass('is-hidden',!ex);if(ex?.relation){this.pathText.setText(`Every connection labelled “${ex.relation}” · ${ex.graph.ids.length} image${ex.graph.ids.length===1?'':'s'}${ex.graph.capped?` · limit ${EXPLORE_LIMIT}`:''}. Choose another relation below, or Vault to leave.`);}else if(ex){const target=[...this.selected][0];this.pathText.setText(target&&!ex.isRoot(target)&&steps.length?`One shortest path · ${steps.length} hops\n`+steps.map(step=>{const e=step.edge,forward=e.source.imageId===step.from,from=forward?e.source:e.target,to=forward?e.target:e.source,arrow=e.direction==='both'?'↔':e.direction==='none'?'—':(e.direction==='forward')===forward?'→':'←';return `${this.scene.describe(from)} ${arrow} ${relation(e)} ${arrow} ${this.scene.describe(to)}`;}).join('\n'):ex.roots.length>1?`${ex.roots.length} starting images · select an image to trace its path from the nearest of them.`:'Starting image anchored · select an image to trace its path. Links can be traversed either way.');}
 }
 /** Every colour the canvas uses, read from the theme each frame. */
 private palette(){return themePalette(this.win.getComputedStyle(this.contentEl));}
 private syncModeBar(){
  const drawing=this.mode==='rect'||this.mode==='polygon'||this.mode==='connect',polygon=this.mode==='polygon';
  this.drawingControls.toggleClass('is-hidden',!drawing);
  if(!drawing)return;
  this.drawingText.setText(polygon?'Click polygon corners. Click the first corner or Finish to close.'
   :this.mode==='rect'?'Drag across an image to draw a rectangle region.'
   :this.pending?'Choose the other end of the connection.':'Choose where the connection starts.');
  this.finishButton.toggleClass('is-hidden',!polygon);
  this.undoPointButton.toggleClass('is-hidden',!polygon);
  this.finishButton.disabled=(this.polygon?.points.length??0)<3;
 }
 /** One fact per part, joined once. The nested template this replaced could not be read, and
  * it printed a stray space wherever an optional part was absent. */
 private syncStatus(visible:number,filter:string){
  const ex=this.exploration;
  const parts=[`${ex?`${ex.graph.ids.length} connected / `:''}${this.scene.images.size.toLocaleString()} images`,`${visible.toLocaleString()} visible`];
  if(ex?.relation)parts.push(`every “${ex.relation}” connection`);
  if(this.selected.size>1)parts.push(`${this.selected.size} selected`);
  parts.push(this.mode==='select'?'Drag to pan · shift-drag selects · ? lists the shortcuts'
   :this.mode==='move'?'Drag an image to move · shift-drag selects · positions snap to the 40px grid'
   :this.mode==='connect'?(this.pending?'Choose target':'Choose source')
   :this.mode==='rect'?'Drag across an image to draw a region':'Click the corners of a region');
  if(ex?.graph.capped)parts.push(`Neighborhood limit: ${EXPLORE_LIMIT}`);
  if(filter)parts.push(`${this.scene.shownEdges().filter(e=>relation(e)===filter).length} matching links; context dimmed`);
  const text=parts.join(' · ');
  if(text!==this.statusText){this.statusText=text;this.status.setText(text);}
  const zoom=`${Math.round(this.camera.scale*100)}%`;
  if(zoom!==this.renderedZoom){this.renderedZoom=zoom;this.zoomLabel.setText(zoom);}
  this.syncJob();
 }
 /** Background work gets a chip of its own rather than a number wedged into the status, and
  * the chip carries the only way to stop it. Both passes cache per item, so stopping loses
  * nothing: each resumes where it left off. */
 private syncJob(){
  const job=this.host.jobState();
  this.jobChip.toggleClass('is-hidden',!job);
  if(!job)  {this.renderedJob='';return;}
  const percent=job.total?Math.min(100,Math.round(job.done/job.total*100)):0;
  const text=`${job.name} ${job.done.toLocaleString()} / ${job.total.toLocaleString()}`;
  if(text===this.renderedJob)return;
  this.renderedJob=text;
  this.jobText.setText(text);
  this.jobStop.toggleClass('is-hidden',!job.stoppable);
  this.jobChip.style.setProperty('--image-graph-job-progress',`${percent}%`);
 }
 /** Said aloud, not printed: the tool and the selection are the two things a person who
  * cannot see the canvas has no other way to learn. Never mid-gesture. */
 private announce(){
  if(this.drag)return;
  const tool=this.mode==='select'?'Navigate':this.mode==='move'?'Move':this.mode==='rect'?'Region':this.mode==='polygon'?'Polygon':'Connect';
  const what=this.selection.kind==='edge'?'connection selected':this.selection.kind==='region'?'region selected'
   :this.selected.size?`${this.selected.size} image${this.selected.size===1?'':'s'} selected`:'nothing selected';
  const text=`${tool} tool. ${what}.`;
  if(text===this.announced)return;
  this.announced=text;this.announcer.setText(text);
 }
 private zoomStep(factor:number){const r=this.canvas.getBoundingClientRect();this.zoomAt(factor,{x:r.left+r.width/2,y:r.top+r.height/2});}
 /** Find an image by name or folder, from anywhere. */
 findImage(){
  const images=this.snapshot.images.filter(image=>!image.missing);
  if(!images.length){new Notice('This vault has no images yet.');return;}
  new ImagePicker(this.app,images,image=>`${this.scene.caption(image.id)} — ${image.path}`,image=>this.reveal(image.id)).open();
 }
 /** Bring one image into view from anywhere. An exploration that does not hold it is left
  * first, because the answer to "where is this" is never "it is not on screen". */
 reveal(imageId:string):boolean{
  if(!this.scene.images.has(imageId))return false;
  if(this.exploration&&!this.exploration.positions.has(imageId))this.exitExploration();
  this.focusImage(imageId);this.canvas.focus();this.openInspectorIfOpen();return true;
 }
 private openInspectorIfOpen(){if(!this.inspector.hasClass('is-hidden'))this.renderInspector();}
 /** Drop the cached bitmap and its backing store. Returns null so a caller can rebuild. */
 /** A connection's endpoints sit inside its two image rectangles, so their union bounds the line.
  * The margin keeps a midpoint label that overhangs the viewport, without drawing every distant edge. */
 private world(event:{clientX:number;clientY:number}):Point{const r=this.canvas.getBoundingClientRect();return toWorld(this.camera,event.clientX-r.left,event.clientY-r.top);}
 /** A right-click or a long press: whatever it lands on becomes the selection, unless it is
  * already part of one, in which case the selection stands and the menu acts on all of it. */
 private pointAt(hit:Hit|null){if(hit&&this.scene.holds(hit))return;this.select(hit,false);}
 private select(hit:Hit|null,multiple=false){
  this.metadataTicket++;this.scene.select(hit,multiple);this.followSelection();
  if(!this.inspector.hasClass('is-hidden'))this.renderInspector();this.schedule();
 }
 private path(){const ex=this.exploration,target=[...this.selected][0];return ex&&target?ex.pathTo(target):[];}
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
  const endpoint=this.scene.endpointAt(p);this.hover=endpoint?{endpoint}:null;
 }
 private pointerDown(event:PointerEvent){
  if(event.button!==0&&event.button!==1)return;this.canvas.focus();this.canvas.setPointerCapture(event.pointerId);this.pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});this.clearLongPress();
  if(this.pointers.size>1){const [a,b]=[...this.pointers.values()];this.pinch=pinchFrom(a,b);this.drag=null;return;}
  // Read fresh rather than trusting the last frame's hover: a fast pointer can arrive
  // between frames, and a press must land on what is under it now.
  const p=this.world(event),grip=this.gripAt(p),endpoint=this.scene.endpointAt(p),hit=this.mode!=='select'||event.altKey?(endpoint?{endpoint}:null):this.hit(p);
  this.drag={pointer:event.pointerId,kind:'waiting',start:p,screen:{x:event.clientX,y:event.clientY},origin:{...this.camera},hit,forcePan:this.space||event.button===1,forceMove:event.altKey||this.mode==='move'};
  const intent=pressIntent({shift:event.shiftKey,space:this.space,button:event.button,mode:this.mode,onGrip:!!grip});
  if(intent==='marquee')this.drag.marquee={base:this.scene.selectedImages,last:p};
  else if(intent==='handle'&&grip){this.drag.kind='handle';this.draft={kind:'resize',...grip,shape:grip.origin};}
  if(event.pointerType==='touch')this.longPress=this.win.setTimeout(()=>{if(this.drag?.kind==='waiting'){const target=this.drag.hit;this.drag=null;this.pointAt(target);this.menu(event,target);}},550);
 }
 private pointerMove(event:PointerEvent){
  // Hover comes first: most moves carry no button, and the guard below drops those.
  if(!this.drag||this.drag.kind==='waiting'){this.hoverPoint={clientX:event.clientX,clientY:event.clientY};this.schedule();}
  if(!this.pointers.has(event.pointerId))return;this.pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});
  if(this.pointers.size>1){
   this.clearLongPress();const [a,b]=[...this.pointers.values()];
   const step=pinchStep(this.pinch??pinchFrom(a,b),a,b);
   // The zoom is about where the fingers were; the slide then follows them, which is the
   // opposite sense to a scroll.
   if(this.pinch){this.zoomAt(step.factor,this.pinch.center);this.camera=scrollBy(this.camera,-step.dx,-step.dy);}
   this.pinch=step.next;this.schedule();return;}
  const p=this.world(event),drag=this.drag;
  if(!drag||drag.pointer!==event.pointerId)return;
  if(drag.kind==='waiting'){
   if(!movedEnough(drag.screen,{x:event.clientX,y:event.clientY}))return;this.clearLongPress();
   const over=drag.hit?('edge'in drag.hit?'edge':'image'):null;
   drag.kind=dragBecomes({marquee:!!drag.marquee,forcePan:drag.forcePan,forceMove:drag.forceMove,over,mode:this.mode});
   if(drag.kind==='region'&&drag.hit&&'endpoint'in drag.hit){drag.imageId=drag.hit.endpoint.imageId;this.draft={kind:'region',imageId:drag.imageId,start:drag.start,last:p};this.select(drag.hit);}
   else if(drag.kind==='image'&&drag.hit&&'endpoint'in drag.hit){drag.imageId=drag.hit.endpoint.imageId;if(!this.selected.has(drag.imageId))this.select(drag.hit);drag.origins=this.scene.movable(drag.imageId);}
  }
  if(drag.kind==='pan')this.camera={...this.camera,x:drag.origin.x+event.clientX-drag.screen.x,y:drag.origin.y+event.clientY-drag.screen.y};
  else if(drag.kind==='image'&&drag.origins){const dx=p.x-drag.start.x,dy=p.y-drag.start.y;
   for(const [id,rect] of drag.origins)this.scene.place(id,rect.x+dx,rect.y+dy,rect);this.scene.moved();}
  else if(drag.kind==='marquee'&&drag.marquee){drag.marquee.last=p;this.setSelection(imageSelection([...drag.marquee.base,...this.scene.spatial().query(rectBetween(drag.start,p))]));}
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
  }else if(drag.kind==='image'&&drag.origins){const moved=this.scene.movedRecords(drag.origins.keys());this.renderer.invalidate();
   if(!this.exploration&&moved.length)this.run(()=>this.host.updateImages(moved));}
  else if(drag.kind==='marquee'&&!this.inspector.hasClass('is-hidden'))this.renderInspector();
  else if(drag.kind==='handle'&&this.draft?.kind==='resize'){const resize=this.draft;this.draft=null;const region=this.scene.regions.get(resize.regionId);
   if(region&&JSON.stringify(region.shape)!==JSON.stringify(resize.shape))this.run(()=>this.host.saveRegion({...region,shape:resize.shape}));}
  else if(drag.kind==='region'&&this.draft?.kind==='region'){const d=this.draft,r=this.positions.get(d.imageId)!;this.draft=null;const shape=regionFromDrag(d.start,d.last,r);if(shape.width*r.width*this.camera.scale>4&&shape.height*r.height*this.camera.scale>4)this.createRegion(d.imageId,shape);}
  this.schedule();
 }
 private syncModeButtons(){
  if(this.renderedMode===this.mode)return;this.renderedMode=this.mode;
  for(const {button,mode} of this.modeButtons){button.toggleClass('is-active',mode===this.mode);button.setAttribute('aria-pressed',String(mode===this.mode));}
 }
 /** The rectangle holding every one of `ids`, or null when none of them is placed. */
 /** The grip of the selected region under `p`, if the pointer is close enough to one. */
 private grip:{regionId:string;imageId:string;handle:HandleId;origin:RegionShape}|null=null;
 private gripAt(p:Point){
  const selection=this.selection;if(selection.kind!=='region'||this.mode!=='select')return null;
  const region=this.scene.regions.get(selection.regionId),r=this.positions.get(selection.imageId);if(!region||!r||isForeignRegion(region))return null;
  if(Math.min(r.width,r.height)*this.camera.scale<=48)return null;
  const reach=8/this.camera.scale;
  for(const grip of regionHandles(region.shape)){
   if(Math.abs(p.x-(r.x+grip.x*r.width))<=reach&&Math.abs(p.y-(r.y+grip.y*r.height))<=reach)
    return{regionId:region.id,imageId:selection.imageId,handle:grip.id,origin:region.shape};
  }
  return null;
 }
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
  const gesture=wheelGesture(event,this.canvas.clientHeight);
  if(gesture.kind==='zoom'){
   this.zoomCursor=gesture.into?'zoom-in':'zoom-out';this.win.clearTimeout(this.zoomTimer);
   this.zoomTimer=this.win.setTimeout(()=>{this.zoomCursor=null;this.schedule();},180);
   this.zoomAt(gesture.factor,{x:event.clientX,y:event.clientY});return;
  }
  this.camera=scrollBy(this.camera,gesture.dx,gesture.dy);this.schedule();
 }
 private zoomAt(factor:number,client:Point){const r=this.canvas.getBoundingClientRect();this.camera=zoomCameraAt(this.camera,factor,{x:client.x-r.left,y:client.y-r.top});this.schedule();}
 private keydown(event:KeyboardEvent){
  if(event.code==='Space'){this.space=true;event.preventDefault();return;}
  const command=commandFor(event);if(!command)return;
  if(swallows(command))event.preventDefault();
  this.obey(command);this.schedule();
 }
 /** Exhaustive on purpose: a command with no branch here fails to compile. */
 private obey(command:Command){
  switch(command.kind){
   case'cancel':return this.cancel();
   case'mode':return this.setMode(command.mode);
   case'connect':{const hit=this.scene.selectionHit();return this.beginConnect(hit&&'endpoint'in hit?hit.endpoint:undefined);}
   case'explore':return this.exploreSelection();
   case'expand':return this.expandImages([...this.selected]);
   case'pin':return this.pinImages([...this.selected]);
   case'properties':return this.openInspector();
   case'home':return this.exploration?this.exitExploration():this.fit();
   case'zoom':return this.zoomPreset(command.to);
   case'finish':if(this.mode==='polygon')this.finishPolygon();return;
   case'delete':if(this.mode==='polygon'){this.polygon?.points.pop();this.schedule();}else this.removeSelected();return;
   case'menu':{const r=this.canvas.getBoundingClientRect();return this.menu({clientX:r.left+40,clientY:r.top+40},this.scene.selectionHit(),undefined,true);}
   case'help':return this.showShortcuts();
   case'undo':return this.run(()=>this.host.undo());
   case'redo':return this.run(()=>this.host.redo());
   case'nudge':return this.mode==='move'||!this.selected.size?this.nudge(command.dx,command.dy):this.travel(command.dx,command.dy,command.far);
  }
 }
 /**
  * Walk the selection from image to image. This is the canvas's only keyboard travel: Tab
  * belongs to the browser, and a widget that takes it traps the person who needs it most.
  * `far` — Shift — adds the image rather than replacing the selection.
  */
 private travel(dx:number,dy:number,far:boolean){
  const from=[...this.selected].map(id=>this.positions.get(id)).filter((r):r is Rect=>!!r).at(-1);
  if(!from)return this.nudge(dx,dy);
  const next=neighbourInDirection(from,this.scene.shownRects(),Math.sign(dx),Math.sign(dy));
  if(!next){new Notice('No image that way.');return;}
  this.setSelection(imageSelection(far?[...this.selected,next]:[next]));
  const r=this.positions.get(next);if(r)this.bringIntoView(r);
  this.openInspectorIfOpen();this.schedule();
 }
 /** Scroll just enough, and keep the zoom. Flying to each image in turn is not travel. */
 private bringIntoView(r:Rect){
  const pad=48;
  this.camera=scrollIntoView(this.camera,r,{width:this.canvas.clientWidth,height:this.canvas.clientHeight},pad,pad+40);
  this.schedule();
 }
 /** Move every selected image by one step, and write the new whole-vault positions. */
 private nudge(dx:number,dy:number){
  const origins=[...this.selected];
  // With nothing selected the arrows walk the camera, which is what a map should do.
  if(!origins.length){this.camera=scrollBy(this.camera,dx,dy);this.schedule();return;}
  for(const id of origins){const r=this.positions.get(id);if(r&&!this.exploration?.isAnchor(id))this.scene.place(id,r.x+dx,r.y+dy,r);}
  this.scene.moved();this.renderer.invalidate();
  if(!this.exploration){const moved=this.scene.movedRecords(origins);if(moved.length)this.run(()=>this.host.updateImages(moved));}
  this.schedule();
 }
 private zoomPreset(to:'reset'|'all'|'selection'){
  if(to==='all')return this.fit();
  if(to==='selection'){const band=this.scene.bounds(this.selected);if(!band)return void new Notice('Select an image to zoom to it.');return this.fit(band);}
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

 /**
  * The context menu, built in sections so every entry point reads the same way:
  *
  *   the thing under the pointer · the view · undo and redo · export · delete
  *
  * A right-click on an image, a region or a connection shows only that thing, its history and
  * its delete: a menu about a picture is not the place for the tools, and the toolbar has
  * them. A right-click on the canvas, the Actions button and Shift+F10 show `everything`: the
  * selection's items first when there is one, then the view. The image items act on the
  * selection through the methods the keys and the toolbar call, so the three surfaces cannot
  * disagree — `pointAt` has already put the hit into the selection, or left a selection that
  * held it standing.
  */
 private menu(point:{clientX:number;clientY:number},hit:Hit|null,event?:MouseEvent,everything=hit===null){
  const menu=event?Menu.forEvent(event):new Menu();
  let open=false;
  const section=()=>{if(open)menu.addSeparator();open=false;};
  const item=(label:string,icon:string,callback:()=>void)=>{menu.addItem(i=>i.setTitle(label).setIcon(icon).onClick(callback));open=true;};
  const ex=this.exploration;
  if(hit&&'endpoint'in hit){
   const e=hit.endpoint,region=e.regionId?this.scene.regions.get(e.regionId):undefined,foreign=!!region&&isForeignRegion(region);
   const ids=!e.regionId&&this.selected.has(e.imageId)?[...this.selected]:[e.imageId],many=ids.length>1,these=many?`these ${ids.length} images`:'this image';
   if(region){
    // The region first: it is what was pointed at. Its image follows.
    item('Connect from here','git-fork',()=>this.beginConnect(e));
    item('Properties','settings-2',()=>this.openInspector());
    item('Create image from region','crop',()=>this.run(()=>this.host.extractRegion(region.id)));
    if(foreign&&this.host.annotationAvailable())item('Open in Image Annotation','pen-tool',()=>this.run(()=>this.host.openInAnnotation(region.id)));
    section();
   }
   item(many?`Explore ${these}`:'Explore connections','compass',()=>this.exploreImages(ids));
   if(ex){if(ex.countsHops)item(many?`Expand neighbors of ${these}`:'Expand neighbors','expand',()=>this.expandImages(ids));
    const pinnable=ids.filter(id=>!ex.isAnchor(id)),release=pinnable.every(id=>ex.pinned.has(id));
    if(pinnable.length)item(`${release?'Unpin':'Pin'} ${many?`${pinnable.length} images`:'image'}`,release?'pin-off':'pin',()=>this.pinImages(pinnable));}
   if(!region){
    section();
    item('Connect from here','git-fork',()=>this.beginConnect(e));
    // With the whole view below, the tools are in their own group.
    if(!everything){item(many?'Move these images':'Move image','move',()=>this.setMode('move'));item('Draw rectangle region','square',()=>this.setMode('rect'));item('Draw polygon region','pen-tool',()=>this.setMode('polygon'));}
    item('Properties','settings-2',()=>this.openInspector());
   }
   section();
   item('Open image','image',()=>this.run(()=>this.host.openImage(e.imageId)));
   item('Open companion note','file-text',()=>this.run(()=>this.host.openCompanion(e.imageId)));
   if(this.host.annotationAvailable())item('Annotate in Image Annotation','pen-tool',()=>this.run(()=>this.host.annotateInAnnotation(e.imageId)));
   if(!ex&&!everything){section();item(`Return ${these} to the grid`,'layout-grid',()=>this.returnToGrid(ids));}
  }else if(hit){
   const name=relationOf(hit.edge.properties);
   if(name)item(`Explore every “${name}” connection`,'compass',()=>this.exploreRelation(name));
   item('Properties','settings-2',()=>this.openInspector());
  }
  if(everything){
   section();
   if(ex)item('Back to the vault','arrow-left',()=>this.exitExploration());
   item('Fit everything','maximize',()=>this.fit());
   if(this.selected.size)item('Zoom to the selection','zoom-in',()=>this.zoomPreset('selection'));
   section();
   item('Navigate','mouse-pointer',()=>this.setMode('select'));
   item('Move images','move',()=>this.setMode('move'));
   item('Draw rectangle region','square',()=>this.setMode('rect'));
   item('Draw polygon region','pen-tool',()=>this.setMode('polygon'));
   if(this.mode==='polygon'&&this.polygon)item('Finish polygon','check',()=>this.finishPolygon());
   section();
   item('Explore a relation…','compass',()=>this.exploreRelationPicker());
   if(!ex)item(this.selected.size?`Return ${this.selected.size===1?'this image':`these ${this.selected.size} images`} to the grid`:'Return every moved image to the grid','layout-grid',()=>this.returnToGrid(this.selected.size?[...this.selected]:undefined));
   const block=this.viewBlock(hit);
   if(ex&&block){
    item('Copy this view as a note block','copy',()=>this.run(async()=>{await navigator.clipboard.writeText(block);new Notice('Block copied. Paste it into any note.');}));
    item('Add this view to a note…','file-plus',()=>this.run(async()=>{const path=await this.host.insertNoteBlock(block);if(path)new Notice(`Added to ${path}.`);}));
   }
  }
  const labels=this.host.historyLabels();
  section();
  if(labels.undo)item(`Undo ${labels.undo}`,'undo-2',()=>this.run(()=>this.host.undo()));
  if(labels.redo)item(`Redo ${labels.redo}`,'redo-2',()=>this.run(()=>this.host.redo()));
  if(everything){section();this.exportMenu(item);}
  // Delete last, in a group of its own, as Obsidian's own menus do.
  section();
  if(hit&&'endpoint'in hit&&hit.endpoint.regionId){const regionId=hit.endpoint.regionId,region=this.scene.regions.get(regionId);if(region&&!isForeignRegion(region))item('Delete region and its connections','trash-2',()=>this.run(()=>this.host.deleteRegion(regionId)));}
  else if(hit&&'edge'in hit)item('Delete connection','trash-2',()=>this.run(()=>this.host.deleteEdge(hit.edge.id)));
  menu.showAtPosition({x:point.clientX,y:point.clientY});
 }
 private returnToGrid(ids?:readonly string[]){this.run(async()=>{
  const released=await this.host.unpinImages(ids);
  new Notice(released?`${released.toLocaleString()} image${released===1?'':'s'} returned to the grid.`:'No image is out of the grid.');
 });}
 /** In the vault the current graph IS the whole vault, so that pair collapses to one entry. */
 private exportMenu(item:(label:string,icon:string,callback:()=>void)=>void){
  const action=(label:string,visual:boolean,scope:'current'|'selected'|'whole')=>item(label,visual?'camera':'download',()=>this.run(async()=>{const frame=this.frame(scope);if(!frame.imageIds.length)throw new Error('Select at least one image.');await(visual?this.host.exportVisual(frame,this.canvas):this.host.exportCanvas(frame));}));
  if(this.exploration)action('Save this view as editable Canvas',false,'current');
  if(this.selected.size)action('Save selected images as editable Canvas',false,'selected');
  action('Save whole vault as editable Canvas',false,'whole');
  action('Save viewport as visual snapshot',true,'current');
 }
 /**
  * The block that would draw what is on screen. An exploration describes itself; in the vault
  * view there is nothing to draw, so whatever is under the pointer or chosen stands in.
  */
 private viewBlock(hit:Hit|null):string|null{
  const ex=this.exploration;
  if(ex?.relation)return noteBlock({path:null,relation:ex.relation,depth:ex.depth});
  const anchor=ex?.roots[0]??(hit&&'endpoint'in hit?hit.endpoint.imageId:[...this.selected][0]);
  const image=anchor?this.scene.images.get(anchor):undefined;
  return image?noteBlock({path:image.path,relation:null,depth:ex?.depth??1}):null;
 }
 private removeSelected(){const s=this.selection;
  if(s.kind==='edge')this.run(()=>this.host.deleteEdge(s.id));
  else if(s.kind==='region')this.run(()=>this.host.deleteRegion(s.regionId));
  else if(this.selected.size)new Notice(`Delete removes a region or a connection. ${this.selected.size===1?'That image stays':`Those ${this.selected.size} images stay`} in the vault.`,6000);
  else new Notice('Select a region or connection to delete.');
 }
 private openInspector(){this.inspector.removeClass('is-hidden');this.renderInspector();}
 private toggleInspector(){if(this.inspector.hasClass('is-hidden'))this.openInspector();else{this.metadataTicket++;this.inspector.addClass('is-hidden');}}
 /**
  * The panel, in the same order whatever is chosen: what it is, what can be done with it,
  * its fields, its properties, and one Save at the bottom that stays in view. Prose is kept
  * out — a field explains itself by its caption and its placeholder, and a problem is said on
  * the row that has it.
  */
 private renderInspector(){
  const ticket=++this.metadataTicket;for(const builder of this.propertyBuilders)builder.dispose();this.propertyBuilders=[];this.inspector.empty();
  const head=this.inspector.createDiv({cls:'image-graph-inspector-head'}),title=head.createSpan({cls:'image-graph-inspector-heading'});
  const close=head.createEl('button',{text:'×',attr:{'aria-label':'Close properties'}});close.onclick=()=>{this.metadataTicket++;this.inspector.addClass('is-hidden');};
  const edge=this.snapshot.edges.find(e=>e.id===this.selectedEdge);
  if(edge){
   title.setText('Connection');
   const ends=this.inspector.createDiv({cls:'image-graph-inspector-identity'}).createDiv();
   ends.createDiv({cls:'image-graph-inspector-name',text:this.scene.describe(edge.source)});
   ends.createDiv({cls:'image-graph-inspector-sub',text:`→ ${this.scene.describe(edge.target)}`});
   const select=this.field('Arrow').createEl('select');
   for(const [value,text]of [['none','None'],['forward','Source → target'],['reverse','Source ← target'],['both','Both directions']])select.createEl('option',{attr:{value},text});select.value=edge.direction;
   this.propertyEditor(edge.properties,async props=>{if(!relationOf(props))throw new Error('Give the connection a relation — the label shown beside its line, for example “resembles”.');await this.host.saveEdge({...edge,direction:select.value as Direction,properties:props});},[],'The relation property is the label beside the line.');
   return;
  }
  const region=this.selectedRegion?this.scene.regions.get(this.selectedRegion):undefined;
  if(region&&isForeignRegion(region)){title.setText('Region');this.foreignInspector(region);return;}
  if(region){
   title.setText('Region');
   const label=this.field('Label').createEl('input',{attr:{placeholder:'Region'}});label.value=region.label;
   const geometry=this.inspector.createEl('details',{cls:'image-graph-inspector-details'});geometry.createEl('summary',{text:'Position and size'});const shape=this.geometryEditor(geometry,region.shape);
   this.propertyEditor(region.properties,async props=>{await this.host.saveRegion({...region,label:label.value,shape:shape.getShape(),properties:props});});
   return;
  }
  const imageId=[...this.selected][0],image=imageId?this.scene.images.get(imageId):undefined;
  if(!image){title.setText('Properties');this.inspector.createEl('p',{cls:'image-graph-empty-inspector',text:'Select an image, a region or a connection.'});return;}
  title.setText('Image');
  const name=image.path.split('/').pop()??image.path,folder=image.path.slice(0,image.path.length-name.length-1);
  const identity=this.inspector.createDiv({cls:'image-graph-inspector-identity has-thumb'});
  identity.createEl('img',{cls:'image-graph-inspector-thumb',attr:{src:this.app.vault.adapter.getResourcePath(image.path),alt:''}});
  const text=identity.createDiv();text.createDiv({cls:'image-graph-inspector-name',text:name});
  if(folder)text.createDiv({cls:'image-graph-inspector-sub',text:folder});
  // One image is edited at a time. Say which, rather than let a selection of forty look like one.
  if(this.selected.size>1)text.createDiv({cls:'image-graph-inspector-sub',text:`One of ${this.selected.size} selected`});
  const actions=this.inspector.createDiv({cls:'image-graph-inspector-actions'});
  const openImage=actions.createEl('button',{text:'Open image'});openImage.onclick=()=>this.run(()=>this.host.openImage(imageId));
  const open=actions.createEl('button',{text:'Companion note'});open.onclick=()=>this.run(()=>this.host.openCompanion(imageId));
  const loading=this.inspector.createEl('p',{cls:'image-graph-inspector-sub',text:'Loading properties…'});
  this.run(async()=>{const props=await this.host.readMetadata(imageId);if(!this.active||ticket!==this.metadataTicket)return;loading.remove();this.propertyEditor(props,p=>this.host.saveMetadata(imageId,p),[...RESERVED_KEYS]);});
 }
 /** A caption on the left and the control on the right, one line. */
 private field(caption:string):HTMLElement{const row=this.inspector.createEl('label',{cls:'image-graph-inspector-field'});row.createSpan({cls:'image-graph-inspector-caption',text:caption});return row;}
 /** A region Image Annotation drew: its name, where it was attached, and the way back. Nothing here edits. */
 private foreignInspector(region:RegionRecord){
  const identity=this.inspector.createDiv({cls:'image-graph-inspector-identity'}).createDiv();
  identity.createDiv({cls:'image-graph-inspector-name',text:region.label});
  identity.createDiv({cls:'image-graph-inspector-sub',text:'Drawn in Image Annotation'});
  const actions=this.inspector.createDiv({cls:'image-graph-inspector-actions'});
  if(this.host.annotationAvailable()){const open=actions.createEl('button',{text:'Open in Image Annotation'});open.onclick=()=>this.run(()=>this.host.openInAnnotation(region.id));}
  const extract=actions.createEl('button',{text:'Create image'});extract.onclick=()=>this.run(()=>this.host.extractRegion(region.id));
  const attachments=this.host.regionAttachments(region.id);
  this.inspector.createDiv({cls:'image-graph-inspector-section',text:attachments.length?'Attached to':'Not attached to any note'});
  for(const attachment of attachments){const note=attachment.notePath.replace(/\.md$/,'');const b=this.inspector.createEl('button',{cls:'image-graph-attachment',text:attachment.blockId?`${note} · paragraph`:note});b.onclick=()=>this.run(()=>this.host.openAttachment(attachment));}
  this.inspector.createEl('p',{cls:'image-graph-property-help',text:'Edit or delete this region in Image Annotation. Connections drawn to it stay here.'});
 }
 /** Named fields for the one structured value an owner edits by hand, parsed rather than cast. */
 private geometryEditor(parent:HTMLElement,shape:RegionShape):{getShape:()=>RegionShape}{
  const number=(host:HTMLElement,caption:string,value:number)=>{
   const field=host.createEl('label',{cls:'image-graph-geometry-field'});field.createSpan({text:caption});
   const input=field.createEl('input',{attr:{type:'number',step:'0.001',min:'0',max:'1','aria-label':caption}});input.value=String(value);return input;
  };
  const read=(input:HTMLInputElement)=>input.value.trim()===''?Number.NaN:Number(input.value);
  if(shape.type==='rect'){
   const row=parent.createDiv({cls:'image-graph-geometry-row'});
   const x=number(row,'x',shape.x),y=number(row,'y',shape.y),width=number(row,'Width',shape.width),height=number(row,'Height',shape.height);
   parent.createEl('p',{cls:'image-graph-property-help',text:'Fractions of the image, measured from its top-left corner.'});
   return {getShape:()=>parseRegionShape({type:'rect',x:read(x),y:read(y),width:read(width),height:read(height)})};
  }
  parent.createEl('p',{cls:'image-graph-property-help',text:'Corners as fractions of the image, in order.'});
  const corners=shape.points.map((point,index)=>{const row=parent.createDiv({cls:'image-graph-geometry-row'});row.createSpan({cls:'image-graph-inspector-caption',text:`Corner ${index+1}`});return{x:number(row,'x',point.x),y:number(row,'y',point.y)};});
  return {getShape:()=>parseRegionShape({type:'polygon',points:corners.map(corner=>({x:read(corner.x),y:read(corner.y)}))})};
 }
 private propertyEditor(properties:Properties,save:(properties:Properties)=>Promise<void>,reserved:string[]=[],hint?:string){
  this.inspector.createDiv({cls:'image-graph-inspector-section',text:'Properties'});
  if(hint)this.inspector.createEl('p',{cls:'image-graph-property-help',text:hint});
  const builder=renderPropertyBuilder(this.inspector,properties,{reservedKeys:reserved,onChange:()=>report(0)});
  this.propertyBuilders.push(builder);
  // The footer stays in view however long the table is, so Save is never scrolled away.
  const footer=this.inspector.createDiv({cls:'image-graph-inspector-footer'});
  const button=footer.createEl('button',{cls:'mod-cta',text:'Save'});
  const feedback=footer.createSpan({cls:'image-graph-inspector-status',attr:{role:'status','aria-live':'polite'}});
  // Each field reports itself as it is typed. Saving stays the boundary, not the first warning.
  const report=(count:number)=>{feedback.textContent=count?`${count} ${count===1?'property needs':'properties need'} attention`:'';};
  const recheck=()=>report(builder.check());
  this.registerDomEvent(this.inspector,'input',recheck);this.registerDomEvent(this.inspector,'change',recheck);
  button.onclick=()=>{this.run(async()=>{
   feedback.textContent='';button.disabled=true;
   try{await save(builder.getValue());feedback.textContent='Saved';this.schedule();}
   catch(error){const message=propertyMessage(error);feedback.textContent=message||'Could not save. Try again.';builder.check();}
   finally{button.disabled=false;}
  });};
 }

 focusImage(imageId:string){const r=this.positions.get(imageId)??this.scene.images.get(imageId);if(!r)return;this.setSelection(imageSelection([imageId]));this.camera=fitBox(r,{width:this.canvas.clientWidth,height:this.canvas.clientHeight},{padX:80,padY:100,minScale:.01,maxScale:1.8});this.schedule();}
 revealExtracted(imageId:string,parentImageId:string){this.refresh();if(this.exploration){this.exploration.expand(parentImageId);this.rebuild(false);}this.focusImage(imageId);}
 /** Explore whatever is chosen. A connection is a thing a person pointed at, so it means the
  * two pictures it joins — `Explore every “…” connection` is the relation, and it says so. A
  * selection of several images means all of them: a smaller space to arrange and draw in. */
 private exploreSelection(){
  const selection=this.selection;
  if(selection.kind==='edge'){
   const edge=this.snapshot.edges.find(e=>e.id===selection.id);
   if(edge)return this.exploreImages([...new Set([edge.source.imageId,edge.target.imageId])]);
  }
  if(this.selected.size)this.exploreImages([...this.selected]);
  else new Notice('Choose an image to explore its connections, or use the arrow beside the button to choose a relation.',7000);
 }
 exploreImage(imageId:string){this.exploreImages([imageId]);}
 /** One picture, the two a connection joins, or every picture of a selection. */
 exploreImages(imageIds:readonly string[]){
  const next=Exploration.fromImages(this.snapshot,imageIds,this.exploration?.savedCamera??{...this.camera});
  if(!next)return;
  this.cancel();
  this.exploration=next;
  this.setSelection(imageSelection(next.roots));this.depthSelect.value='1';this.relationSelect.value='';this.rebuild(true);
 }
 /** Everything one relation joins, as a graph. There is no starting image and no hop count:
  * a relation is a shape the whole vault has, not a view from one picture. */
 exploreRelation(relation:string){
  if(!relation)return;
  const next=Exploration.fromRelation(this.snapshot,relation,this.exploration?.savedCamera??{...this.camera});
  if(!next){new Notice(`Nothing is connected by “${relation}”.`);return;}
  this.cancel();
  this.exploration=next;
  this.setSelection(NOTHING);this.relationSelect.value=relation;
  this.rebuild(true);
 }
 /** Explore whatever is chosen: an image, the relation of a chosen connection, or a relation
  * picked from a list when nothing is chosen at all. */
 exploreRelationPicker(){
  const names=relationNames(this.snapshot);
  if(!names.length){new Notice('No connection carries a relation yet.');return;}
  new RelationPicker(this.app,names,this.snapshot,name=>this.exploreRelation(name)).open();
 }
 setDepth(depth:number){const ex=this.exploration;if(!ex)return;ex.setDepth(depth);this.depthSelect.value=String(ex.depth);this.rebuild(true);}
 setRelationFilter(value:string){
  const ex=this.exploration;if(!ex)return;
  // Exploring a relation, the list picks which relation. Exploring an image, it dims the rest.
  if(ex.relation!==null){if(value)this.exploreRelation(value);else this.exitExploration();return;}
  ex.filter=value;this.relationSelect.value=value;this.schedule();
 }
 /** Outside an exploration there is nothing to expand, so the images are explored instead. */
 expandImages(imageIds:readonly string[]){const ex=this.exploration;if(!imageIds.length)return;if(!ex){this.exploreImages(imageIds);return;}for(const id of imageIds)ex.expand(id);this.rebuild(true);}
 /** One state for the set: all pinned becomes all free; anything else becomes all pinned. */
 pinImages(imageIds:readonly string[]){const ex=this.exploration;if(!ex)return;const ids=imageIds.filter(id=>!ex.isAnchor(id));if(!ids.length)return;
  const release=ids.every(id=>ex.pinned.has(id));for(const id of ids)if(release||!ex.pinned.has(id))ex.togglePin(id);this.schedule();}
 private rebuild(refit:boolean){if(!this.exploration)return;
  this.scene.rebuildExploration();if(refit)this.fit();this.schedule();}
 exitExploration(){const ex=this.exploration;if(!ex)return;this.camera={...ex.savedCamera};this.exploration=null;this.setSelection(keepImages(this.selection));this.cancel();this.schedule();}
 private fit(box?:Rect|null){
  const anchor=this.exploration?.anchor??null;const root=!box&&anchor?this.positions.get(anchor):null;
  box=box??this.scene.bounds(this.positions.keys());
  if(!box)return;
  const viewport={width:this.canvas.clientWidth||800,height:this.canvas.clientHeight||600};
  // An anchored neighbourhood keeps its starting picture in the middle, so the camera has to
  // reach as far past it as the furthest image on the other side does.
  const centred=root?boxAround({x:root.x+root.width/2,y:root.y+root.height/2},box):box;
  this.camera=fitBox(centred,viewport,{padX:root?100:80,padY:root?160:150,margin:FIT_MARGIN,bottomInset:FOOTER_BAND,maxScale:MAX_FIT_SCALE});
  this.schedule();
 }
 frame(scope:'current'|'selected'|'whole'='current'):ViewFrame{const imageIds=scope==='whole'?this.snapshot.images.map(i=>i.id):scope==='selected'?[...this.selected]:[...this.scene.shownIds()],ids=new Set(imageIds),positions:Record<string,Rect>={};for(const imageId of imageIds){const r=scope==='whole'?this.scene.wholeLayout.get(imageId):this.positions.get(imageId);if(r)positions[imageId]=copy(r);}const edgeIds=(scope==='whole'?this.snapshot.edges:this.scene.shownEdges()).filter(e=>ids.has(e.source.imageId)&&ids.has(e.target.imageId)).map(e=>e.id);return{imageIds,edgeIds,positions,camera:{...this.camera},width:this.canvas.clientWidth,height:this.canvas.clientHeight};}
 debugState(){return{camera:{...this.camera},selection:this.selection.kind,selected:[...this.selected],selectedRegion:this.selectedRegion,selectedEdge:this.selectedEdge,mode:this.mode,draft:this.draft?.kind??null,pending:this.pending,imageCount:this.scene.images.size,stats:{...this.stats},exploration:this.exploration?{roots:[...this.exploration.roots],relation:this.exploration.relation,depth:this.exploration.depth,ids:this.exploration.graph.ids,pinned:[...this.exploration.pinned],capped:this.exploration.graph.capped}:null,frame:this.frame()};}
}
