// Buddy in agent mode, end to end in the real desktop: only the model is scripted. The meta tools,
// catalog, skills, prefetch, repairs, window.pcHost and the Files store are all real.
import { test, expect } from '@playwright/test';
import { skipUnlessEnabled } from './catalog.mjs';

async function scriptedModel(page) {
  await page.addInitScript(() => { Object.defineProperty(navigator, 'gpu', { configurable: true, value: { requestAdapter: async () => ({ features: new Set(['shader-f16']) }) } }); });
  await page.route('**/worker.js', route => route.fulfill({ contentType: 'text/javascript', body: `
    const call = (name, args) => '<tool_call><function=' + name + '>' + Object.entries(args).map(([k, v]) => '<parameter=' + k + '>' + v + '</parameter>').join('') + '</function></tool_call>';
    onmessage = ({ data }) => {
      if (data.type === 'load') return setTimeout(() => postMessage({ type: 'ready', key: data.key }), 50);
      if (data.type === 'count') return postMessage({ type: 'counted', id: data.id, tokens: 100 });
      if (data.type !== 'generate') return;
      const user = data.messages.findLast(m => m.role === 'user').content;
      const last = data.messages.at(-1);
      const names = data.tools.map(t => t.function.name).join(',');
      let text;
      if (last.role === 'tool') text = 'DONE ' + last.content.slice(0, 160) + ' NOTE=' + user.includes('Note: matching skill') + ' TOOLS=' + names;
      else if (user.includes('Open the Files app')) text = call('call_tool', { tool: 'desktop.open_app', app: 'files' });
      else if (user.includes('dark mode')) text = call('call_tool', { tool: 'desktop.set_theme(theme: light|dark)', theme: 'dark' });
      else if (user.includes('folder called BuddyTest')) text = call('call_tool', { tool: 'files.mkdir', path: 'BuddyTest' });
      else text = 'A plain answer.';
      postMessage({ type: 'token', id: data.id, text }); postMessage({ type: 'done', id: data.id, text });
    };` }));
}
async function openBuddy(page) {
  await page.goto('/pc/');
  await page.locator('[data-buddy-toggle]').click();
  const buddy = page.frameLocator('#pc-buddy iframe');
  await expect(buddy.locator('html')).toHaveAttribute('data-theme', /light|dark/);
  await buddy.locator('#load-model').click();
  await expect(buddy.locator('#send')).toBeEnabled();
  return buddy;
}
async function ask(buddy, text) {
  // A tool round and the answer round each add an assistant bubble; wait for the answer.
  await buddy.locator('#message').fill(text); await buddy.locator('#send').click();
  await expect(buddy.locator('.message.assistant').last()).toContainText('DONE', { timeout: 15000 });
  return buddy.locator('.message.assistant').last().innerText();
}

test('Buddy opens an app through call_tool, with the skill note and only the six meta tools', async ({ page }) => {
  skipUnlessEnabled(test, 'ai-agent');
  await scriptedModel(page);
  const buddy = await openBuddy(page);
  const reply = await ask(buddy, 'Open the Files app please');
  await expect(page.locator('[data-window="files"]')).toBeVisible();
  expect(reply).toContain('"ok":true');
  expect(reply).toContain('NOTE=true');
  expect(reply).toContain('TOOLS=lookup_skill_index,read_skill,find_in_skill,find_tool,describe_tool,call_tool');
});

test('a tool name with signature text is repaired, and the theme really changes', async ({ page }) => {
  skipUnlessEnabled(test, 'ai-agent');
  await scriptedModel(page);
  const buddy = await openBuddy(page);
  await page.evaluate(() => window.pcHost.setTheme('light'));
  const reply = await ask(buddy, 'Switch to dark mode');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(reply).toContain('"ok":true');
  expect(reply).toContain('repaired');
});

test('Buddy creates a folder in the real Files store', async ({ page }) => {
  skipUnlessEnabled(test, 'ai-agent');
  await scriptedModel(page);
  const buddy = await openBuddy(page);
  const reply = await ask(buddy, 'Make a folder called BuddyTest');
  expect(reply).toContain('"ok":true');
  const exists = await page.evaluate(async () => {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('webpc-files');
    try { await root.getDirectoryHandle('BuddyTest'); return true; } catch { return false; }
  });
  expect(exists).toBe(true);
});
