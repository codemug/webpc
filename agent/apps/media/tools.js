// Media pack: drive the Media Player app (src/scripts/pc/apps/media.mjs). The app runs directly
// in its utility page (kind iframe in catalog.yaml, no inner iframe; pcHost.appWindow('media')
// resolves the page's own window). Live DOM: #media-video (the media element), #media-title,
// #media-status, #media-seek, #media-volume (a 0..1 range whose input event runs the app's
// setVolume, which clamps and saves to localStorage pc:media:volume) and the playlist #media-
// list (li[data-i] rows with a .mp-name, the selected row carrying class "sel"). The app's own
// "Open from Files" path builds a Blob from the picked bytes and adds it to the playlist
// (media.mjs:134), which this pack mirrors on the video element directly: the playlist is
// module-scoped in media.mjs, so the video element is the reachable surface. The app notes
// (media.mjs:34) that programmatic play() can be blocked by the real-browser autoplay policy,
// so play_file reports the live playing state plus a note instead of failing.
import { ToolError } from '../../../src/apps/ai-agent/runtime/args.mjs';
import { mediaKind } from '../../../src/scripts/pc/media/playlist.mjs';

const APP = 'media';
const NEEDS = ['host', 'app:media'];
const NOT_HERE = 'The Media Player is not available here (WebPC Agent is not running inside WebPC).';

// Gate on ctx.host (needs: ['host', 'app:media']), then turn host rejections, which carry a
// code (unknown_app, not_open, not_iframe, timeout, invalid_argument), and Files readBytes
// rejections (not_found, not_a_file, too_large) into a ToolError.
const call = (ctx, fn) => {
  if (!ctx.host) throw new ToolError('not_available', NOT_HERE, '');
  return Promise.resolve()
    .then(() => fn(ctx.host))
    .catch(error => {
      if (error instanceof ToolError) throw error;
      throw new ToolError(error.code || 'app_error', error.message, '');
    });
};

// The appWindow result is the media page window itself (no inner iframe).
const page = host => host.appWindow(APP);

export const pack = { id: APP, title: 'Media Player' };

