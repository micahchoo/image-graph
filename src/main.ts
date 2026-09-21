import {Plugin, Notice, TFile, TFolder, parseYaml, type TAbstractFile, normalizePath} from 'obsidian';
import {GraphStore} from './store';
import {ImageGraphView, VIEW_TYPE} from './view';
import {GraphExporter} from './export';
import {ThumbnailCache} from './thumbnails';
import {OverviewAtlas} from './overview';
import {findExtractionPosition} from './extraction';
import {detached} from './dom';
import {newId, type GraphHost, type ImageRecord, type RegionRecord, type EdgeRecord, type Properties, type ViewFrame} from './types';

const isImage=(path:string)=>/\.(png|jpe?g|webp|gif|bmp|avif|svg)$/i.test(path);
const errorMessage=(error:unknown)=>error instanceof Error?error.message:String(error);

export default class ImageGraphPlugin extends Plugin implements GraphHost {
 store!:GraphStore;
 exporter!:GraphExporter;
 thumbnails!:ThumbnailCache;
 overviewCache!:OverviewAtlas;
 private listeners=new Set<()=>void>();
 private alive=true;
 private refreshTimer:number|undefined;
 private reloadData=false;
 private refreshImages=false;
 private seeding:Promise<void>|null=null;
 private window!:Window;

