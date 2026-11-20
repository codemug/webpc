# WebPC

A desktop in the browser: windows, a taskbar and about 25 apps that run locally in the page. Among them are the Storytold Craft editors, a real offline Linux terminal, an on-device AI agent, network tools and a Wireshark-powered packet viewer.

WebPC is a static site. It is built to be mounted at `/pc/` on a host site; [codemug.github.io](https://github.com/codemug/codemug.github.io) is the first host. Every app is pinned to an exact upstream release and verified by checksum before it is unpacked. Opening an app makes no request to another host unless you use a feature that says it does (for example a DNS lookup or a cloud model with your own key).

## The catalog

[`catalog.yaml`](catalog.yaml) is the single source of truth. Each entry under `apps:` has:

- **The desktop entry:** `title`, `category`, `keywords`, `description`, `src`, `kind` (`iframe`, `external` or `about`) and the window size.
- **`enabled`:** set it to `false` and the app is not prepared, not on the desktop, and its pages and files are removed from `dist/`.
- **`sources`:** every upstream artifact the app is built from, pinned exactly. Each has `upgrade: auto` or `upgrade: manual`.

| Source type | Pinned by | Example |
|---|---|---|
| `github-release` | tag, asset URL, SHA-256 (plus an optional pinned licence file) | the Craft apps, SQLiteViz, BeepBox, CyberChef |
| `npm` | exact version, which must match `package.json` and `package-lock.json` | xterm, Excalidraw, the Network Tools libraries |
| `npm-tarball` | version and SRI integrity | wiregasm (Packet Viewer) |
| `cdn-file` | package, version, file and SHA-256 (jsDelivr) | Transformers.js, Readability |
| `alpine` | the Linux guest's package lock | Terminal |
| `huggingface` | model repo and commit | AI Agent models |

`npm run catalog` validates the file and generates the desktop registry. It names the app and field of every defect, and checks the npm pins against the lockfile. `npm test` and `npm run build` run it first.

## Commands

```sh
npm ci --ignore-scripts
npm test                       # unit tests (validates the catalog first)
npm run build                  # prepare enabled apps, build, prune disabled apps, check the 990 MB budget
npm run preview                # serve dist/ on localhost:4321 (open /pc/)
npm run test:browser           # Playwright suite against the built site (Chromium; run locally, not in CI)
npm run upgrade -- --dry-run   # list newer upstream releases without changing anything
```

A clean build downloads the pinned releases into `node_modules/.cache/webpc/` and needs Docker and Python 3 for the Linux guest, plus `unzip`.

## Automatic upgrades

[`upgrade.yml`](.github/workflows/upgrade.yml) runs every Monday at 03:00 UTC, and on demand with an optional single app id.

1. For each enabled app it finds the newest eligible release of each `upgrade: auto` source:
   - GitHub releases: from the pinned repo only, with no drafts, prereleases or downgrades;
   - npm: within the pinned major (within the minor for `0.x`);
   - the Linux guest: the current Alpine index builds.
2. A release must be at least 3 days old.
3. For one app at a time, it writes the new pins (hashing the exact new files), then runs `npm test`, `npm run build` and a headless smoke check of that app.
4. An app that passes becomes one commit on `main`. An app that fails is reverted and reported.
5. Manual sources, new majors and failures go in one rolling issue, "Upgrades that need a human".

Manual sources are the ones with hand-written adapters (Docs, Excalidraw, the v86 emulator, the Anthropic SDK) and the AI model revisions.

## How a host site uses it

[`ci.yml`](.github/workflows/ci.yml) runs `npm ci`, `npm test` and `npm run build` on every push and pull request. On `main`, and after every upgrade run, it publishes the tested build as the `latest-dist` release:

- `webpc-dist.tar.gz`, which contains `pc/` and `third-party/`;
- its `.sha256` checksum;
- `webpc-build.json`, which records the commit.

A host downloads the archive, checks it against the `.sha256`, and extracts it into its own `dist/` before deploying. codemug.github.io does this on every publish and once a day.

## Apps

Office: GridCraft, Docs, DeckCraft, PDFCraft. Developer: Terminal, Packet Viewer, VS Code (opens vscode.dev). Utilities: SQLiteViz, Files, Media Player, CyberChef, Network Tools, AI Agent, VERT (opens vert.sh). Creative: LightCraft, FigCraft, SoundCraft, BeepBox, FilmCraft, CADCraft, VectorCraft, PhotoCraft, EffectCraft, MaterialCraft, TextureCraft, Excalidraw.

Per-app notes on integration, storage isolation and audio behaviour are in [`docs/webpc/`](docs/webpc/). The window manager and message contracts are in [`src/components/pc/DESIGN.md`](src/components/pc/DESIGN.md). Third-party licences and the changes WebPC made are under [`public/third-party/`](public/third-party/) (served at `/third-party/`).
