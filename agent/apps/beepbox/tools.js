// BeepBox pack: drive the vendored BeepBox editor (public/pc/vendor/beepbox, v4.2.2) inside the
// app's inner iframe. The vendored index.html (line 253) declares `let editor;` and then sets
// `editor = new beepbox.SongEditor(...)`; as a top-level `let`, the editor is not a window
// property, so the pack reads it through the frame's own realm (win.eval, see app below).
// The editor is a SongEditor (editor/SongEditor.ts): public doc (SongDocument, with public
// song: Song and public synth: Synth) is the live model. The song is the inner frame's URL
// hash, mirrored to localStorage pc:beepbox:song:v1 by the wrapper (src/scripts/pc/apps/
// beepbox.mjs), which also sets the precedent for the button.playButton / button.pauseButton
// selectors.
import { ToolError } from '../../../src/apps/ai-agent/runtime/args.mjs';
import { innerApi } from '../../shared/inner-app.js';

const APP = 'beepbox';
const NEEDS = ['host', 'app:beepbox'];
const NOT_HERE = 'BeepBox is not available here (Buddy is not running inside WebPC).';

// Gate on ctx.host (needs: ['host', 'app:beepbox']), then turn host rejections, which carry a
// code (unknown_app, not_open, not_iframe, timeout, invalid_argument), and innerApi's
// not_available into a ToolError the model can act on.
const call = (ctx, fn) => {
  if (!ctx.host) throw new ToolError('not_available', NOT_HERE, '');
  return Promise.resolve()
    .then(() => fn(ctx.host))
    .catch(error => {
      if (error instanceof ToolError) throw error;
      throw new ToolError(error.code || 'app_error', error.message, '');
    });
};

// The app window is the WebPC wrapper page; the real editor window is the #beepbox-frame
// iframe's contentWindow. The vendored index.html builds the editor in an inline classic script
// with a top-level `let editor`, which is NOT a window property, so win.editor is always
// undefined. It is read through the frame's own realm instead: win.eval runs in the inner
// realm's global scope, where the lexical `editor` binding is visible (live-confirmed: the
// inner page has no CSP, and editor.doc/song/synth resolve through it).
const app = async (host, ctx) => innerApi(await host.appWindow(APP), 'beepbox-frame', win => {
  try {
    const editor = win.eval('typeof editor === "undefined" ? null : editor');
    return editor ? { editor, win } : null;
  } catch { return null; }
}, { sleep: ctx.sleep, timeoutMs: ctx.timeoutMs });

export const pack = { id: APP, title: 'BeepBox' };

