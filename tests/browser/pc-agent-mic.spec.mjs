// M2 microphone, end to end in the real desktop: Chrome's fake microphone plays a tone (the fake
// UI grants it at once), and the model is scripted; it answers HEARD <n> with the sample count of
// the audio part it received (0 when the message carried no audio).
import { test, expect } from '@playwright/test';
import { skipUnlessEnabled } from './catalog.mjs';

test.use({ launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] } });

async function scriptedModel(page) {
  await page.addInitScript(() => { Object.defineProperty(navigator, 'gpu', { configurable: true, value: { requestAdapter: async () => ({ features: new Set(['shader-f16']) }) } }); });
  await page.route('**/worker.js', route => route.fulfill({ contentType: 'text/javascript', body: `
    onmessage = ({ data }) => {
      if (data.type === 'load') return setTimeout(() => postMessage({ type: 'ready', key: data.key }), 50);
      if (data.type === 'count') return postMessage({ type: 'counted', id: data.id, tokens: 100 });
      if (data.type !== 'generate') return;
      const user = data.messages.findLast(m => m.role === 'user').content;
      const parts = Array.isArray(user) ? user : [{ type: 'text', text: user }];
      const audio = parts.find(p => p.type === 'audio');
      const n = audio && audio.audio ? audio.audio.samples.length : 0;
      postMessage({ type: 'token', id: data.id, text: 'HEARD ' + n });
      postMessage({ type: 'done', id: data.id, text: 'HEARD ' + n });
    };` }));
}
async function openAgent(page, model = null) {
  await page.goto('/pc/');
  await page.locator('[data-buddy-toggle]').click();
  const agent = page.frameLocator('#pc-buddy iframe');
  await expect(agent.locator('html')).toHaveAttribute('data-theme', /light|dark/);
  if (model) await agent.locator('#model').selectOption(model);
  await agent.locator('#load-model').click();
  await expect(agent.locator('#model-state')).toContainText('Ready');
  return agent;
}
// Record for about the given milliseconds, then stop: the chip must be visible afterwards.
async function record(agent, page, ms) {
  await agent.locator('#mic').click();
  await expect(agent.locator('#mic')).toHaveText(/⏺/);
  await page.waitForTimeout(ms);
  await agent.locator('#mic').click();
  await expect(agent.locator('#audio-chip')).toBeVisible();
}
// Every stored thread record, read straight from IndexedDB (the thread store's keys).
async function threadRecords(page) {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('keyval-store'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const tx = db.transaction('keyval-store', 'readonly');
    const keys = await new Promise((resolve, reject) => { const r = tx.objectStore('keyval-store').getAllKeys(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const out = [];
    for (const key of keys) {
      if (typeof key !== 'string' || !key.startsWith('buddy:thread:')) continue;
      const value = await new Promise((resolve, reject) => { const r = tx.objectStore('keyval-store').get(key); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      if (value?.history) out.push(value);
    }
    return out;
  });
}

test('the microphone is hidden for lfm3-1.7b and shown for gemma4-e2b', async ({ page }) => {
  skipUnlessEnabled(test, 'ai-agent');
  await scriptedModel(page);
  await page.goto('/pc/');
  await page.locator('[data-buddy-toggle]').click();
  const agent = page.frameLocator('#pc-buddy iframe');
  await expect(agent.locator('html')).toHaveAttribute('data-theme', /light|dark/);
  await expect(agent.locator('#mic')).toBeHidden(); // the default model (lfm3-1.7b) has no audio
  await agent.locator('#model').selectOption('gemma4-e2b');
  await expect(agent.locator('#mic')).toBeVisible();
});

test('a recording of about a second shows a chip with its seconds', async ({ page }) => {
  skipUnlessEnabled(test, 'ai-agent');
  await scriptedModel(page);
  const agent = await openAgent(page, 'gemma4-e2b');
  await record(agent, page, 1300);
  await expect(agent.locator('#audio-name')).toHaveText(/🎙 1\.\d s/);
});

test('Send delivers about 16,000 samples per second and clears the chip', async ({ page }) => {
  skipUnlessEnabled(test, 'ai-agent');
  await scriptedModel(page);
  const agent = await openAgent(page, 'gemma4-e2b');
  await agent.locator('#message').fill('what did I say?');
  await record(agent, page, 1300); // about 1.3 s of the fake tone
  await agent.locator('#send').click();
  const reply = await agent.locator('.message.assistant').last();
  await expect(reply).toContainText('HEARD', { timeout: 20000 });
  const n = Number((await reply.innerText()).match(/HEARD (\d+)/)[1]);
  expect(n).toBeGreaterThanOrEqual(16000); // the 16 kHz mono resample of ~1.3 s
  expect(n).toBeLessThanOrEqual(26000);
  await expect(agent.locator('#audio-chip')).toBeHidden(); // the recording is gone after the send
});

test('the stored chat keeps the marker and no samples survive a reload', async ({ page }) => {
  skipUnlessEnabled(test, 'ai-agent');
  await scriptedModel(page);
  const agent = await openAgent(page, 'gemma4-e2b');
  await agent.locator('#message').fill('remember this tone');
  await record(agent, page, 1200);
  await agent.locator('#send').click();
  await expect(agent.locator('.message.assistant').last()).toContainText('HEARD', { timeout: 20000 });
  await expect(agent.locator('.message.user').last()).toContainText('[audio');
  const before = await threadRecords(page);
  expect(before.some(r => r.history.some(m => m.content.includes('[audio')))).toBe(true);
  expect(before.every(r => r.history.every(m => !('audio' in m)))).toBe(true, 'no samples in the saved records');
  await page.reload();
  await page.locator('[data-buddy-toggle]').click();
  const agent2 = page.frameLocator('#pc-buddy iframe');
  await expect(agent2.locator('.message.user').last()).toContainText('[audio', { timeout: 20000 }); // the chat reopens with the marker
  await expect(agent2.locator('#audio-chip')).toBeHidden(); // and without any live recording
});

test('audio with no typed text sends', async ({ page }) => {
  skipUnlessEnabled(test, 'ai-agent');
  await scriptedModel(page);
  const agent = await openAgent(page, 'gemma4-e2b');
  await record(agent, page, 1200);
  await expect(agent.locator('#send')).toBeEnabled(); // the chip alone enables Send
  await agent.locator('#send').click();
  const reply = await agent.locator('.message.assistant').last();
  await expect(reply).toContainText('HEARD', { timeout: 20000 });
  const n = Number((await reply.innerText()).match(/HEARD (\d+)/)[1]);
  expect(n).toBeGreaterThan(0);
  await expect(agent.locator('.message.user').last()).toHaveText(/\[audio 1\.\d s\]/); // marker only, no typed text
});
