#!/usr/bin/env bash
# Publish the built dist/ to the two releases the host site reads:
#   latest-dist   the rolling build of main, kept exactly as it was
#   v<next>       one rolling draft for the next version, kept on every main push
# Each gets the same three assets:
#   webpc-dist.tar.gz         dist/ (pc/ and third-party/ only; the root redirect is for local preview)
#   webpc-dist.tar.gz.sha256  its checksum, verified by the host before extracting
#   webpc-build.json          the commit, the build time and the version (the draft's, next to commit and builtAt)
# The draft's version comes from the conventional commits since the last published tag
# (scripts/release/versions.mjs): any type! subject or BREAKING CHANGE in a body is a
# major, any feat a minor, else a patch. With no published tag the version is v0.1.0.
# Needs GH_TOKEN with contents: write. Usage: scripts/release/publish-dist.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
test -d dist/pc || { echo "publish-dist: run npm run build first" >&2; exit 1; }
sha=$(git rev-parse HEAD)
version=$(node scripts/release/versions.mjs next)
printf '{"commit":"%s","builtAt":"%s","version":"%s"}\n' "$sha" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$version" > webpc-build.json
tar -czf webpc-dist.tar.gz -C dist pc third-party
sha256sum webpc-dist.tar.gz | cut -d' ' -f1 > webpc-dist.tar.gz.sha256

# --- latest-dist: the rolling build, unchanged ---------------------------------
if ! gh release view latest-dist --repo "$GITHUB_REPOSITORY" > /dev/null 2>&1; then
  gh release create latest-dist --repo "$GITHUB_REPOSITORY" --title "Latest WebPC build" --notes "Rolling build of main. Download webpc-dist.tar.gz and check it against webpc-dist.tar.gz.sha256." --latest=false
fi
gh release upload latest-dist webpc-dist.tar.gz webpc-dist.tar.gz.sha256 webpc-build.json --repo "$GITHUB_REPOSITORY" --clobber
gh release edit latest-dist --repo "$GITHUB_REPOSITORY" --notes "Rolling build of main at ${sha}. Download webpc-dist.tar.gz and check it against webpc-dist.tar.gz.sha256."

# --- the versioned draft: one for the next version, refreshed on every push ----
node scripts/release/versions.mjs notes > webpc-release-notes.md
draft=$(gh release list --repo "$GITHUB_REPOSITORY" --json tagName,isDraft --jq '[.[]|select(.isDraft)][0].tagName // empty')
if [ -n "$draft" ] && [ "$draft" != "$version" ]; then
  # A feat or breaking change landed after the draft was cut: move its tag and title to the new version.
  gh release edit "$draft" --repo "$GITHUB_REPOSITORY" --tag "$version" --title "$version"
fi
if [ -z "$draft" ]; then
  gh release create "$version" --repo "$GITHUB_REPOSITORY" --draft --title "$version" --target "$sha" --notes-file webpc-release-notes.md
fi
gh release upload "$version" webpc-dist.tar.gz webpc-dist.tar.gz.sha256 webpc-build.json --repo "$GITHUB_REPOSITORY" --clobber
gh release edit "$version" --repo "$GITHUB_REPOSITORY" --target "$sha" --notes-file webpc-release-notes.md
echo "published latest-dist and draft ${version} for ${sha} ($(du -h webpc-dist.tar.gz | cut -f1))"
