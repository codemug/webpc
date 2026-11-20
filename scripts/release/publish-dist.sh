#!/usr/bin/env bash
# Publish the built dist/ as the "latest-dist" release assets, which the host site downloads:
#   webpc-dist.tar.gz         dist/ (pc/ and third-party/ only; the root redirect is for local preview)
#   webpc-dist.tar.gz.sha256  its checksum, verified by the host before extracting
#   webpc-build.json          the commit and time it was built from
# Needs GH_TOKEN with contents: write. Usage: scripts/release/publish-dist.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
test -d dist/pc || { echo "publish-dist: run npm run build first" >&2; exit 1; }
sha=$(git rev-parse HEAD)
printf '{"commit":"%s","builtAt":"%s"}\n' "$sha" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > webpc-build.json
tar -czf webpc-dist.tar.gz -C dist pc third-party
sha256sum webpc-dist.tar.gz | cut -d' ' -f1 > webpc-dist.tar.gz.sha256
if ! gh release view latest-dist > /dev/null 2>&1; then
  gh release create latest-dist --title "Latest WebPC build" --notes "Rolling build of main. Download webpc-dist.tar.gz and check it against webpc-dist.tar.gz.sha256." --latest=false
fi
gh release upload latest-dist webpc-dist.tar.gz webpc-dist.tar.gz.sha256 webpc-build.json --clobber
gh release edit latest-dist --notes "Rolling build of main at ${sha}. Download webpc-dist.tar.gz and check it against webpc-dist.tar.gz.sha256."
echo "published latest-dist for ${sha} ($(du -h webpc-dist.tar.gz | cut -f1))"
