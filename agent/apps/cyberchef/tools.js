// CyberChef pack: the CyberChef app tools (bake a recipe, list operations).
// Every tool drives the CyberChef app the vendored release installs as window.app
// (public/pc/vendor/cyberchef/assets/main.js, v11.5.0; set on DOMContentLoaded, grep marker
// "window.app=new Ud("). The app runs recipes in a chef web worker, so the main-thread
// app.bake() is fire-and-forget (it posts to the worker and returns undefined); the result is
// delivered to the callback passed to the background worker's bake
// (app.manager.background.bake(input, recipeConfig, options, progress, step, callback)), which
// the worker answers with bakeComplete {dish, result, type, ...} or bakeError {error}.
// app.operations is the operation registry keyed by name (grep marker key:"filterOperations").
import { ToolError, closest, callLine } from '../../../src/apps/ai-agent/runtime/args.mjs';
import { innerApi } from '../../shared/inner-app.js';
import { OPERATION_NAMES } from './operations.js';

const APP = 'cyberchef';
const FRAME = 'cyberchef-frame';
const NEEDS = ['host', 'app:cyberchef'];
const NOT_HERE = 'CyberChef is not available here (WebPC Agent is not running inside WebPC).';

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

// Matching normalization for operation and arg names: lowercase, underscores/dashes/whitespace
// collapse to one space, so "To_Base64", "to-base64" and "To Base64" all read "to base64".
const normName = name => String(name ?? '').trim().toLowerCase().replace(/[_\s-]+/g, ' ');

// Plain phrasings the models use in place of the exact operation name (the lfm3 train attempts
// from review/agent-lfm3-1.7b-cyberchef.md): keys are normalized phrasings, values the exact
// registry names, verified present in the vendored v11.5.0 list.
const PHRASINGS = {
  'base64 encode': 'To Base64',
  'encode base64': 'To Base64',
  'base64 decode': 'From Base64',
  'decode base64': 'From Base64',
  'hex encode': 'To Hex',
  'encode hex': 'To Hex',
  'hex decode': 'From Hex',
  'decode hex': 'From Hex',
  'from hex': 'From Hex',
  'uppercase': 'To Upper case',
  'upper case': 'To Upper case',
  'lowercase': 'To Lower case',
  'lower case': 'To Lower case',
  'rot13 decode': 'ROT13',
  'decode rot13': 'ROT13',
  'url decode': 'URL Decode',
  'url encode': 'URL Encode',
};

// A recipe is a comma-separated list of operations; a step may carry per-operation args in parens,
// e.g. "From_Hex,To_Upper_case" or "ROT13(Amount=19)". The parens keep arg-list commas from
// splitting the step.
const splitSteps = text => {
  const steps = [];
  let depth = 0;
  let buf = '';
  for (const ch of String(text ?? '')) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { steps.push(buf); buf = ''; }
    else buf += ch;
  }
  steps.push(buf);
  return steps.map(s => s.trim()).filter(Boolean);
};

// One step: "Name" or "Name(arg=value, arg2=value2)".
const parseStep = step => {
  const open = step.indexOf('(');
  if (open < 0) return { name: step, overrides: {} };
  if (!step.endsWith(')')) throw new ToolError('invalid_argument', `recipe step "${step}" has an unbalanced ( - per-operation args look like ROT13(Amount=19)`, '');
  const name = step.slice(0, open).trim();
  if (!name) throw new ToolError('invalid_argument', `recipe step "${step}" is missing the operation name before (`, '');
  const overrides = {};
  for (const pair of step.slice(open + 1, -1).split(',').map(p => p.trim()).filter(Boolean)) {
    const eq = pair.indexOf('=');
    if (eq < 1) throw new ToolError('invalid_argument', `recipe arg "${pair}" must be arg=value (e.g. ROT13(Amount=19))`, '');
    let value = pair.slice(eq + 1).trim();
    if (value.length > 1 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) value = value.slice(1, -1);
    overrides[pair.slice(0, eq).trim()] = value;
  }
  return { name, overrides };
};

