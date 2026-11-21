// System pack: Buddy's own tools, moved into the tool catalog (plan section 10).
// Each tool delegates to the existing implementation in src/apps/ai-agent/agent.js
// (createTools), which the session builds per turn and passes in as ctx.legacy, so the
// behaviour, limits and safety checks of every tool stay exactly as they were.
import { ToolError } from '../../src/apps/ai-agent/runtime/args.mjs';

export const pack = { id: 'system', title: 'Buddy' };

// Run a legacy tool; its { error } results become teaching errors for the model.
async function legacy(ctx, name, args) {
  const tool = ctx.legacy?.[name];
  if (!tool) throw new ToolError('not_available', `${name} is not available right now (it needs a model, a setting or an app that is not ready).`, '');
  const result = await tool.run(args);
  if (result && typeof result === 'object' && typeof result.error === 'string') throw new ToolError('app_error', result.error, '');
  return result;
}

const S = (description, extra = {}) => ({ type: 'string', description, ...extra });
const T = (description, extra = {}) => ({ type: 'text', description, ...extra });

export const tools = [
  {
    name: 'system.calculate', purpose: 'Work out an arithmetic expression exactly.',
    when: 'Use when the user asks to add, plus, minus, times, multiply, divide, convert or total numbers.',
    params: { expression: S('Arithmetic with + - * / ^ % and parentheses, e.g. (12.5*4)/3', { required: true }) },
    effect: 'read', needs: ['legacy:calculate'],
    examples: [{ args: { expression: '3*0.24*24*30' }, says: 'Cost of 3 servers for 30 days' }],
    run: (args, ctx) => legacy(ctx, 'calculate', args),
  },
  {
    name: 'system.web_search', purpose: 'Search Wikipedia for facts about people, places and things.',
    when: 'Use when the user asks who, what or when about the world, or to look something up.',
    params: { query: S('A few search words, e.g. Eiffel Tower height', { required: true }) },
    effect: 'read', untrusted: true, needs: ['legacy:web_search'],
    examples: [{ args: { query: 'Apollo Guidance Computer' }, says: 'Look up the Apollo computer' }],
    run: (args, ctx) => legacy(ctx, 'web_search', args),
  },
  {
    name: 'system.http_get', purpose: 'Read a web page or JSON API and return its main text.',
    when: 'Use when the user names a site or link to read, or after web_search found one.',
    params: { url: S('Full http or https URL', { required: true }) },
    effect: 'read', untrusted: true, needs: ['legacy:http_get'],
    examples: [{ args: { url: 'https://en.wikipedia.org/wiki/Alan_Turing' }, says: 'Read the Alan Turing page' }],
    run: (args, ctx) => legacy(ctx, 'http_get', args),
  },
  {
    name: 'system.run_javascript', purpose: 'Run a short JavaScript snippet in a locked sandbox.',
    when: 'Use when the user wants dates, sorting, counting or data shaping done exactly.',
    params: { code: T('JavaScript; the last expression or a return statement is the result', { required: true }) },
    effect: 'read', needs: ['legacy:run_javascript'],
    examples: [{ args: { code: '[10, 9, 100].sort((a, b) => a - b)' }, says: 'Sort some numbers' }],
    run: (args, ctx) => legacy(ctx, 'run_javascript', args),
  },
  {
    name: 'system.run_code', purpose: "Run Python, Node.js or shell code in WebPC's Linux.",
    when: 'Use when the user asks to run a script, use Python, or do work in the terminal or Linux.',
    params: {
      lang: { type: 'enum', values: ['python', 'node', 'sh'], required: true, description: 'Language' },
      code: T('Code to run', { required: true }),
      timeout_ms: { type: 'integer', min: 1, max: 120000, description: 'Run limit in ms (default 30000)' },
    },
    effect: 'external', needs: ['legacy:run_code'],
    examples: [{ args: { lang: 'python', code: 'print(2**10)' }, says: 'Run a tiny Python script' }],
    run: (args, ctx) => legacy(ctx, 'run_code', args),
  },
  {
    name: 'system.translate', purpose: 'Translate text on this device.',
    when: 'Use when the user asks to translate text into another language.',
    params: {
      text: T('Text to translate', { required: true }),
      target_language: S('BCP 47 target code, e.g. fr', { required: true }),
      source_language: S('BCP 47 source code; omit for English'),
    },
    effect: 'read', needs: ['legacy:translate'],
    examples: [{ args: { text: 'Good morning', target_language: 'fr' }, says: 'Translate to French' }],
    run: (args, ctx) => legacy(ctx, 'translate', args),
  },
  {
    name: 'system.summarize', purpose: 'Summarize text on this device.',
    when: 'Use when the user asks for a summary, the key points or a short version of some text.',
    params: { text: T('Text to summarize', { required: true }), type: { type: 'enum', values: ['key-points', 'tldr', 'teaser', 'headline'], description: 'Summary style' } },
    effect: 'read', needs: ['legacy:summarize'],
    examples: [{ args: { text: 'A long article about rivers and how they shape valleys over time.', type: 'tldr' }, says: 'TL;DR of a text' }],
    run: (args, ctx) => legacy(ctx, 'summarize', args),
  },
  {
    name: 'system.detect_language', purpose: 'Detect which language a text is written in.',
    when: 'Use when the user asks what language something is, or before translating unknown text.',
    params: { text: T('Text to inspect', { required: true }) },
    effect: 'read', needs: ['legacy:detect_language'],
    examples: [{ args: { text: 'Bonjour tout le monde' }, says: 'Which language is this' }],
    run: (args, ctx) => legacy(ctx, 'detect_language', args),
  },
  {
    name: 'system.search_files', purpose: 'Search the meaning of the files the user granted.',
    when: 'Use when the user asks what their files say about a topic, after building the index.',
    params: { query: S('What to look for', { required: true }), k: { type: 'integer', min: 1, max: 10, description: 'How many chunks (default 5)' } },
    effect: 'read', untrusted: true, needs: ['legacy:search_files'],
    examples: [{ args: { query: 'budget for March' }, says: 'Find the March budget notes' }],
    run: (args, ctx) => legacy(ctx, 'search_files', args),
  },
  {
    name: 'system.ocr_image', purpose: 'Read the text in an image on this device.',
    when: 'Use when the user wants the words in a picture, screenshot or scan.',
    params: { source: S("'attached' for the attached image, or a Files path of an image", { required: true }) },
    effect: 'read', untrusted: true, needs: ['legacy:ocr_image'],
    examples: [{ args: { source: 'attached' }, says: 'Read the text in this image' }],
    run: (args, ctx) => legacy(ctx, 'ocr_image', args),
  },
  {
    name: 'system.remove_background', purpose: 'Cut the background out of an image on this device.',
    when: 'Use when the user wants a photo with a transparent or removed background.',
    params: { source: S("'attached' for the attached image, or a Files path of an image", { required: true }) },
    effect: 'change', needs: ['legacy:remove_background'],
    examples: [{ args: { source: 'attached' }, says: 'Remove the background of this photo' }],
    run: (args, ctx) => legacy(ctx, 'remove_background', args),
  },
];
