import { test, expect } from '@playwright/test';
import { skipUnlessEnabled } from './catalog.mjs';

const appHtml = `<!doctype html><title>GridCraft test app</title><label>Cell A1 <input id="cell"></label><script>
parent.postMessage({type:'pc:ready',appId:'gridcraft'},location.origin);
</script>`;
async function fakeGridcraft(page) {
  let loads = 0;
  await page.route('**/pc/apps/gridcraft/', route => { loads++; return route.fulfill({ contentType: 'text/html', body: appHtml }); });
  return () => loads;
}
const win = (page, id) => page.locator(`[data-window="${id}"]`);

test('PC launches lazily and reuses app state after minimize and close', async ({ page }) => {
  skipUnlessEnabled(test, 'gridcraft');
  const loads = await fakeGridcraft(page);
  await page.goto('/pc/');
  await expect(page.locator('iframe')).toHaveCount(0);
  const shortcut = page.locator('[data-shortcut="gridcraft"]');
  await shortcut.click();
  await expect(page.locator('iframe')).toHaveCount(0);
  await shortcut.dblclick();
  await expect(win(page, 'gridcraft')).toHaveAttribute('data-load', 'ready');
  const cell = page.frameLocator('iframe').getByLabel('Cell A1');
  await cell.fill('Keep my work');
  await page.getByRole('button', { name: 'Minimize GridCraft', exact: true }).click();
  await expect(win(page, 'gridcraft')).toBeHidden();
  await page.getByRole('button', { name: 'Switch to GridCraft', exact: true }).click();
  await expect(cell).toHaveValue('Keep my work');
  await page.getByRole('button', { name: 'Close GridCraft', exact: true }).click();
  await expect(win(page, 'gridcraft')).toBeHidden();
  await expect(page.locator('[data-task="gridcraft"]')).toHaveCount(0);
  await shortcut.focus();
  await page.keyboard.press('Enter');
  await expect(cell).toHaveValue('Keep my work');
  expect(loads()).toBe(1);
});

