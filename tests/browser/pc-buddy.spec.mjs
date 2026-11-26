import { test, expect } from '@playwright/test';
import { skipUnlessEnabled } from './catalog.mjs';

const button = page => page.locator('[data-buddy-toggle]');
const panel = page => page.locator('#pc-buddy');
const frame = page => page.frameLocator('#pc-buddy iframe');

test('WebPC Agent is a taskbar button, not a desktop app; opening it lazy-loads the panel', async ({ page }) => {
  skipUnlessEnabled(test, 'ai-agent');
  await page.setViewportSize({ width: 1440, height: 900 });
  const offSite = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if ((url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') offSite.push(request.url());
  });
  await page.goto('/pc/');
  await expect(page.locator('.pc-shortcut[data-shortcut="ai-agent"]')).toHaveCount(0);
  await expect(page.locator('[data-open-app="ai-agent"]')).toHaveCount(0);
  await expect(page.locator('iframe')).toHaveCount(0);
  await expect(page.locator('.pc-taskbar [data-buddy-toggle]')).toBeVisible();
  const box = await button(page).boundingBox();
  const tasks = await page.locator('[data-tasks]').boundingBox();
  expect(box.x).toBeLessThanOrEqual(1440 * 0.25); // left edge within the left quarter
  expect(box.x).toBeLessThan(tasks.x); // left of the task list
  await button(page).click();
  await expect(button(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(panel(page)).toHaveCSS('transform', 'none'); // the 200 ms slide-in has finished
  const pbox = await panel(page).boundingBox();
  expect(pbox.x + pbox.width).toBeCloseTo(1440, 0); // right edge at the viewport edge
  const bar = await page.locator('.pc-taskbar').boundingBox();
  const top = await page.locator('.pc-topbar').boundingBox();
  expect(Math.abs(pbox.y - (top.y + top.height))).toBeLessThanOrEqual(1); // starts below the top bar
  expect(Math.abs(pbox.y + pbox.height - bar.y)).toBeLessThanOrEqual(1); // ends at the taskbar's top edge
  expect(pbox.width).toBeGreaterThanOrEqual(478);
  expect(pbox.width).toBeLessThanOrEqual(482);
  const frameEl = page.locator('#pc-buddy iframe');
  await expect(frameEl).toHaveCount(1);
  await expect(frameEl).toHaveAttribute('src', /\/pc\/apps\/ai-agent\/$/);
  await expect(frame(page).locator('h1')).toHaveText('WebPC Agent');
  expect(offSite).toEqual([]); // nothing leaves the loopback host before any model loads
});

test('closing WebPC Agent hides the panel and keeps its frame; focus returns to the button', async ({ page }) => {
  skipUnlessEnabled(test, 'ai-agent');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/pc/');
  await button(page).click();
  await expect(frame(page).locator('h1')).toHaveText('WebPC Agent');
  await page.evaluate(() => { document.querySelector('#pc-buddy iframe').contentWindow.__buddyMark = 1; });
  await frame(page).locator('#panel-close').click(); // the close button lives in Buddy's own header
  await expect(button(page)).toHaveAttribute('aria-expanded', 'false');
  await expect(button(page)).toBeFocused();
  await expect(panel(page)).toBeHidden();
  await button(page).click();
  await expect(panel(page)).toBeVisible();
  const mark = await page.evaluate(() => document.querySelector('#pc-buddy iframe').contentWindow.__buddyMark);
  expect(mark).toBe(1); // the same document survived the close: no reload
});

test('Escape inside the WebPC Agent frame closes the panel', async ({ page }) => {
  skipUnlessEnabled(test, 'ai-agent');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/pc/');
  await button(page).click();
  await expect(frame(page).locator('h1')).toHaveText('WebPC Agent');
  // The heading is static HTML; data-theme arrives only after app.js has run (pc:ready -> pc:theme),
  // so the Escape handler exists before the key press.
  await expect(frame(page).locator('html')).toHaveAttribute('data-theme', /light|dark/);
  await frame(page).locator('#message').focus();
  await page.keyboard.press('Escape');
  await expect(button(page)).toHaveAttribute('aria-expanded', 'false');
  await expect(panel(page)).toBeHidden();
});

test('at a 390 px viewport the open panel takes the full width', async ({ page }) => {
  skipUnlessEnabled(test, 'ai-agent');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/pc/');
  await button(page).click();
  await expect(panel(page)).toHaveCSS('transform', 'none');
  const box = await panel(page).boundingBox();
  expect(box.width).toBeCloseTo(390, 0);
  expect(box.x).toBeCloseTo(0, 0);
});

test('the WebPC Agent button shows background chats from pc:buddy-status', async ({ page }) => {
  skipUnlessEnabled(test, 'ai-agent');
  await page.goto('/pc/');
  await button(page).click();
  await expect(frame(page).locator('html')).toHaveAttribute('data-theme', /light|dark/);
  // The app posts its own counts (0, 0) in the same step that enables New chat (app.js init:
  // initialized, controls(), postBadge()); wait for it, or that post can land after the fake
  // ones below and reset the badge (seen on a slow run).
  await expect(frame(page).locator('#new-chat')).toBeEnabled();
  const badge = page.locator('[data-buddy-badge]');
  await expect(badge).toBeHidden();
  const post = data => page.evaluate(d => document.querySelector('#pc-buddy iframe').contentWindow.parent.postMessage(d, location.origin), data);
  // Messages must come from the Buddy frame itself: post from inside it.
  const postFromBuddy = data => page.frames().find(f => f.url().includes('/pc/apps/ai-agent/')).evaluate(d => parent.postMessage(d, location.origin), data);
  await postFromBuddy({ type: 'pc:buddy-status', running: 2, needsYou: 0 });
  await expect(badge).toHaveText('2');
  await expect(button(page)).toHaveAttribute('aria-label', 'WebPC Agent, 2 chats running');
  await postFromBuddy({ type: 'pc:buddy-status', running: 1, needsYou: 1 });
  await expect(badge).toHaveText('1');
  await expect(badge).toHaveAttribute('data-kind', 'needs-you');
  await expect(button(page)).toHaveAttribute('aria-label', 'WebPC Agent, 1 chat running, 1 needs you');
  await post({ type: 'pc:buddy-status', running: 9, needsYou: 9 }); // from the desktop page itself: ignored
  await expect(badge).toHaveText('1');
  await postFromBuddy({ type: 'pc:buddy-status', running: 0, needsYou: 0 });
  await expect(badge).toBeHidden();
});
