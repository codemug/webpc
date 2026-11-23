WebPC Terminal -- third-party software and source provenance

The Terminal runs Alpine Linux 3.24 (aarch64 user space) on unkernel, a
Linux kernel compiled to WebAssembly. Pinned version 0.2.0-261123-8f039c5
(pins in catalog.yaml and scripts/pc/terminal/packages.json):
https://github.com/pithings/unkernel/tree/v0.2.0-261123-8f039c5
The kernel is GPL-2.0 (see unkernel-LICENSE.txt); the JavaScript SDK is
MIT (see unkernel-LICENSE-MIT.txt). These texts are the unmodified
licence files of the pinned npm package
(https://www.npmjs.com/package/unkernel/v/0.2.0-261123-8f039c5).

The guest image alpine.erofs is the unmodified image of the pinned
unkernel release; scripts/pc/prepare-terminal.mjs verifies it against
distros.json and the SHA-256 pinned in catalog.yaml before vendoring it.

The pre-baked data disk template webpc-terminal-data-v1.kwsparse.gz adds
Python and Node.js to that image (28 Alpine packages, exact versions and
licences in the release notes). It is downloaded and SHA-256 checked
from the public release
https://github.com/codemug/webpc/releases/tag/terminal-data-v1 .
See data-template-NOTICES.txt for the package licences and Alpine's
source pointers (aports branch 3.24-stable).

xterm.js with addon-fit (exact versions are pinned in catalog.yaml at
https://github.com/codemug/webpc):
https://github.com/xtermjs/xterm.js -- MIT, see xterm-LICENSE.txt.
