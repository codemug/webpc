// Excalidraw pack: the drawing canvas tools (add shapes, add text, list, fit view, clear).
// Every tool drives the imperative API the app exposes as window.webpcExcalidraw.api
// (scripts/pc/excalidraw/main.jsx:106), the @excalidraw/excalidraw ExcalidrawImperativeAPI
// (dist/types/excalidraw/types.d.ts:603): getSceneElements, updateScene, resetScene, scrollToContent.
// The scene autosaves to localStorage, so edits persist; resetScene also clears the undo history.
import { ToolError } from '../../../src/apps/ai-agent/runtime/args.mjs';
import { innerApi } from '../../shared/inner-app.js';

const APP = 'excalidraw';
const FRAME = 'excalidraw-frame';
const NEEDS = ['host', 'app:excalidraw'];
const NOT_HERE = 'Excalidraw is not available here (WebPC Agent is not running inside WebPC).';

// Gate on ctx.host (needs: ['host', 'app:excalidraw']), then turn host rejections, which carry a
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

// The real app runs in the #excalidraw-frame iframe of the wrapper page that appWindow returns
// (src/pages/pc/apps/excalidraw/index.astro:10); webpcExcalidraw.api is set on that inner window
// once the <Excalidraw> api callback fires (scripts/pc/excalidraw/main.jsx:106). Dig in and poll.
const getApi = async (host, ctx) => innerApi(await host.appWindow(APP), FRAME, win => win.webpcExcalidraw?.api, { sleep: ctx.sleep, timeoutMs: ctx.timeoutMs });

// Element builders. updateScene replaces the scene array without normalizing new elements, so
// every element carries the full ExcalidrawElement base shape (dist/types/excalidraw/element/
// types.d.ts _ExcalidrawElementBase).
const stamp = () => Math.floor(Math.random() * 2 ** 31).toString(36);
const base = type => ({
  id: `buddy-${stamp()}${stamp()}`,
  type, x: 0, y: 0, width: 100, height: 100, angle: 0,
  strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'hachure',
  strokeWidth: 2, strokeStyle: 'solid', roundness: null, roughness: 1, opacity: 100,
  groupIds: [], frameId: null, boundElements: null, index: null, isDeleted: false,
  seed: Math.floor(Math.random() * 2 ** 31), version: 1, versionNonce: Math.floor(Math.random() * 2 ** 31),
  updated: Date.now(), link: null, locked: false,
});
const lines = text => Math.max(1, String(text).split('\n').length);
// shortcut: text width/height are estimates (12px per char at fontSize 20); Excalidraw re-measures
// text on load and when the element is first edited.
const makeText = (text, x, y) => ({ ...base('text'), x, y, text, originalText: text, fontSize: 20, fontFamily: 1, textAlign: 'left', verticalAlign: 'top', containerId: null, autoResize: true, lineHeight: 1.25, width: Math.max(20, String(text).length * 12), height: 25 * lines(text) });
// A labeled shape: the shape plus a bound text element centred on it (ROUNDNESS.PROPORTIONAL_RADIUS = 2).
const makeLabeled = (type, x, y, width, height, label) => {
  const shape = { ...base(type), x, y, width, height, roundness: type === 'rectangle' ? { type: 2 } : null };
  if (!label) return [shape];
  const text = { ...makeText(label, x + width / 2 - (label.length * 12) / 2, y + height / 2 - 12), containerId: shape.id, textAlign: 'center', autoResize: false, width, height };
  shape.boundElements = [{ id: text.id, type: 'text' }];
  return [shape, text];
};
const linear = (type, x1, y1, x2, y2, endArrowhead) => ({ ...base(type), x: x1, y: y1, width: Math.abs(x2 - x1), height: Math.abs(y2 - y1), points: [[0, 0], [x2 - x1, y2 - y1]], lastCommittedPoint: null, startBinding: null, endBinding: null, startArrowhead: null, endArrowhead });