const renderStep = (name, overrides) => {
  const entries = Object.entries(overrides);
  return entries.length ? `${name}(${entries.map(([key, value]) => `${key}=${value}`).join(', ')})` : name;
};

// Resolve a recipe name to the exact registry name: the exact name, then the SHA-2 size aliases
// (SHA256/SHA-256/SHA_256 bake SHA2 with its Size arg; MD5 and SHA1 are their own operations and
// are never aliased), then the plain phrasings, then the case- and separator-insensitive registry
// match ("rot13" -> ROT13, "to_base64" -> "To Base64").
const resolveOp = (name, known, knownNorm) => {
  if (known.includes(name)) return { op: name };
  const normalized = normName(name);
  // The separator is optional: "sha256" stays digit-glued after normalization, "sha-256" becomes "sha 256".
  const alias = normalized.match(/^sha ?(224|256|384|512)$/);
  if (alias && known.includes('SHA2')) return { op: 'SHA2', size: alias[1] };
  const phrase = PHRASINGS[normalized];
  if (phrase && known.includes(phrase)) return { op: phrase };
  const normed = knownNorm.get(normalized);
  return normed ? { op: normed } : null;
};

// Coerce a recipe-supplied arg value to the arg's type: numbers to Number, booleans to true/false,
// option-type args to the option with the same label (case- and separator-insensitive), everything
// else stays a string. A {name, value} option takes the value string (the editableOption alphabets).
const optionValue = option => (option && typeof option === 'object' ? (option.value !== undefined ? option.value : option.name) : option);
const coerceArgValue = (raw, arg) => {
  if (arg?.type === 'number' && /^-?(?:\d+\.?\d*|\.\d+)$/.test(raw)) return Number(raw);
  if (arg?.type === 'boolean') return raw === 'true' || raw === '1';
  const options = Array.isArray(arg?.value) ? arg.value : [];
  if (options.length && ['option', 'editableOption', 'list', 'argSelector'].includes(arg?.type)) {
    const hit = options.find(option => normName(option?.name ?? option) === normName(raw));
    if (hit !== undefined) return optionValue(hit);
  }
  return raw;
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
    // A4: the operation names live inside the recipe, not in the tool text, so an inner name
    // (find_tool "sha256") would not match. Index every registry name (generated from the
    // vendored release, operations.js) plus the SHA-2 size aliases bake accepts (SHA2 with a
    // Size arg; MD5 and SHA1 are real operations and are already in the list). Both the bare
    // and dashed alias forms: the dashed form keeps the digits as exact terms ("sha-256" must
    // outrank the "sha" prefix match of "shape" in the drawing apps).
    keywords: [...OPERATION_NAMES, 'sha256', 'sha-256', 'sha224', 'sha-224', 'sha384', 'sha-384', 'sha512', 'sha-512'],
    params: {
      recipe: { type: 'text', required: true, description: 'Comma-separated operation names, underscores for spaces, optional per-op args in parens: "From_Hex,To_Upper_case" or "ROT13(Amount=19)"' },
      input: { type: 'text', description: 'The text to run through the recipe; empty when the operation makes its own input' },
    },
    effect: 'change',
    needs: NEEDS,
    examples: [
      { args: { recipe: 'To_Base64', input: 'hello world' }, says: 'Base64 encode this' },
      { args: { recipe: 'From_Hex,To_Upper_case', input: '48656c6c6f' }, says: 'Decode the hex and uppercase it' },
      { args: { recipe: 'ROT13(Amount=19)', input: 'OLSSV' }, says: 'Decode a Caesar shift of 7' },
    ],
    // The main-thread app.bake() is fire-and-forget, so bake through the background chef worker
    // (app.manager.background.bake(input, recipeConfig, options, progress, step, callback)):
    // recipeConfig is an array of {op, args} (the Flow _parseConfig shape, grep marker
    // key:"_parseConfig"); options.returnType 1 is DishType.STRING (grep marker I.STRING=1) so the
    // result comes back as text; the worker answers bakeComplete {dish, result, type, ...} or
    // bakeError {error}, both delivered to the callback
    run: async (args, ctx) => call(ctx, async host => {
      const app = await getApi(host, ctx);
      const known = Object.keys(app.operations);
      const knownNorm = new Map(known.map(name => [normName(name), name]));
      const steps = splitSteps(args.recipe);
      if (steps.length === 0) throw new ToolError('invalid_argument', 'recipe is empty; give at least one operation, e.g. "To_Base64"', '');
      const parsed = steps.map(parseStep);
      const input = String(args.input ?? '');
      const plan = parsed.map((step, i) => {
        const { name, overrides } = step;
        const resolved = resolveOp(name, known, knownNorm);
        if (!resolved) return null;
        // A per-op arg must name one of the operation's real args (case- and separator-insensitive);
        // the error's fix line is the exact call with the closest arg name filled in.
        const defArgs = app.operations[resolved.op]?.args ?? [];
        for (const argName of Object.keys(overrides)) {
          if (!defArgs.some(arg => normName(arg.name) === normName(argName))) {
            const argNames = defArgs.map(arg => arg.name);
            const close = argNames.length ? closest(argName, argNames, 1)[0] : '';
            let fix = steps.join(',');
            if (close) {
              const corrected = { ...overrides };
              delete corrected[argName];
              corrected[close] = overrides[argName];
              fix = steps.map((s, j) => (j === i ? renderStep(resolved.op, corrected) : s)).join(',');
            }
            throw new ToolError('invalid_argument', `${resolved.op} has no argument named "${argName}"${close ? `; closest: ${close}` : ''}`, callLine('cyberchef.bake', { recipe: fix, ...(input ? { input } : {}) }));
          }
        }
        return { ...resolved, overrides };
      });
      const bad = plan.flatMap((step, i) => (step ? [] : [{ i, name: parsed[i].name }]));
      if (bad.length) {
        // The fix line is the exact call with the closest operation names filled in for the unknowns.
        const close = [...new Set(bad.flatMap(b => closest(b.name, known, 3)))];
        const fix = steps.map((s, i) => (plan[i] ? s : (closest(parsed[i].name, known, 1)[0] ?? s))).join(',');
        throw new ToolError('invalid_argument', `unknown operation(s) ${bad.map(b => b.name.replace(/_/g, ' ')).join(', ')}${close.length ? `; closest: ${close.join(', ')}` : ''}`, callLine('cyberchef.bake', { recipe: fix, ...(input ? { input } : {}) }));
      }
      // Fill each arg from the operation's defaults so the op runs as if added via the UI; a
      // per-op arg in the recipe overrides its default, and an SHA alias overrides only the SHA2
      // Size arg (UNVERIFIED arg layout: Size first, then two Rounds args - read from the vendored
      // v11.5.0 definition, the lead bakes "abc" live).
      const ops = plan.map(({ op, size, overrides }) => ({
        op,
        args: (app.operations[op].args ?? []).map(arg => {
          if (size && arg.name === 'Size') return size;
          const given = Object.entries(overrides).find(([key]) => normName(key) === normName(arg.name));
          return given ? coerceArgValue(given[1], arg) : defaultArg(arg);
        }),
      }));
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
          } else resolve({ output: data?.result, type: data?.type, ops: parsed.map(p => p.name.replace(/_/g, ' ')) });
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
      // Case-insensitive substring over the normalized names, so "To_Upper_case" finds "To Upper case"
      // (the model passes the recipe spelling).
      const needle = normName(args.query ?? '');
      const rows = Object.keys(app.operations)
        .filter(name => needle === '' || normName(name).includes(needle))
        .slice(0, 10)
        .map(name => {
          const def = app.operations[name];
          return { name, module: def?.module, args: (def?.args ?? []).map(arg => arg.name), description: brief(def?.description) };
        });
      return { count: rows.length, operations: rows };
    }),
  },
];
