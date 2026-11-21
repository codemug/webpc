// Buddy M3 threads end to end in the real desktop: only the model is scripted, and it holds
// the reply for 1500 ms for any message containing HOLD. Threads, one session per thread,
// the Chats list, the status chips, the approval cards and the pc:buddy-status badge are real.
import { test, expect } from '@playwright/test';
import { skipUnlessEnabled } from './catalog.mjs';

async function scriptedModel(page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'gpu', { configurable: true, value: { requestAdapter: async () => ({ features: new Set(['shader-f16']) }) } });
    window.__badges = [];
    addEventListener('message', event => { if (event.data?.type === 'pc:buddy-status') window.__badges.push(event.data); });
  });
  await page.route('**/worker.js', route => route.fulfill({ contentType: 'text/javascript', body: `
    const call = (name, args) => '\u003ctool_call>\u003cfunction=' + name + '>' + Object.entries(args).map(([k, v]) => '\u003cparameter=' + k + '>' + v + '\u003c/parameter>').join('') + '\u003c/function>\u003c/tool_call>';
    onmessage = ({ data }) => {
      if (data.type === 'load') return setTimeout(() => postMessage({ type: 'ready', key: data.key }), 50);
      if (data.type === 'count') return postMessage({ type: 'counted', id: data.id, tokens: 100 });
      if (data.type !== 'generate') return;
      const user = data.messages.findLast(m => m.role === 'user').content;
      const last = data.messages.at(-1);
      const answer = text => { postMessage({ type: 'token', id: data.id, text }); postMessage({ type: 'done', id: data.id, text }); };
      if (user.includes('HOLD')) return setTimeout(() => answer('Held reply done.'), 1500);
      if (last.role === 'tool') return answer('DONE ' + last.content.slice(0, 160));
      if (user.includes('delete the file BuddyTest')) return answer(call('call_tool', { tool: 'files.delete', path: 'BuddyTest' }));
      answer('A plain answer.');
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
// After a reload the desktop forgets the panel: toggle it back and wait for the app to be
// fully started (the Chats button is disabled until the thread store is open).
async function reopen(page) {
  await page.locator('[data-buddy-toggle]').click();
  const buddy = page.frameLocator('#pc-buddy iframe');
  await expect(buddy.locator('html')).toHaveAttribute('data-theme', /light|dark/);
  await expect(buddy.locator('#chats')).toBeEnabled();
  return buddy;
}
async function send(buddy, text) {
  await buddy.locator('#message').fill(text);
  await buddy.locator('#send').click();
}
const chips = buddy => buddy.locator('#chats-list .chip');

test('two chats run at once and both end done; switching back shows the held answer', async ({ page }) => {
  skipUnlessEnabled(test, 'ai-agent');
  await scriptedModel(page);
  const buddy = await openBuddy(page);
  await send(buddy, 'HOLD first chat please');
  await page.waitForTimeout(100);
  await buddy.locator('#new-chat').click(); // New chat never stops: the HOLD chat keeps running
  await expect(buddy.locator('#messages')).toBeEmpty();
  await buddy.locator('#chats').click();
  await expect(chips(buddy).filter({ hasText: 'running' })).toHaveCount(1); // the old chat's chip says so
  await buddy.locator('#chats').click();
  await send(buddy, 'Second chat hello');
  await expect(buddy.locator('.message.assistant').last()).toContainText('A plain answer.', { timeout: 15000 });
  await expect.poll(() => page.evaluate(() => (window.__badges ?? []).some(b => b.running >= 1))).toBe(true);
  await buddy.locator('#chats').click();
  await expect(chips(buddy).filter({ hasText: 'done' })).toHaveCount(2, { timeout: 15000 });
  await buddy.locator('#chats-list .chat-open').filter({ hasText: 'HOLD first chat' }).click();
  await expect(buddy.locator('#chats-panel')).toBeHidden();
  await expect(buddy.locator('#messages')).toContainText('Held reply done.');
  await expect.poll(() => page.evaluate(() => (window.__badges ?? []).at(-1).running)).toBe(0);
});

test('a reload keeps both chats in the list with their done status', async ({ page }) => {
  skipUnlessEnabled(test, 'ai-agent');
  await scriptedModel(page);
  const buddy = await openBuddy(page);
  await send(buddy, 'First chat note');
  await expect(buddy.locator('.message.assistant').last()).toContainText('A plain answer.');
  await buddy.locator('#chats').click();
  await buddy.locator('#chats-new').click();
  await send(buddy, 'Second chat note');
  await expect(buddy.locator('.message.assistant').last()).toContainText('A plain answer.');
  await page.waitForTimeout(100); // let the done status writes land before the reload
  await page.reload();
  const again = await reopen(page);
  await again.locator('#chats').click();
  await expect(again.locator('#chats-list .chat-open').filter({ hasText: 'First chat note' })).toBeVisible();
  await expect(again.locator('#chats-list .chat-open').filter({ hasText: 'Second chat note' })).toBeVisible();
  await expect(chips(again).filter({ hasText: 'done' })).toHaveCount(2);
});

test('a running chat is interrupted by a reload', async ({ page }) => {
  skipUnlessEnabled(test, 'ai-agent');
  await scriptedModel(page);
  const buddy = await openBuddy(page);
  await send(buddy, 'HOLD interrupted please');
  await page.waitForTimeout(100);
  await buddy.locator('#chats').click();
  await expect(chips(buddy).filter({ hasText: 'running' })).toHaveCount(1);
  await page.reload();
  const again = await reopen(page);
  await again.locator('#chats').click();
  await expect(again.locator('#chats-list .chat-open').filter({ hasText: 'HOLD interrupted please' })).toBeVisible();
  await expect(chips(again).filter({ hasText: 'interrupted' })).toHaveCount(1);
});

test('a destructive call shows an in-chat approval card; Deny refuses it', async ({ page }) => {
  skipUnlessEnabled(test, 'ai-agent');
  await scriptedModel(page);
  const buddy = await openBuddy(page);
  await send(buddy, 'delete the file BuddyTest');
  await expect(buddy.locator('.approval')).toBeVisible();
  await expect(buddy.locator('.approval p')).toContainText('confirm before running it');
  await expect(buddy.locator('.approval pre')).toContainText('files.delete');
  await page.waitForTimeout(100);
  await buddy.locator('#chats').click();
  await expect(chips(buddy).filter({ hasText: 'needs you' })).toHaveCount(1);
  await buddy.locator('#chats').click();
  await buddy.locator('.approval .approve-deny').click();
  await expect(buddy.locator('.approval')).toHaveCount(0);
  await expect(buddy.locator('.message.assistant').last()).toContainText('did not approve', { timeout: 15000 });
  await page.waitForTimeout(100);
  await buddy.locator('#chats').click();
  await expect(chips(buddy).filter({ hasText: 'done' })).toHaveCount(1);
});

test('Stop resolves a pending approval card as Deny and interrupts the chat', async ({ page }) => {
  skipUnlessEnabled(test, 'ai-agent');
  await scriptedModel(page);
  const buddy = await openBuddy(page);
  await send(buddy, 'delete the file BuddyTest');
  await expect(buddy.locator('.approval')).toBeVisible();
  await buddy.locator('#stop').click();
  await expect(buddy.locator('.approval')).toHaveCount(0);
  await expect(buddy.locator('#messages')).toContainText('Stopped.');
  await page.waitForTimeout(100);
  await buddy.locator('#chats').click();
  await expect(chips(buddy).filter({ hasText: 'interrupted' })).toHaveCount(1);
});

test('Stop ends only the stopped chat; the other HOLD chat still finishes done', async ({ page }) => {
  skipUnlessEnabled(test, 'ai-agent');
  await scriptedModel(page);
  const buddy = await openBuddy(page);
  await send(buddy, 'HOLD first chat please');
  await page.waitForTimeout(100);
  await buddy.locator('#new-chat').click();
  await send(buddy, 'HOLD second chat please');
  await page.waitForTimeout(100);
  await buddy.locator('#stop').click();
  await expect(buddy.locator('#send')).toBeEnabled();
  await expect(buddy.locator('#model-state')).toContainText('Ready');
  await buddy.locator('#chats').click();
  await expect(chips(buddy).filter({ hasText: 'done' })).toHaveCount(1, { timeout: 15000 });
  await expect(chips(buddy).filter({ hasText: 'interrupted' })).toHaveCount(1);
  await expect(chips(buddy).filter({ hasText: 'running' })).toHaveCount(0);
  await expect(buddy.locator('#chats-list .chat-open').filter({ hasText: 'HOLD first chat' })).toBeVisible();
  await expect(buddy.locator('#chats-list .chat-open').filter({ hasText: 'HOLD second chat' })).toBeVisible();
});

test('deleting a chat asks first and keeps it when the dialog is dismissed', async ({ page }) => {
  skipUnlessEnabled(test, 'ai-agent');
  await scriptedModel(page);
  const buddy = await openBuddy(page);
  await send(buddy, 'Kept chat note');
  await expect(buddy.locator('.message.assistant').last()).toContainText('A plain answer.');
  await buddy.locator('#chats').click();
  await expect(buddy.locator('#chats-list .chat-row')).toHaveCount(1);
  const dialogPromise = page.waitForEvent('dialog');
  const clickP = buddy.locator('.chat-delete').first().click();
  // The confirm() dialog blocks the page, so click() only resolves once the dialog is handled:
  // handle it in parallel instead of awaiting the click first.
  const dialog = await dialogPromise;
  expect(dialog.message()).toContain('Delete this chat');
  await dialog.dismiss();
  await clickP;
  await expect(buddy.locator('#chats-list .chat-row')).toHaveCount(1);
});