// One shape per line: "rectangle 100 100 200 80 Start", "ellipse 10 20 140 60", "text 5 5 Hello",
// "line 0 0 200 0", "arrow 1 2" (an arrow from shape line 1 to shape line 2 of this spec, 1-based;
// a label adds no line of its own).
const parseSpec = text => {
  const SHAPES = ['rectangle', 'ellipse', 'diamond', 'line', 'arrow', 'text'];
  const spec = String(text ?? '').split('\n').map(line => line.trim()).filter(Boolean);
  if (spec.length === 0) throw new ToolError('invalid_argument', 'spec is empty; one shape per line, e.g. "rectangle 120 30 160 70 In"', '');
  const built = [];
  const shapes = []; // one entry per shape line (a label never counts); arrow targets
  const errors = [];
  spec.forEach((line, i) => {
    const words = line.split(/\s+/);
    const kind = words[0];
    if (!SHAPES.includes(kind)) { errors.push(`line ${i + 1}: unknown shape "${kind}" (use ${SHAPES.join(', ')})`); return; }
    if (kind === 'text') {
      const nums = words.slice(1, 3).map(Number);
      const label = words.slice(3).join(' ');
      if (nums.length < 2 || nums.some(Number.isNaN) || !label) { errors.push(`line ${i + 1}: text needs x, y and a label, e.g. "text 5 5 Hello world"`); return; }
      const el = makeText(label, nums[0], nums[1]);
      built.push(el);
      shapes.push(el);
      return;
    }
    if (kind === 'line') {
      const nums = words.slice(1).map(Number);
      if (nums.length !== 4 || nums.some(Number.isNaN)) { errors.push(`line ${i + 1}: line needs x1, y1, x2 and y2`); return; }
      const el = linear('line', nums[0], nums[1], nums[2], nums[3], null);
      built.push(el);
      shapes.push(el);
      return;
    }
    if (kind === 'arrow') {
      const nums = words.slice(1).map(Number);
      if (nums.length !== 2 || nums.some(Number.isNaN)) { errors.push(`line ${i + 1}: arrow takes two shape line numbers (1-based), e.g. "arrow 1 2"`); return; }
      const from = shapes[nums[0] - 1];
      const to = shapes[nums[1] - 1];
      if (!from || !to) { errors.push(`line ${i + 1}: shape lines ${nums[0]} and ${nums[1]} must be listed before the arrow`); return; }
      const ax = from.x + from.width / 2, ay = from.y + from.height / 2, bx = to.x + to.width / 2, by = to.y + to.height / 2;
      built.push(linear('arrow', ax, ay, bx, by, 'arrow'));
      return;
    }
    // rectangle, ellipse and diamond: x, y, width, height then an optional label word.
    const nums = words.slice(1, 5).map(Number);
    const rest = words.slice(5);
    if (nums.length < 4 || nums.some(Number.isNaN)) { errors.push(`line ${i + 1}: ${kind} takes four positional numbers (x y width height, not k=v), e.g. "rectangle 120 30 160 70 In"`); return; }
    if (rest.length && rest.every(w => !Number.isNaN(Number(w)))) { errors.push(`line ${i + 1}: ${kind} takes exactly four numbers, got ${words.length - 1} (the extra "${rest.join(' ')}" would become a label)`); return; }
    const label = rest.join(' ');
    const els = makeLabeled(kind, nums[0], nums[1], nums[2], nums[3], label);
    built.push(...els);
    shapes.push(els[0]);
  });
  if (errors.length) throw new ToolError('invalid_argument', errors.join('; '), 'call_tool tool=excalidraw.add_shapes spec="rectangle 120 30 160 70 In"');
  return built;
};

export const pack = { id: APP, title: 'Excalidraw' };