export const tools = [
  {
    name: 'beepbox.get_song',
    purpose: 'Get the current song hash and tempo.',
    when: 'Use when the user asks for the song link, or before loading or saving a song.',
    params: {},
    effect: 'read',
    needs: NEEDS,
    examples: [{ args: {}, says: 'What is the BeepBox song link?' }],
    // The live model is the fresh source: editor.doc.song.toBase64String() is the shareable hash
    // the app puts after # in URLs (SongEditor file menu copyUrl) and song.tempo is the live BPM
    // (synth/synth.ts Song class).
    run: async (args, ctx) => call(ctx, async host => {
      const { editor } = await app(host, ctx);
      return { hash: editor.doc.song.toBase64String(), tempo: editor.doc.song.tempo };
    }),
  },
  {
    name: 'beepbox.load_song',
    purpose: 'Load a song from a BeepBox hash or share URL.',
    when: 'Use when the user has a BeepBox song link or hash and wants it opened.',
    params: { hash: { type: 'string', required: true, description: 'The song hash (the part after # in a share URL), or the full URL' } },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { hash: 'sJ3mR8k2q' }, says: 'Open this song' }],
    // The editor listens for hashchange (SongDocument _whenHistoryStateChanged): when
    // history.state is null and the hash is non-empty it loads the song from the hash via
    // ChangeSong. The app keeps its own history state after boot, so clear it first
    // (history.replaceState(null, '')) and set the hash; if the same song is already loaded, an
    // empty-hash round trip first, so the hashchange that loads it actually fires.
    run: async (args, ctx) => call(ctx, async host => {
      const { win } = await app(host, ctx);
      const value = String(args.hash).trim();
      const at = value.lastIndexOf('#');
      const raw = at >= 0 ? value.slice(at + 1) : value;
      // A share URL without # has no hash to load; real hashes are base64 and never contain "://".
      if (!raw || raw.includes('://')) throw new ToolError('invalid_argument', 'no song hash in the value (the hash is the part after # in a BeepBox share URL)', '');
      const target = '#' + raw;
      win.history.replaceState(null, '');
      if (win.location.hash === target) {
        win.location.hash = '';
        await new Promise(resolve => setTimeout(resolve, 50)); // let the empty hash settle before loading
      }
      win.location.hash = target;
      return { hash: raw };
    }),
  },
  {
    name: 'beepbox.new_song',
    purpose: 'Start a blank song; the current one is lost unless its hash was saved.',
    when: 'Use when the user wants a fresh BeepBox song and agreed to lose the current one.',
    params: {},
    effect: 'destructive',
    needs: NEEDS,
    examples: [{ args: {}, says: 'Start a new BeepBox song' }],
    // The app's own File menu action "+ New Blank Song" (SongEditor _fileMenuHandler case "new"):
    // set the menu value to "new" and fire change; the handler resets the song through the normal
    // change and undo machinery. The menu is the select inside .beepboxEditor that has a "new"
    // option (option value "new", SongEditor file menu definition).
    run: async (args, ctx) => call(ctx, async host => {
      const { editor, win } = await app(host, ctx);
      const menus = [...win.document.querySelectorAll('.beepboxEditor select')];
      const fileMenu = menus.find(menu => [...menu.options].some(option => option.value === 'new'));
      if (!fileMenu) throw new ToolError('app_error', 'the BeepBox file menu was not found in the app', '');
      fileMenu.value = 'new';
      fileMenu.dispatchEvent(new Event('change', { bubbles: true }));
      return { hash: editor.doc.song.toBase64String() };
    }),
  },
  {
    name: 'beepbox.set_tempo',
    purpose: 'Set the song tempo in BPM.',
    when: 'Use when the user wants the song faster or slower.',
    params: { bpm: { type: 'integer', required: true, min: 30, max: 300, description: 'Tempo in beats per minute (the app allows 30 to 300)' } },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { bpm: 180 }, says: 'Speed the song up to 180 BPM' }],
    // The app's own tempo stepper (SongEditor line 589: the stepper's change listener records
    // ChangeTempo with the exact BPM): the stepper is the number input next to the tempo slider
    // (the range input with min 0 max 14), so set its value and fire change.
    run: async (args, ctx) => call(ctx, async host => {
      const { editor, win } = await app(host, ctx);
      const slider = win.document.querySelector('input[type="range"][min="0"][max="14"]');
      const stepper = slider?.closest('.selectRow')?.querySelector('input[type="number"]');
      if (!stepper) throw new ToolError('app_error', 'the tempo control was not found in the app', '');
      stepper.value = String(args.bpm);
      stepper.dispatchEvent(new Event('change', { bubbles: true }));
      return { tempo: editor.doc.song.tempo };
    }),
  },
  {
    name: 'beepbox.play',
    purpose: 'Play the current song.',
    when: 'Use when the user wants to hear the song.',
    params: {},
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: {}, says: 'Play the song' }],
    // The app's own Play button (class playButton, visible while not playing; the wrapper's
    // pcBeforeClose uses the sibling button.pauseButton selector). doc.synth.playing (the Synth
    // playing getter, live-confirmed on the real editor) is the live state. Playback starts
    // through the app's handler, so the state is re-read after a short settle: if it did not
    // start, the audio context is likely suspended (the browser autoplay policy and the WebPC
    // audio guard suspend it when the window was closed; a programmatic click is not a user
    // gesture that can resume it), and the result says so.
    run: async (args, ctx) => call(ctx, async host => {
      const { editor, win } = await app(host, ctx);
      if (editor.doc.synth.playing) return { playing: true };
      const button = win.document.querySelector('button.playButton');
      if (!button || button.style.display === 'none') throw new ToolError('app_error', 'the play button is not visible; the app may still be loading', '');
      button.click();
      await new Promise(resolve => setTimeout(resolve, 200)); // let the app's handler start playback
      const playing = editor.doc.synth.playing;
      return playing
        ? { playing: true }
        : { playing: false, note: 'the app did not start playing; the audio context may be suspended (autoplay policy or the WebPC audio guard), so click Play once in the app window to unlock audio' };
    }),
  },
  {
    name: 'beepbox.stop',
    purpose: 'Stop the song that is playing.',
    when: 'Use when the user wants playback stopped.',
    params: {},
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: {}, says: 'Stop the music' }],
    // The stop is decided from the live state, never from button visibility (live check: right
    // after play, the pause button's style.display was not a reliable signal). editor.doc.synth.
    // playing (the Synth playing getter, live-confirmed) is the source of truth; stopping goes
    // through the app's own pause button (class pauseButton; the wrapper's pcBeforeClose clicks
    // exactly this selector). Stopping an already stopped song is a success, not an error.
    run: async (args, ctx) => call(ctx, async host => {
      const { editor, win } = await app(host, ctx);
      if (!editor.doc.synth.playing) return { playing: false };
      const button = win.document.querySelector('button.pauseButton');
      if (button) button.click();
      await new Promise(resolve => setTimeout(resolve, 200)); // let the app's handler stop playback
      return { playing: editor.doc.synth.playing };
    }),
  },
];
