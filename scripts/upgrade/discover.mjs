// Release discovery for the upgrader: pure "pick the upgrade" rules (unit-tested on recorded
// responses) plus thin fetchers for GitHub releases, the npm registry, the Alpine package
// index and Hugging Face model heads.
import { gunzipSync } from 'node:zlib';
import semver from 'semver';

/** A release must be this old before it is picked (supply-chain cooling-off). */
export const COOL_DAYS = 3;
const DAY = 86_400_000;
const oldEnough = (iso, now) => Date.parse(iso) <= now.getTime() - COOL_DAYS * DAY;
const versionOf = tag => semver.valid(String(tag).replace(/^v/, ''));

export function globToRegExp(glob) {
  return new RegExp(`^${glob.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
}

/**
 * Newest stable GitHub release that is newer than the pinned tag, old enough, and has exactly one
 * asset matching the source's glob, served from the pinned repo. Null when there is none.
 */
export function pickGithubRelease(releases, source, now = new Date()) {
  const current = versionOf(source.tag);
  const match = globToRegExp(source.asset);
  let best = null;
  for (const r of releases) {
    const version = versionOf(r.tag_name);
    if (r.draft || r.prerelease || !version || !oldEnough(r.published_at, now)) continue;
    if (current && !semver.gt(version, current)) continue;
    const assets = (r.assets ?? []).filter(a => match.test(a.name));
    const prefix = `https://github.com/${source.repo}/releases/download/${r.tag_name}/`;
    if (assets.length !== 1 || !assets[0].browser_download_url.startsWith(prefix)) continue;
    if (!best || semver.gt(version, best.version)) best = { tag: r.tag_name, version, url: assets[0].browser_download_url, asset: assets[0].name, publishedAt: r.published_at };
  }
  return best;
}

/**
 * Newest stable npm version compatible with the pin (^current: same major, or same minor for
 * 0.x), old enough. `newerMajor` reports the newest stable version outside that range.
 */
export function pickNpmVersion(meta, current, now = new Date()) {
  const stable = Object.keys(meta.versions ?? {}).filter(v => semver.valid(v) && !semver.prerelease(v) && semver.gt(v, current));
  const compatible = stable.filter(v => semver.satisfies(v, `^${current}`) && meta.time?.[v] && oldEnough(meta.time[v], now));
  const version = compatible.length ? semver.rsort(compatible)[0] : null;
  const outside = stable.filter(v => !semver.satisfies(v, `^${current}`));
  const dist = version ? meta.versions[version].dist ?? {} : {};
  return { version, integrity: dist.integrity ?? null, tarball: dist.tarball ?? null, newerMajor: outside.length ? semver.rsort(outside)[0] : null };
}

/** Parse an Alpine APKINDEX text into name -> { name, version, origin, license, sourceCommit, url }. */
export function parseApkIndex(text) {
  const map = new Map();
  for (const block of text.split(/\n\n+/)) {
    const field = {};
    for (const line of block.split('\n')) if (line[1] === ':') field[line[0]] = line.slice(2);
    if (field.P) map.set(field.P, { name: field.P, version: field.V, origin: field.o, license: field.L, sourceCommit: field.c, url: field.U });
  }
  return map;
}

// ---------- network (thin; exercised by `npm run upgrade -- --dry-run`) ----------

const headers = () => ({ accept: 'application/vnd.github+json', 'user-agent': 'webpc-upgrader', ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) });
async function getJson(url, init = {}) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}
export const fetchGithubReleases = repo => getJson(`https://api.github.com/repos/${repo}/releases?per_page=30`, { headers: headers() });
export const fetchNpm = pkg => getJson(`https://registry.npmjs.org/${pkg.replace('/', '%2f')}`);
export const fetchHfHead = async repo => (await getJson(`https://huggingface.co/api/models/${repo}`)).sha;

/** Read the APKINDEX file out of an Alpine APKINDEX.tar.gz (concatenated gzip members, plain tar inside). */
export function apkIndexFromTarGz(bytes) {
  const tar = gunzipSync(bytes);
  for (let at = 0; at + 512 <= tar.length;) {
    const name = tar.subarray(at, at + 100).toString('latin1').replace(/\0.*$/s, '');
    if (!name) break;
    const size = parseInt(tar.subarray(at + 124, at + 136).toString('latin1').trim(), 8) || 0;
    if (name === 'APKINDEX') return tar.subarray(at + 512, at + 512 + size).toString('utf8');
    at += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error('APKINDEX not found in the index archive');
}
export async function fetchApkIndex(branch, repo, arch) {
  const url = `https://dl-cdn.alpinelinux.org/alpine/${branch}/${repo}/${arch}/APKINDEX.tar.gz`;
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return parseApkIndex(apkIndexFromTarGz(Buffer.from(await response.arrayBuffer())));
}
