import {mkdir,readFile,writeFile,rename,rm,readdir,copyFile,access} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join,dirname} from 'node:path';
import {releases} from './craft/releases.mjs';
import {loadCatalog,appSources,isEnabled} from '../catalog/catalog.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url)),cache=join(root,'node_modules/.cache/webpc/craft');
const exists=async path=>{try{await access(path);return true;}catch{return false;}};
// What the PhotoCraft snippet workaround must do, keyed on archive contents (never on the
// pinned version): 'none' when the archive already ships app/snippets/, 'move-root' when it
// ships root snippets/ only, 'missing' when the caller must fail loudly.
export function snippetPlan(hasAppSnippets,hasRootSnippets){
  if(hasAppSnippets)return 'none';
  if(hasRootSnippets)return 'move-root';
  return 'missing';
}
// Pure (unit-tested): the pinned download plan for every enabled Craft app. The catalog is
// the only place a version, URL or checksum is written; version is the tag minus a leading v.
export function craftPlan(catalog){
  return Object.keys(releases).flatMap(id=>{
    if(!isEnabled(catalog,id))return [];
    const source=appSources(catalog,id,'github-release')[0];
    if(!source)throw new Error(`${id}: catalog.yaml has no github-release source`);
    return [{id,url:source.url,sha256:source.sha256,version:String(source.tag).replace(/^v/,''),repo:source.repo,tag:source.tag}];
  });
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  const bootstrap=await readFile(new URL('./craft/bootstrap.js',import.meta.url),'utf8');
  const audioGuard=await readFile(new URL('./static-apps/audio-guard.js',import.meta.url),'utf8');
  const fingerprint=createHash('sha256').update(bootstrap).update(audioGuard).update(await readFile(fileURLToPath(import.meta.url))).digest('hex');
  await mkdir(cache,{recursive:true});await mkdir(join(root,'public/pc/vendor'),{recursive:true});
  const catalog=loadCatalog();
  const plan=new Map(craftPlan(catalog).map(entry=>[entry.id,entry]));
  for(const id of Object.keys(releases)){
    const release=releases[id],entry=plan.get(id);
    if(!entry){console.log(`Skipped ${id}: disabled in catalog.yaml.`);continue;}
    const {url,sha256,version,repo,tag}=entry;
    const output=join(root,'public/pc/vendor',id),marker=join(output,'.release.json');
    try{const installed=JSON.parse(await readFile(marker,'utf8'));await access(join(output,'index.html'));if(installed.sha256===sha256&&installed.fingerprint===fingerprint){console.log(`${release.title} ${version} already prepared.`);continue;}}catch{}
    const zip=join(cache,`${id}-${version}.zip`);let bytes;
    try{bytes=await readFile(zip);}catch{console.log(`Downloading ${release.title} ${version}…`);const response=await fetch(url,{signal:AbortSignal.timeout(180000)});if(!response.ok)throw new Error(`${id}: HTTP ${response.status}`);bytes=Buffer.from(await response.arrayBuffer());}
    if(createHash('sha256').update(bytes).digest('hex')!==sha256)throw new Error(`${id}: checksum mismatch; no assets replaced.`);
    await writeFile(zip,bytes);
    const names=execFileSync('unzip',['-Z1',zip],{encoding:'utf8'}).trim().split('\n');
    if(names.some(name=>name.startsWith('/')||name.includes('\\')||name.split('/').includes('..')))throw new Error(`${id}: unsafe archive path`);
    const stage=`${output}.staging-${process.pid}`;await mkdir(stage,{recursive:true});
    try{
      execFileSync('unzip',['-q',zip,'-d',stage]);const payload=join(stage,`${id}-web-${version}`);
      async function prune(dir){for(const entry of await readdir(dir,{withFileTypes:true})){const path=join(dir,entry.name);if(entry.isDirectory())await prune(path);else if(/\.(br|gz)$/.test(entry.name)||['_headers','.htaccess'].includes(entry.name))await rm(path);}}
      await prune(payload);
      if(id==='photocraft'){ // some archive ships its eframe snippet at root snippets/ only, but the app imports it from app/snippets/
        const target=join(payload,'app','snippets'),fix=snippetPlan(await exists(target),await exists(join(payload,'snippets')));
        if(fix==='missing')throw new Error(`${id}: archive has neither snippets/ nor app/snippets/`);
        if(fix==='move-root'){
          async function copyTree(src,dest){await mkdir(dest,{recursive:true});for(const entry of await readdir(src,{withFileTypes:true})){const s=join(src,entry.name),d=join(dest,entry.name);if(entry.isDirectory())await copyTree(s,d);else await copyFile(s,d);}}
          await copyTree(join(payload,'snippets'),target);
        }
      }
      // Each marker must appear exactly once: a silent miss would ship without the audio guard or bootstrap.
      const once=(text,from,to)=>{if(text.split(from).length!==2)throw new Error(`${id}: index.html must contain ${from} exactly once; upstream changed, refusing to prepare.`);return text.replace(from,to);};
      let html=await readFile(join(payload,'index.html'),'utf8');html=once(once(html,'<html lang="en">',`<html lang="en" data-webpc-app="${id}">`),'<head>','<head>\n<script src="./webpc-audio-guard.js"></script>\n<script src="./webpc-bootstrap.js"></script>');
      await writeFile(join(payload,'index.html'),html);await writeFile(join(payload,'webpc-audio-guard.js'),audioGuard);await writeFile(join(payload,'webpc-bootstrap.js'),bootstrap);
      const notice=join(root,'public/third-party',id);await mkdir(notice,{recursive:true});
      async function notices(dir,relative=''){for(const entry of await readdir(dir,{withFileTypes:true})){const path=join(dir,entry.name),rel=join(relative,entry.name);if(entry.isDirectory())await notices(path,rel);else if(/^(LICENSE|NOTICE|OFL|ATTRIBUTION)|\.LICEN[CS]E(?:\.txt)?$/i.test(entry.name)){const target=join(notice,rel);await mkdir(dirname(target),{recursive:true});await copyFile(path,target);}}}
      await notices(payload);
      await writeFile(join(notice,'WEBPC.txt'),`${release.title} ${version}\nUpstream: https://github.com/${repo}/tree/${tag}\nRelease: ${url}\nSHA-256: ${sha256}\nOfficial WASM, JavaScript and embedded assets are preserved. WebPC injects a shared audio guard (webpc-audio-guard.js) and a small entry script (webpc-bootstrap.js) for storage safety, focus, session handling and the SoundCraft Enable-audio gate. Precompressed siblings and hosting-specific header templates are omitted. See docs/webpc/craft-apps.md.\n${id==='photocraft'?'Packaging workaround: this archive ships its eframe snippet at root snippets/ only, while the app imports it from app/snippets/, so preparation copies snippets/ to app/snippets/ (skipped when the archive already ships app/snippets/).\n':''}`);
      await writeFile(join(payload,'.release.json'),JSON.stringify({...release,version,sha256,url,fingerprint}));
      await rm(output,{recursive:true,force:true});await rename(payload,output);
    }finally{await rm(stage,{recursive:true,force:true});}
    console.log(`Prepared ${release.title} ${version}.`);
  }
}