 async onload(){
  this.window=this.app.workspace.containerEl.ownerDocument.defaultView??window;
  this.store=new GraphStore(this.app,()=>this.changed());
  this.exporter=new GraphExporter(this.app);
  this.thumbnails=new ThumbnailCache(this.app,this.app.workspace.containerEl.ownerDocument);
  this.overviewCache=new OverviewAtlas(this.app,this.app.workspace.containerEl.ownerDocument);
  await this.store.load();
  this.overviewCache.sync(this.getSnapshot().images);
  await this.backfillExtractionEdges();
  this.registerView(VIEW_TYPE,leaf=>new ImageGraphView(leaf,this));
  this.addRibbonIcon('images','Open image graph',()=>this.run(()=>this.openGraph()));
  this.addCommand({id:'open',name:'Open workspace',callback:()=>this.run(()=>this.openGraph())});
  this.addCommand({id:'explore-active-image',name:'Explore the active image',checkCallback:(checking)=>{const file=this.app.workspace.getActiveFile();if(!file||!isImage(file.path))return false;if(!checking)this.run(async()=>{const view=await this.openGraph();const image=this.getSnapshot().images.find(i=>i.path===file.path);if(image)view.exploreImage(image.id);});return true;}});
  this.addCommand({id:'create-example-connections',name:'Create example connections between twelve images',callback:()=>this.run(()=>this.seedDemo())});
  this.registerEvent(this.app.workspace.on('file-menu',(menu,file)=>{if(!(file instanceof TFile)||!isImage(file.path))return;menu.addItem(item=>item.setTitle('Explore image connections').setIcon('git-fork').onClick(()=>this.run(async()=>{const view=await this.openGraph();const image=this.getSnapshot().images.find(i=>i.path===file.path);if(image)view.exploreImage(image.id);})));}));
  this.registerEvent(this.app.vault.on('create',file=>this.scheduleRefresh(file)));
  this.registerEvent(this.app.vault.on('delete',file=>this.scheduleRefresh(file)));
  this.registerEvent(this.app.vault.on('modify',file=>{if(isImage(file.path)){this.thumbnails.invalidate(file.path);this.overviewCache.invalidate(file.path);}this.scheduleRefresh(file);}));
  this.registerEvent(this.app.vault.on('rename',(file,oldPath)=>this.run(async()=>{this.thumbnails.invalidate(oldPath);await this.store.renamePath(oldPath,file.path);if(isImage(oldPath)||isImage(file.path)||file instanceof TFolder)await this.store.refreshCatalog();this.changed();})));
  this.register(()=>{this.alive=false;this.window.clearTimeout(this.refreshTimer);this.thumbnails.dispose();this.overviewCache.dispose();this.listeners.clear();});
 }
 onunload(){void this.store?.flush().catch(error=>console.error('Image Graph save:',error));}
 private scheduleRefresh(file:TAbstractFile){
  if(file.path.startsWith('_Image Graph/Thumbnails/'))return;
  if(file.path.startsWith('_Image Graph/Data/'))this.reloadData=true;
  else if(isImage(file.path)&&!file.path.startsWith('_Image Graph/Exports/'))this.refreshImages=true;
  else if(file.path.startsWith('_Image Graph/Images/')){this.changed();return;}
  else return;
  this.window.clearTimeout(this.refreshTimer);this.refreshTimer=this.window.setTimeout(()=>this.run(async()=>{await this.store.flush();const reload=this.reloadData,refresh=this.refreshImages;this.reloadData=false;this.refreshImages=false;if(reload)await this.store.load();else if(refresh)await this.store.refreshCatalog();if(this.alive)this.changed();}),350);
 }
 private run(action:()=>Promise<unknown>){void action().catch(error=>new Notice(`Image Graph: ${errorMessage(error)}`,8000));}
 private changed(){if(this.alive){this.overviewCache?.sync(this.getSnapshot().images);for(const listener of this.listeners)listener();}}
 getSnapshot(){return this.store.getSnapshot();}
 subscribe(callback:()=>void){this.listeners.add(callback);return()=>{this.listeners.delete(callback);};}
 imageUrl(image:ImageRecord){const file=this.app.vault.getAbstractFileByPath(image.path);return file instanceof TFile?this.app.vault.getResourcePath(file):'';}
 thumbnail(image:ImageRecord,ready:()=>void,pixels=256){const get:(image:ImageRecord,ready:()=>void,pixels?:number)=>CanvasImageSource|null=this.thumbnails.get.bind(this.thumbnails);return get(image,ready,pixels);}
 overviewThumbnail(image:ImageRecord,ready:()=>void){return this.overviewCache.get(image,ready);}
 thumbnailProgress(){return this.overviewCache.stats;}
 async updateImage(image:ImageRecord){await this.store.upsertImage(image);}
 async saveRegion(region:RegionRecord){await this.store.upsertRegion(region);}
 async deleteRegion(id:string){await this.store.removeRegion(id);}
 async saveEdge(edge:EdgeRecord){await this.store.upsertEdge(edge);}
 async deleteEdge(id:string){await this.store.removeEdge(id);}
 async readMetadata(id:string){return this.store.readMetadata(id);}
 async saveMetadata(id:string,properties:Properties){await this.store.writeMetadata(id,properties);}
 async openCompanion(id:string){const file=await this.store.ensureCompanion(id);await this.app.workspace.getLeaf('tab').openFile(file);}
 async openImage(id:string){const image=this.getSnapshot().images.find(i=>i.id===id);const file=image&&this.app.vault.getAbstractFileByPath(image.path);if(!(file instanceof TFile))throw new Error('The image file is missing.');await this.app.workspace.getLeaf('tab').openFile(file);}
 async exportCanvas(frame:ViewFrame){const file=await this.exporter.canvas(this.getSnapshot(),frame);new Notice(`Canvas saved: ${file.path}`);return file;}
 async exportVisual(frame:ViewFrame,source?:HTMLCanvasElement){const file=await this.exporter.visual(this.getSnapshot(),frame,source);new Notice(`Visual snapshot saved: ${file.path}`);return file;}
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
  const points=region.shape.type==='polygon'?region.shape.points:[{x:region.shape.x,y:region.shape.y},{x:region.shape.x+region.shape.width,y:region.shape.y+region.shape.height}];
  const x=Math.max(0,Math.min(...points.map(p=>p.x))),y=Math.max(0,Math.min(...points.map(p=>p.y))),right=Math.min(1,Math.max(...points.map(p=>p.x))),bottom=Math.min(1,Math.max(...points.map(p=>p.y)));
  const sw=(right-x)*img.naturalWidth,sh=(bottom-y)*img.naturalHeight;if(sw<=0||sh<=0)throw new Error('The region has no area.');
  const scale=Math.min(1,4096/Math.max(sw,sh)),canvas=detached(doc,'canvas');canvas.width=Math.max(1,Math.round(sw*scale));canvas.height=Math.max(1,Math.round(sh*scale));
  const ctx=canvas.getContext('2d');if(!ctx)throw new Error('Image drawing is unavailable.');
  if(region.shape.type==='polygon'){ctx.beginPath();region.shape.points.forEach((p,i)=>{const px=(p.x-x)*img.naturalWidth*scale,py=(p.y-y)*img.naturalHeight*scale;if(i)ctx.lineTo(px,py);else ctx.moveTo(px,py);});ctx.closePath();ctx.clip();}
  ctx.drawImage(img,x*img.naturalWidth,y*img.naturalHeight,sw,sh,0,0,canvas.width,canvas.height);
  const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(new Error('Image encoding failed.')),'image/png'));
  const folder='_Image Graph/Extracted';for(const path of ['_Image Graph',folder])if(!this.app.vault.getAbstractFileByPath(path))await this.app.vault.createFolder(path);
  const path=normalizePath(`${folder}/${newId('region')}.png`);await this.app.vault.createBinary(path,await blob.arrayBuffer());await this.store.refreshCatalog();
  const extracted=this.getSnapshot().images.find(i=>i.path===path);if(!extracted)throw new Error('The extracted image was not added to the catalog.');
  const dimensions=sw>=sh?{width:240,height:240*sh/sw}:{width:240*sw/sh,height:240};
  const position=findExtractionPosition(this.getSnapshot().images, image, dimensions.width, dimensions.height,extracted.id);
  await this.updateImage({...extracted,...dimensions,...position});
  await this.saveMetadata(extracted.id,{source_image:`[[${image.path}]]`,source_region:region.id});
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
   if(!extracted.path.startsWith('_Image Graph/Extracted/')||!extracted.metadataPath?.startsWith('_Image Graph/Images/'))continue;
   const companion=this.app.vault.getAbstractFileByPath(extracted.metadataPath);if(!(companion instanceof TFile))continue;
   let frontmatter:unknown;try{const text=await this.app.vault.read(companion),match=text.match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/);frontmatter=match?parseYaml(match[1]):undefined;}catch{continue;}
   if(!frontmatter||typeof frontmatter!=='object'||(frontmatter as Record<string,unknown>).image_graph_id!==extracted.id)continue;
   const metadata=await this.readMetadata(extracted.id),regionId=typeof metadata.source_region==='string'?metadata.source_region:undefined,region=regionId?regions.get(regionId):undefined;
   if(!region)continue;const parent=snapshot.images.find(image=>image.id===region.imageId);if(!parent)continue;
   const edgeId=`derived-${extracted.id}-${region.id}`;if(snapshot.edges.some(edge=>edge.id===edgeId))continue;
   const images=this.getSnapshot().images;
   const overlaps=images.some(other=>other.id!==extracted.id&&!other.missing&&extracted.x<other.x+other.width&&extracted.x+extracted.width>other.x&&extracted.y<other.y+other.height&&extracted.y+extracted.height>other.y);
   if(overlaps){const position=findExtractionPosition(images,parent,extracted.width,extracted.height,extracted.id);await this.updateImage({...extracted,...position});}
   await this.ensureExtractionEdge(extracted,parent,region);
  }
 }
}
