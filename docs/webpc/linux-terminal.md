# Browser-local Linux Terminal

`/pc/apps/terminal/` runs a real Alpine Linux 3.24 system (aarch64 user space) on [unkernel](https://github.com/pithings/unkernel): a Linux kernel compiled to WebAssembly with a real MMU, its own file systems and its own TCP/IP stack. The kernel runs in a dedicated module Worker; xterm.js renders its pty. This replaces the previous v86 x86 emulator. The pinned unkernel release, its `alpine.erofs` image and the pre-baked data disk are pinned in `catalog.yaml` and `scripts/pc/terminal/packages.json`.

It has 512 MiB guest memory plus browser overhead. Opening the desktop does not load this guest; the user starts it. The kernel needs WebAssembly JSPI (Chrome or Edge 137+, Firefox 153+, Safari 27+); other browsers see a clear "this browser cannot run the Terminal" message instead of a broken window.

## What loads, and where it comes from

`npm ci --ignore-scripts && npm run assets:pc` runs `scripts/pc/prepare-terminal.mjs`, which vendors into ignored `public/pc/vendor/unkernel/`, every byte SHA-256 checked:

- the unkernel SDK browser files (`web.mjs`, `_chunks/core.mjs`, `unkernel.wasm`) from the pinned npm package, checked against `node_modules`;
- `distros.json` and `alpine.erofs` from the pinned `pithings/unkernel` GitHub release, with the image additionally checked against `distros.json` and the catalog pin;
- the pre-baked data disk template `data-template.kwsparse.gz` from this repository's public `terminal-data-v1` release. A local prebake cache under `node_modules/.cache/webpc/unkernel/` is reused only when it already matches the pinned hash; otherwise the asset is fetched and cached.

No Docker, no Python and no guest build tools: preparation is Node plus pinned downloads. The output carries a `release.json` manifest whose `recipeId` (pins, release assets, SDK bytes) makes stale generated output re-prepare instead of being served.

## The pre-baked data disk

The template is a 4 GiB ext4 data disk (27,338 blocks in use, 39.7 MB gzipped) with `python3 3.14.10-r1` and `nodejs 24.22.3-r0` installed on top of the base image from Alpine's v3.24 `main` repository. It is built with

```sh
node --experimental-wasm-jspi scripts/pc/terminal/prebake.mjs
```

on Node 24 or newer, because Node 24.1's V8 still keeps JSPI behind a flag. CI runs Node 22 and never pre-bakes; the template is uploaded once as the public `terminal-data-v1` release asset, whose notes list the 28 added packages and their licences. The prebake boots the guest once with the host network (installs the pinned packages) and once with `--no-net` (proves they run offline), then exports the disk and prints the SHA-256 to pin in `packages.json`.

## Why the image is fetched whole

GitHub Pages gzips byte-range responses for binary files: `content-encoding: gzip` applies to the range of the compressed bytes, so the SDK's lazy Range reads of `alpine.erofs` corrupt the guest and it falls back to its safe mode. Preparation therefore downloads the image whole, and the page hands the Worker a `blob:` URL that Chrome can range-read (Firefox and Safari unverified). `application/gzip` files are served raw, which is the fallback if blob ranges fail elsewhere.

## Persistence

The kernel mounts the read-only `alpine.erofs` root image under a writable ext4 data disk kept in IndexedDB. The browser seeds that disk from the template only when it has no saved disk yet, and fetches the 40 MB template only in that case. Everything the user changes (files, installed packages) survives a reload. There are no checkpoints or session exports: the data disk itself is the state.

## Exec service (BroadcastChannel)

`/pc/apps/terminal/` listens on `BroadcastChannel('webpc-terminal')` for `{type:'exec-request', id, from, lang, code, timeoutMs}` from other same-origin pages (WebPC Agent) and replies with `exec-result` (`{id, exitCode, output, truncated, durationMs}`) or `exec-error` (`{id, reason}`). The difference from the v86 design is how a run happens: instead of typing into the console and scraping the serial output, the Terminal side executes the code through the kernel's `vm.exec()` API, which returns the exit code and the output directly.

Every run still needs a visible approval click: the prompt shows the source app, the language and the full code with **Run** and **Deny** buttons (Deny focused by default, keyboard accessible, no auto-approve timeout, because any same-origin page can post on the channel). Languages: `sh`, `python`, `node`. The pure protocol helpers live in `src/scripts/pc/apps/terminal-exec.mjs`; unit tests are in `tests/pc-terminal-exec.test.mjs`.

## Upgrading the pinned kernel

1. Pick the new unkernel release tag and read that release's `distros.json` asset.
2. In `catalog.yaml`, move the `unkernel` npm pin and both `pithings/unkernel` `github-release` sources to the new tag, re-pinning the SHA-256 of `distros.json` and `alpine.erofs` from that `distros.json`.
3. `npm ci`, then re-run `scripts/pc/prepare-terminal.mjs`; it fails until the catalog pins and the installed package agree.
4. Bump `kernelVersion` in `scripts/pc/terminal/packages.json` to the new version.
5. If the base image changed, re-prebake the data disk (Node 24, `--experimental-wasm-jspi`), pin the printed template SHA-256 in `packages.json`, publish a new `terminal-data-v*` release asset, and point the `codemug/webpc` source in `catalog.yaml` at it.

Kernels are upgraded manually on purpose: unkernel releases almost daily, and the pin, the image, the pre-bake and the browser suite all move together.

## Networking and licensing

The guest has no network by default: no `eth0`, no DNS. A general network would go through unkernel's Wisp proxy support (a separately operated relay, authentication and explicit user configuration); none is included or silently connected here.

`public/third-party/terminal/` carries unkernel's licence texts (kernel GPL-2.0, SDK MIT) and the template's provenance. The guest packages keep their own licences (see `data-template-NOTICES.txt` and the release notes). Preserve applicable notices and source-distribution obligations when distributing the guest.

Real Chromium behavior is covered in `tests/browser/pc-linux.spec.mjs`.
