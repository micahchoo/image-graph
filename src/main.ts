import {MarkdownRenderChild, Plugin, Notice, TFile, TFolder, parseYaml, type TAbstractFile, normalizePath} from 'obsidian';
import {GraphStore} from './store';
import {ImageGraphView, VIEW_TYPE} from './view';
import {GraphExporter} from './export';
import {ThumbnailCache} from './thumbnails';
import {OverviewAtlas} from './overview';
import {SizeIndex} from './sizes';
import {Jobs} from './jobs';
import {renderEmbed, type EmbedHost} from './embed';
import {EXTRACTED_ROOT, NOTES_ROOT, OLD_NOTES_ROOT, annotationLinks, attachmentLink} from './links';
import {DATA_ROOT, EXPORTS_ROOT, THUMBNAILS_ROOT, ensureFolder} from './folders';
import {ANNOTATION_INDEX, annotationId, annotationPlugin, readAnnotationIndex} from './annotations';
import {FuzzySuggestModal, type App} from 'obsidian';

/** Which note to add a block to. Cancelling answers with nothing, so nothing is written. */
class NotePicker extends FuzzySuggestModal<TFile>{
 private chosen=false;
 constructor(app:App,private notes:TFile[],private answer:(file:TFile|null)=>void){super(app);this.setPlaceholder('Add the block to which note?');}
 getItems(){return this.notes;}
 getItemText(file:TFile){return file.path;}
 onChooseItem(file:TFile){this.chosen=true;this.answer(file);}
 /* Obsidian closes the modal BEFORE it says what was chosen, so a cancel answered first and
  * the choice arrived to a promise already settled. Let the choice win the race. */
 onClose(){super.onClose();window.setTimeout(()=>{if(!this.chosen)this.answer(null);},0);}
}
import {exploreSize} from './layout';
import {isCatalogImage} from './catalog';
import {extractionPath, findExtractionPosition, regionCrop} from './extraction';
import {detached} from './dom';
import {overlaps} from './geometry';
import {type Attachment, type GraphHost, type ImageRecord, type RegionRecord, type EdgeRecord, type Properties, type ViewFrame} from './types';

/** One answer to what is an image: the catalog's. A TIFF the catalog held was refused here until 2026-09-21. */
const isImage=isCatalogImage;
const errorMessage=(error:unknown)=>error instanceof Error?error.message:String(error);

export default class ImageGraphPlugin extends Plugin implements GraphHost {
 store!:GraphStore;
 exporter!:GraphExporter;
 thumbnails!:ThumbnailCache;
 overviewCache!:OverviewAtlas;
 sizes!:SizeIndex;
 jobs!:Jobs;
 private listeners=new Set<()=>void>();
 private jobListeners=new Set<()=>void>();
 private jobTimer:number|undefined;
 private alive=true;
 private refreshTimer:number|undefined;
 private reloadData=false;
 private refreshImages=false;
 private reloadAnnotations=false;
 /** Where Image Annotation attached each foreign region, by the graph's region id. */
 private attachments=new Map<string,Attachment[]>();
 private annotationWarning='';
 private seeding:Promise<void>|null=null;
 private window!:Window;

