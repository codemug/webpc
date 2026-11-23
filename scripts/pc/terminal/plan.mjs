// Pure helpers for the unkernel Terminal (pre-bake and prepare). No I/O and no
// dependency on the unkernel package, so the unit tests need no kernel or network.
export const TODO = 'TODO';
const APK_NAME = /^[a-z0-9][a-z0-9.+-]*$/;
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Validate scripts/pc/terminal/packages.json. With requireTemplateSha the
 * templateSha256 must be pinned (prepare refuses to vendor otherwise); the
 * pre-bake leaves it a placeholder because it is the step that prints the value.
 * @returns {string[]} every defect found (empty when valid).
 */
export function validatePackagesLock(lock, { requireTemplateSha = false } = {}) {
  if (!lock || typeof lock !== 'object') return ['packages.json must be a JSON object'];
  const errors = [];
  if (lock.schema !== 1) errors.push('schema must be 1');
  if (typeof lock.kernelVersion !== 'string' || lock.kernelVersion.trim() === '') errors.push('kernelVersion must be a non-empty string');
  if (typeof lock.distro !== 'string' || !/^[a-z0-9]+$/.test(lock.distro)) errors.push('distro must match [a-z0-9]+');
  if (!Array.isArray(lock.packages) || lock.packages.length === 0) errors.push('packages must be a non-empty list');
  else lock.packages.forEach((p, i) => {
    if (!p || typeof p !== 'object') { errors.push(`packages[${i}] must be a mapping`); return; }
    if (typeof p.name !== 'string' || !APK_NAME.test(p.name)) errors.push(`packages[${i}].name must be an apk package name`);
    if (typeof p.version !== 'string' || p.version.trim() === '') errors.push(`packages[${i}].version must be pinned to the version the dry run installed`);
    else if (p.version.trim() === TODO) errors.push(`packages[${i}] (${p.name}): the version is still a TODO; fill it from the pre-bake dry run before running`);
  });
  if (requireTemplateSha && (typeof lock.templateSha256 !== 'string' || !HEX64.test(lock.templateSha256))) errors.push('templateSha256 must be the 64 hex SHA-256 printed by the pre-bake');
  return errors;
}

/** The apk add arguments: "name=version" per package, space joined. */
export const apkPackages = lock => lock.packages.map(p => `${p.name}=${p.version}`).join(' ');

/**
 * The one-line script the pre-bake types into the offline verify boot: prove both
 * interpreters run (with the libraries Buddy's code tools lean on), then power off: the CLI
 * exits only when the guest halts, so the poweroff follows ";" and runs even if a check fails
 * (the marker check reports that). \n is Enter.
 */
export const buildOfflineInput = () =>
  `python3 -c 'import json, sqlite3, sys; print("python3-ok", sys.version.split()[0])' && node -e 'console.log("node-ok", process.version)'; sudo poweroff\n`;

/** The one-line script the pre-bake types into the networked boot: install the pinned
 * packages, then the same verify (one line, so a busy console never sees a half-typed
 * next command; a failed install skips the verify and the output check fails). */
export const buildInstallInput = lock => `sudo apk add --no-progress ${apkPackages(lock)} && ${buildOfflineInput()}`;

/**
 * The unkernel pins from a catalog app's sources: one npm source for the SDK plus one
 * github-release asset for distros.json and one for the distro image (<distro>.erofs);
 * all release assets must share one tag.
 * @returns {{ok: boolean, errors: string[], npm: string|null, tag: string|null,
 *            assets: Record<string, {tag: string, url: string, sha256: string}>}}
 */
export function unkernelPins(sources, distro) {
  const errors = [];
  const list = Array.isArray(sources) ? sources : [];
  const npm = list.find(s => s?.type === 'npm' && s.package === 'unkernel');
  if (!npm || typeof npm.version !== 'string' || npm.version === '') errors.push('an npm source for package "unkernel" with a version is required');
  const repo = 'pithings/unkernel';
  const releases = list.filter(s => s?.type === 'github-release' && s.repo === repo);
  const assets = {};
  for (const asset of ['distros.json', `${distro}.erofs`]) {
    const found = releases.find(s => s.asset === asset);
    if (!found || typeof found.url !== 'string' || found.url === '' || typeof found.sha256 !== 'string' || !HEX64.test(found.sha256)) {
      errors.push(`a github-release source of ${repo} for asset "${asset}" with a url and a 64 hex sha256 is required`);
      continue;
    }
    assets[asset] = { tag: found.tag, url: found.url, sha256: found.sha256 };
  }
  if (new Set(releases.map(s => s.tag)).size > 1) errors.push('the unkernel release assets must share one tag');
  return { ok: errors.length === 0, errors, npm: npm?.version ?? null, tag: releases[0]?.tag ?? null, assets };
}

/** The non-zero disk blocks of an image as [index, bytes] pairs for encodeKwsparse. */
export function planBlocks(image, blockSize, firstIndex = 0) {
  if (!Number.isInteger(blockSize) || blockSize <= 0) throw new Error('blockSize must be a positive integer');
  const blocks = [];
  for (let index = firstIndex, start = 0; start < image.length; index++, start += blockSize) {
    const chunk = image.subarray(start, Math.min(start + blockSize, image.length));
    let zero = true;
    for (let i = 0; i < chunk.length; i++) if (chunk[i] !== 0) { zero = false; break; }
    if (!zero) blocks.push([index, new Uint8Array(chunk)]); // a copy: Buffer#slice would be a view
  }
  return blocks;
}