export const tools = [
  {
    name: 'excalidraw.add_shapes',
    purpose: 'Add shapes, labels, lines and arrows to the canvas, one per line of a spec.',
    when: 'Use when the user wants a diagram, flowchart or sketch drawn on the canvas.',
    params: { spec: { type: 'text', required: true, description: 'One shape per line: "rectangle 120 30 160 70 In", "ellipse 60 40 130 55", "diamond 250 55 160 90", "text 5 5 Hello", "line 0 0 150 0", "arrow 1 2" (shape line numbers, 1-based)' } },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { spec: 'rectangle 120 30 160 70 In\nrectangle 380 30 160 70 Out\narrow 1 2' }, says: 'Draw an In to Out flow' }],
    // getSceneElements + updateScene (types.d.ts:603-611); captureUpdate "IMMEDIATELY" makes the
    // add undoable (store.d.ts:16)
    run: async (args, ctx) => call(ctx, async host => {
      const ex = await getApi(host, ctx);
      const elements = parseSpec(args.spec);
      ex.updateScene({ elements: [...ex.getSceneElements(), ...elements], captureUpdate: 'IMMEDIATELY' });
      return { added: elements.length };
    }),
  },
  {
    name: 'excalidraw.add_text',
    purpose: 'Add a free text label at a canvas position.',
    when: 'Use when the user wants a caption, note or standalone label on the canvas.',
    params: {
      text: { type: 'text', required: true, description: 'The label text' },
      x: { type: 'integer', required: true, description: 'Left edge in canvas coordinates' },
      y: { type: 'integer', required: true, description: 'Top edge in canvas coordinates' },
    },
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: { text: 'Launch plan', x: 30, y: 30 }, says: 'Add a title to the drawing' }],
    // Same updateScene path as add_shapes, for a single text element
    run: async (args, ctx) => call(ctx, async host => {
      const ex = await getApi(host, ctx);
      const element = makeText(args.text, args.x, args.y);
      ex.updateScene({ elements: [...ex.getSceneElements(), element], captureUpdate: 'IMMEDIATELY' });
      return { added: 1 };
    }),
  },
  {
    name: 'excalidraw.list_elements',
    purpose: 'List the elements on the canvas with their type and position.',
    when: 'Use when the user asks what is on the canvas, or before drawing more on top of it.',
    params: {},
    effect: 'read',
    needs: NEEDS,
    examples: [{ args: {}, says: 'What is on the canvas?' }],
    // getSceneElements (types.d.ts:611), trimmed to the fields the model can act on
    run: async (args, ctx) => call(ctx, async host => {
      const ex = await getApi(host, ctx);
      const elements = [...ex.getSceneElements()].map(el => {
        const row = { id: el.id, type: el.type, x: Math.round(el.x), y: Math.round(el.y), width: Math.round(el.width), height: Math.round(el.height) };
        if (el.type === 'text') row.text = el.text;
        return row;
      });
      return { count: elements.length, elements };
    }),
  },
  {
    name: 'excalidraw.fit_view',
    purpose: 'Zoom the canvas so all content fits in view.',
    when: 'Use when the user says zoom to fit, show everything or fit the view.',
    params: {},
    effect: 'change',
    needs: NEEDS,
    examples: [{ args: {}, says: 'Fit everything in view' }],
    // scrollToContent with no target and fitToContent (App.d.ts:335)
    run: async (args, ctx) => call(ctx, async host => {
      const ex = await getApi(host, ctx);
      ex.scrollToContent(undefined, { fitToContent: true, animate: true });
      return { fitted: true };
    }),
  },
  {
    name: 'excalidraw.clear',
    purpose: 'Delete every element on the canvas; undo is lost too.',
    when: 'Use when the user wants the whole canvas emptied and agreed to lose the drawing and its undo history.',
    params: {},
    effect: 'destructive',
    needs: NEEDS,
    examples: [{ args: {}, says: 'Clear the canvas' }],
    // resetScene (types.d.ts:606): resets scene and history (App.d.ts:281-285)
    run: async (args, ctx) => call(ctx, async host => {
      const ex = await getApi(host, ctx);
      ex.resetScene();
      return { cleared: true };
    }),
  },
];
