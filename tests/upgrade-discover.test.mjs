import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pickGithubRelease, pickNpmVersion, parseApkIndex, globToRegExp, COOL_DAYS } from '../scripts/upgrade/discover.mjs';

const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/upgrade/${name}`, import.meta.url), 'utf8'));
const day = 86_400_000;
const releases = fixture('gridcraft-releases.json'); // real API response (trimmed): v0.19.1 ... v0.16.1
const gridcraft = { type: 'github-release', repo: 'storytold/gridcraft', tag: 'v0.16.1', asset: 'gridcraft-web-*.zip' };
const after = iso => new Date(Date.parse(iso) + (COOL_DAYS + 1) * day);

test('github: the newest stable release with a matching asset, once it is old enough', () => {
  const pick = pickGithubRelease(releases, gridcraft, after('2026-11-12T00:06:29Z'));
  assert.deepEqual(pick, { tag: 'v0.19.1', version: '0.19.1', url: 'https://github.com/storytold/gridcraft/releases/download/v0.19.1/gridcraft-web-0.19.1.zip', asset: 'gridcraft-web-0.19.1.zip', publishedAt: '2026-11-12T00:06:29Z' });
});

test('github: releases inside the cooling-off window are skipped, not picked', () => {
  // One day after v0.19.1, the cut-off is 2026-11-10: v0.19.1 and v0.19.0 are too new, v0.18.0 qualifies.
  const pick = pickGithubRelease(releases, gridcraft, new Date(Date.parse('2026-11-12T00:06:29Z') + day));
  assert.equal(pick.tag, 'v0.18.0');
});

test('github: drafts, prereleases, missing assets and the current tag give no upgrade', () => {
  const shaped = [
    { tag_name: 'v9.0.0', draft: true, prerelease: false, published_at: '2026-01-01T00:00:00Z', assets: [{ name: 'gridcraft-web-9.0.0.zip', browser_download_url: 'https://github.com/storytold/gridcraft/releases/download/v9.0.0/gridcraft-web-9.0.0.zip' }] },
    { tag_name: 'v8.0.0', draft: false, prerelease: true, published_at: '2026-01-01T00:00:00Z', assets: [{ name: 'gridcraft-web-8.0.0.zip', browser_download_url: 'https://github.com/storytold/gridcraft/releases/download/v8.0.0/gridcraft-web-8.0.0.zip' }] },
    { tag_name: 'v7.0.0', draft: false, prerelease: false, published_at: '2026-01-01T00:00:00Z', assets: [{ name: 'gridcraft-7.0.0-linux.AppImage', browser_download_url: 'https://github.com/storytold/gridcraft/releases/download/v7.0.0/x' }] },
    { tag_name: 'v0.16.1', draft: false, prerelease: false, published_at: '2025-12-01T00:00:00Z', assets: [{ name: 'gridcraft-web-0.16.1.zip', browser_download_url: 'https://github.com/storytold/gridcraft/releases/download/v0.16.1/gridcraft-web-0.16.1.zip' }] },
  ];
  assert.equal(pickGithubRelease(shaped, gridcraft, new Date('2026-06-01')), null);
});

test('github: an asset URL outside the pinned repo is refused', () => {
  const evil = [{ tag_name: 'v1.0.0', draft: false, prerelease: false, published_at: '2026-01-01T00:00:00Z', assets: [{ name: 'gridcraft-web-1.0.0.zip', browser_download_url: 'https://evil.example/gridcraft-web-1.0.0.zip' }] }];
  assert.equal(pickGithubRelease(evil, gridcraft, new Date('2026-06-01')), null);
});

test('github: a tag that is not newer by semver never replaces the pin (no downgrades)', () => {
  const current = { ...gridcraft, tag: 'v0.19.1' };
  assert.equal(pickGithubRelease(releases, current, after('2026-11-12T00:06:29Z')), null);
});

test('globs match whole asset names only', () => {
  assert.equal(globToRegExp('BeepBox_*.zip').test('BeepBox_4_2_2.zip'), true);
  assert.equal(globToRegExp('BeepBox_*.zip').test('BeepBox_4_2_2.zip.sig'), false);
  assert.equal(globToRegExp('dist.zip').test('distXzip'), false);
});

test('npm: the newest stable version in the same major, old enough; a new major is reported, not picked', () => {
  const meta = fixture('npm-xterm.json'); // real registry data: 5.4.x, 5.5.0, 6.0.0, 6.1.0 betas
  const pick = pickNpmVersion(meta, '5.4.0', new Date('2026-11-20'));
  assert.equal(pick.version, '5.5.0');
  assert.equal(pick.integrity, meta.versions['5.5.0'].dist.integrity);
  assert.equal(pick.newerMajor, '6.0.0');
  assert.equal(pickNpmVersion(meta, '5.5.0', new Date('2026-11-20')).version, null);
});

test('npm: for 0.x versions only patch releases count as compatible', () => {
  const meta = { 'dist-tags': { latest: '0.6.0' }, time: { '0.5.473': '2025-01-01T00:00:00Z', '0.5.480': '2025-02-01T00:00:00Z', '0.6.0': '2025-03-01T00:00:00Z' },
    versions: { '0.5.473': { dist: {} }, '0.5.480': { dist: { integrity: 'sha512-a' } }, '0.6.0': { dist: { integrity: 'sha512-b' } } } };
  const pick = pickNpmVersion(meta, '0.5.473', new Date('2026-01-01'));
  assert.equal(pick.version, '0.5.480');
  assert.equal(pick.newerMajor, '0.6.0');
});

test('apk index: one record per package with version, origin, license and commit', () => {
  const index = 'C:Q1abc=\nP:bash\nV:5.2.37-r0\nA:x86\no:bash\nL:GPL-3.0-or-later\nc:0123456789abcdef0123456789abcdef01234567\nU:https://www.gnu.org/software/bash/\n\nP:nano\nV:8.4-r0\no:nano\nL:GPL-3.0-or-later\nc:fedcba9876543210fedcba9876543210fedcba98\nU:https://www.nano-editor.org/\n';
  assert.deepEqual(parseApkIndex(index).get('bash'), { name: 'bash', version: '5.2.37-r0', origin: 'bash', license: 'GPL-3.0-or-later', sourceCommit: '0123456789abcdef0123456789abcdef01234567', url: 'https://www.gnu.org/software/bash/' });
  assert.equal(parseApkIndex(index).size, 2);
});
