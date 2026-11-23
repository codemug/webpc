// Unit tests for scripts/release/versions.mjs (the versioned-release helpers).
// Pure functions only: no git, no gh, no browser.
// Run: node --test tests/release-versions.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { highestVersion, bumpFor, nextVersion, releaseNotes } from '../scripts/release/versions.mjs';

const fix = (subject) => ({ subject });

test('no published tag gives v0.1.0', () => {
  assert.equal(nextVersion([], []), 'v0.1.0');
  assert.equal(nextVersion([], [fix('feat: something new')]), 'v0.1.0');
  assert.equal(highestVersion([]), null);
});

test('patch, minor and major bumps', () => {
  assert.equal(nextVersion(['v1.2.3'], [fix('fix: a repair')]), 'v1.2.4');
  assert.equal(nextVersion(['v1.2.3'], [fix('feat: a new app')]), 'v1.3.0');
  assert.equal(nextVersion(['v1.2.3'], [fix('feat!: a breaking feature')]), 'v2.0.0');
  assert.equal(nextVersion(['v1.2.3'], [fix('chore: tidy'), { subject: 'fix: x', body: 'no changes here' }]), 'v1.2.4');
});

test('BREAKING CHANGE in the body is a major bump', () => {
  assert.equal(nextVersion(['v1.2.3'], [{ subject: 'fix: the rebuild', body: 'BREAKING CHANGE: the dist layout moved' }]), 'v2.0.0');
});

test('a breaking commit wins over feats; scoped feats are minors', () => {
  assert.equal(nextVersion(['v0.4.9'], [fix('feat: small'), { subject: 'refactor!: new core', body: '' }]), 'v1.0.0');
  assert.equal(nextVersion(['v0.4.9'], [fix('feat(api): endpoint')]), 'v0.5.0');
  assert.equal(bumpFor([fix('feat: small'), fix('fix: a repair')]), 'minor');
  assert.equal(bumpFor([fix('fix: a repair')]), 'patch');
  assert.equal(bumpFor([]), 'patch');
});

test('a pre-existing non-semver tag such as latest-dist is ignored', () => {
  assert.equal(nextVersion(['latest-dist'], [fix('fix: a repair')]), 'v0.1.0');
  assert.deepEqual(highestVersion(['latest-dist', 'v0.2.0']), { major: 0, minor: 2, patch: 0 });
});

test('the highest tag wins regardless of list order', () => {
  assert.equal(nextVersion(['v0.9.0', 'v0.10.0'], [fix('fix: a repair')]), 'v0.10.1');
  assert.equal(nextVersion(['v0.10.0', 'v0.9.0'], [fix('feat: a new app')]), 'v0.11.0');
  assert.equal(nextVersion(['v1.2.3', 'v1.10.0', 'v1.9.9'], []), 'v1.10.1');
});

test('notes: one line per non-merge commit, newest first, with the 7-char shorthash', () => {
  const commits = [
    { subject: 'fix: the last fix', hash: 'abcdef1234567890', merge: false },
    { subject: 'Merge main into feature', hash: 'ffff000011112222', merge: true },
    { subject: 'feat: the feature', hash: '1234abcd5678ef90', merge: false },
  ];
  assert.equal(
    releaseNotes(commits, { builtFrom: 'abcdef1234567890' }),
    '- fix: the last fix (abcdef1)\n- feat: the feature (1234abc)\nBuilt from commit abcdef1234567890.',
  );
});

test('notes: the cap keeps the first lines, then and N more', () => {
  const commits = Array.from({ length: 105 }, (_, i) => ({
    subject: `commit ${i + 1}`,
    hash: `${String(1000 + i)}abcdef123456789`,
    merge: false,
  }));
  const notes = releaseNotes(commits, { builtFrom: 'ffffffffffffffffffffffffffffffffffffffff' });
  const lines = notes.split('\n');
  assert.equal(lines.length, 102, '100 commit lines, the and-N-more line and the built-from line');
  assert.equal(lines[0], '- commit 1 (1000abc)');
  assert.equal(lines[99], '- commit 100 (1099abc)');
  assert.equal(lines[100], '- and 5 more');
  assert.equal(lines[101], 'Built from commit ffffffffffffffffffffffffffffffffffffffff.');
});

test('notes: merge commits are left out of the count and the cap', () => {
  const commits = [];
  for (let i = 0; i < 101; i++) commits.push({ subject: `commit ${i + 1}`, hash: `${i}abcdef123456789`, merge: false });
  commits.splice(5, 0, { subject: 'Merge pull request 7', hash: 'mmmmabcdef12345678', merge: true });
  const notes = releaseNotes(commits, { builtFrom: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }).split('\n');
  assert.equal(notes.length, 102);
  assert.equal(notes[100], '- and 1 more', 'the merge does not count against the cap');
  assert.ok(!notes.some((line) => line.includes('Merge pull request')));
});