export const tools = [
  {
    name: 'media.play_file',
    purpose: 'Play an audio or video file from the Files app in the Media Player.',
    when: 'Use when the user wants to play, open or listen to an audio or video file.',
    params: { path: { type: 'path', required: true, description: 'The file path in the Files app, e.g. /music/tune.mp3' } },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { path: '/music/tune.mp3' }, says: 'Play this song' }],
    // readBytes (src/apps/ai-agent/runtime/files-ctx.mjs:64) gives the bytes; mediaKind
    // (src/scripts/pc/media/playlist.mjs, the app's own type check) gates the format. The app's
    // Open-from-Files path wraps the bytes in a Blob and plays them, so mirror that on the video
    // element. video.play() may be rejected by the autoplay policy (media.mjs:34), which is
    // reported as playing false plus a note, not an error.
    run: async (args, ctx) => call(ctx, async host => {
      const read = ctx.files?.readBytes;
      if (typeof read !== 'function') throw new ToolError('not_available', 'the Files tools are not enabled here, so no file can be played', '');
      let file;
      try { file = await read(args.path); }
      catch (error) {
        // A wrong path (the model guesses /tmp/tune.wav for /music/tone-440hz-2s.wav) points at
        // files.find instead of dead-ending (lfm3-1.7b media-05/08).
        if (error?.code === 'not_found' || error?.code === 'not_a_file' || /does not exist|not a file/i.test(error?.message ?? '')) throw new ToolError('not_found', String(error?.message ?? 'the file was not found'), 'call_tool tool=files.find query=<query>');
        throw error;
      }
      const kind = mediaKind(file.name);
      if (!kind) throw new ToolError('invalid_argument', `"${file.name}" is not an audio or video file`, '');
      const win = await page(host);
      const video = win.document.getElementById('media-video');
      video.src = win.URL.createObjectURL(new win.Blob([file.bytes]));
      win.document.getElementById('media-title').textContent = file.name;
      let note;
      try {
        await video.play();
      } catch {
        note = 'autoplay was blocked by the browser; click the Play button in the Media app to hear it';
      }
      return { name: file.name, kind, playing: video.paused === false, ...(note ? { note } : {}) };
    }),
  },
  {
    name: 'media.pause',
    purpose: 'Pause the media that is playing.',
    when: 'Use when the user wants playback to stop for a while.',
    params: {},
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: {}, says: 'Pause the music' }],
    // The app's own pause path is video.pause() (media.mjs:61 toggle()).
    run: async (args, ctx) => call(ctx, async host => {
      const win = await page(host);
      win.document.getElementById('media-video').pause();
      return { paused: true };
    }),
  },
  {
    name: 'media.seek',
    purpose: 'Move playback to a position in seconds.',
    when: 'Use when the user wants to jump forward or back in the media.',
    params: { seconds: { type: 'number', required: true, min: 0, description: 'The position in seconds to move to' } },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { seconds: 30 }, says: 'Jump to 30 seconds' }],
    // The app's own seek path is video.currentTime = the seek value (media.mjs:102). The media
    // must be loaded first: without metadata video.duration is not finite and a seek is dropped.
    run: async (args, ctx) => call(ctx, async host => {
      const win = await page(host);
      const video = win.document.getElementById('media-video');
      const duration = video.duration;
      if (!Number.isFinite(duration) || duration <= 0) throw new ToolError('app_error', 'no media is loaded yet; play a file first', '');
      if (args.seconds < 0 || args.seconds > duration) throw new ToolError('invalid_argument', `seconds must be between 0 and the media length (${Math.floor(duration)} s)`, '');
      video.currentTime = args.seconds;
      return { time: video.currentTime };
    }),
  },
  {
    name: 'media.volume',
    purpose: 'Set the playback volume, 0 to 100 percent.',
    when: 'Use when the user wants it louder or softer.',
    params: { percent: { type: 'integer', required: true, min: 0, max: 100, description: 'The volume in percent' } },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { percent: 35 }, says: 'Set the volume to 35 percent' }],
    // Drive the app's own volume input (0..1, media.mjs:87): set its value and fire input, so
    // the app's setVolume clamps and saves the volume to localStorage the way a user's slider
    // would.
    run: async (args, ctx) => call(ctx, async host => {
      const win = await page(host);
      const video = win.document.getElementById('media-video');
      const vol = win.document.getElementById('media-volume');
      vol.value = String(args.percent / 100);
      vol.dispatchEvent(new Event('input'));
      return { volume: video.volume };
    }),
  },
  {
    name: 'media.status',
    purpose: 'Report what is playing, where, and the playlist.',
    when: 'Use when the user asks what is playing, or before controlling playback.',
    params: {},
    effect: 'read',
    needs: NEEDS,
    examples: [{ args: {}, says: 'What is playing?' }],
    // Live state only: the video element for position/duration/volume/muted, #media-title for
    // the name, and #media-list rows for the playlist (media.mjs renderList: li[data-i] with
    // .mp-name, the selected row carrying class "sel").
    run: async (args, ctx) => call(ctx, async host => {
      const win = await page(host);
      const video = win.document.getElementById('media-video');
      const rows = [...win.document.querySelectorAll('#media-list li[data-i]')];
      return {
        title: win.document.getElementById('media-title').textContent,
        playing: video.paused === false,
        time: video.currentTime,
        duration: Number.isFinite(video.duration) ? video.duration : null,
        volume: video.volume,
        muted: video.muted,
        playlist: rows.map(row => ({ name: row.querySelector('.mp-name')?.textContent ?? '', current: /(^|\s)sel(\s|$)/.test(row.className) })),
      };
    }),
  },
];
