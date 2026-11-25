// Desktop pack: the shell tools (windows, apps, theme, icons). Every tool drives the
// desktop through ctx.host, the window.pcHost object installed by src/scripts/pc/desktop.js.
// No module-level side effects: the build imports this file in Node.
import { ToolError } from '../../src/apps/ai-agent/runtime/args.mjs';

const NOT_HERE = 'The desktop is not available here (WebPC Agent is not running inside WebPC).';

// Gate on ctx.host (needs: ['host']), then turn host rejections, which carry a code
// (unknown_app, not_open, not_iframe, timeout, invalid_argument), into a ToolError.
// fixFor (optional) returns a corrected call line for fixable errors.
const call = (ctx, fn, fixFor) => {
  if (!ctx.host) throw new ToolError('not_available', NOT_HERE, '');
  return Promise.resolve()
    .then(() => fn(ctx.host))
    .catch(error => {
      if (error instanceof ToolError) throw error;
      throw new ToolError(typeof error.code === 'string' ? error.code : 'app_error', error.message, fixFor ? fixFor(error) : '');
    });
};

// Window verbs fail with not_open until the app is open; the fix line names
// desktop.open_app so the model copies a window-open, not a tab-open (b14 desktop-04:
// open_in_tab satisfied "open" in the model's head, the window still was not open, and
// the empty fix line let it loop 15 rounds).
const notOpenFix = app => error => (error.code === 'not_open' ? `call_tool tool=desktop.open_app app=${app}` : '');

// Shared spec for the app id parameter: a live enum over the registry apps.
const APP = { type: 'enum', required: true, values: 'apps', description: 'The app id, from desktop.list_apps' };

export const pack = { id: 'desktop', title: 'Desktop' };

