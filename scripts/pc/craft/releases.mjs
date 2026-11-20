// Craft apps: behaviour only. The pinned version, download URL and SHA-256 of every app
// live in catalog.yaml (read through appSources by prepare-craft.mjs and CraftApp.astro);
// nothing in this file may hard-code a version or checksum.
export const releases = {
  lightcraft: { title:'LightCraft', description:'Organize, develop and export photos.', accept:'image/*,.dng,.nef,.cr2,.arw,.raf,.orf,.rw2', help:'Photos and edits save automatically in LightCraft’s own browser library. Keep original photos elsewhere. Use File → Back Up Library and Restore Library for portable backups. Photo exports download normally. Some desktop preset/curve file dialogs are unavailable in this web release.' },
  figcraft: { title:'FigCraft', description:'Design interfaces, vectors and diagrams.', accept:'.figcraft,.fig,.json,.svg,.png,.jpg,.jpeg', help:'Use the native editor to create documents, draw shapes and export designs. Save downloads the actual file and keeps a browser copy of the last saved .figcraft or JSON document. Reopen saved restores that copy; changes after Save are not autosaved. Online sharing requires your own compatible server.' },
  pdfcraft: { title:'PDFCraft', description:'Read, edit and annotate PDF documents.', accept:'.pdf', help:'Open a PDF, then use the native annotation and editing tools. Save downloads a PDF and keeps a browser copy of the last saved document. Reopen saved restores that copy; changes after Save are not autosaved. Large documents and OCR need additional memory.' },
  soundcraft: { title:'SoundCraft', mode:'standalone', open:'drop', loading:'soundcraft_loading', description:'Arrange audio and MIDI, and mix sessions.', accept:'audio/*,.mid,.midi,.smf,.scraft,.scraftz', help:'Import audio, MIDI or a SoundCraft session. Enable audio explicitly, then use the native transport to play. Save Session as a .scraftz bundle to include media; the download also becomes your last saved browser copy. Live edits are not autosaved. Closing the WebPC window suspends audio and retains this session until page reload. Reopening requires Enable audio again. Native recording and desktop plug-ins are not provided by this browser wrapper.' },
  filmcraft: { title:'FilmCraft', description:'Cut and mix video, audio and stills into films.', accept:'.fcproj,video/*,audio/*,image/*,.m2ts', help:'Open a .fcproj project or import video, audio or stills, then cut and mix on the native timeline. Save downloads the project file and keeps a browser copy of the last saved .fcproj; video, audio and caption exports download normally. Reopen saved restores that copy; changes after Save are not autosaved. Playback starts on your first click or key press in the editor, per browser autoplay rules.' },
  cadcraft: { title:'CADCraft', description:'Draw and edit CAD drawings (DXF, DWG).', accept:'.dxf,.dwg,.shx', help:'Open a .dxf drawing or import DXF, DWG or SHX files, then use the native drawing tools. Save downloads the DXF drawing and keeps a browser copy of the last saved .dxf; other exports download normally. Reopen saved restores that copy; changes after Save are not autosaved. A new WebPC session starts on the Start tab, not with a blank drawing.' },
  gridcraft: { title:'GridCraft', description:'Create and edit spreadsheets (XLSX, CSV, ODS).', accept:'.xlsx,.xlsm,.xls,.xlsb,.ods,.csv,.tsv,.txt,.slk,.json', help:'Open a spreadsheet or import XLSX, ODS, CSV and other grid formats, then work in the native grid. Save downloads the .xlsx workbook and keeps a browser copy of the last saved workbook; PDF exports download normally. Reopen saved restores that copy; changes after Save are not autosaved. A new WebPC session starts with an empty workbook.' },
  deckcraft: { title:'DeckCraft', description:'Build slide decks and present them.', accept:'.deckcraft,.pptx,.potx,.ppsx,.txt,.md', help:'Open a deck or a .txt/.md outline, or start blank, then use the native slide editor. Save downloads the deck in its own format and keeps a browser copy of the last saved .deckcraft or presentation file; PDF, picture and outline exports download normally. Reopen saved restores that copy; changes after Save are not autosaved. A new WebPC session starts with an empty presentation.' },
  vectorcraft: { title:'VectorCraft', mode:'standalone', open:'openFile', dirty:'docInspect', description:'Draw and edit vector illustrations.', accept:'.vectorcraft,.svg,.svgz,.pdf,.ai,.eps,.dxf,.emf,.wmf,image/*', help:'Open a .vectorcraft document or import SVG, PDF, AI and other vector formats, then draw with the native tools. Save downloads the document in its own format and keeps a browser copy of the last saved .vectorcraft; SVG, PDF and other exports download normally. Reopen saved restores that copy; changes after Save are not autosaved. A new WebPC session starts with an empty document.' },
  photocraft: { title:'PhotoCraft', mode:'standalone', open:'drop', description:'Edit photos and layers, non-destructively.', accept:'.pcraft,.psd,.psb,.xcf,.ora,.kra,.krz,.pdn,image/*', help:'Open a .pcraft document or import Photoshop, Krita, GIMP or flat images, then work in the native editor. Save downloads the document and keeps a browser copy of the last saved .pcraft; image exports download normally. Reopen saved restores that copy; changes after Save are not autosaved. Closing or reloading asks first while the open document has unsaved changes.' },
  effectcraft: { title:'EffectCraft', mode:'standalone', open:'addFile', loading:'loading', nosw:true, description:'Composite video, audio and images with effects.', accept:'.ecproj,video/*,audio/*,image/*', help:'Open a .ecproj project or import media, then composite on the native timeline. The project also keeps itself in EffectCraft’s own browser storage; File ▸ Save downloads the project and keeps a browser copy of the last saved .ecproj, and GIF, PNG and zip exports download normally. Audio starts on your first click or key press in the editor, per browser autoplay rules. Closing the WebPC window stops playback. A new WebPC session restores the last EffectCraft session.' },
  materialcraft: { title:'MaterialCraft', mode:'standalone', open:'drop', description:'Build shader graphs for game engines.', accept:'.sbs,.mcraft,image/*', help:'Open a .sbs or .mcraft package, or drop images in as bitmaps, then build the graph in the native editor. Save downloads the package and keeps a browser copy of the last saved package; other exports download normally. Reopen saved restores that copy; changes after Save are not autosaved. A new WebPC session starts with an empty graph.' },
  texturecraft: { title:'TextureCraft', mode:'standalone', open:'drop', description:'Bake and author textures for 3D meshes.', accept:'.tcraft,.glb,.gltf,.fbx,.dae,.obj,.stl,.ply', help:'Open a .tcraft project or import a mesh here (import images from the editor’s own File menu), then bake and author textures in the native editor. Save downloads the project and keeps a browser copy of the last saved .tcraft; texture-set and mesh exports download normally. Reopen saved restores that copy; changes after Save are not autosaved. Closing asks first while the project has unsaved changes.' },
};
const nativePatterns={
  pdfcraft:/\.pdf$/i,
  soundcraft:/\.scraftz$/i,
  filmcraft:/\.fcproj$/i,
  cadcraft:/(\.dxf|\.dwg)$/i,
  gridcraft:/\.xlsx$/i,
  deckcraft:/(\.deckcraft|\.pptx|\.potx|\.ppsx)$/i,
  vectorcraft:/\.vectorcraft$/i,
  photocraft:/\.pcraft$/i,
  effectcraft:/\.ecproj$/i,
  // The web save downloads an SBS package as a <name>_sbs.zip transport zip (web_files.rs:142).
  materialcraft:/(\.sbs|\.mcraft|_sbs\.zip)$/i,
  texturecraft:/\.tcraft$/i,
};
export function nativeSource(id) { const pattern=nativePatterns[id]; return pattern?pattern.source:null; }
export function nativeFile(id,name,bytes) {
  if(id==='figcraft'){
    if(/\.figcraft$/i.test(name))return true;
    if(!/\.json$/i.test(name))return false;
    // Variable/style JSON exports are not documents and must not replace recovery.
    try{const data=JSON.parse(new TextDecoder().decode(bytes));return data.format==='figcraft'&&Array.isArray(data.pages)&&data.nodes!==null&&typeof data.nodes==='object';}catch{return false;}
  }
  const pattern=nativePatterns[id];
  return pattern?pattern.test(name):false;
}
export function validSave(data) { return typeof data?.name==='string' && data.name.length>0 && data.name.length<=255 && (data.bytes instanceof ArrayBuffer || ArrayBuffer.isView(data.bytes)); }