test('PC manages keyboard geometry, stacking, maximize, and launcher focus', async ({ page }) => {
  skipUnlessEnabled(test, 'gridcraft');
  await fakeGridcraft(page);
  await page.goto('/pc/');
  await expect(page.locator('.pc-shortcuts').getByText('About WebPC', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Apps', exact: true }).click();
  await expect(page.locator('#pc-launcher')).toBeVisible();
  await expect(page.locator('#pc-launcher').getByText('About WebPC', { exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-launcher-toggle]')).toBeFocused();
  await page.locator('[data-shortcut="gridcraft"]').focus();
  await page.keyboard.press('Enter');
  await expect(win(page, 'gridcraft')).toHaveAttribute('data-load', 'ready');
  await page.getByRole('button', { name: 'Help', exact: true }).click();
  await expect(win(page, 'about')).toHaveAttribute('data-active', 'true');
  const title = win(page, 'about').locator('[data-move]');
  const before = await win(page, 'about').boundingBox();
  await title.focus();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Shift+ArrowLeft');
  const moved = await win(page, 'about').boundingBox();
  expect(moved.x).toBe(before.x - 20);
  expect(moved.width).toBe(before.width - 20);
  await page.getByRole('button', { name: 'Maximize Help', exact: true }).click();
  await expect(win(page, 'about')).toHaveAttribute('data-maximized', 'true');
  await page.getByRole('button', { name: 'Restore Help', exact: true }).click();
  expect((await win(page, 'about').boundingBox()).width).toBe(moved.width);
  await page.frameLocator('iframe').getByLabel('Cell A1').click();
  await expect(win(page, 'gridcraft')).toHaveAttribute('data-active', 'true');
  await page.getByRole('button', { name: 'Show desktop', exact: true }).click();
  await expect(win(page, 'gridcraft')).toBeHidden();
  await expect(win(page, 'about')).toBeHidden();
});

test('PC pointer dragging and resizing work without escaping the workspace', async ({ page }) => {
  await page.goto('/pc/');
  await page.getByRole('button', { name: 'Help', exact: true }).click();
  const title = await win(page, 'about').locator('[data-move]').boundingBox();
  const before = await win(page, 'about').boundingBox();
  await page.mouse.move(title.x + 100, title.y + 22);
  await page.mouse.down();
  await page.mouse.move(title.x + 170, title.y + 52, { steps: 5 });
  await page.mouse.up();
  const moved = await win(page, 'about').boundingBox();
  expect(moved.x).toBe(before.x + 70);
  expect(moved.y).toBe(before.y + 30);
  const grip = await win(page, 'about').locator('.pc-resize').boundingBox();
  await page.mouse.move(grip.x + 12, grip.y + 12);
  await page.mouse.down();
  await page.mouse.move(grip.x + 72, grip.y + 42, { steps: 5 });
  await page.mouse.up();
  expect((await win(page, 'about').boundingBox()).width).toBe(moved.width + 60);
});

test('PC iframe failure offers a working retry', async ({ page }) => {
  skipUnlessEnabled(test, 'gridcraft');
  let failed = true;
  await page.route('**/pc/apps/gridcraft/', route => route.fulfill({ status: failed ? 404 : 200, contentType: 'text/html', body: failed ? '<title>404 Not Found</title>' : appHtml }));
  await page.goto('/pc/');
  await page.locator('[data-shortcut="gridcraft"]').dblclick();
  await expect(win(page, 'gridcraft')).toHaveAttribute('data-load', 'error');
  await expect(page.getByRole('heading', { name: 'GridCraft couldn’t open' })).toBeVisible();
  failed = false;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(win(page, 'gridcraft')).toHaveAttribute('data-load', 'ready');
});

test('closing a window with unsaved changes warns, and closes only if the user confirms', async ({ page }) => {
  skipUnlessEnabled(test, 'gridcraft');
  await fakeGridcraft(page);
  await page.goto('/pc/');
  await page.locator('[data-shortcut="gridcraft"]').dblclick();
  await expect(win(page, 'gridcraft')).toHaveAttribute('data-load', 'ready');
  await page.locator('iframe').evaluate(frame => { frame.contentWindow.pcBeforeClose = () => false; });
  const warnings = [];
  // First answer: keep the window.
  page.once('dialog', dialog => { warnings.push(dialog.message()); dialog.dismiss(); });
  await page.getByRole('button', { name: 'Close GridCraft', exact: true }).click();
  await expect(win(page, 'gridcraft')).toBeVisible();
  await expect(page.locator('[data-announcement]')).toContainText('still open');
  // Second answer: close anyway.
  page.once('dialog', dialog => { warnings.push(dialog.message()); dialog.accept(); });
  await page.getByRole('button', { name: 'Close GridCraft', exact: true }).click();
  await expect(win(page, 'gridcraft')).toBeHidden();
  expect(warnings).toEqual(Array(2).fill('GridCraft has changes that are not saved. Close it anyway and lose them?'));
});

test('a window with nothing unsaved closes without a warning', async ({ page }) => {
  skipUnlessEnabled(test, 'gridcraft');
  await fakeGridcraft(page);
  await page.goto('/pc/');
  await page.locator('[data-shortcut="gridcraft"]').dblclick();
  await expect(win(page, 'gridcraft')).toHaveAttribute('data-load', 'ready');
  await page.locator('iframe').evaluate(frame => { frame.contentWindow.pcBeforeClose = () => true; });
  let warned = false;
  page.on('dialog', dialog => { warned = true; dialog.dismiss(); });
  await page.getByRole('button', { name: 'Close GridCraft', exact: true }).click();
  await expect(win(page, 'gridcraft')).toBeHidden();
  expect(warned).toBe(false);
});

test.describe('PC touch and responsive layout' , () => {
  test.use({ hasTouch: true });
  test('touch launch and visible window controls at 320/375/414/768', async ({ page }) => {
    for (const width of [320, 375, 414, 768]) {
      await page.setViewportSize({ width, height: 760 });
      await page.goto('/pc/');
      await page.getByRole('button', { name: 'Help', exact: true }).tap();
      await expect(win(page, 'about')).toBeVisible();
      const box = await win(page, 'about').boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await expect(page.getByRole('button', { name: 'Close Help', exact: true })).toBeInViewport();
      await page.getByRole('button', { name: 'Close Help', exact: true }).tap();
      await expect(win(page, 'about')).toBeHidden();
    }
  });
});

test('WebPC launcher filters apps and launches a keyboard search result', async ({ page }) => {
  skipUnlessEnabled(test, 'gridcraft');
  const loads = await fakeGridcraft(page);
  await page.goto('/pc/');
  await expect(page).toHaveTitle('WebPC · Usman Shahid');
  await page.getByRole('button', { name: 'Apps', exact: true }).click();
  const search = page.getByRole('searchbox', { name: 'Search apps' });
  await expect(search).toBeFocused();
  await search.fill('no app matches this');
  await expect(page.locator('[data-app-empty]')).toBeVisible();
  await search.fill('spreadsheet');
  await expect(page.locator('[data-app-result=gridcraft]')).toBeVisible();
  await expect(page.locator('[data-app-result=terminal]')).toBeHidden(); // a real app that does not match
  // Developer holds no spreadsheet app (System went with the About app), so the filter empties the list.
  await page.getByLabel('App category').selectOption('Developer');
  await expect(page.locator('[data-app-empty]')).toBeVisible();
  await page.getByLabel('App category').selectOption('all');
  await search.press('Enter');
  await expect(win(page, 'gridcraft')).toHaveAttribute('data-load', 'ready');
  expect(loads()).toBe(1);
});

test('right-click on a shortcut offers Open in new window and the popup loads the app', async ({ page }) => {
  skipUnlessEnabled(test, 'gridcraft');
  await page.goto('/pc/');
  const popup = page.waitForEvent('popup');
  await page.locator('[data-shortcut="gridcraft"]').click({ button: 'right' });
  await expect(page.getByRole('menu')).toBeVisible();
  await page.getByRole('menuitem', { name: 'Open in new window' }).click();
  const window = await popup;
  expect(new URL(window.url()).pathname).toBe('/pc/apps/gridcraft/');
  await window.close();
});

test('Shift+F10 opens the menu, arrow keys move the selection and Escape restores focus', async ({ page }) => {
  skipUnlessEnabled(test, 'gridcraft');
  await page.goto('/pc/');
  const shortcut = page.locator('[data-shortcut="gridcraft"]');
  await shortcut.focus();
  await page.keyboard.press('Shift+F10');
  await expect(page.getByRole('menu')).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Open', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Open in new window' })).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(page.getByRole('menuitem', { name: 'Open', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toBeHidden();
  await expect(shortcut).toBeFocused();
});

// The first free cell of the default (column-major) icon layout, desktop-relative.
// The default layout fills cells p = 0..apps-1 in order (icon-layout.mjs column-major,
// with the overflow row-band past the last row), so p = apps is free.
async function freeCell(page) {
  return page.evaluate(() => {
    const ws = document.querySelector('#pc-workspace');
    const apps = ws.querySelectorAll('[data-shortcut]').length;
    const cols = Math.max(1, Math.floor((ws.clientWidth - 16) / 102));
    const rows = Math.max(1, Math.floor((ws.clientHeight - 16) / 112));
    const nominal = cols * rows;
    const p = apps;
    const cell = p < nominal
      ? { col: Math.floor(p / rows), row: p % rows }
      : { col: (p - nominal) % cols, row: rows + Math.floor((p - nominal) / cols) };
    return { col: cell.col, row: cell.row, centre: { x: 16 + cell.col * 102 + 51, y: 16 + cell.row * 112 + 56 } };
  });
}
async function dragIconToFreeCell(page, id) {
  const cell = await freeCell(page);
  const icon = page.locator(`[data-shortcut="${id}"]`);
  const from = await icon.boundingBox();
  const ws = await page.locator('#pc-workspace').boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(ws.x + cell.centre.x, ws.y + cell.centre.y, { steps: 8 });
  await page.mouse.up();
  return { icon, cell, ws };
}

test('dragging an icon to an empty cell persists across reload', async ({ page }) => {
  skipUnlessEnabled(test, 'gridcraft');
  await page.goto('/pc/');
  const { icon, cell, ws } = await dragIconToFreeCell(page, 'gridcraft');
  expect(await page.locator('iframe').count()).toBe(0); // a drag never opens the app
  const after = await icon.boundingBox();
  expect(after.x).toBe(ws.x + 16 + cell.col * 102);
  expect(after.y).toBe(ws.y + 16 + cell.row * 112);
  await page.reload();
  const reloaded = await page.locator('[data-shortcut="gridcraft"]').boundingBox();
  expect(reloaded.x).toBe(after.x);
  expect(reloaded.y).toBe(after.y);
});

test('Arrange icons restores the default layout', async ({ page }) => {
  skipUnlessEnabled(test, 'gridcraft');
  await page.goto('/pc/');
  const icon = page.locator('[data-shortcut="gridcraft"]');
  const defaultBox = await icon.boundingBox();
  await dragIconToFreeCell(page, 'gridcraft');
  const moved = await icon.boundingBox();
  expect(moved.x).not.toBe(defaultBox.x);
  await page.locator('#pc-workspace').click({ position: { x: 4, y: 4 }, button: 'right' });
  await page.getByRole('menuitem', { name: 'Arrange icons' }).click();
  const restored = await icon.boundingBox();
  expect(restored.x).toBe(defaultBox.x);
  expect(restored.y).toBe(defaultBox.y);
});

test('Alt+ArrowRight moves the focused icon one cell to the right', async ({ page }) => {
  skipUnlessEnabled(test, 'gridcraft');
  await page.goto('/pc/');
  const { icon } = await dragIconToFreeCell(page, 'gridcraft'); // park it at the first free cell
  const before = await icon.boundingBox();
  await icon.focus();
  await page.keyboard.press('Alt+ArrowRight');
  const after = await icon.boundingBox();
  expect(after.x).toBe(before.x + 102); // CELL_W; the cell to the right of the first free cell is free
  expect(after.y).toBe(before.y);
});
