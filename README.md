<p align="center">
  <a href="https://usmanshahid.is-a.dev/pc/"><img src="docs/images/hero.png" alt="WebPC desktop with a real Linux terminal drawing a Mandelbrot set in Python, in front of GridCraft and SoundCraft windows" width="100%"></a>
</p>

<h1 align="center">WebPC</h1>

<p align="center">
  <b>A whole desktop in a browser tab.</b><br>
  24 real apps (a video editor, a 3D texture painter, a music DAW, Linux, Wireshark and an AI agent) running entirely on your machine.<br>
  Pinned, verified and kept up to date by a weekly robot.
</p>

<p align="center">
  <a href="https://usmanshahid.is-a.dev/pc/"><b>▶&nbsp;Try it live at usmanshahid.is-a.dev/pc</b></a>
</p>

<p align="center">
  <a href="https://github.com/codemug/webpc/actions/workflows/ci.yml"><img src="https://github.com/codemug/webpc/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/codemug/webpc/actions/workflows/upgrade.yml"><img src="https://github.com/codemug/webpc/actions/workflows/upgrade.yml/badge.svg" alt="Weekly app upgrades"></a>
  <a href="https://github.com/codemug/webpc/releases/tag/latest-dist"><img src="https://img.shields.io/badge/build-latest--dist-0e7490" alt="Latest build"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-16a34a" alt="MIT licence"></a>
</p>

---

## Why WebPC

