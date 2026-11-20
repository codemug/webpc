// WebPC catalog (catalog.yaml): load, validate, and derive the desktop registry.
// Node-only (reads files). Browser code imports the generated registry JSON instead
// (src/scripts/pc/registry.generated.json, written by `npm run catalog`).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DESKTOP_KEYS = ['id', 'title', 'category', 'keywords', 'description', 'src', 'kind', 'loadTimeout', 'width', 'height'];
const APP_KEYS = new Set([...DESKTOP_KEYS, 'enabled', 'sources']);
const KINDS = new Set(['iframe', 'external', 'about']);
const HEX64 = /^[0-9a-f]{64}$/;
// Keys each source type must have (plus `type`, `upgrade`); optional keys are listed after `|`.
const SOURCE_KEYS = {
  'github-release': ['repo', 'tag', 'asset', 'url', 'sha256', '|', 'license'],
  npm: ['package', 'version'],
  'npm-tarball': ['package', 'version', 'integrity'],
  'cdn-file': ['package', 'version', 'file', 'sha256'],
  alpine: ['lock'],
  huggingface: ['models'],
};

const isText = v => typeof v === 'string' && v.trim() !== '';
const isPositiveInt = v => Number.isInteger(v) && v > 0;

function sourceErrors(app, source, i) {
  const at = `${app.id}: sources[${i}]`;
  if (!source || typeof source !== 'object') return [`${at} must be a mapping`];
  const spec = SOURCE_KEYS[source.type];
  if (!spec) return [`${at}.type "${source.type}" is not one of ${Object.keys(SOURCE_KEYS).join(', ')}`];
  const cut = spec.indexOf('|');
  const required = cut === -1 ? spec : spec.slice(0, cut);
  const allowed = new Set(['type', 'upgrade', ...spec.filter(k => k !== '|')]);
  const errors = [];
  for (const key of Object.keys(source)) if (!allowed.has(key)) errors.push(`${at}: unknown key "${key}"`);
  for (const key of required) if (source[key] === undefined || source[key] === null || source[key] === '') errors.push(`${at}.${key} is required`);
  if (source.upgrade !== 'auto' && source.upgrade !== 'manual') errors.push(`${at}.upgrade must be auto or manual`);
  if ('sha256' in source && !HEX64.test(String(source.sha256))) errors.push(`${at}.sha256 must be 64 lowercase hex characters`);
  if (source.type === 'github-release') {
    if (!/^[\w.-]+\/[\w.-]+$/.test(String(source.repo))) errors.push(`${at}.repo must be owner/name`);
    if (!String(source.url).startsWith(`https://github.com/${source.repo}/releases/download/${source.tag}/`)) errors.push(`${at}.url must be a release asset of ${source.repo} at ${source.tag}`);
    if (source.license && (!isText(source.license.path) || !HEX64.test(String(source.license.sha256)))) errors.push(`${at}.license needs a path and a sha256`);
  }
  if (source.type === 'npm-tarball' && !/^sha512-[A-Za-z0-9+/]+=*$/.test(String(source.integrity))) errors.push(`${at}.integrity must be an sha512- SRI string`);
  if (source.type === 'huggingface') {
    for (const [repo, sha] of Object.entries(source.models ?? {})) if (!/^[0-9a-f]{40}$/.test(String(sha))) errors.push(`${at}.models["${repo}"] must be a 40-character commit sha`);
  }
  return errors;
}

function appErrors(app) {
  const id = app?.id;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(String(id))) return [`app id "${id}" must be lowercase letters, digits and dashes`];
  const errors = [];
  for (const key of Object.keys(app)) if (!APP_KEYS.has(key)) errors.push(`${id}: unknown key "${key}"`);
  if (typeof app.enabled !== 'boolean') errors.push(`${id}: enabled must be true or false`);
  for (const key of ['title', 'category', 'description']) if (!isText(app[key])) errors.push(`${id}: ${key} is required`);
  if (!Array.isArray(app.keywords) || !app.keywords.every(isText)) errors.push(`${id}: keywords must be a list of words`);
  if (!KINDS.has(app.kind)) errors.push(`${id}: kind must be one of ${[...KINDS].join(', ')}`);
  if (app.kind === 'iframe' && app.src !== `/pc/apps/${id}/`) errors.push(`${id}: src must be /pc/apps/${id}/`);
  if (app.kind === 'external' && !String(app.src).startsWith('https://')) errors.push(`${id}: src must be an https URL`);
  for (const key of ['loadTimeout', 'width', 'height']) if (key in app && !isPositiveInt(app[key])) errors.push(`${id}: ${key} must be a positive whole number`);
  if ('sources' in app && !Array.isArray(app.sources)) errors.push(`${id}: sources must be a list`);
  (Array.isArray(app.sources) ? app.sources : []).forEach((s, i) => errors.push(...sourceErrors(app, s, i)));
  return errors;
}

