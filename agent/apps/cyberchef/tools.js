// CyberChef pack: the CyberChef app tools (bake a recipe, list operations).
// Every tool drives the CyberChef app the vendored release installs as window.app
// (public/pc/vendor/cyberchef/assets/main.js, v11.5.0; set on DOMContentLoaded, grep marker
// "window.app=new Ud("). The app runs recipes in a chef web worker, so the main-thread
// app.bake() is fire-and-forget (it posts to the worker and returns undefined); the result is
// delivered to the callback passed to the background worker's bake
// (app.manager.background.bake(input, recipeConfig, options, progress, step, callback)), which
// the worker answers with bakeComplete {dish, result, type, ...} or bakeError {error}.
// app.operations is the operation registry keyed by name (grep marker key:"filterOperations").
import { ToolError, closest } from '../../../src/apps/ai-agent/runtime/args.mjs';
import { innerApi } from '../../shared/inner-app.js';

const APP = 'cyberchef';
const FRAME = 'cyberchef-frame';
const NEEDS = ['host', 'app:cyberchef'];
const NOT_HERE = 'CyberChef is not available here (Buddy is not running inside WebPC).';

// Gate on ctx.host (needs: ['host', 'app:cyberchef']), then turn host rejections, which carry a
// code (unknown_app, not_open, not_iframe, timeout, invalid_argument), into a ToolError.
const call = (ctx, fn) => {
  if (!ctx.host) throw new ToolError('not_available', NOT_HERE, '');
  return Promise.resolve()
    .then(() => fn(ctx.host))
    .catch(error => {
      if (error instanceof ToolError) throw error;
      throw new ToolError(error.code || 'app_error', error.message, '');
    });
};

// The real app runs in the #cyberchef-frame iframe of the wrapper page that appWindow returns
// (src/pages/pc/apps/cyberchef/index.astro:10); window.app is set on that inner window on
// DOMContentLoaded (main.js, grep marker "window.app=new Ud("). Dig in and poll until the app has
// the operation registry and the background bake worker (app.manager.background) is wired up.
const getApi = async (host, ctx) => innerApi(await host.appWindow(APP), FRAME, win => {
  const app = win?.app;
  return app && app.operations && typeof app.bake === 'function' && typeof app.manager?.background?.bake === 'function' ? app : null;
}, { sleep: ctx.sleep, timeoutMs: ctx.timeoutMs });

// A recipe is a comma-separated list of operation names; underscores become spaces, so
// "To_Base64" and "From_Hex,To_Upper_case" both parse. Operation names use spaces.
const parseRecipe = text => {
  const names = String(text ?? '').split(',').map(name => name.trim().replace(/_/g, ' ')).filter(Boolean);
  if (names.length === 0) throw new ToolError('invalid_argument', 'recipe is empty; give at least one operation, e.g. "To_Base64"', '');
  return names;
};