export const tools = [
  {
    name: 'desktop.list_apps',
    purpose: 'List the apps the desktop can open, optionally by category.',
    when: 'Use when the user asks what apps are available or which category an app is in.',
    params: { category: { type: 'string', description: 'Only apps in this category, e.g. Office; omit for all apps' } },
    effect: 'read',
    needs: ['host'],
    examples: [{ args: { category: 'Office' }, says: 'What Office apps can I start?' }, { args: {}, says: 'What apps are here?' }],
    run: async (args, ctx) => {
      const apps = await call(ctx, host => host.apps());
      return args.category ? apps.filter(app => app.category.toLowerCase() === String(args.category).trim().toLowerCase()) : apps;
    },
  },
  {
    name: 'desktop.list_windows',
    purpose: 'List the open windows with their state and position.',
    when: 'Use when the user asks what is open, or before closing or arranging windows.',
    params: {},
    effect: 'read',
    needs: ['host'],
    examples: [{ args: {}, says: 'What is open?' }],
    run: async (args, ctx) => call(ctx, host => host.windows()),
  },
  {
    name: 'desktop.open_app',
    purpose: 'Start an app on the desktop.',
    when: 'Use when the user says start, launch or open, naming an app such as Files or GridCraft.',
    params: { app: APP },
    effect: 'change',
    needs: ['host'],
    examples: [{ args: { app: 'gridcraft' }, says: 'Launch GridCraft' }, { args: { app: 'terminal' }, says: 'Open the terminal' }],
    run: async (args, ctx) => call(ctx, host => host.open(args.app)),
  },
  {
    name: 'desktop.focus',
    purpose: 'Bring an app window to the front.',
    when: 'Use when the user wants to switch to, select or bring an open app to the front.',
    params: { app: APP },
    effect: 'change',
    needs: ['host'],
    examples: [{ args: { app: 'docs' }, says: 'Switch to Docs' }],
    run: async (args, ctx) => call(ctx, host => host.focus(args.app), notOpenFix(args.app)),
  },
  {
    name: 'desktop.minimize',
    purpose: 'Hide an app window to the taskbar.',
    when: 'Use when the user says minimize, hide or tuck an app window away.',
    params: { app: APP },
    effect: 'change',
    needs: ['host'],
    examples: [{ args: { app: 'files' }, says: 'Hide Files' }],
    run: async (args, ctx) => call(ctx, host => host.minimize(args.app), notOpenFix(args.app)),
  },
  {
    name: 'desktop.maximize',
    purpose: 'Make an app window fill the desktop.',
    when: 'Use when the user says maximize, expand or make an app window bigger or full screen.',
    params: { app: APP },
    effect: 'change',
    needs: ['host'],
    examples: [{ args: { app: 'gridcraft' }, says: 'Maximize the spreadsheet' }],
    run: async (args, ctx) => call(ctx, host => host.maximize(args.app), notOpenFix(args.app)),
  },
  {
    name: 'desktop.restore',
    purpose: 'Bring a minimized or maximized window back.',
    when: 'Use when the user wants a hidden or maximized window back to its normal size.',
    params: { app: APP },
    effect: 'change',
    needs: ['host'],
    examples: [{ args: { app: 'files' }, says: 'Bring Files back' }],
    run: async (args, ctx) => call(ctx, host => host.restore(args.app), notOpenFix(args.app)),
  },
  {
    name: 'desktop.close',
    purpose: 'Close an app window; if it has unsaved work, ask, then use desktop.force_close.',
    when: 'Use when the user says quit, close or exit an app window.',
    params: { app: APP },
    effect: 'change',
    needs: ['host'],
    examples: [{ args: { app: 'docs' }, says: 'Close Docs' }],
    run: async (args, ctx) => call(ctx, host => host.close(args.app)),
  },
  {
    name: 'desktop.force_close',
    purpose: 'Force-close an app window, discarding unsaved work, only after the user agrees.',
    when: 'Use when close reported unsaved work and the user agreed to discard it.',
    params: { app: APP },
    effect: 'destructive',
    needs: ['host'],
    examples: [{ args: { app: 'gridcraft' }, says: 'Close it anyway, I do not need the changes' }],
    run: async (args, ctx) => call(ctx, host => host.close(args.app, { force: true })),
  },
  {
    name: 'desktop.move',
    purpose: 'Move an app window to a position on the desktop.',
    when: 'Use when the user says move, drag or reposition an app window to a spot.',
    params: {
      app: APP,
      x: { type: 'integer', required: true, min: 0, description: 'New left edge in pixels from the desktop top-left corner' },
      y: { type: 'integer', required: true, min: 0, description: 'New top edge in pixels from the desktop top-left corner' },
    },
    effect: 'change',
    needs: ['host'],
    examples: [{ args: { app: 'terminal', x: 36, y: 32 }, says: 'Move the terminal to the top left' }],
    run: async (args, ctx) => call(ctx, host => host.move(args.app, args.x, args.y), notOpenFix(args.app)),
  },
  {
    name: 'desktop.resize',
    purpose: 'Resize an app window to a width and height.',
    when: 'Use when the user says resize, shrink, stretch or make an app window a certain size.',
    params: {
      app: APP,
      width: { type: 'integer', required: true, min: 200, description: 'New width in pixels' },
      height: { type: 'integer', required: true, min: 150, description: 'New height in pixels' },
    },
    effect: 'change',
    needs: ['host'],
    examples: [{ args: { app: 'docs', width: 760, height: 480 }, says: 'Make Docs a smaller window' }],
    run: async (args, ctx) => call(ctx, host => host.resize(args.app, args.width, args.height), notOpenFix(args.app)),
  },
  {
    name: 'desktop.tile',
    purpose: 'Arrange all visible windows side by side or in a grid.',
    when: 'Use when the user says side by side, split screen, arrange, tile or next to each other.',
    params: { layout: { type: 'enum', values: ['left-right', 'grid', 'cascade'], default: 'left-right', description: 'The arrangement: left-right, grid or cascade' } },
    effect: 'change',
    needs: ['host'],
    examples: [{ args: { layout: 'grid' }, says: 'Put the windows in a grid' }, { args: {}, says: 'Put them side by side' }],
    run: async (args, ctx) => call(ctx, host => host.tile(args.layout ?? 'left-right')),
  },
  {
    name: 'desktop.show_desktop',
    purpose: 'Minimize every window to show the desktop.',
    when: 'Use when the user says show the desktop, clear the screen or minimize everything.',
    params: {},
    effect: 'change',
    needs: ['host'],
    examples: [{ args: {}, says: 'Show me the desktop' }],
    run: async (args, ctx) => call(ctx, host => host.showDesktop()),
  },
  {
    name: 'desktop.get_theme',
    purpose: 'Report the current desktop color theme.',
    when: 'Use when the user asks which theme or color mode the desktop is in.',
    params: {},
    effect: 'read',
    needs: ['host'],
    examples: [{ args: {}, says: 'What theme is on?' }],
    run: async (args, ctx) => call(ctx, host => host.theme()),
  },
  {
    name: 'desktop.set_theme',
    purpose: 'Switch the desktop to light or dark mode.',
    when: 'Use when the user says dark mode, light mode, switch theme or toggle the color.',
    params: { theme: { type: 'enum', required: true, values: ['light', 'dark'], description: 'The theme to switch to' } },
    effect: 'change',
    needs: ['host'],
    examples: [{ args: { theme: 'dark' }, says: 'Turn on dark mode' }],
    run: async (args, ctx) => call(ctx, host => host.setTheme(args.theme)),
  },
  {
    name: 'desktop.arrange_icons',
    purpose: 'Re-arrange the desktop icons to the default layout.',
    when: 'Use when the user says tidy, clean up or arrange the desktop icons.',
    params: {},
    effect: 'change',
    needs: ['host'],
    examples: [{ args: {}, says: 'Tidy my desktop icons' }],
    run: async (args, ctx) => call(ctx, host => host.arrangeIcons()),
  },
  {
    name: 'desktop.open_in_tab',
    purpose: 'Open an app in a new browser tab or window.',
    when: 'Use when the user says open in a new tab or new window, or detach an app.',
    params: {
      app: APP,
      how: { type: 'enum', values: ['tab', 'window'], default: 'tab', description: 'Open it in a new tab or a new browser window' },
    },
    effect: 'external',
    needs: ['host'],
    examples: [{ args: { app: 'files' }, says: 'Open Files in a new tab' }, { args: { app: 'gridcraft', how: 'window' }, says: 'Open GridCraft in its own window' }],
    run: async (args, ctx) => call(ctx, host => host.openExternal(args.app, args.how ?? 'tab')),
  },
];