/** @returns {string[]} every defect found, each naming the app and field (empty when valid). */
export function validateCatalog(catalog) {
  if (!catalog || !Array.isArray(catalog.apps)) return ['catalog.yaml must have an "apps" list'];
  const errors = []; const seen = new Set();
  for (const app of catalog.apps) {
    if (seen.has(app?.id)) errors.push(`${app.id}: duplicate id`);
    seen.add(app?.id);
    errors.push(...appErrors(app));
  }
  return errors;
}

/** npm sources must match package.json (exact pin) and package-lock.json, which `npm ci` installs from. */
export function checkNpmPins(catalog, pkg, lock) {
  const errors = [];
  for (const app of catalog.apps) for (const s of app.sources ?? []) {
    if (s.type !== 'npm') continue;
    const declared = pkg.dependencies?.[s.package] ?? pkg.devDependencies?.[s.package];
    const locked = lock.packages?.[`node_modules/${s.package}`]?.version;
    if (declared === undefined) errors.push(`${app.id}: ${s.package} is missing from package.json`);
    else if (declared !== s.version) errors.push(`${app.id}: ${s.package} is ${s.version} in the catalog but ${declared} in package.json`);
    else if (locked !== s.version) errors.push(`${app.id}: ${s.package} is ${s.version} in the catalog but ${locked} in package-lock.json`);
  }
  return errors;
}

/** Load and validate catalog.yaml (and its npm pins). Throws one error listing every defect. */
export function loadCatalog(root = ROOT) {
  const read = name => readFileSync(new URL(name, `file://${root.endsWith('/') ? root : `${root}/`}`), 'utf8');
  const catalog = parse(read('catalog.yaml'));
  const errors = [...validateCatalog(catalog), ...(Array.isArray(catalog?.apps) ? checkNpmPins(catalog, JSON.parse(read('package.json')), JSON.parse(read('package-lock.json'))) : [])];
  if (errors.length) throw new Error(`catalog.yaml is invalid:\n- ${errors.join('\n- ')}`);
  return catalog;
}

const find = (catalog, id) => {
  const app = catalog.apps.find(a => a.id === id);
  if (!app) throw new Error(`unknown app "${id}"`);
  return app;
};
export const isEnabled = (catalog, id) => find(catalog, id).enabled;
export const appSources = (catalog, id, type, pkg) => (find(catalog, id).sources ?? []).filter(s => (!type || s.type === type) && (!pkg || s.package === pkg));

/** Desktop registry: enabled apps only, desktop fields only, in catalog order. */
export function registryEntries(catalog) {
  return catalog.apps.filter(a => a.enabled).map(a => Object.fromEntries(DESKTOP_KEYS.filter(k => k in a).map(k => [k, a[k]])));
}

export const REGISTRY_JSON = 'src/scripts/pc/registry.generated.json';
/** `npm run catalog`: validate, then write the registry the browser code imports. */
export function writeRegistry(root = ROOT) {
  const catalog = loadCatalog(root);
  writeFileSync(`${root}${REGISTRY_JSON}`, `${JSON.stringify(registryEntries(catalog), null, 1)}\n`);
  return catalog;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const catalog = writeRegistry();
  const off = catalog.apps.filter(a => !a.enabled).map(a => a.id);
  console.log(`catalog.yaml valid: ${catalog.apps.length} apps (${off.length ? `disabled: ${off.join(', ')}` : 'all enabled'}).`);
}