// Strip HTML tags and cap the length, for the one-line description shown to the model.
const brief = (html, max = 140) => String(html ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').replace(/ +([.,;])/g, '$1').trim().slice(0, max);

// A recipe bakes each operation with explicit args; when the recipe text names an operation
// without args, fill each from that operation's defaults the way the CyberChef UI does. An
// option, editableOption or list arg takes its first option (value[defaultIndex]): a plain
// string option is the value itself, while a {name, value} option uses the label (name) for
// option args and the editable value string for editableOption args (the op's run() calls
// .replace on the alphabet, so it must be a string, not the option list). An argSelector arg
// takes value[defaultIndex].name; every other type (string, number, boolean) takes the raw
// value, or the type's zero value when value is absent.
const defaultArg = (arg) => {
  const value = arg?.value;
  const index = arg?.defaultIndex ?? 0;
  if (Array.isArray(value) && ['option', 'editableOption', 'list'].includes(arg?.type)) {
    const opt = value[index];
    if (opt && typeof opt === 'object') return arg.type === 'editableOption' ? opt.value : opt.name;
    return opt;
  }
  if (arg?.type === 'argSelector') return Array.isArray(value) ? (value[index]?.name ?? '') : value;
  if (value !== undefined && value !== null) return value;
  if (arg?.type === 'number') return 0;
  if (arg?.type === 'boolean') return false;
  if (arg?.type === 'string') return '';
  return null;
};

export const pack = { id: APP, title: 'CyberChef' };

export const tools = [
  {
    name: 'cyberchef.bake',
    purpose: 'Run a CyberChef recipe of operations on some input text and return the result.',
    when: 'Use when the user wants to encode, decode, hash, cipher or otherwise transform text.',
    params: {
      recipe: { type: 'text', required: true, description: 'Comma-separated operation names, underscores for spaces: "To_Base64" or "From_Hex,To_Upper_case"' },
      input: { type: 'text', description: 'The text to run through the recipe; empty when the operation makes its own input' },
    },
    effect: 'change',
    needs: NEEDS,
    examples: [
      { args: { recipe: 'To_Base64', input: 'hello world' }, says: 'Base64 encode this' },
      { args: { recipe: 'From_Hex,To_Upper_case', input: '48656c6c6f' }, says: 'Decode the hex and uppercase it' },
    ],
    // The main-thread app.bake() is fire-and-forget, so bake through the background chef worker
    // (app.manager.background.bake(input, recipeConfig, options, progress, step, callback)):
    // recipeConfig is an array of {op, args} (the Flow _parseConfig shape, grep marker
    // key:"_parseConfig"); options.returnType 1 is DishType.STRING (grep marker I.STRING=1) so the
    // result comes back as text; the worker answers bakeComplete {dish, result, type, ...} or
    // bakeError {error}, both delivered to the callback
    run: async (args, ctx) => call(ctx, async host => {
      const app = await getApi(host, ctx);
      const names = parseRecipe(args.recipe);
      const known = Object.keys(app.operations);
      const ops = [];
      const bad = [];
      // Hash aliases: SHA256, SHA-256 or SHA_256 (case-insensitive; 224, 384, 512 likewise) are
      // not operations - they bake the SHA2 operation with its Size arg at that size. MD5 and
      // SHA1 are their own operations and are never aliased.
      for (const name of names) {
        const alias = name.match(/^SHA[\s_-]?(224|256|384|512)$/i);
        const opName = alias ? 'SHA2' : name;
        if (!known.includes(opName)) { bad.push(name); continue; }
        // Fill each arg from the operation's defaults so the op runs as if added via the UI; an
        // alias overrides only the SHA2 Size arg (UNVERIFIED arg layout: Size first, then two
        // Rounds args - read from the vendored v11.5.0 definition, the lead bakes "abc" live).
        ops.push({ op: opName, args: (app.operations[opName].args ?? []).map(arg => alias && arg.name === 'Size' ? alias[1] : defaultArg(arg)) });
      }
      if (bad.length) {
        const close = [...new Set(bad.flatMap(name => closest(name, known, 3)))];
        throw new ToolError('invalid_argument', `unknown operation(s) ${bad.join(', ')}${close.length ? `; closest: ${close.join(', ')}` : ''}`, '');
      }
      const worker = app.manager?.background;
      if (!worker?.chefWorker) throw new ToolError('not_available', 'the CyberChef bake worker is not ready; try again shortly', '');
      const out = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new ToolError('app_error', 'the recipe did not finish in time', '')), ctx.timeoutMs ?? 30000);
        worker.bake(String(args.input ?? ''), ops, { returnType: 1 }, 0, false, (data) => {
          clearTimeout(timer);
          if (data?.error) {
            const err = data.error;
            const message = typeof err === 'string' ? err : err?.displayStr ?? err?.message ?? 'the recipe failed';
            reject(new ToolError('app_error', String(message), ''));
          } else resolve({ output: data?.result, type: data?.type, ops: names });
        });
      });
      return out;
    }),
  },
  {
    name: 'cyberchef.list_operations',
    purpose: 'List the CyberChef operations available, filtered by a name substring.',
    when: 'Use when the user asks what CyberChef can do, or to find the right operation name.',
    params: { query: { type: 'string', description: 'Substring to match operation names against (case-insensitive); every operation when omitted' } },
    effect: 'read',
    needs: NEEDS,
    examples: [
      { args: { query: 'base64' }, says: 'What base64 operations are there?' },
      { args: { query: 'hash' }, says: 'Find the hashing operations' },
    ],
    // app.operations is the registry keyed by operation name (main.js key:"filterOperations" iterates
    // it; the wrapper reads .description/.args and Flow reads .module, grep markers key:"filterOperations"
    // and key:"_parseConfig"); trimmed to the fields the model can act on, top 10
    run: async (args, ctx) => call(ctx, async host => {
      const app = await getApi(host, ctx);
      const needle = String(args.query ?? '').toLowerCase();
      const rows = Object.keys(app.operations)
        .filter(name => needle === '' || name.toLowerCase().includes(needle))
        .slice(0, 10)
        .map(name => {
          const def = app.operations[name];
          return { name, module: def?.module, args: (def?.args ?? []).map(arg => arg.name), description: brief(def?.description) };
        });
      return { count: rows.length, operations: rows };
    }),
  },
];