 async onload(){
  this.window=this.app.workspace.containerEl.ownerDocument.defaultView??window;
  this.store=new GraphStore(this.app,()=>this.changed());
  this.exporter=new GraphExporter(this.app);
  this.thumbnails=new ThumbnailCache(this.app,this.app.workspace.containerEl.ownerDocument);
  /* Progress is not a change to the graph. Sending it down the data channel ran a full
   * refresh for every percent, inside draw(), once per visible image — the view redrew,
   * which asked the atlas for a tile, which reported progress, which refreshed again.
   * Obsidian's main thread never came back. Its own channel, and delivered late. */
  this.jobs=new Jobs(()=>this.notifyJobs());
  this.overviewCache=new OverviewAtlas(this.app,this.app.workspace.containerEl.ownerDocument,this.jobs);
  await this.store.load();
  // Built after the store is loaded: it reports sizes as soon as it has read them, and a
  // mutation before load() is a refusal.
  this.sizes=new SizeIndex(this.app,this.app.workspace.containerEl.ownerDocument,sizes=>this.run(()=>this.store.applyPixelSizes(sizes)),this.jobs);
  this.overviewCache.sync(this.getSnapshot().images);
  this.sizes.sync(this.getSnapshot().images);
  await this.syncAnnotations();
  await this.backfillExtractionEdges();
  const renamed=await this.store.migrateCompanions();
  if(renamed)new Notice(`Image Graph: ${renamed.toLocaleString()} companion note${renamed===1?'':'s'} renamed after ${renamed===1?'its image':'their images'}, under ${NOTES_ROOT}.`,8000);
  await this.store.syncCompanionLinks();
  this.registerView(VIEW_TYPE,leaf=>new ImageGraphView(leaf,this));
  /* A neighbourhood inside a note. The block is the owner's text: it is read, never written
   * back. One still render per block, because six blocks must not be six render loops. */
  this.registerMarkdownCodeBlockProcessor('image-graph',(source,element,context)=>{
   const child=new MarkdownRenderChild(element);
   const host:EmbedHost={
    getSnapshot:()=>this.getSnapshot(),
    subscribe:(callback:()=>void)=>this.subscribe(callback),
    thumbnail:(image:ImageRecord,ready:()=>void,pixels?:number)=>this.thumbnail(image,ready,pixels),
    reveal:(path:string)=>this.revealPath(path),
    exploreRelation:async(relation:string)=>{(await this.openGraph()).exploreRelation(relation);},
   };
   const embed=renderEmbed(element,source,host,element.ownerDocument);
   child.register(()=>embed.dispose());
   context.addChild(child);
  });
  this.addRibbonIcon('images','Open image graph',()=>this.run(()=>this.openGraph()));
  this.addCommand({id:'open',name:'Open workspace',callback:()=>this.run(()=>this.openGraph())});
  this.addCommand({id:'explore-active-image',name:'Explore the active image',checkCallback:(checking)=>{const file=this.app.workspace.getActiveFile();if(!file||!isImage(file.path))return false;if(!checking)this.run(async()=>{const view=await this.openGraph();const image=this.getSnapshot().images.find(i=>i.path===file.path);if(image)view.exploreImage(image.id);});return true;}});
  this.addCommand({id:'create-example-connections',name:'Create example connections between twelve images',callback:()=>this.run(()=>this.seedDemo())});
  this.addCommand({id:'find-image',name:'Find an image in the graph',callback:()=>this.run(async()=>(await this.openGraph()).findImage())});
  this.addCommand({id:'explore-relation',name:'Explore every connection of one relation',callback:()=>this.run(async()=>(await this.openGraph()).exploreRelationPicker())});
  this.addCommand({id:'stop-background-work',name:'Stop background work',checkCallback:(checking)=>{if(!this.jobs?.busy||this.jobs.stopped)return false;if(!checking)this.run(async()=>{this.stopJobs();new Notice('Background work stopped. It resumes when you ask, or next time the plugin loads.');});return true;}});
  this.addCommand({id:'resume-background-work',name:'Resume background work',checkCallback:(checking)=>{if(!this.jobs?.stopped)return false;if(!checking)this.run(async()=>this.resumeJobs());return true;}});
  this.addCommand({id:'unpin-images',name:'Return every moved image to the grid',callback:()=>this.run(async()=>{const n=await this.unpinImages();new Notice(n?`${n.toLocaleString()} image${n===1?'':'s'} returned to the grid.`:'Every image is already in the grid.');})});
  this.addCommand({id:'undo-graph-change',name:'Undo the last graph change',callback:()=>this.run(()=>this.undo())});
  this.addCommand({id:'redo-graph-change',name:'Redo the last graph change',callback:()=>this.run(()=>this.redo())});
  this.addCommand({id:'remove-dangling-region-connections',name:'Remove connections to deleted Image Annotation regions',callback:()=>this.run(async()=>{const n=await this.store.removeDanglingRegionEdges();new Notice(n?`${n.toLocaleString()} connection${n===1?'':'s'} removed.`:'Every connection still has its region.');})});
  this.addCommand({id:'find-active-image',name:'Find the active image in the graph',checkCallback:(checking)=>{const file=this.app.workspace.getActiveFile();if(!file||!isImage(file.path))return false;if(!checking)this.run(()=>this.revealPath(file.path));return true;}});
  /* The file explorer is where a person already knows which picture they mean. Reaching it
   * in a workspace of twenty thousand had no answer but panning. */
  this.registerEvent(this.app.workspace.on('file-menu',(menu,file)=>{
   if(!(file instanceof TFile)||!isImage(file.path))return;
   menu.addItem(item=>item.setTitle('Find in image graph').setIcon('search').onClick(()=>this.run(()=>this.revealPath(file.path))));
   menu.addItem(item=>item.setTitle('Explore image connections').setIcon('git-fork').onClick(()=>this.run(async()=>{const view=await this.openGraph();const image=this.getSnapshot().images.find(i=>i.path===file.path);if(image)view.exploreImage(image.id);})));
  }));
  this.registerEvent(this.app.vault.on('create',file=>this.scheduleRefresh(file)));
  this.registerEvent(this.app.vault.on('delete',file=>this.scheduleRefresh(file)));
  this.registerEvent(this.app.vault.on('modify',file=>{if(isImage(file.path)){this.thumbnails.invalidate(file.path);this.overviewCache.invalidate(file.path);}this.scheduleRefresh(file);}));
  this.registerEvent(this.app.vault.on('rename',(file,oldPath)=>this.run(async()=>{this.thumbnails.invalidate(oldPath);await this.store.renamePath(oldPath,file.path);if(isImage(oldPath)||isImage(file.path)||file instanceof TFolder)await this.store.refreshCatalog();this.changed();})));
  this.register(()=>{this.alive=false;this.window.clearTimeout(this.refreshTimer);this.window.clearTimeout(this.jobTimer);this.jobListeners.clear();this.thumbnails.dispose();this.overviewCache.dispose();this.sizes?.dispose();this.jobs?.dispose();this.listeners.clear();});
 }
 onunload(){void this.store?.flush().catch(error=>console.error('Image Graph save:',error));}
 private scheduleRefresh(file:TAbstractFile){
  if(file.path.startsWith(`${THUMBNAILS_ROOT}/`))return;
  if(file.path.startsWith(`${DATA_ROOT}/`))this.reloadData=true;
  else if(file.path===ANNOTATION_INDEX)this.reloadAnnotations=true;
  else if(isImage(file.path)&&!file.path.startsWith(`${EXPORTS_ROOT}/`))this.refreshImages=true;
  else if(file.path.startsWith(`${NOTES_ROOT}/`)||file.path.startsWith(`${OLD_NOTES_ROOT}/`)){this.changed();return;}
  else return;
  this.window.clearTimeout(this.refreshTimer);this.refreshTimer=this.window.setTimeout(()=>this.run(async()=>{await this.store.flush();const reload=this.reloadData,refresh=this.refreshImages,annotations=this.reloadAnnotations;this.reloadData=false;this.refreshImages=false;this.reloadAnnotations=false;if(reload)await this.store.load();else if(refresh)await this.store.refreshCatalog();if(reload||refresh)this.sizes?.republish();
   // A new picture can be the one a foreign region was waiting for, so the catalog refresh re-reads the index too.
   if(reload||refresh||annotations)await this.syncAnnotations();if(this.alive)this.changed();}),350);
 }
 /**
  * Read Image Annotation's index into foreign regions. The file is read, never the plugin:
  * the regions stay while that plugin is disabled, and go only when their file does. A file
  * that cannot be read keeps the last good reading and says so once, not once per reload.
  */
 private async syncAnnotations(){
  const file=this.app.vault.getAbstractFileByPath(ANNOTATION_INDEX);
  if(!(file instanceof TFile)){this.attachments=new Map();this.store.setForeignRegions([]);await this.store.syncAnnotationLinks(new Map());return;}
  try{
   const text=await this.app.vault.cachedRead(file),byPath=new Map(this.getSnapshot().images.map(image=>[image.path,image.id]));
   const read=readAnnotationIndex(text,byPath);
   if(read.skipped.invalid)console.warn(`Image Graph: ${read.skipped.invalid} Image Annotation region${read.skipped.invalid===1?'':'s'} could not be read.`);
   this.attachments=read.attachments;this.store.setForeignRegions(read.regions,read.sources);this.annotationWarning='';
   await this.store.syncAnnotationLinks(annotationLinks(read.regions,read.attachments));
  }catch(error){const message=errorMessage(error);if(message!==this.annotationWarning){this.annotationWarning=message;new Notice(`Image Graph: ${message}`,8000);}}
 }
 private run(action:()=>Promise<unknown>){void action().catch(error=>new Notice(`Image Graph: ${errorMessage(error)}`,8000));}
 private changed(){if(this.alive){const images=this.getSnapshot().images;this.overviewCache?.sync(images);this.sizes?.sync(images);for(const listener of this.listeners)listener();}}
 getSnapshot(){return this.store.getSnapshot();}
 subscribe(callback:()=>void){this.listeners.add(callback);return()=>{this.listeners.delete(callback);};}
 subscribeJobs(callback:()=>void){this.jobListeners.add(callback);return()=>{this.jobListeners.delete(callback);};}
 private notifyJobs(){if(this.jobTimer!==undefined||!this.alive)return;this.jobTimer=this.window.setTimeout(()=>{this.jobTimer=undefined;if(this.alive)for(const listener of this.jobListeners)listener();},120);}
 imageUrl(image:ImageRecord){const file=this.app.vault.getAbstractFileByPath(image.path);return file instanceof TFile?this.app.vault.getResourcePath(file):'';}
 thumbnail(image:ImageRecord,ready:()=>void,pixels=256){const get:(image:ImageRecord,ready:()=>void,pixels?:number)=>CanvasImageSource|null=this.thumbnails.get.bind(this.thumbnails);return get(image,ready,pixels);}
 overviewThumbnail(image:ImageRecord,ready:()=>void){return this.overviewCache.get(image,ready);}
 jobState(){return this.jobs?.current??null;}
 stopJobs(){this.jobs?.stop();}
 resumeJobs(){this.jobs?.resume();this.overviewCache?.sync(this.getSnapshot().images);this.sizes?.sync(this.getSnapshot().images);}
 async updateImage(image:ImageRecord){await this.store.upsertImage(image);}
 async updateImages(images:readonly ImageRecord[]){await this.store.upsertImages(images);}
 async unpinImages(ids?:readonly string[]){return this.store.unpinImages(ids);}
 async undo(){const label=await this.store.undo();new Notice(label?`Undid: ${label}.`:'Nothing to undo.');}
 async redo(){const label=await this.store.redo();new Notice(label?`Redid: ${label}.`:'Nothing to redo.');}
 historyLabels(){return this.store.historyLabels();}
 async saveRegion(region:RegionRecord){await this.store.upsertRegion(region);}
 async deleteRegion(id:string){await this.store.removeRegion(id);}
 async saveEdge(edge:EdgeRecord){await this.store.upsertEdge(edge);}
 async deleteEdge(id:string){await this.store.removeEdge(id);}
 async readMetadata(id:string){return this.store.readMetadata(id);}
 async saveMetadata(id:string,properties:Properties){await this.store.writeMetadata(id,properties);}
 async openCompanion(id:string){const file=await this.store.ensureCompanion(id);await this.app.workspace.getLeaf('tab').openFile(file);}
 async openImage(id:string){const image=this.getSnapshot().images.find(i=>i.id===id);const file=image&&this.app.vault.getAbstractFileByPath(image.path);if(!(file instanceof TFile))throw new Error('The image file is missing.');await this.app.workspace.getLeaf('tab').openFile(file);}
 regionAttachments(id:string){return this.attachments.get(id)??[];}
 async openAttachment(attachment:Attachment){await this.app.workspace.openLinkText(attachment.notePath+(attachment.blockId?`#^${attachment.blockId}`:''),'',true);}
 annotationAvailable(){return annotationPlugin(this.app)!==null;}
 async openInAnnotation(regionId:string){const id=annotationId(regionId),plugin=annotationPlugin(this.app);if(!id)throw new Error('This region was drawn here, not in Image Annotation.');if(!plugin)throw new Error('Image Annotation is not loaded.');plugin.openRegion(id);}
 async annotateInAnnotation(imageId:string){const image=this.getSnapshot().images.find(i=>i.id===imageId),plugin=annotationPlugin(this.app);if(!image)throw new Error('The image is missing.');if(!plugin)throw new Error('Image Annotation is not loaded.');await plugin.openImage({value:image.path,label:image.path.split('/').pop()??image.path});}
 async exportCanvas(frame:ViewFrame){const file=await this.exporter.canvas(this.getSnapshot(),frame);new Notice(`Canvas saved: ${file.path}`);return file;}
 async exportVisual(frame:ViewFrame,source?:HTMLCanvasElement){const file=await this.exporter.visual(this.getSnapshot(),frame,source);new Notice(`Visual snapshot saved: ${file.path}`);return file;}
 /** Open the workspace and put one image in the middle of it. */
 /**
  * Append a block to a note the owner picks. Choosing a file and writing it is vault work, so
  * it lives here; the view only knows what the block should say.
  */
 async insertNoteBlock(block:string):Promise<string>{
  const notes=this.app.vault.getMarkdownFiles();
  if(!notes.length)throw new Error('This vault has no notes to insert into.');
  const file=await new Promise<TFile|null>(resolve=>{
   const picker=new NotePicker(this.app,notes,resolve);
   picker.open();
  });
  if(!file)return '';
  await this.app.vault.process(file,current=>`${current.replace(/\s*$/,'')}\n\n${block}\n`);
  await this.app.workspace.getLeaf('tab').openFile(file);
  return file.path;
 }
 private async revealPath(path:string):Promise<void>{
  const view=await this.openGraph(),image=this.getSnapshot().images.find(i=>i.path===path);
  if(!image){new Notice('That image is not in the graph yet. It is added when the catalog next refreshes.');return;}
  view.reveal(image.id);
 }
 async openGraph():Promise<ImageGraphView>{
  const existing=this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];const leaf=existing??this.app.workspace.getLeaf('tab');
  if(!existing)await leaf.setViewState({type:VIEW_TYPE,active:true});await this.app.workspace.revealLeaf(leaf);
  if(!(leaf.view instanceof ImageGraphView))throw new Error('The image graph could not open.');return leaf.view;
 }
 async seedDemo():Promise<void>{
  if(this.seeding)return this.seeding;
  this.seeding=this.createExampleConnections();try{await this.seeding;}finally{this.seeding=null;}
 }
 private async createExampleConnections(){
  const snapshot=this.getSnapshot(),images=snapshot.images.filter(i=>!i.missing).slice(0,12);
  if(images.length<2)throw new Error('Add at least two images to create example connections.');
  const regionIds=new Set(snapshot.regions.map(r=>r.id)),edgeIds=new Set(snapshot.edges.map(e=>e.id));
  for(const image of images)for(const side of [0,1]){const id=`demo-${image.id}-${side}`;if(regionIds.has(id))continue;await this.saveRegion({id,imageId:image.id,label:side?'Example detail B':'Example detail A',shape:{type:'rect',x:side?.56:.14,y:side?.52:.18,width:.28,height:.28},properties:{example:true}});}
  const links:Array<[number,number,string,EdgeRecord['direction']]>=[[0,1,'resembles','both'],[0,2,'shares palette','none'],[1,3,'echoes shape','forward'],[1,4,'contrasts with','none'],[2,5,'inspired by','reverse'],[3,6,'repeats motif','forward'],[4,7,'resembles','both'],[5,8,'echoes shape','none'],[3,4,'shares palette','none'],[6,9,'inspired by','forward'],[7,10,'contrasts with','none'],[8,11,'repeats motif','both']];
  for(const [index,[a,b,relation,direction]]of links.entries()){if(!images[a]||!images[b])continue;const id=`demo-edge-${images[a].id}-${images[b].id}`;if(edgeIds.has(id))continue;await this.saveEdge({id,source:{imageId:images[a].id,...(index%3?{regionId:`demo-${images[a].id}-1`}:{})},target:{imageId:images[b].id,regionId:`demo-${images[b].id}-0`},direction,properties:{relation,example:true,notes:'Illustrative connection for exploring the interface; not an inferred claim about the images.'}});}
  await this.store.flush();new Notice('Example connections are ready. Their properties mark them as illustrative.');const view=await this.openGraph();view.exploreImage(images[0].id);
 }
 async extractRegion(id:string):Promise<void>{
  const snapshot=this.getSnapshot(),region=snapshot.regions.find(r=>r.id===id),image=region&&snapshot.images.find(i=>i.id===region.imageId);
  if(!region||!image)throw new Error('The region or source image is missing.');
  const doc=this.app.workspace.containerEl.ownerDocument,url=this.imageUrl(image);if(!url)throw new Error('The source image is missing.');const img=detached(doc,'img');img.src=url;await img.decode();
  const crop=regionCrop(region.shape,img.naturalWidth,img.naturalHeight);
  const canvas=detached(doc,'canvas');canvas.width=crop.width;canvas.height=crop.height;
  const ctx=canvas.getContext('2d');if(!ctx)throw new Error('Image drawing is unavailable.');
  if(region.shape.type==='polygon'){ctx.beginPath();region.shape.points.forEach((p,i)=>{const px=(p.x*img.naturalWidth-crop.sourceX)*crop.scale,py=(p.y*img.naturalHeight-crop.sourceY)*crop.scale;if(i)ctx.lineTo(px,py);else ctx.moveTo(px,py);});ctx.closePath();ctx.clip();}
  ctx.drawImage(img,crop.sourceX,crop.sourceY,crop.sourceWidth,crop.sourceHeight,0,0,crop.width,crop.height);
  const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(new Error('Image encoding failed.')),'image/png'));
  await ensureFolder(this.app,EXTRACTED_ROOT);
  const path=normalizePath(extractionPath(region.label,image.path,candidate=>!!this.app.vault.getAbstractFileByPath(candidate)));await this.app.vault.createBinary(path,await blob.arrayBuffer());await this.store.refreshCatalog();
  const extracted=this.getSnapshot().images.find(i=>i.path===path);if(!extracted)throw new Error('The extracted image was not added to the catalog.');
  const dimensions=exploreSize({width:crop.sourceWidth,height:crop.sourceHeight},240);
  const position=findExtractionPosition(this.getSnapshot().images, image, dimensions.width, dimensions.height,extracted.id);
  // Placed beside the picture it came from, so it keeps that place rather than the rows'.
  await this.updateImage({...extracted,...dimensions,...position,pinned:true});
  // An extracted crop remembers the notes its region was attached to, when Image Annotation drew it.
  const notes=this.regionAttachments(region.id).map(attachment=>attachmentLink(attachment,region.label));
  await this.saveMetadata(extracted.id,{source_image:`[[${image.path}]]`,source_region:region.id,...(notes.length?{source_notes:notes}:{})});
  await this.ensureExtractionEdge(extracted, image, region);
  await this.store.flush();
  const view=await this.openGraph();
  view.revealExtracted(extracted.id,image.id);
  new Notice(`Created ${path}`);
 }

 private async ensureExtractionEdge(extracted:ImageRecord,parent:ImageRecord,region:RegionRecord){
  const id=`derived-${extracted.id}-${region.id}`,existing=this.getSnapshot().edges.find(edge=>edge.id===id);if(existing)return;
  await this.saveEdge({id,source:{imageId:extracted.id},target:{imageId:parent.id,regionId:region.id},direction:'forward',properties:{relation:'derived from'}});
 }

 private async backfillExtractionEdges(){
  const snapshot=this.getSnapshot(),regions=new Map(snapshot.regions.map(region=>[region.id,region]));
  for(const extracted of snapshot.images){
   if(!extracted.path.startsWith(`${EXTRACTED_ROOT}/`)||!extracted.metadataPath)continue;
   const companion=this.app.vault.getAbstractFileByPath(extracted.metadataPath);if(!(companion instanceof TFile))continue;
   let frontmatter:unknown;try{const text=await this.app.vault.read(companion),match=text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|$)/);frontmatter=match?parseYaml(match[1]):undefined;}catch{continue;}
   if(!frontmatter||typeof frontmatter!=='object'||(frontmatter as Record<string,unknown>).image_graph_id!==extracted.id)continue;
   const metadata=await this.readMetadata(extracted.id),regionId=typeof metadata.source_region==='string'?metadata.source_region:undefined,region=regionId?regions.get(regionId):undefined;
   if(!region)continue;const parent=snapshot.images.find(image=>image.id===region.imageId);if(!parent)continue;
   const edgeId=`derived-${extracted.id}-${region.id}`;if(snapshot.edges.some(edge=>edge.id===edgeId))continue;
   const images=this.getSnapshot().images;
   const covered=images.some(other=>other.id!==extracted.id&&!other.missing&&overlaps(extracted,other));
   if(covered){const position=findExtractionPosition(images,parent,extracted.width,extracted.height,extracted.id);await this.updateImage({...extracted,...position,pinned:true});}
   await this.ensureExtractionEdge(extracted,parent,region);
  }
 }
}
