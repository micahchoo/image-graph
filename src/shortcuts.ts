/** One grid step in the whole-vault layout, and the long stride. */
export const NUDGE=40, STRIDE=200;

/** What a keystroke asks for. The view switches over this exhaustively, so a command added
 * here without a branch there does not compile. Penpot keeps the same split: a table of
 * shortcuts in data/workspace/shortcuts.cljs, and handlers that read it. */
export type Command=
 |{kind:'cancel'}
 |{kind:'mode';mode:'rect'|'polygon'|'move'}
 |{kind:'connect'}|{kind:'explore'}|{kind:'expand'}|{kind:'pin'}|{kind:'properties'}
 |{kind:'home'}|{kind:'zoom';to:'reset'|'all'|'selection'}
 |{kind:'finish'}|{kind:'delete'}|{kind:'menu'}|{kind:'help'}
 |{kind:'nudge';dx:number;dy:number};

const ARROWS:Record<string,[number,number]>={arrowleft:[-1,0],arrowright:[1,0],arrowup:[0,-1],arrowdown:[0,1]};

/** The keystroke a canvas event asks for, or null when the canvas should not answer it.
 * Space is excluded here: it is held, not pressed, so the view tracks it directly. */
export function commandFor(event:KeyboardEvent):Command|null{
 if(event.ctrlKey||event.metaKey||event.altKey)return null;
 const key=event.key.toLowerCase(),arrow=ARROWS[key];
 if(arrow)return{kind:'nudge',dx:arrow[0]*(event.shiftKey?STRIDE:NUDGE),dy:arrow[1]*(event.shiftKey?STRIDE:NUDGE)};
 if(event.shiftKey){
  if(key==='0')return{kind:'zoom',to:'reset'};
  if(key==='1')return{kind:'zoom',to:'all'};
  if(key==='2')return{kind:'zoom',to:'selection'};
  if(key==='f10')return{kind:'menu'};
  if(key==='?'||key==='/')return{kind:'help'};
  return null;
 }
 switch(key){
  case'escape':case'v':return{kind:'cancel'};
  case'r':return{kind:'mode',mode:'rect'};
  case'g':return{kind:'mode',mode:'polygon'};
  case'm':return{kind:'mode',mode:'move'};
  case'c':return{kind:'connect'};
  case'e':return{kind:'explore'};
  case'x':return{kind:'expand'};
  case'p':return{kind:'pin'};
  case'i':return{kind:'properties'};
  case'0':return{kind:'home'};
  case'enter':return{kind:'finish'};
  case'delete':case'backspace':return{kind:'delete'};
  case'contextmenu':return{kind:'menu'};
  case'?':return{kind:'help'};
  default:return null;
 }
}

/** Commands that must not also reach Obsidian. */
export function swallows(command:Command):boolean{
 return command.kind==='nudge'||command.kind==='delete'||command.kind==='menu'||command.kind==='help'||command.kind==='zoom';
}

/** The panel `?` opens. Every row names a key this file answers. */
export const SHORTCUTS:Array<{group:string;rows:Array<[string,string]>}>=[
 {group:'Move around',rows:[
  ['Drag','Pan the canvas'],
  ['Wheel / two fingers','Scroll the canvas'],
  ['Ctrl or ⌘ + wheel','Zoom at the pointer'],
  ['Space + drag, middle drag','Pan from anywhere'],
  ['0','Fit the canvas, or leave a connection map'],
  ['Shift + 0 / 1 / 2','Zoom to 100% / everything / the selection'],
 ]},
 {group:'Select',rows:[
  ['Click','Select an image, region or connection'],
  ['Shift + click','Add an image to the selection, or take it out'],
  ['Shift + drag','Select every image the band touches'],
  ['Arrows','Move the selected images one grid step'],
  ['Shift + arrows','Move them five steps'],
  ['Delete','Delete the selected region or connection'],
 ]},
 {group:'Build',rows:[
  ['R','Draw a rectangle region'],
  ['G','Draw a polygon region · Enter closes it'],
  ['C','Connect from the selection'],
  ['M','Move images · drag one to carry the whole selection'],
  ['Drag a grip','Resize the selected region'],
  ['I','Open properties'],
 ]},
 {group:'Explore',rows:[
  ['E','Explore the connections of the selected image'],
  ['X','Expand the neighbours of the selected image'],
  ['P','Pin or unpin the selected image'],
  ['Right click, long press, Shift + F10','Actions for what is under the pointer'],
  ['?','This panel'],
  ['Escape or V','Cancel and go back to panning'],
 ]},
];
