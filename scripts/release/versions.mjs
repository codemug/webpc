#!/usr/bin/env node
// Versioned WebPC releases: a semver tag per published release and one rolling draft for
// the next version. Pure helpers (no git, no gh, so the Node tests need neither) plus a
// small CLI that reads git itself via execFileSync. publish-dist.sh calls the CLI.
//
//   node scripts/release/versions.mjs next    print the next version for HEAD
//   node scripts/release/versions.mjs notes   print the draft release notes for HEAD
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// A published tag: vMAJOR.MINOR.PATCH, nothing else (latest-dist and friends are ignored).
const SEMVER = /^v(\d+)\.(\d+)\.(\d+)$/;
// A conventional-commit subject with a breaking marker, e.g. feat!: or fix(api)!:
const BREAKING_SUBJECT = /^[\w-]+(\([^)]*\))?!:/;
// A feat subject, e.g. feat: or feat(api): (feat!: is breaking, caught above first).
const FEAT_SUBJECT = /^feat(\([^)]*\))?!?:/;

/**
 * The highest published semver tag among `tags` (strings from git tag --list), as
 * { major, minor, patch }, or null when none exists. Non-semver tags are ignored and
 * the result does not depend on the list order.
 */
export function highestVersion(tags) {
  let best = null;
  for (const tag of tags) {
    const match = String(tag).match(SEMVER);
    if (!match) continue;
    const version = { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
    if (
      best === null
      || version.major > best.major
      || (version.major === best.major && version.minor > best.minor)
      || (version.major === best.major && version.minor === best.minor && version.patch > best.patch)
    ) best = version;
  }
  return best;
}

/**
 * The bump implied by `commits` ([{ subject, body }]): major when any subject has a
 * type! marker or any body has BREAKING CHANGE, minor when any subject is a feat,
 * else patch.
 */
export function bumpFor(commits) {
  for (const commit of commits) {
    const subject = String(commit?.subject ?? '');
    const body = String(commit?.body ?? '');
    if (BREAKING_SUBJECT.test(subject) || body.includes('BREAKING CHANGE')) return 'major';
  }
  for (const commit of commits) {
    if (FEAT_SUBJECT.test(String(commit?.subject ?? ''))) return 'minor';
  }
  return 'patch';
}

/**
 * The next version tag: v0.1.0 with no published tag, else the highest published tag
 * bumped by `commits` (the commits since that tag). tags are the strings from
 * git tag --list 'v*.*.*'.
 */
export function nextVersion(tags, commits) {
  const top = highestVersion(tags);
  if (top === null) return 'v0.1.0';
  const bump = bumpFor(commits);
  if (bump === 'major') return `v${top.major + 1}.0.0`;
  if (bump === 'minor') return `v${top.major}.${top.minor + 1}.0`;
  return `v${top.major}.${top.minor}.${top.patch + 1}`;
}

/**
 * The draft release notes: one line per non-merge commit, newest first, as
 * "- subject (shorthash)", capped at `cap` lines plus "- and N more" when there are
 * more, then a line naming the commit the assets were built from.
 * commits: [{ subject, hash, merge }], newest first (a merge commit has two or more
 * parents and carries merge: true). builtFrom: the full commit sha.
 */
export function releaseNotes(commits, { builtFrom, cap = 100 } = {}) {
  const shown = [];
  for (const commit of commits) if (commit && !commit.merge) shown.push(commit);
  const lines = [];
  const limit = Math.max(0, cap);
  for (const commit of shown.slice(0, limit)) lines.push(`- ${commit.subject} (${String(commit.hash).slice(0, 7)})`);
  if (shown.length > limit) lines.push(`- and ${shown.length - limit} more`);
  if (builtFrom) lines.push(`Built from commit ${builtFrom}.`);
  return lines.join('\n');
}

// ---- CLI: read git directly ---------------------------------------------------

const git = (args) => execFileSync('git', args, { encoding: 'utf8' });

/** The tags a published release can use: the brief's git tag --list pattern. */
function listTags() {
  return git(['tag', '--list', 'v*.*.*']).split(/\r?\n/).filter(Boolean);
}

/**
 * Commits since `tag` (all of history when null), newest first, as
 * { subject, body, hash, merge }. Records are separated with a unit separator so a
 * multiline body can never be mistaken for a commit boundary.
 */
function commitsSince(tag) {
  const range = tag ? [`${tag}..HEAD`] : [];
  const raw = git(['log', ...range, '--format=%x1e%H%x1f%P%x1f%s%x1f%b']);
  const commits = [];
  for (const record of raw.split('\x1e')) {
    const text = record.trim();
    if (text === '') continue;
    const [hash, parents, subject, ...bodyParts] = text.split('\x1f');
    commits.push({
      hash,
      subject,
      body: bodyParts.join('\x1f'),
      merge: parents.trim().split(/\s+/).filter(Boolean).length > 1,
    });
  }
  return commits;
}

function runCli(argv) {
  const [command] = argv;
  if (command !== 'next' && command !== 'notes') {
    process.stderr.write('usage: node scripts/release/versions.mjs <next|notes>\n');
    return 1;
  }
  const tags = listTags();
  const top = highestVersion(tags);
  const tag = top === null ? null : `v${top.major}.${top.minor}.${top.patch}`;
  const commits = commitsSince(tag);
  if (command === 'next') {
    process.stdout.write(nextVersion(tags, commits) + '\n');
    return 0;
  }
  const builtFrom = git(['rev-parse', 'HEAD']).trim();
  process.stdout.write(releaseNotes(commits, { builtFrom }) + '\n');
  return 0;
}

// Run the CLI only when executed directly, so the pure helpers stay importable in tests.
if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(runCli(process.argv.slice(2)));
