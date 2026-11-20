import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import {nativeFile,nativeSource,validSave,releases} from '../scripts/pc/craft/releases.mjs';
import {craftPlan,snippetPlan} from '../scripts/pc/prepare-craft.mjs';
import {appSources,isEnabled} from '../scripts/catalog/catalog.mjs';
const json=value=>new TextEncoder().encode(JSON.stringify(value));
const base=()=>parse(readFileSync(new URL('../catalog.yaml',import.meta.url),'utf8'));
test('Craft recovery accepts native documents without replacing them with exports',()=>{
  assert.equal(nativeFile('figcraft','design.figcraft'),true);
  assert.equal(nativeFile('figcraft','design.json',json({format:'figcraft',version:1,pages:[1],nodes:{1:{type:'page'}}})),true);
  for(const [name,data] of [['variables.json',{collections:[]}],['styles.json',{format:'figcraft',styles:[]}],['broken.json','{bad']])assert.equal(nativeFile('figcraft',name,json(data)),false);
  assert.equal(nativeFile('figcraft','preview.png'),false);
  assert.equal(nativeFile('soundcraft','session.scraftz'),true);
  assert.equal(nativeFile('soundcraft','session.scraft'),false,'plain session may omit media');
  assert.equal(nativeFile('soundcraft','mix.wav'),false);
  assert.equal(nativeFile('pdfcraft','document.PDF'),true);
  assert.equal(nativeFile('lightcraft','photo.png'),false,'native LightCraft owns its library');
  assert.equal(nativeFile('filmcraft','edit.fcproj'),true);
  assert.equal(nativeFile('filmcraft','Edit.FCPROJ'),true);
  assert.equal(nativeFile('filmcraft','final.mp4'),false,'video exports are not projects');
  assert.equal(nativeFile('filmcraft','mix.wav'),false);
  assert.equal(nativeFile('cadcraft','drawing.dxf'),true);
  assert.equal(nativeFile('cadcraft','Drawing.DXF'),true);
  assert.equal(nativeFile('cadcraft','drawing.dwg'),true,'DWG is a selectable save format');
  assert.equal(nativeFile('cadcraft','drawing.svg'),false,'SVG is an export');
  assert.equal(nativeFile('cadcraft','symbols.shx'),false);
  assert.equal(nativeFile('gridcraft','budget.xlsx'),true);
  assert.equal(nativeFile('gridcraft','Budget.XLSX'),true);
  assert.equal(nativeFile('gridcraft','budget.pdf'),false,'PDF export is a copy');
  assert.equal(nativeFile('gridcraft','data.csv'),false,'CSV imports are not workbooks');
  assert.equal(nativeFile('deckcraft','talk.deckcraft'),true);
  assert.equal(nativeFile('deckcraft','talk.pptx'),true,'a .pptx keeps its format on Save');
  assert.equal(nativeFile('deckcraft','template.potx'),true);
  assert.equal(nativeFile('deckcraft','show.pdf'),false,'PDF export is a copy');
  assert.equal(nativeFile('deckcraft','outline.md'),false,'outlines open untitled');
  assert.equal(nativeFile('vectorcraft','art.vectorcraft'),true);
  assert.equal(nativeFile('vectorcraft','Art.VECTORCRAFT'),true);
  assert.equal(nativeFile('vectorcraft','art.svg'),false,'SVG is an export');
  assert.equal(nativeFile('vectorcraft','art.pdf'),false);
  assert.equal(nativeFile('photocraft','photo.pcraft'),true);
  assert.equal(nativeFile('photocraft','photo.psd'),false,'PSD imports are not PhotoCraft documents');
  assert.equal(nativeFile('effectcraft','project.ecproj'),true);
  assert.equal(nativeFile('effectcraft','clip.mp4'),false,'media imports are not projects');
  assert.equal(nativeFile('materialcraft','graph.sbs'),true);
  assert.equal(nativeFile('materialcraft','graph.mcraft'),true);
  assert.equal(nativeFile('materialcraft','graph_sbs.zip'),true,'web save downloads the transport zip');
  assert.equal(nativeFile('materialcraft','texture.png'),false,'images import as bitmaps');
  assert.equal(nativeFile('texturecraft','project.tcraft'),true);
  assert.equal(nativeFile('texturecraft','project_textures.zip'),false,'texture-set export');
  assert.equal(nativeFile('texturecraft','mesh.glb'),false,'meshes import, projects open');
});
test('Standalone entries carry a mode, an open method and a rebuildable native pattern (pins live in the catalog)',()=>{
  const standalone=Object.entries(releases).filter(([,r])=>r.mode==='standalone');
  assert.ok(standalone.length>=6,'all six no-protocol apps are standalone');
  for(const [id,entry] of standalone){
    assert.ok(entry.open,`${id} declares how it opens files`);
    assert.ok(entry.accept&&entry.help,`${id} declares open formats and help`);
    assert.ok(nativeSource(id),`${id} has a native pattern`);
  }
  const entry=releases.vectorcraft;
  assert.equal(entry.open,'openFile');
  assert.equal(entry.dirty,'docInspect','documented docInspect reports a dirty flag');
  for(const [id,other] of standalone)if(id!=='vectorcraft')assert.equal(other.dirty,undefined,`${id} documents no dirty field: conservative fallback`);
  assert.equal(releases.effectcraft.open,'addFile');
  assert.equal(releases.effectcraft.loading,'loading');
  assert.equal(releases.photocraft.open,'drop');
  assert.equal(releases.materialcraft.open,'drop');
  assert.equal(releases.texturecraft.open,'drop');
  assert.equal(releases.soundcraft.open,'drop');
  assert.equal(releases.soundcraft.loading,'soundcraft_loading');
  assert.ok(new RegExp(nativeSource('soundcraft'),'i').test('session.scraftz'),'pattern rebuilds case-insensitive');
  assert.ok(new RegExp(nativeSource('vectorcraft'),'i').test('x.vectorcraft'),'pattern rebuilds case-insensitive');
  assert.equal(nativeFile('vectorcraft','x.vectorcraft'),true,'nativeFile agrees with nativeSource');
  for(const [id] of standalone)assert.equal('sha256' in releases[id],false,`${id} no longer pins a checksum here; catalog.yaml does`);
});
test('Craft save messages need a bounded filename and actual binary data',()=>{
  assert.equal(validSave({name:'a.pdf',bytes:new Uint8Array([1,2])}),true);
  assert.equal(validSave({name:'a.pdf',bytes:new ArrayBuffer(2)}),true);
  for(const value of [null,{}, {name:'a.pdf',bytes:[1,2]}, {name:'',bytes:new ArrayBuffer(1)}, {name:'x'.repeat(256),bytes:new ArrayBuffer(1)}])assert.equal(validSave(value),false);
});
test('craftPlan takes every enabled app\'s pin from the catalog (no version/URL/sha256 in the preparer)',()=>{
  const catalog=base();
  const plan=craftPlan(catalog);
  assert.deepEqual(plan.map(e=>e.id),Object.keys(releases),'one plan entry per Craft app, in releases.mjs order');
  for(const entry of plan){
    const source=appSources(catalog,entry.id,'github-release')[0];
    assert.equal(entry.url,source.url,'url comes from catalog.yaml');
    assert.equal(entry.sha256,source.sha256,'sha256 comes from catalog.yaml');
    assert.equal(entry.version,String(source.tag).replace(/^v/,''),'version is the tag without a leading v');
  }
});
test('craftPlan skips a disabled app and keeps the rest',()=>{
  const byId=(c,id)=>{const a=c.apps.find(x=>x.id===id);if(!a)throw new Error(`no app ${id}`);return a;};
  const catalog=base();
  const disabledId=Object.keys(releases).find(id=>isEnabled(catalog,id));
  byId(catalog,disabledId).enabled=false;
  const plan=craftPlan(catalog);
  assert.ok(!plan.some(e=>e.id===disabledId),`the disabled app (${disabledId}) is not planned`);
  assert.equal(plan.length,Object.keys(releases).length-1,'every other Craft app is still planned');
});
test('snippetPlan is keyed on archive contents, not the pinned version',()=>{
  assert.equal(snippetPlan(true,true),'none','app/snippets/ present: nothing to do');
  assert.equal(snippetPlan(false,true),'move-root','root snippets/ only: copy it into app/snippets/');
  assert.equal(snippetPlan(false,false),'missing','neither location: the caller must fail loudly');
  assert.equal(snippetPlan(true,false),'none','app/snippets/ wins even without root snippets/');
});