- **Real apps, not mock-ups.** The Storytold Craft editors are full Rust and WebAssembly applications. The Terminal runs Alpine Linux on a real Linux kernel compiled to WebAssembly. The Packet Viewer runs Wireshark's own dissectors. WebPC Agent, the built-in assistant, runs language models on your GPU.
- **Nothing leaves your machine.** Opening an app makes zero requests to any other host. The smoke checks and browser tests assert this for each app. Your files stay in your browser's storage, and network tools only reach out when you press their button.
- **No server.** WebPC is a static site: drop the build into any host and serve it at `/pc/`.
- **WebPC Agent, one click away.** A friendly on-device assistant slides in from the taskbar over the right third of the screen. It can read the files you grant, search the web and run code in the Terminal, and it keeps your chat while hidden.
- **A real desktop feel.** Drag icons anywhere on the desktop, move, resize and maximize windows, and right-click any app to pop it out into its own browser window.
- **Pinned and verified.** Every upstream release is pinned to an exact version and SHA-256 checksum, and checked before it is unpacked.
- **Keeps itself current.** Every Monday a workflow looks for new releases, upgrades each app, and runs the unit tests, a full build and a headless smoke check. Only then does it commit to `main`. Anything that needs a person lands in [one tidy issue](https://github.com/codemug/webpc/issues).
- **One file to rule it.** [`catalog.yaml`](catalog.yaml) lists every app and every pin. Set `enabled: false` and the app is gone from the desktop and the build.

## A look inside

<table>
  <tr>
    <td width="50%"><img src="docs/images/desktop.png" alt="The WebPC desktop with 27 app icons and the WebPC wordmark"><br><b>The desktop.</b> Drag icons anywhere (they snap to a grid and stay put), right-click an app to open it in a WebPC window, a new browser window or a tab, and use windows, a taskbar, an app launcher, full keyboard control, and light and dark themes.</td>
    <td width="50%"><img src="docs/images/terminal.png" alt="A Linux terminal showing an ASCII Mandelbrot set rendered by Python"><br><b>Terminal.</b> Real Alpine Linux with a shell, Python and Node.js. It runs offline, and your files survive a reload.</td>
  </tr>
  <tr>
    <td><img src="docs/images/filmcraft.png" alt="FilmCraft video editor with a demo project on a multi-track timeline"><br><b>FilmCraft.</b> A timeline video editor with effects, titles and audio mixing.</td>
    <td><img src="docs/images/soundcraft.png" alt="SoundCraft digital audio workstation with drum, bass, pad, keys and lead tracks"><br><b>SoundCraft.</b> A multitrack audio workstation for editing, mixing and exporting.</td>
  </tr>
  <tr>
    <td><img src="docs/images/texturecraft.jpg" alt="TextureCraft painting a rusty red material onto a 3D sphere"><br><b>TextureCraft.</b> Paint and bake PBR textures onto 3D meshes.</td>
    <td><img src="docs/images/packets.png" alt="Packet Viewer dissecting DNS, TCP and HTTP packets with a protocol tree and hex dump"><br><b>Packet Viewer.</b> Open pcap and pcapng captures with Wireshark 4.6 dissectors, compiled to WebAssembly.</td>
  </tr>
  <tr>
    <td><img src="docs/images/buddy.png" alt="WebPC Agent's panel open over the right third of the WebPC desktop, greeting with Hi, I'm WebPC Agent"><br><b>WebPC Agent.</b> Your on-device sidekick, opened from the taskbar. Local models with tools for files, the web, OCR, background removal and running code in the Terminal. An optional cloud model uses your own key.</td>
    <td><img src="docs/images/excalidraw.png" alt="Excalidraw diagram: catalog.yaml to weekly upgrader to latest-dist to your site"><br><b>Excalidraw.</b> Hand-drawn diagrams with its fonts served by WebPC, never fetched from a CDN. Pictured: how WebPC ships.</td>
  </tr>
</table>

## What's on the desktop

| | Apps |
|---|---|
| **Office** | GridCraft (spreadsheets) · Docs · DeckCraft (presentations) · PDFCraft |
| **Creative** | FilmCraft · EffectCraft · SoundCraft · BeepBox · PhotoCraft · LightCraft · VectorCraft · FigCraft · CADCraft · MaterialCraft · TextureCraft · Excalidraw |
| **Built in** | WebPC Agent, the assistant behind the taskbar's WebPC Agent button (not a desktop app) |
| **Developer** | Terminal (Alpine Linux) · Packet Viewer (Wireshark dissectors) · VS Code (opens vscode.dev) |
| **Utilities** | Files · Media Player · SQLiteViz · CyberChef · Network Tools (DNS, RDAP, global ping, subnets, password strength, age encryption) · VERT (opens vert.sh) |

## WebPC Agent

WebPC Agent is the assistant behind the taskbar's WebPC Agent button: a panel over the right third of the desktop, not a window. It runs a local model by default (Qwen3.5 0.8B or 2B, or LFM3 1.7B, the default; the weights download once after you load the model and are cached in this browser) and can use an optional cloud model with your own key, opt-in per session and never persisted.

WebPC Agent acts through a tool catalog of 257 tools in 25 packs, built by `npm run catalog` from the source packs in `agent/`: the desktop and its windows, the Files area, and every enabled app. It finds what to do with six meta tools:

- `lookup_skill_index`: search the skill wiki for how to do a task.
- `read_skill`: read one skill by path, or one of its sections.
- `find_in_skill`: find matching lines inside one skill.
- `find_tool`: search the tool catalog for what a tool does.
- `describe_tool`: show a tool's full parameter list, effect and call template.
- `call_tool`: call a catalog tool with its own parameters.

WebPC Agent runs every tool call without asking, on every backend. `scripts/agent/eval.mjs` runs 60 tasks from `tests/agent-eval/tasks.yaml` against a running preview; the contributor guide for the packs is [agent/README.md](agent/README.md).

## How it ships

```mermaid
flowchart LR
  C[catalog.yaml<br/>apps, flags, pins] --> B[npm run build<br/>prepare, verify, prune]
  U[weekly upgrader<br/>bump, test, smoke-check] -->|commits passing apps| C
  B --> CI[CI on main]
  CI --> R[latest-dist release<br/>tarball + SHA-256]
  CI --> D[versioned draft release<br/>next semver tag]
  R --> H[your site<br/>served at /pc/]
```

1. **[`catalog.yaml`](catalog.yaml)** holds each app's desktop entry, its `enabled` flag and its pinned sources. There are 39 sources, 29 of them on automatic upgrades.
2. **`npm run build`** does the following:
   - validates the catalog;
   - downloads and verifies each enabled app;
   - builds the static site;
   - removes the pages and files of disabled apps;
   - fails if the result exceeds 990 MB (GitHub Pages allows 1 GB).
3. **CI** runs the tests and the build on every push. On `main` it publishes the result as the [`latest-dist`](https://github.com/codemug/webpc/releases/tag/latest-dist) release and keeps one rolling draft of the next version:
    - the version is a semver tag, bumped from the commits since the last published release: any `type!:` subject or `BREAKING CHANGE` in a body is a major, any `feat` a minor, otherwise a patch, and the first is `v0.1.0`;
    - on every push the draft's assets are replaced, its target moves to the pushed commit and its notes are rewritten: one line per non-merge commit, newest first, capped at 100 lines;
    - when a feat or a breaking change lands after the draft was cut, its tag and title move to the new version.

   Publishing is manual: un-draft the release in the GitHub UI, or with `gh release edit v0.1.0 --draft=false --repo codemug/webpc`. Publishing creates the version's git tag at the draft's target commit (a draft only holds a pending tag), and a host site can then pin that version.
4. **A host site** downloads `latest-dist`, checks the checksum and serves it at `/pc/`. [codemug.github.io](https://github.com/codemug/codemug.github.io) does this on every deploy and once a day. `latest-dist` stays the rolling build until the site pins a published version; `webpc-build.json` names the commit, the build time and the version it was built from.

## The catalog

Each entry under `apps:` has a desktop entry (`title`, `category`, `keywords`, `description`, `src`, `kind`, window size), an `enabled` flag, an optional upstream `icon`, and its `sources`:

```yaml
- id: gridcraft
  enabled: true
  title: GridCraft
  category: Office
  wasm:
    build: "cd apps/gridcraft-web && trunk build --release"
  icon:                     # the app's own icon, pinned and served by WebPC
    from: repo              # a file in the app's repo at its release tag
    path: assets/app-icon/hicolor/256x256/apps/ai.storyteller.gridcraft.png
    sha256: 3d8cb180ae9ea3691051e8d2309e79baf6f69e0a86276bf50265b5867ff26e41
  sources:
    - type: github-release
      repo: storytold/gridcraft
      tag: v0.19.1
      asset: gridcraft-web-*.zip
      url: https://github.com/storytold/gridcraft/releases/download/v0.19.1/gridcraft-web-0.19.1.zip
      sha256: 48c5d1b101befebb3c5ba3b7a14914f01c3207934813ed07dc4251b7ae116a78
      upgrade: auto
```

| Source type | Pinned by | Used for |
|---|---|---|
| `github-release` | tag, asset URL and SHA-256 (plus an optional pinned licence file) | the Craft apps, SQLiteViz, BeepBox, CyberChef |
| `npm` | exact version, matching `package.json` and the lockfile | xterm, Excalidraw, the Network Tools libraries |
| `npm-tarball` | version and SRI integrity | wiregasm (Packet Viewer) |
| `cdn-file` | package, version, file and SHA-256 | Transformers.js, Readability |
| `huggingface` | model repo and commit | WebPC Agent's models |

Icons come from upstream wherever the app ships one: the Storytold apps' own icon set (re-pinned by the upgrader whenever the tag moves), the icons inside the SQLiteViz, BeepBox and CyberChef releases, and pinned files for Excalidraw and VERT. WebPC's own apps keep its gradient tiles.

**A packaged app builds to WebAssembly.** An app is *packaged* when WebPC downloads its pinned release, prepares it under `/pc/apps/<id>/` and ships its bytes with the site: every `kind: iframe` app. Each packaged entry carries a `wasm` block whose single key `build` is the command that builds the app's wasm module from its source repository at the pinned version (for example `cd apps/gridcraft-web && trunk build --release`). WebPC's build never runs that command; it ships the upstream artifact as-is. An app added after 2026-11-23 must provide a real `wasm.build`. The pre-existing apps that ship no wasm module built from their own source (JavaScript apps such as CyberChef and BeepBox, and WebPC's own Files and Media pages) are exempted by the `LEGACY_NON_WASM` list in `scripts/catalog/catalog.mjs`, which is closed: do not add ids to it. `external` apps (a link to a hosted service) and the one `panel` app (WebPC Agent) are not packaged, so they need no `wasm` block.

`npm run catalog` validates the file, naming the app and field of every defect, and generates the desktop registry. `npm test` and `npm run build` run it first.

## Automatic upgrades

[`upgrade.yml`](.github/workflows/upgrade.yml) runs every Monday at 03:00 UTC, or on demand for a single app. For each `upgrade: auto` source it picks the newest eligible release:

- **GitHub releases:** only from the pinned repo, never a draft, a prerelease or a downgrade.
- **npm packages:** within the pinned major version (for `0.x`, within the minor).

Every release must be at least 3 days old. One app at a time, the upgrader writes the new pins (hashing the exact new files), then runs the tests, the build and that app's smoke check. A pass becomes one commit on `main`; a failure is reverted and reported. Manual sources (hand-written adapters, AI model revisions) and new major versions are listed in the issue instead. That commit, like every push to main, refreshes the latest-dist release and the versioned draft (see How it ships).

```sh
npm run upgrade -- --dry-run   # see what is newer upstream, change nothing
```

## Run it yourself

```sh
npm ci --ignore-scripts
npm test               # unit tests (validates the catalog first)
npm run build          # needs unzip and network for a clean build
npm run preview        # open http://localhost:4321/pc/
npm run test:browser   # Playwright suite against the build (Chromium)
```

A clean build caches the pinned downloads in `node_modules/.cache/webpc/`.

To host WebPC on your own static site, download `webpc-dist.tar.gz` from [`latest-dist`](https://github.com/codemug/webpc/releases/tag/latest-dist) and verify it against `webpc-dist.tar.gz.sha256`. Then extract it into your build output. It contains `pc/` and `third-party/`.

## License

WebPC's own code is released under the [MIT License](LICENSE). The apps it bundles keep their own licences: each one's licence, notices and the changes WebPC made are under [`public/third-party/`](public/third-party/).

## Credits

WebPC stands on excellent open-source work, including:
- the [Storytold](https://github.com/storytold) Craft apps;
- [unkernel](https://github.com/pithings/unkernel) and [Alpine Linux](https://alpinelinux.org);
- [wiregasm](https://github.com/good-tools/wiregasm) and Wireshark;
- [Transformers.js](https://github.com/huggingface/transformers.js);
- [Excalidraw](https://github.com/excalidraw/excalidraw), [CyberChef](https://github.com/gchq/CyberChef), [SQLiteViz](https://github.com/lana-k/sqliteviz), [BeepBox](https://github.com/johnnesky/beepbox) and [xterm.js](https://github.com/xtermjs/xterm.js).

Each app's licence, notices and the changes WebPC made are under [`public/third-party/`](public/third-party/), served at `/third-party/`. Integration notes live in [`docs/webpc/`](docs/webpc/), and the window manager design is in [`src/components/pc/DESIGN.md`](src/components/pc/DESIGN.md).

<p align="center"><a href="https://usmanshahid.is-a.dev/pc/"><b>Open WebPC</b></a> · made by <a href="https://usmanshahid.is-a.dev">Usman Shahid</a></p>
