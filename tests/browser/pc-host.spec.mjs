import { test, expect } from '@playwright/test';
import { skipUnlessEnabled } from './catalog.mjs';

// The desktop host API (window.pcHost), driven exactly the way the Buddy agent drives
// it (parent.pcHost), each result checked against the DOM state it must produce.
// Error codes do not survive page.evaluate, so failures are caught in-page and read
// back as { code, message }.
// The call is passed as [method, ...args] (functions cannot cross into page.evaluate).
const rejectInfo = (page, [method, ...args]) => page.evaluate(async ([method, args]) => {
  try { await window.pcHost[method](...args); return null; }
  catch (error) { return { code: error.code, message: error.message }; }
}, [method, args]);

test('window.pcHost is installed on the desktop page, frozen at version 1', async ({ page }) => {
  await page.goto('/pc/');
  const info = await page.evaluate(() => ({ version: window.pcHost.version, frozen: Object.isFrozen(window.pcHost) }));
  expect(info).toEqual({ version: 1, frozen: true });
  const apps = await page.evaluate(() => window.pcHost.apps());
  expect(apps.length).toBeGreaterThan(0);
  for (const app of apps) {
    expect(typeof app.id).toBe('string');
    expect(typeof app.title).toBe('string');
  }
  expect(apps.some(app => app.kind === 'panel')).toBe(false); // the Buddy panel is not an app window
});

test('open, focus, minimize, restore, maximize and close drive the window DOM', async ({ page }) => {
  skipUnlessEnabled(test, 'files');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/pc/');
  expect(await page.evaluate(() => window.pcHost.open('files'))).toEqual({ id: 'files', opened: true });
  const win = page.locator('section[data-window="files"]');
  await expect(win).toBeVisible();
  const row = id => page.evaluate(rowId => window.pcHost.windows().then(rows => rows.find(entry => entry.id === rowId)), id);
  expect(await row('files')).toMatchObject({ state: 'normal', active: true });
  // minimize hides the window
  expect(await page.evaluate(() => window.pcHost.minimize('files'))).toMatchObject({ id: 'files', state: 'minimized' });
  await expect(win).toBeHidden();
  expect(await row('files')).toMatchObject({ state: 'minimized', active: false });
  // restore un-minimizes and focuses
  expect(await page.evaluate(() => window.pcHost.restore('files'))).toMatchObject({ state: 'normal', active: true });
  await expect(win).toBeVisible();
  // maximize takes the whole workspace
  expect(await page.evaluate(() => window.pcHost.maximize('files'))).toMatchObject({ state: 'maximized', x: 0, y: 0 });
  await expect(win).toHaveAttribute('data-maximized', 'true');
  const maximized = await row('files');
  const workspaceBox = await page.locator('#pc-workspace').boundingBox();
  expect(Math.abs(maximized.width - workspaceBox.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(maximized.height - workspaceBox.height)).toBeLessThanOrEqual(1);
  // maximize is idempotent
  expect(await page.evaluate(() => window.pcHost.maximize('files'))).toMatchObject({ state: 'maximized' });
  // restore un-maximizes
  expect(await page.evaluate(() => window.pcHost.restore('files'))).toMatchObject({ state: 'normal' });
  await expect(win).not.toHaveAttribute('data-maximized', 'true');
  // focus on an active normal window keeps it active
  expect(await page.evaluate(() => window.pcHost.focus('files'))).toMatchObject({ state: 'normal', active: true });
  // close removes the window from the state and hides the element
  expect(await page.evaluate(() => window.pcHost.close('files'))).toEqual({ id: 'files', closed: true });
  await expect(win).toBeHidden();
  expect(await page.evaluate(() => window.pcHost.windows().then(rows => rows.some(entry => entry.id === 'files')))).toBe(false);
});

test('close runs pcBeforeClose like the close button; force overrides it', async ({ page }) => {
  skipUnlessEnabled(test, 'files');
  await page.goto('/pc/');
  await page.evaluate(() => window.pcHost.open('files'));
  await page.evaluate(async () => {
    const frame = await window.pcHost.appWindow('files');
    frame.pcBeforeClose = () => false; // a dirty app
  });
  expect(await page.evaluate(() => window.pcHost.close('files'))).toEqual({ id: 'files', closed: false, dirty: true });
  await expect(page.locator('section[data-window="files"]')).toBeVisible();
  expect(await page.evaluate(() => window.pcHost.close('files', { force: true }))).toEqual({ id: 'files', closed: true });
  await expect(page.locator('section[data-window="files"]')).toBeHidden();
});

test('setTheme flips the DOM and reaches the open app frame; theme() reads it back', async ({ page }) => {
  skipUnlessEnabled(test, 'files');
  await page.goto('/pc/');
  await page.evaluate(() => window.pcHost.open('files'));
  await page.evaluate(async () => {
    const frame = await window.pcHost.appWindow('files');
    frame.__themes = [];
    frame.addEventListener('message', event => {
      if (event.data?.type === 'pc:theme') frame.__themes.push(event.data.theme);
    });
  });
  expect(await page.evaluate(() => window.pcHost.setTheme('light'))).toBe('light');
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('light');
  expect(await page.evaluate(() => window.pcHost.theme())).toBe('light');
  expect(await page.evaluate(() => document.querySelector('section[data-window="files"] iframe').contentWindow.__themes)).toContain('light');
});

test('appWindow resolves the ready frame window of a same-origin app', async ({ page }) => {
  skipUnlessEnabled(test, 'files');
  await page.goto('/pc/');
  const pathname = await page.evaluate(async () => (await window.pcHost.appWindow('files')).location.pathname);
  expect(pathname).toBe('/pc/apps/files/');
});

test('an unknown id rejects with unknown_app, the closest match and the valid ids', async ({ page }) => {
  skipUnlessEnabled(test, 'gridcraft');
  await page.goto('/pc/');
  const error = await rejectInfo(page, ['open', 'gridcraf']);
  expect(error.code).toBe('unknown_app');
  expect(error.message).toContain('closest: gridcraft');
  expect(error.message).toContain('apps:');
  // and an app that was never open rejects with not_open
  const notOpen = await rejectInfo(page, ['focus', 'gridcraft']);
  expect(notOpen.code).toBe('not_open');
});
