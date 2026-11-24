import { ModelClient } from './model-client.js';
import { CloudClient } from './cloud-client.js';
import { ChromeModelClient, chromeAvailability, chromeExecutors, chromeDownload, chromeToolGates, CHROME_TOOL_APIS } from './chrome-ai.js';
import { pickFile } from './picker.mjs';
import { createFileHost } from './files-host.js';
import { createSearchHost } from './search-host.js';
import { AgentSession } from './session.js';
import { ConversationStore, validateConversation, MODEL_KEY, LEGACY_MODEL_KEY } from './storage.js';
import { MODELS, DEFAULT_MODEL } from './models.js';
import { checkImage, IMAGE_MAX_SIDE } from './agent.js';
import { dataUrlBytes } from './cloud.js';
import { webSearch, httpGet } from './web.js';
import { runJavaScript } from './sandbox.js';
import * as fileStore from './store.mjs';
import { resolveInGrants } from './file-tools.js';
import { BGBM_ENGINES, ocrTextResult, nobgName, nobgTarget, downscalePlan, OCR_MAX_DIM, MAX_IMAGE_BYTES, validateImageFile, visionToolsEnabled } from './vision-tools.js';
import { createExecClient } from './exec-client.js';
import { createAgent, createPolicy, craftApi } from './runtime/index.mjs';
import { initHelp, licenseNotice, modelKindLine, stripApps } from './help.js';
import { renderMarkdown } from './markdown.js';
import { createFilesCtx } from './runtime/files-ctx.mjs';
import { createThreadStore, ThreadLimitError } from './threads.js';
import { createSharedModel } from './shared-model.js';
// The welcome icons are clones of the desktop's own .pc-app-icon nodes: Buddy runs
// in the desktop's same-origin iframe, so the strip and the starters reuse the
// exact <img> or <svg> the desktop draws. The desktop's tile CSS (the .pc-icon-<id>
// gradient, white glyph) does not apply inside Buddy, so the source's computed
// background, color and padding (scaled to 28 px) are copied onto the clone.
// Without a parent desktop (the standalone /pc/apps/ai-agent/ route) or without a
// match, a round letter badge.
const appIcon = (id, title) => {
  let source = null;
  try { source = parent.document.querySelector(`.pc-app-icon.pc-icon-${CSS.escape(id)}`); } catch { /* cross-origin parent */ }
  if (source) {
    const icon = source.cloneNode(true);
    icon.setAttribute('aria-hidden', 'true');
    icon.removeAttribute('id');
    icon.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
    icon.classList.add('strip-icon');
    const cs = parent.getComputedStyle(source);
    const pad = (parseFloat(cs.paddingTop) || 0) * (28 / (source.offsetWidth || 54));
    icon.style.cssText = `background-color:${cs.backgroundColor};background-image:${cs.backgroundImage};color:${cs.color};padding:${pad}px`;
    return icon;
  }
  const icon = document.createElement('span');
  icon.className = 'strip-icon strip-badge';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = String(title ?? '?').trim().charAt(0).toUpperCase();
  return icon;
};
const $ = id => document.getElementById(id);
// ?eval=1 trace hook: when the page URL has ?eval=1, every tool call is recorded into
// window.__buddyTrace as { name, arguments, ok, errorType, result } so an eval runner can
// read the exact calls and their outcomes. Without the flag nothing is recorded and
// behaviour is unchanged.
const EVAL_TRACE = new URLSearchParams(location.search).get('eval') === '1';
if (EVAL_TRACE) window.__buddyTrace = [];
const traceStart = (name, args) => { if (EVAL_TRACE) window.__buddyTrace.push({ name, arguments: args }); };
const traceResult = (name, args, result) => {
  if (!EVAL_TRACE) return;
  const entries = window.__buddyTrace;
  let entry = null;
  for (let i = entries.length - 1; i >= 0; i--) { if (entries[i].name === name && !('ok' in entries[i])) { entry = entries[i]; break; } }
  if (!entry) { entry = { name, arguments: args }; entries.push(entry); }
  entry.ok = !result?.error;
  entry.errorType = result?.error && typeof result.error === 'object' ? (result.error.type ?? 'error') : (result?.error ? 'error' : null);
  try { entry.result = JSON.parse(JSON.stringify(result)); } catch { entry.result = { unserializable: true }; }
};
// Cloud models are opt-in per session: the key lives only in CloudClient's memory and is never persisted.
const CLOUD_MODELS = { 'cloud:anthropic': 'Claude · cloud (your key)', 'cloud:openai': 'OpenAI-compatible · cloud (your key)' };
const isCloud = key => Boolean(CLOUD_MODELS[key]);
const CHROME_MODEL = 'chrome:builtin'; const isChrome = key => key === CHROME_MODEL;
const store = new ConversationStore(); let initialized = false, loading = false, loadVersion = 0, loadError = null, selected = DEFAULT_MODEL, pendingImage = null;
let threads = null; // the thread store, built at startup from idb-keyval (see the startup section)
try { const saved = localStorage.getItem(MODEL_KEY) ?? localStorage.getItem(LEGACY_MODEL_KEY); if (MODELS[saved]) selected = saved; } catch {}
for (const [key, model] of Object.entries(MODELS)) $('model').add(new Option(`${model.label} · ${model.size}`, key));
for (const [key, label] of Object.entries(CLOUD_MODELS)) $('model').add(new Option(label, key));
$('model').value = selected;
const cloud = new CloudClient();
const chrome = new ChromeModelClient(self);
// The facade (with clientRef, defined below) points every thread at whichever backend is active:
// the local worker, the BYOK cloud client or Chrome's on-device model.
const status = text => { $('status').textContent = text; };
const error = text => { $('error').textContent = text; $('error').hidden = !text; };
function storageError(text) { $('storage-warning').hidden = false; $('storage-warning').querySelector('span').textContent = `${text} Your chat is still in memory; export it before closing.`; $('save-state').textContent = 'Not saved — export your chat'; }
function controls() {
  $('load-model').disabled = !initialized || loading || Boolean(session.active) || client.ready || isCloud(selected) || (isChrome(selected) && chrome.ready);
  $('stop').disabled = !(loading || session.active || client.ready || cloud.ready || chrome.ready);
  $('send').disabled = !initialized || Boolean(session.active) || !$('message').value.trim();
  $('new-chat').disabled = !initialized; $('import').disabled = !initialized; $('previous').disabled = !initialized; $('chats').disabled = !initialized;
  $('model-state').textContent = loading ? 'Loading…' : cloud.ready ? `Cloud · ${cloud.host}` : isChrome(selected) && chrome.ready ? 'Chrome · on device' : client.ready ? session.active ? 'Working locally' : 'Ready · on device' : 'Not loaded';
  imageInputControls();
}
// Image input is offered by the Qwen vision models and by an active cloud model; LFM3 and the on-device
// Chrome model are text-only.
function imageInputControls() {
  const cloudSelected = isCloud(selected);
  const vision = Boolean(MODELS[selected]?.vision) || (cloudSelected && cloud.ready);
  const box = $('image-input');
  box.disabled = !vision || loading || Boolean(session.active);
  if (!vision) box.checked = false;
  $('attach').disabled = !box.checked || loading || Boolean(session.active);
  $('image-label').dataset.help = `Attach PNG, JPEG or WebP images up to 10 MB for Qwen models to read. Images are not saved; the chat keeps a text marker. ${isChrome(selected) ? 'Chrome built-in model is text-only' : cloudSelected ? (cloud.ready ? `sent to ${cloud.host}` : 'enable it in Settings') : (MODELS[selected]?.vision ? `+${MODELS[selected].vision.size} when first used` : 'Qwen models only')}`;
  applyVisionGates();
}
const nearBottom = () => $('conversation').scrollHeight - $('conversation').scrollTop - $('conversation').clientHeight < 100;
function follow(wasNear) { if (wasNear) $('conversation').scrollTop = $('conversation').scrollHeight; }
function message(role, content = '') {
  const near = nearBottom(); $('welcome').hidden = true;
  const root = document.createElement('article'); root.className = `message ${role}`;
  const label = document.createElement('div'); label.className = 'message-label'; label.textContent = role === 'user' ? 'You' : 'Buddy';
  const body = document.createElement('div'); body.className = 'message-body';
  if (role === 'assistant') body.replaceChildren(renderMarkdown(content)); else body.textContent = content;
  root.append(label, body); $('messages').append(root); follow(near); return body;
}
function toolCard(data) {
  const root = document.createElement('details'); root.className = 'tool';
  const label = document.createElement('summary'); label.textContent = `${data.name} · running`;
  const body = document.createElement('pre'); body.textContent = JSON.stringify(data.arguments, null, 2);
  root.append(label, body); $('messages').append(root); data.element = root; return root;
}
function toolResult(card, result) {
  card.element.querySelector('summary').textContent = `${card.name} · ${result.error ? 'could not complete' : 'complete'}`;
  card.element.querySelector('pre').textContent = JSON.stringify({ arguments: card.arguments, result }, null, 2);
}
function render(value) {
  $('messages').replaceChildren(); $('welcome').hidden = value.history.length > 0;
  const cards = new Map();
  for (const item of value.history) {
    if (item.role === 'tool') { const card = cards.get(item.tool_call_id); if (card) { let result; try { result = JSON.parse(item.content); } catch { result = { content: item.content }; } toolResult(card, result); } }
    else {
      if (item.content) message(item.role, item.content);
      for (const call of item.tool_calls ?? []) { const card = { ...call.function }; toolCard(card); cards.set(call.id, card); }
    }
  }
  $('conversation').scrollTop = value.history.length ? $('conversation').scrollHeight : 0;
}
const client = new ModelClient({ failure: err => { error(err.message); controls(); }, progress: data => {
  if (!loading) return;
  const percent = Number(data.progress); $('progress').hidden = false;
  if (Number.isFinite(percent)) { $('progress').max = 100; $('progress').value = percent; }
  else $('progress').removeAttribute('value');
  status(`${data.status ?? 'Loading'}${data.file ? ` · ${data.file}` : ''}${Number.isFinite(percent) ? ` · ${Math.round(percent)}%` : ''}`);
} });
// Chrome built-in AI (on-device): a tool is offered only when its API reports 'available' — a
// model-initiated create() has no user gesture to start Chrome's own download. The Settings buttons
// for 'downloadable' APIs are that gesture; on success availability is re-checked and the tool appears.
const chromeTools = {}; let chromeAvail = null, chromeExec_ = null, chromeDownloading = false;
chromeAvailability(self).then((availability) => {
  chromeAvail = availability; chromeExec_ = chromeExecutors(self, status);
  applyChromeGates(); renderChromeStatus();
  if (availability.languageModel !== 'unavailable') { $('model').add(new Option('Chrome built-in · on-device', CHROME_MODEL)); controls(); }
});
function applyChromeGates() {
  const gates = chromeToolGates(chromeAvail);
  chromeTools.translate = gates.translate ? chromeExec_.translate : null;
  chromeTools.summarize = gates.summarize ? chromeExec_.summarize : null;
  chromeTools.detectLanguage = gates.detectLanguage ? chromeExec_.detectLanguage : null;
}
function renderChromeStatus() {
  const box = $('chrome-downloads'); box.replaceChildren();
  if (!chromeAvail) return;
  $('chrome-status').textContent = [['Prompt API (chat)', chromeAvail.languageModel], ['Translator', chromeAvail.translator], ['Summarizer', chromeAvail.summarizer], ['Language detector', chromeAvail.detector]].map(([name, s]) => `${name}: ${s}`).join(' · ');
  for (const [toolKey, api] of Object.entries(CHROME_TOOL_APIS)) {
    if (chromeAvail[api.availabilityKey] !== 'downloadable') continue;
    const b = document.createElement('button');
    b.textContent = `Download ${api.label} model`;
    b.disabled = chromeDownloading;
    b.addEventListener('click', () => chromeDownloadTool(toolKey, api));
    box.append(b);
  }
}
async function chromeDownloadTool(toolKey, api) {
  chromeDownloading = true; renderChromeStatus();
  try {
    await chromeDownload(self, toolKey, status); // the click is the user gesture Chrome's create() needs
    chromeAvail = await chromeAvailability(self); // re-check so the tool appears once the download completes
    applyChromeGates();
    status(`Chrome ${api.label} model ready.`);
  } catch (err) {
    if (err.name !== 'AbortError') status(`Chrome ${api.label} model download failed: ${err?.message ?? err}`);
  } finally { chromeDownloading = false; renderChromeStatus(); }
}
// ---------- files (grants + search index, AI-2/AI-3) ----------
// Grants are per session: they live only in this page's memory and are cleared on reload (fresh
// page) and when the app closes. They are never written to IndexedDB, localStorage or exports.
const fileGrants = [];
const fileHost = createFileHost({ grants: fileGrants, note: status });
const fileTools = { grants: null };
// The search index is per session too: memory only, cleared with the grants, offered while it has
// chunks. Its embedding model (about 23 MB, Hugging Face, pinned revision) runs in its own worker
// on the WASM device and is downloaded only by the explicit Build click.
let indexAbort = null;
const embedClient = new ModelClient({
  createWorker: () => new Worker(new URL('./embed-worker.js', import.meta.url), { type: 'module' }),
  progress: (p) => { if (indexAbort && p.file) searchStatus(`Downloading ${p.file}: ${p.total ? Math.round(p.progress ?? 0) + '%' : Math.round((p.loaded ?? 0) / 1024) + ' KB'}`); },
});
const searchHost = createSearchHost({ grants: fileGrants, embed: (texts) => embedClient.embed(texts), note: searchStatus, onState: applyFileGates });
function searchStatus(text) { $('files-index-status').textContent = text; }
async function searchFiles(query, k) {
  // A reload of the worker happens only after a Cancel terminated it; with an index present the
  // model files are already fetched (and cached) by the Build click, so this adds no new download.
  if (!embedClient.ready) await embedClient.load('embed');
  return searchHost.search(query, k);
}
function renderIndexControls() {
  const busy = indexAbort !== null;
  $('files-build').disabled = busy || !fileGrants.length;
  $('files-cancel-index').disabled = !busy;
  $('files-build').textContent = searchHost.has() ? 'Rebuild search index' : 'Build search index · 23 MB';
}
function applyFileGates() {
  const on = fileGrants.length > 0;
  fileTools.grants = on ? [...fileGrants] : null;
  fileTools.list = on ? fileHost.list : undefined;
  fileTools.read = on ? fileHost.read : undefined;
  fileTools.write = on ? fileHost.write : undefined;
  fileTools.search = searchHost.has() ? searchFiles : undefined;
  renderIndexControls();
  applyVisionGates();
}
function renderFileGrants() {
  const box = $('files-grants'); box.replaceChildren();
  if (!fileGrants.length) { box.textContent = 'No grants yet.'; return; }
  for (const grant of fileGrants) {
    const row = document.createElement('p');
    const label = document.createElement('span');
    label.textContent = `${grant.kind === 'folder' ? '▸ ' : '▪ '}${grant.root || '(Files root)'} · ${grant.kind}`;
    const revoke = document.createElement('button');
    revoke.textContent = 'Revoke';
    revoke.addEventListener('click', () => { fileGrants.splice(fileGrants.indexOf(grant), 1); searchHost.revokeGrant(grant); applyFileGates(); renderFileGrants(); });
    row.append(label, ' ', revoke); box.append(row);
  }
}
$('files-grant').addEventListener('click', async () => {
  error('');
  const picked = await pickFile({ select: 'any', title: 'Give Buddy access to…' });
  if (!picked) return;
  const grant = picked.name != null ? { root: picked.path, kind: 'file' } : { root: picked.path, kind: 'folder' };
  if (fileGrants.some((g) => g.root === grant.root && g.kind === grant.kind)) { status('Already granted.'); return; }
  fileGrants.push(grant); applyFileGates(); renderFileGrants();
  status(`Granted ${grant.kind} "${grant.root || '(Files root)'}". ${isCloud(selected) ? 'Note: with a cloud model, file contents Buddy reads are sent to that provider.' : ''}`);
});
$('files-build').addEventListener('click', async () => {
  error('');
  if (!fileGrants.length || indexAbort) return;
  indexAbort = new AbortController();
  renderIndexControls();
  searchStatus('Downloading the search model (about 23 MB, Hugging Face) and indexing the granted files…');
  try {
    if (!embedClient.ready) await embedClient.load('embed');
    await searchHost.indexFiles({ signal: indexAbort.signal });
  } catch (err) {
    if (err.name === 'AbortError') searchStatus('Cancelled — the index keeps what it already had.');
    else error(err.message);
  } finally {
    indexAbort = null;
    applyFileGates();
  }
});
$('files-cancel-index').addEventListener('click', () => { indexAbort?.abort(); embedClient.stop(); });
// ---------- vision tools (AI-7/AI-8): OCR + background removal ----------
// Each runs in its own worker (vision-worker.js) on the pinned local models, independent of the
// chat model: first use downloads the model with a size disclosure in the status line, then
// everything runs on this device. Tools are offered while an attached image is possible (image
// input) or a file grant is present; 'attached' resolves to the image attached to the current turn.
const VISION_ENGINE_KEY = 'webpc-ai-agent-vision-engine';
const visionTools = { engine: 'modnet', ocr: undefined, remove: undefined };
{ const savedEngine = localStorage.getItem(VISION_ENGINE_KEY); if (BGBM_ENGINES.some((e) => e.id === savedEngine)) visionTools.engine = savedEngine; }
let visionWorker = null, visionSeq = 0;
const visionPending = new Map();
function visionWorkerStop() {
  const error = new Error('Stopped.');
  for (const wait of visionPending.values()) wait.reject(error);
  visionPending.clear();
  visionWorker?.terminate(); visionWorker = null;
}
function visionRequest(type, payload) {
  if (!visionWorker) {
    visionWorker = new Worker(new URL('./vision-worker.js', import.meta.url), { type: 'module' });
    visionWorker.onmessage = ({ data }) => {
      if (data.type === 'progress') {
        const total = Number(data.total);
        status(`Downloading vision model${total ? ` · about ${Math.round(total / 1048576)} MB from Hugging Face` : ''}${data.message ? ` · ${data.message}` : ''}${data.file && data.file !== 'fallback' ? ` · ${data.file}` : ''}`);
        return;
      }
      const wait = visionPending.get(data.id);
      if (!wait) return;
      visionPending.delete(data.id);
      if (data.type === 'done') wait.resolve(data);
      else wait.reject(new Error(data.message));
    };
    visionWorker.onerror = () => visionWorkerStop(); // uncaught worker error: drop the worker, reject the waiters
  }
  const id = `vision-${Date.now()}-${visionSeq++}`;
  return new Promise((resolve, reject) => {
    visionPending.set(id, { resolve, reject });
    visionWorker.postMessage({ ...payload, type, id });
  });
}
// Resolve the tool's `source`: 'attached' (this turn's image) or a path of an image inside a grant.
async function visionSource(source) {
  if (source === 'attached') {
    if (!pendingImage) return { error: 'No image is attached to this message. Attach one with the paperclip, or pass a path of an image inside a granted folder.' };
    const canvas = document.createElement('canvas'); canvas.width = pendingImage.width; canvas.height = pendingImage.height;
    canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(pendingImage.data), pendingImage.width, pendingImage.height), 0, 0);
    const blob = await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode the attached image.'))), 'image/png'));
    return { blob, name: pendingImage.name };
  }
  if (!fileGrants.length) return { error: 'No file grants. Use source "attached" for the attached image, or grant a folder in Settings.' };
  const resolved = resolveInGrants(fileGrants, source);
  if (resolved.error) return resolved;
  const slash = resolved.path.lastIndexOf('/');
  const base = slash >= 0 ? resolved.path.slice(slash + 1) : resolved.path;
  const parent = slash >= 0 ? resolved.path.slice(0, slash) : '';
  let kind, data;
  try {
    kind = await fileStore.exists(parent, base);
    if (kind === 'folder') return { error: `"${resolved.path}" is a folder; ocr_image and remove_background take an image file.` };
    if (kind === null) return { error: `"${resolved.path}" does not exist inside the grants.` };
    ({ data } = await fileStore.read(parent, base));
  } catch { return { error: `"${resolved.path}" could not be read inside the grants.` }; }
  const problem = validateImageFile({ name: base, type: data.type ?? '', size: data.size });
  if (problem) return { error: problem };
  return { blob: data, name: base, path: resolved.path };
}
const ocrImage = async (source) => {
  const src = await visionSource(source);
  if (src.error) return src;
  try {
    const { text } = await visionRequest('ocr', { image: await src.blob.arrayBuffer() });
    return { text: ocrTextResult(text), source: src.name };
  } catch (err) { return { error: err.message === 'Stopped.' ? 'OCR was stopped.' : err.message }; }
};
// One channel for the Files app's refresh broadcasts: a per-save channel would leak a port on every save.
const filesChangeChannel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('webpc-files') : null;
const removeBackground = async (source) => {
  const src = await visionSource(source);
  if (src.error) return src;
  const engine = BGBM_ENGINES.find((e) => e.id === visionTools.engine) ?? BGBM_ENGINES[0];
  try {
    const done = await visionRequest('bgbm', { image: await src.blob.arrayBuffer(), model: engine.id });
    const png = done.png;
    if (src.path) {
      // Granted source: the write target needs a covering FOLDER grant before the save gate (same gate as write_file).
      const gate = nobgTarget(fileGrants, src.path);
      if (gate.error) return gate;
      const target = gate.target;
      const slash = target.lastIndexOf('/');
      const base = slash >= 0 ? target.slice(slash + 1) : target;
      const parent = slash >= 0 ? target.slice(0, slash) : '';
      try { await fileStore.list(parent); } catch { return { error: `The folder "${parent}" does not exist yet; cannot save "${base}".` }; }
      const kind = await fileStore.exists(parent, base);
      if (kind === 'folder') return { error: `"${base}" is a folder; cannot save the background-removed image there.` };
      await fileStore.write(parent, base, new Uint8Array(await png.arrayBuffer()));
      filesChangeChannel?.postMessage({ type: 'changed' });
      status(`Saved ${target}.`);
      return { saved: target, width: done.width, height: done.height, overwritten: kind === 'file' };
    }
    // Attached source: there is no grant to save into — offer a download instead.
    const name = nobgName(src.name);
    const url = URL.createObjectURL(png);
    const link = document.createElement('a'); link.href = url; link.download = name; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return { download: name, width: done.width, height: done.height, note: 'Download started — check the browser downloads.' };
  } catch (err) { return { error: err.message === 'Stopped.' ? 'Background removal was stopped.' : err.message }; }
};
function visionEnabled() {
  // Attached image possible: a Qwen vision model, or a confirmed cloud model (image input is offered there).
  return visionToolsEnabled({ grants: fileGrants, imageInput: Boolean(MODELS[selected]?.vision) || (isCloud(selected) && cloud.ready) });
}
function applyVisionGates() {
  const on = visionEnabled();
  visionTools.ocr = on ? ocrImage : undefined;
  visionTools.remove = on ? removeBackground : undefined;
}
function renderVisionEngine() {
  $('vision-engine').value = visionTools.engine;
  const engine = BGBM_ENGINES.find((e) => e.id === visionTools.engine) ?? BGBM_ENGINES[0];
  // The download facts live on the select's data-help (the card's help dot has the
  // tool prose); #vision-note is kept for ids but stays empty and hidden.
  $('vision-engine').dataset.help = `ocr_image downloads the OCR model (about 262 MB) once; remove_background downloads about ${engine.sizeMB} MB (${engine.name}) on first use. After that both run on this device and send nothing.`;
}
$('vision-engine').addEventListener('change', () => {
  visionTools.engine = $('vision-engine').value;
  try { localStorage.setItem(VISION_ENGINE_KEY, visionTools.engine); } catch {}
  renderVisionEngine();
});
applyFileGates(); renderFileGrants();
// AI-4: the run_code tool reaches the Linux terminal app's exec service over a same-origin
// BroadcastChannel: the terminal page runs the code in its guest at once (no approval prompt).
// exec-client.js owns the pending map, the per-run wall timer, the 20 KB output cap and the
// grace on not-running/busy (wait graceMs for the terminal page's exec-pending before failing).
const execChannel = new BroadcastChannel('webpc-terminal');
const exec = createExecClient(execChannel);
const runCode = (lang, code, timeoutMs) => exec.run(lang, code, timeoutMs);
// Agent mode: Buddy reaches the desktop, Files and every app pack through the six meta tools.
// The desktop API exists only when Buddy runs inside WebPC (same-origin parent with pcHost).
// The safety policy follows the live backend (cloud models need Files grants) on every call.
const backendNow = () => (isChrome(selected) ? 'chrome' : isCloud(selected) ? 'cloud' : 'local');
const livePolicy = () => createPolicy({ backend: backendNow(), grants: fileGrants.map(g => g.root) });
const agent = createAgent({ policy: { newTurn: text => livePolicy().newTurn(text), decide: (...a) => livePolicy().decide(...a), noteResult: (...a) => livePolicy().noteResult(...a) } });
// The per-turn skill note is off: on the clean 60-task eval (one chat per task) lfm3-1.7b scored
// 29/60 without it and 24/60 with it. ?eval=1&prefetch=1 turns it back on, for eval comparisons only.
if (!(EVAL_TRACE && new URLSearchParams(location.search).get('prefetch') === '1')) agent.prefetch = () => '';
// The welcome strip: the apps Buddy has tools for, in catalog order, first 8 plus a +N chip.
{
  const { shown, hidden } = stripApps(agent.apps, [...agent.catalog.tools.keys()]);
  const strip = $('app-strip');
  for (const app of shown) {
    const li = document.createElement('li');
    const item = document.createElement('button'); item.type = 'button';
    item.dataset.help = `${app.title}: Buddy can open it and work in it.`;
    item.setAttribute('aria-label', app.title);
    item.append(appIcon(app.id, app.title));
    li.append(item); strip.append(li);
  }
  if (hidden.length) {
    const li = document.createElement('li');
    const chip = document.createElement('button'); chip.type = 'button'; chip.className = 'more';
    chip.textContent = `+${hidden.length}`;
    chip.dataset.help = hidden.map(app => app.title).join(', ');
    chip.setAttribute('aria-label', `${hidden.length} more apps`);
    li.append(chip); strip.append(li);
  }
  // The starters' empty icon spans (index.html) get the desktop's own icon.
  for (const span of document.querySelectorAll('#welcome .examples [data-app-icon]')) {
    const id = span.dataset.appIcon;
    span.append(appIcon(id, agent.apps.find(a => a.id === id)?.title ?? id));
  }
}
const desktopHost = () => { try { return parent !== window && parent.pcHost ? parent.pcHost : null; } catch { return null; } };
const filesCtx = createFilesCtx(fileStore, { broadcast: path => filesChangeChannel?.postMessage({ type: 'changed', path }) });
// ctx.craft(id): an ArtCraft app's page API (window.<id> inside its editor frame), opened if needed.
const craft = async id => craftApi(await desktopHost().appWindow(id), id);
// M3: one AgentSession per open thread, each saving through the thread store. `session` is the
// visible one, so the single-session code paths (controls, composer, export) keep reading it.
// Every thread's model work goes through the shared model (part A): per-thread scheduling and
// per-request worker interrupts, so stopping one thread never ends another thread's work and
// never kills the worker. A model switch retargets every session's client (rebindSessions).
const clientRef = { current: client };
const sharedModels = {
  local: createSharedModel(client, { concurrency: 1 }),
  cloud: createSharedModel(cloud, { concurrency: 3 }),
  chrome: createSharedModel(chrome, { concurrency: 1 }),
};
const sharedFor = () => (isChrome(selected) ? sharedModels.chrome : isCloud(selected) ? sharedModels.cloud : sharedModels.local);
// The facade manager the agent layer expects (part A contract): forThread builds the thread's
// facade on the active backend's shared model; cancelThread stops one thread only (queued jobs
// dropped, in-flight request interrupted).
const shared = {
  forThread: (id) => sharedFor().forThread(id),
  cancelThread: (id) => sharedFor().cancelThread(id),
};
function bindClient() { clientRef.current = isChrome(selected) ? chrome : isCloud(selected) ? cloud : client; }
// A model switch moves every live session's client to the new backend's shared model. The
// placeholder session never sends, so it keeps the facade it was built with.
function rebindSessions() {
  for (const s of sessions.values()) s.client = shared.forThread(s.threadId);
}
const sessions = new Map(); // thread id -> AgentSession
let visibleId = null;
let session = makePlaceholderSession();
const statusMap = new Map(); // thread id -> last known status
const ACTIVE_STATUSES = ['running', 'needs_you'];
const CHIP_LABEL = { running: 'running', waiting: 'waiting', needs_you: 'needs you', done: 'done', failed: 'failed', interrupted: 'interrupted' };
// Holds the controls live before the first thread opens: its store is a no-op (it never writes)
// and its events go nowhere, so it is safe to cancel, export or persist.
function makePlaceholderSession() {
  return new AgentSession({ client: shared.forThread('placeholder'), store: { save: async () => {} }, webSearch, httpGet, runJavaScript, runCode, chrome: chromeTools, files: fileTools, vision: visionTools, agent, host: desktopHost, filesCtx, craft, proxyAllowed: () => false, emit: () => {} });
}
function makeSession(id, record) {
  const s = new AgentSession({ client: shared.forThread(id), store: { save: value => verifiedSave(id, value) }, webSearch, httpGet, runJavaScript, runCode, chrome: chromeTools, files: fileTools, vision: visionTools, agent, host: desktopHost, filesCtx, craft, proxyAllowed: () => $('reader-proxy').checked, emit: (type, data) => onEvent(s, type, data) });
  s.threadId = id; s.history = record.history; s.summary = record.summary;
  return s;
}
function onEvent(s, type, data) {
  const id = s.threadId;
  if (type === 'busy') {
    if (data) setThreadStatus(id, 'running');
    else if (ACTIVE_STATUSES.includes(statusMap.get(id) ?? 'idle')) setThreadStatus(id, 'done');
    if (s === session) { controls(); if (!data) status(clientRef.current.ready ? 'Ready for your next question.' : 'Load a model to continue.'); }
    return;
  }
  if (type === 'error') { setThreadStatus(id, 'failed'); if (s === session) error(data); return; }
  if (type === 'saved') { if (s === session) { $('storage-warning').hidden = true; $('save-state').textContent = 'Local'; } return; }
  if (type === 'storage-error') { if (s === session) storageError(data); return; }
  if (s !== session) return; // a background thread: its history updates inside the session, the DOM waits for the switch
  switch (type) {
    case 'status': status(data); break;
    case 'reset': render(s); break;
    case 'user': message('user', data.content); break;
    case 'reply-start': data.element = message('assistant'); break;
    // While streaming, keep only the latest text and render at most once per
    // animation frame (Markdown parsing the whole answer every token is the cost
    // the old textContent avoided).
    case 'reply-token': {
      data.bubble.latest = data.text;
      if (!data.bubble.frame) data.bubble.frame = requestAnimationFrame(() => {
        data.bubble.frame = null;
        const near = nearBottom();
        data.bubble.element.replaceChildren(renderMarkdown(data.bubble.latest));
        follow(near);
      });
      break;
    }
    // The answer hit the length limit (worker done with truncated): a visible marker
    // on the bubble, with the explanation in the help pop-up.
    case 'reply-cut': {
      const chip = document.createElement('span');
      chip.className = 'chip cut';
      chip.textContent = 'Cut short';
      chip.dataset.help = 'The answer hit the length limit. Ask Buddy to continue.';
      data.bubble.element.parentElement.append(chip);
      break;
    }
    case 'tool-start': toolCard(data); traceStart(data.name, data.arguments); break;
    case 'tool-result': toolResult(data.toolCard, data.result); traceResult(data.toolCard.name, data.toolCard.arguments, data.result); break;
  }
}
// A put can resolve even when the write never becomes visible (seen once in the field, not
// reproducible locally): the thread's row then keeps its old title and status. Both verified
// writers re-read through the store's own list() and repeat the write after short delays until
// the value is visible. list() only shows rows whose record loads, so a visible row proves the
// record write and the index write both committed; a failed check only triggers a re-save.
const VERIFY_RETRIES = [75, 150];
async function verifiedSave(id, value) {
  if (!threads) throw new Error('Storage is unavailable.');
  const before = Date.now();
  await threads.save(id, value);
  for (const wait of VERIFY_RETRIES) {
    const row = (await threads.list()).find(r => r.id === id);
    if (row && row.updatedAt >= before) return;
    if (!sessions.has(id)) return; // the thread was deleted meanwhile: do not resurrect its row
    await new Promise(resolve => setTimeout(resolve, wait));
    await threads.save(id, value);
  }
}
async function verifiedSetStatus(id, status) {
  if (!threads) return;
  await threads.setStatus(id, status);
  for (const wait of VERIFY_RETRIES) {
    const row = (await threads.list()).find(r => r.id === id);
    if (row && row.status === status) return;
    if (!sessions.has(id)) return;
    await new Promise(resolve => setTimeout(resolve, wait));
    await threads.setStatus(id, status);
  }
}
async function setThreadStatus(id, status) {
  if ((statusMap.get(id) ?? 'idle') === status) return;
  statusMap.set(id, status);
  postBadge(); updateChips();
  try { await verifiedSetStatus(id, status); } catch {}
}
let lastBadge = null;
// Post the counts to the desktop whenever they change; the lead wires the desktop side.
function postBadge() {
  if (parent === window) return;
  let running = 0, needsYou = 0;
  for (const st of statusMap.values()) { if (st === 'running') running++; else if (st === 'needs_you') needsYou++; }
  if (lastBadge && lastBadge.running === running && lastBadge.needsYou === needsYou) return;
  lastBadge = { running, needsYou };
  parent.postMessage({ type: 'pc:buddy-status', running, needsYou }, location.origin);
}
function updateChips() {
  if ($('chats-panel').hidden) return;
  for (const el of document.querySelectorAll('#chats-list .chat-row')) {
    const chip = el.querySelector('.chip');
    if (!chip) continue;
    const st = statusMap.get(el.dataset.id) ?? 'idle';
    chip.className = `chip ${st}`; chip.hidden = st === 'idle'; chip.textContent = CHIP_LABEL[st] ?? st;
  }
}
const relTime = at => {
  const mins = Math.max(0, Math.floor((Date.now() - at) / 60000));
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
};
async function renderChats() {
  const box = $('chats-list');
  box.replaceChildren();
  let rows = [];
  try { rows = await threads?.list() ?? []; } catch {}
  for (const row of rows) { statusMap.set(row.id, row.status); box.append(chatRow(row)); }
  if (!rows.length) { const empty = document.createElement('p'); empty.className = 'chats-empty'; empty.textContent = 'No chats yet. Start one with New chat.'; box.append(empty); }
  postBadge();
}
function chatRow(row) {
  const el = document.createElement('div'); el.className = `chat-row${row.id === visibleId ? ' active' : ''}`; el.dataset.id = row.id;
  const open = document.createElement('button'); open.className = 'chat-open';
  const title = document.createElement('span'); title.className = 'chat-title'; title.textContent = row.title;
  const time = document.createElement('span'); time.className = 'chat-time'; time.textContent = relTime(row.updatedAt);
  open.append(title, time);
  open.addEventListener('click', () => openThread(row.id).then(() => closeChats()));
  const chip = document.createElement('span'); chip.className = `chip ${row.status}`; chip.textContent = CHIP_LABEL[row.status] ?? row.status; if (row.status === 'idle') chip.hidden = true;
  const rename = document.createElement('button'); rename.className = 'chat-rename'; rename.textContent = 'Rename'; rename.title = 'Rename this chat';
  rename.addEventListener('click', () => beginRename(el, row));
  const del = document.createElement('button'); del.className = 'chat-delete'; del.textContent = 'Delete'; del.title = 'Delete this chat';
  del.addEventListener('click', () => deleteThread(row.id));
  el.append(open, chip, rename, del);
  return el;
}
function beginRename(el, row) {
  const titleEl = el.querySelector('.chat-title');
  if (!titleEl) return;
  const input = document.createElement('input'); input.className = 'chat-rename-input'; input.value = row.title; input.maxLength = 60;
  titleEl.replaceWith(input); input.focus(); input.select();
  let done = false;
  const commit = async save => {
    if (done) return; done = true;
    if (save) { try { await threads.rename(row.id, input.value); } catch (err) { error(err.message); } }
    await renderChats();
  };
  input.addEventListener('keydown', event => { if (event.key === 'Enter') commit(true); else if (event.key === 'Escape') commit(false); });
  input.addEventListener('blur', () => commit(true));
}
async function deleteThread(id) {
  if (!confirm('Delete this chat? Its messages cannot be recovered.')) return;
  await threads.remove(id).catch(() => {});
  statusMap.delete(id);
  sessions.delete(id);
  if (visibleId === id) {
    visibleId = null; session = null;
    const rows = await threads.list().catch(() => []);
    if (rows.length) await openThread(rows[0].id);
    else await newThread();
  }
  await renderChats();
  postBadge();
}
// Opening a thread never cancels anything: other threads keep running, their tokens keep
// landing in their own history, and this one re-renders from what is already committed.
async function openThread(id) {
  let s = sessions.get(id);
  if (!s) {
    const rec = await threads.load(id);
    if (!rec) { await threads.remove(id).catch(() => {}); return; }
    s = makeSession(id, rec); sessions.set(id, s);
  }
  visibleId = id; session = s;
  document.body.dataset.thread = id;
  // Remember the open thread so a reload reopens it (falling back to the newest at startup).
  try { localStorage.setItem('buddy:openThread', id); } catch {}
  render(s); controls();
}
async function newThread() {
  error('');
  let row;
  try { row = await threads.create({ backend: backendNow() }); }
  catch (err) { error(err instanceof ThreadLimitError ? 'The chat limit of 200 is reached. Delete a chat to start a new one.' : err.message); return; }
  sessions.set(row.id, makeSession(row.id, { history: [], summary: '' }));
  statusMap.set(row.id, 'idle');
  await openThread(row.id);
  closeChats(); postBadge(); await renderChats();
  $('message').focus();
}
function closeChats() { $('chats-panel').hidden = true; }
$('chats').addEventListener('click', () => {
  // The panel is absolutely positioned: anchor it below the app header so the header buttons
  // (Chats, New chat, Export, Settings) stay visible and clickable while the list is open.
  if ($('chats-panel').hidden) { $('chats-panel').style.top = $('app-header').offsetHeight + 'px'; $('chats-panel').hidden = false; renderChats(); }
  else closeChats();
});
$('chats-close').addEventListener('click', closeChats);
$('chats-new').addEventListener('click', () => newThread());
// Stop ends the visible thread's work and marks it interrupted when it had work. The other
// threads keep running: their jobs stay queued or in flight and the shared worker survives,
// so the stop interrupts only this thread's in-flight request. With killWorker the shared
// worker ends too, and every in-flight local request ends with it: the Stop button does that
// only while a model is loading, because no chat has started on that model yet; model change,
// load and page close kill it the same way.
function stopVisible(text = isCloud(selected) || isChrome(selected) ? 'Stopped. Send the message again to continue.' : 'Stopped. Load the model again to continue; cached downloads are kept.', killWorker = false) {
  if (session && session.active) setThreadStatus(session.threadId, 'interrupted');
  loadVersion++; loading = false; session?.cancel(); visionWorkerStop(); exec.cancelAll(); if (killWorker) clientRef.current.stop(); $('progress').hidden = true;
  document.querySelectorAll('.message-body:empty').forEach(el => { el.textContent = 'Stopped.'; });
  document.querySelectorAll('.tool summary').forEach(el => { if (el.textContent.endsWith('· running')) el.textContent = el.textContent.replace('· running', '· stopped'); });
  controls(); status(text);
}
// Closing the page ends every thread's work, visible or not, and the shared worker with them.
function cancelAll(text) {
  for (const s of sessions.values()) {
    if (s.active) setThreadStatus(s.threadId, 'interrupted');
    s.cancel();
  }
  loadVersion++; loading = false; visionWorkerStop(); exec.cancelAll(); clientRef.current.stop(); $('progress').hidden = true;
  if (text) status(text);
  controls();
}
function modelInfo() {
  const notice = kind => { const n = licenseNotice(kind); $('model-license').replaceChildren(document.createTextNode(n.line)); $('about-help').dataset.help = n.help; };
  if (isCloud(selected)) {
    $('model').dataset.help = 'Cloud model: nothing downloads locally. Enter your API key in Settings and confirm the opt-in; your prompts, tool results and attached images go to the provider named there.';
    notice('cloud');
    return;
  }
  if (isChrome(selected)) {
    $('model').dataset.help = 'Chrome built-in model: nothing downloads from this site. Load it to start Chrome’s own on-device model download (needs at least 22 GB free space). Chat, translation and summarization stay on this device.';
    notice('chrome');
    return;
  }
  const model = MODELS[selected];
  const kind = modelKindLine(selected);
  $('model').dataset.help = `${kind ? `${kind} ` : ''}Load ${model.label} when ready: ${model.size} of model files from Hugging Face. No model files download automatically. Chat and computation stay on device; web tools make the requests you ask for.`;
  const link = document.createElement('a'); link.href = `https://huggingface.co/${model.repo}/tree/${model.revision}`; link.target = '_blank'; link.rel = 'noopener'; link.textContent = `${model.label} · ${model.license}`;
  // Local: the visible About line is the license link itself; the sentence is in the help dot.
  $('model-license').replaceChildren(link);
  $('about-help').dataset.help = licenseNotice('local').help;
}
async function doLoad(vision) {
  loadError = null;
  stopVisible(undefined, true); const version = ++loadVersion; loading = true; controls(); error(''); $('progress').hidden = false; $('progress').removeAttribute('value');
  if (isChrome(selected)) {
    // The click is the user gesture Chrome's create() needs; its monitor drives the status line.
    status('Loading Chrome’s on-device model…');
    try {
      await chrome.load(status); if (version !== loadVersion) return;
      status('Chrome model ready. Everything runs on this device.'); $('message').focus();
    } catch (err) { if (version === loadVersion && err.name !== 'AbortError') { loadError = err; error(err.message); } }
    finally { if (version === loadVersion) { loading = false; $('progress').hidden = true; controls(); } }
    return;
  }
  status('Checking WebGPU…');
  try {
    if (!navigator.gpu) throw new Error('WebGPU is unavailable. Use a compatible browser/device with hardware acceleration. Your saved conversation is still available.');
    const adapter = await navigator.gpu.requestAdapter();
    if (version !== loadVersion) return;
    if (!adapter) throw new Error('No WebGPU adapter is available. Your saved conversation is still available.');
    if (!adapter.features.has('shader-f16')) throw new Error('This WebGPU device does not support shader-f16, required by these models.');
    const spec = MODELS[selected];
    status(vision && spec.vision ? `Loading ${spec.label} with image support · ${spec.size} + ${spec.vision.size} vision encoder…` : `Loading ${spec.label} · first download ${spec.size}…`);
    await client.load(selected, { vision }); if (version !== loadVersion) return;
    status('Model ready. Messages are processed on this device.'); $('message').focus();
  } catch (err) { if (version === loadVersion && err.name !== 'AbortError') { loadError = err; error(err.message); } }
  finally { if (version === loadVersion) { loading = false; $('progress').hidden = true; controls(); } }
}
// A send while a load is running joins the in-flight load instead of restarting it: doLoad
// would kill the worker it is downloading (stopVisible with killWorker), so a second start
// would cancel the first. The Load model button is disabled while a load runs; only a send
// reaches a second start.
let loadInFlight = null;
function startLoad(vision) {
  if (loadInFlight) return loadInFlight;
  loadInFlight = doLoad(vision).finally(() => { loadInFlight = null; });
  return loadInFlight;
}
$('load-model').addEventListener('click', () => startLoad($('image-input').checked));
$('stop').addEventListener('click', () => stopVisible(undefined, loading));
$('model').addEventListener('change', () => {
  stopVisible('Model changed. Load it when you’re ready.', true);
  selected = $('model').value;
  cloud.clear(); bindClient(); rebindSessions();
  // Cloud and on-device selections are per session only: never persisted to MODEL_KEY.
  if (!isCloud(selected) && !isChrome(selected)) { try { localStorage.setItem(MODEL_KEY, selected); } catch {} if (!MODELS[selected]?.vision) clearPendingImage(); }
  modelInfo(); controls();
});
// New chat never stops, cancels or kills anything: it creates a thread and switches to it.
// Running chats keep running (their status chip says so); the worker and the cloud key are
// untouched (the key still clears on reload, page close and a model switch).
$('new-chat').addEventListener('click', async () => {
  await newThread();
  controls();
});
$('composer').addEventListener('submit', async event => {
  event.preventDefault(); if ($('send').disabled) return;
  const text = $('message').value; if (!text.trim()) return;
  error('');
  $('message').value = ''; // clear at once; restored below if the send fails before the message reaches the chat
  try {
    let image = null;
    if (pendingImage) {
      if (isCloud(selected)) {
        if (!cloud.ready) { clearPendingImage(); throw new Error('Confirm the cloud model in Settings first (your key was cleared).'); }
        // The cloud turn sends the PNG bytes of the data URL, not the raw RGBA pixels of the original file.
        image = { name: pendingImage.name, width: pendingImage.width, height: pendingImage.height, data: dataUrlBytes(pendingImage.url), type: 'image/png' };
      } else if (!MODELS[selected]?.vision) {
        clearPendingImage(); // also unchecks the (unsupported) image input
      } else if (client.ready) {
        // First image with a text-loaded model: fetch the vision encoder now, on demand.
        if (!client.vision) await startLoad(true);
        if (!client.vision) throw loadError ?? new Error('The model did not finish loading. Send the message again.');
        image = { name: pendingImage.name, width: pendingImage.width, height: pendingImage.height, data: pendingImage.data, type: pendingImage.type };
      }
      // Image pending but the local model is not loaded: the load below starts it with the
      // vision encoder, and the image object is built once it is ready.
    }
    // Send loads the model: a local model that is not ready starts (or joins) the same load
    // the Load model button starts, with the vision encoder when an image is pending, and
    // the message goes out as soon as it is ready. Cloud and Chrome keep their
    // "Load a model first." error from session.send below.
    if (!isCloud(selected) && !isChrome(selected) && !client.ready) {
      // The box is empty during the load, so its placeholder says the message is waiting.
      const placeholder = $('message').placeholder;
      $('message').placeholder = 'Your message sends when the model is ready…';
      try { await startLoad(Boolean(pendingImage) || $('image-input').checked); }
      finally { $('message').placeholder = placeholder; }
      if (!client.ready) throw loadError ?? new Error('The model did not finish loading. Send the message again.');
    }
    if (pendingImage && !isCloud(selected) && !image) {
      image = { name: pendingImage.name, width: pendingImage.width, height: pendingImage.height, data: pendingImage.data, type: pendingImage.type };
    }
    await session.send(text, image);
    if (image) clearPendingImage();
  } catch (err) {
    error(err.message);
    $('message').value = text; // the message never reached the chat: put the text back
  }
  controls();
});
// ---------- image input (Qwen models) ----------
function clearPendingImage() {
  pendingImage = null;
  $('image-chip').hidden = true;
  imageInputControls();
}
function renderImageChip() {
  $('image-chip').hidden = false;
  $('image-preview').src = pendingImage.url;
  $('image-name').textContent = `${pendingImage.name} · ${pendingImage.width}×${pendingImage.height}`;
  $('image-name').title = 'Images are not kept after a reload; the chat stores a text marker.';
}
async function prepareImage(file) {
  const problem = checkImage(file);
  if (problem) { error(problem); return; }
  let bitmap;
  try { bitmap = await createImageBitmap(file); } catch { error('Could not decode that image. Try a PNG, JPEG or WebP.'); return; }
  // Downscale the longest side to 768 px (keeps the pixel payload small; the model rescales internally).
  const scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height); bitmap.close();
  const { data } = canvas.getContext('2d').getImageData(0, 0, width, height);
  pendingImage = { name: file.name.slice(0, 100) || 'image.png', width, height, data: new Uint8Array(data), type: file.type, url: canvas.toDataURL('image/png') };
  renderImageChip(); error('');
}
$('attach').addEventListener('click', () => { if (!$('attach').disabled) $('image-file').click(); });
$('image-file').addEventListener('change', async () => {
  const file = $('image-file').files?.[0]; $('image-file').value = '';
  if (!file) return;
  if (!$('image-input').checked) { error('Turn on Image input first (Qwen models only).'); return; }
  await prepareImage(file);
});
$('image-remove').addEventListener('click', () => clearPendingImage());
$('image-input').addEventListener('change', async () => {
  if (isCloud(selected) || isChrome(selected)) { if (!$('image-input').checked) clearPendingImage(); imageInputControls(); return; }
  const spec = MODELS[selected];
  if (!spec.vision || !$('image-input').checked) { if (!$('image-input').checked) clearPendingImage(); imageInputControls(); return; }
  imageInputControls();
  // Enabling Image input with a loaded text-only model fetches the vision encoder now, on demand.
  if (client.ready && !client.vision) {
    status(`Downloading image support for ${spec.label} (${spec.vision.size})…`);
    await startLoad(true);
  }
});
// ---------- cloud model (BYOK, opt-in per session) ----------
const cloudProvider = () => document.querySelector('input[name="cloud-provider"]:checked').value;
function cloudNotice() {
  const provider = cloudProvider();
  const host = provider === 'anthropic' ? 'api.anthropic.com' : 'the host in your base URL';
  // The visible text is a short chip; the full sentence lives on the chip and the
  // opt-in button as data-help (same text, both open the pop-up).
  const notice = `Your prompts, tool results and any attached image are sent to ${host}. The key is kept in memory only and cleared on reload, when Buddy closes and when you switch models.`;
  $('cloud-notice').textContent = host ? `Sends to ${host}` : '';
  $('cloud-notice').hidden = !host;
  $('cloud-notice').dataset.help = notice;
  $('cloud-use').dataset.help = notice;
  $('cloud-model').placeholder = provider === 'anthropic' ? 'claude-opus-5-5 (cheaper: claude-sonnet-5-5, claude-haiku-5-5)' : 'model name served by this endpoint';
  $('cloud-base-row').hidden = provider !== 'openai';
  $('cloud-effort').hidden = provider !== 'anthropic';
  if (provider === 'anthropic' && !$('cloud-model').value.trim()) $('cloud-model').value = 'claude-opus-5-5';
}
for (const radio of document.querySelectorAll('input[name="cloud-provider"]')) radio.addEventListener('change', cloudNotice);
$('cloud-use').addEventListener('click', () => {
  error('');
  try {
    const { host } = cloud.configure({ provider: cloudProvider(), model: $('cloud-model').value, baseUrl: $('cloud-base').value.trim() || null, key: $('cloud-key').value, effort: $('cloud-effort-select').value });
    $('cloud-key').value = ''; // the key never lingers in the DOM after opt-in
    status(`Cloud model ready. Your prompts are sent to ${host}.`);
    bindClient(); controls();
  } catch (err) { error(err.message); }
});
$('message').addEventListener('input', () => controls());
$('message').addEventListener('keydown', event => {
  // Enter sends (Shift + Enter keeps the newline; Ctrl or ⌘ + Enter still sends);
  // an IME's Enter confirms the composition, it does not send.
  if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return;
  if (event.shiftKey) return;
  event.preventDefault();
  $('composer').requestSubmit();
});
for (const button of document.querySelectorAll('[data-prompt]')) button.addEventListener('click', () => { $('message').value = button.dataset.prompt; controls(); $('message').focus(); });
function download(name, value) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('export').addEventListener('click', () => { download('ai-agent-conversation.json', { version: 1, ...session.snapshot(), savedAt: Date.now() }); session.exportedRevision = session.revision; });
$('raw-export').addEventListener('click', async () => { try { download('ai-agent-stored-data.json', await store.raw()); } catch (err) { storageError(err.message); } });
$('retry-save').addEventListener('click', () => session.persist());
$('settings').addEventListener('click', () => $('settings-dialog').showModal());
$('close-settings').addEventListener('click', () => $('settings-dialog').close());
$('settings-close').addEventListener('click', () => $('settings-dialog').close());
$('import').addEventListener('click', () => $('file').click());
// Import opens the backup as a NEW thread: nothing is replaced or lost, so no confirm is needed.
async function openImported(value) {
  const clean = validateConversation(value);
  const row = await threads.create({ backend: backendNow() });
  await threads.save(row.id, { history: clean.history, summary: clean.summary });
  sessions.set(row.id, makeSession(row.id, { history: clean.history, summary: clean.summary }));
  statusMap.set(row.id, 'idle');
  await openThread(row.id);
  $('settings-dialog').close(); controls();
}
$('file').addEventListener('change', async () => {
  const file = $('file').files[0]; $('file').value = ''; if (!file) return;
  try { if (file.size > 5_000_000) throw new Error('Backups must be smaller than 5 MB.'); const data = JSON.parse(await file.text()); await openImported(data.history ? data : data.current ?? data.legacy ?? data.previous); }
  catch (err) { error(`Backup was not opened: ${err.message}`); $('settings-dialog').close(); }
});
$('previous').addEventListener('click', async () => { try { const raw = await store.raw(); if (!raw.previous) throw new Error('No previous record is stored.'); await openImported(raw.previous); } catch (err) { error(err.message); $('settings-dialog').close(); } });
// Accept desktop messages only from the same-origin parent. No conversation data is posted to it.
const theme = value => { document.documentElement.dataset.theme = value === 'light' ? 'light' : 'dark'; };
try { theme(localStorage.getItem('theme') ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')); } catch { theme('dark'); }
addEventListener('message', event => { if (event.origin === location.origin && event.source === parent && event.data?.type === 'pc:theme') theme(event.data.theme); });
document.addEventListener('pointerdown', () => { if (parent !== window) parent.postMessage({ type: 'pc:focus', appId: 'ai-agent' }, location.origin); }, true);
if (parent !== window) parent.postMessage({ type: 'pc:ready', appId: 'ai-agent' }, location.origin);
// In the desktop panel, the header's close button closes it (the panel has no chrome of its own).
if (parent !== window) { $('panel-close').hidden = false; $('panel-close').addEventListener('click', () => parent.postMessage({ type: 'pc:panel-close', appId: 'ai-agent' }, location.origin)); }
// Escape closes the chats list first, then the desktop panel; skip while a dialog is open (it
// closes itself), and never preventDefault, so Escape still reaches dialogs and the Stop control.
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || parent === window) return;
  if (!$('chats-panel').hidden) { closeChats(); return; }
  if (!document.querySelector('dialog[open]')) parent.postMessage({ type: 'pc:panel-close', appId: 'ai-agent' }, location.origin);
});
const unsaved = () => Boolean(store.pending) || (session.savedRevision < session.revision && session.exportedRevision !== session.revision);
window.pcFlush = () => {
  if (!initialized) { error('Wait for stored data to finish opening before closing.'); return false; }
  if (unsaved()) { error(store.pending ? 'Saving is still in progress. Try closing again after it completes.' : 'This chat could not be saved. Retry save or Export before closing.'); return false; }
  return true;
};
// pcFlush() FIRST: it may refuse the close (pending work), and nothing must be cleared then.
window.pcBeforeClose = () => { if (!window.pcFlush()) return false; cancelAll('App closed. Load the model again to continue.'); $('reader-proxy').checked = false; cloud.clear(); indexAbort = null; searchHost.dispose(); embedClient.stop(); visionWorkerStop(); fileGrants.length = 0; return true; };
addEventListener('beforeunload', event => { if (unsaved()) { event.preventDefault(); event.returnValue = ''; } });
addEventListener('pagehide', () => { cancelAll(); cloud.clear(); indexAbort = null; searchHost.dispose(); embedClient.stop(); fileGrants.length = 0; });
modelInfo(); cloudNotice(); renderVisionEngine(); bindClient(); controls();
// Startup: build the thread store over idb-keyval, flip stale active threads to interrupted,
// copy the legacy single-conversation records into threads, then open the newest thread.
try {
  const idb = await import('./vendor/idb-keyval.js');
  threads = createThreadStore({ kv: { get: idb.get, set: idb.set, del: idb.del }, now: Date.now, newId: () => crypto.randomUUID() });
  await store.restore();
  await threads.markInterrupted();
  const created = await threads.migrateLegacy(await store.raw());
  if (created) status('Previous conversation copied safely. The original record was kept. Load a model to continue.');
} catch (err) { storageError(`Could not open stored chats: ${err.message}`); }
try {
  const rows = await threads?.list() ?? [];
  for (const row of rows) statusMap.set(row.id, row.status);
  if (rows.length) {
    // Reopen the chat the user was viewing (remembered on every openThread); fall back to the newest.
    let openId = null; try { openId = localStorage.getItem('buddy:openThread'); } catch {}
    await openThread(rows.some(r => r.id === openId) ? openId : rows[0].id);
  } else {
    const row = await threads.create({ backend: backendNow() });
    sessions.set(row.id, makeSession(row.id, { history: [], summary: '' }));
    statusMap.set(row.id, 'idle');
    await openThread(row.id);
  }
} catch (err) { storageError(`Could not open stored chats: ${err.message}`); }
initialized = true; controls(); postBadge();
initHelp();
if (!navigator.gpu) status('WebGPU is unavailable here. You can still read, export, and recover saved conversations.');
