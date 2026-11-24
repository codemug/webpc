import { test, expect } from '@playwright/test';
import { skipUnlessEnabled } from './catalog.mjs';
// The guest's pty prompt is busybox sh's "~ $", so an idle shell ends
// the screen there; the kernel console's own prompt never reaches xterm.
const screen = page => page.locator('.xterm-rows');
const shellReady = page => expect.poll(async () => {
  const t = await screen(page).textContent();
  return /[$#⇒]$/.test(t.trimEnd()); // busybox sh on the pty shows "~ $" (measured); root "#"
}, { timeout: 120000 }).toBe(true);
const command = async (page, text) => { await page.locator('.xterm-helper-textarea').focus(); await page.keyboard.type(text); await page.keyboard.press('Enter'); };
const ready = async page => { await page.getByRole('button', { name: 'Start Linux', exact: true }).click(); await shellReady(page); };
const asset = url => /unkernel\.wasm|alpine\.erofs|data-template\.kwsparse\.gz/.test(url);

test('the unkernel Terminal boots, runs tools, interrupts a command, edits a file and keeps it after a reload', async ({ page, baseURL }) => {
  skipUnlessEnabled(test, 'terminal');
  test.setTimeout(240000); page.on('dialog', dialog => dialog.accept());
  const external = []; const lazy = []; const templates = [];
  page.on('request', request => {
    if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== new URL(baseURL).origin) external.push(request.url());
    if (asset(request.url())) { lazy.push(request.url()); if (request.url().includes('data-template.kwsparse.gz')) templates.push(request.url()); }
  });
  await page.goto('/pc/apps/terminal/');
  await page.waitForTimeout(250);
  expect(lazy, 'the kernel, distro and template load only when Linux starts').toEqual([]);
  await ready(page); // first boot: the template is downloaded and the data disk seeded
  // Every marker below is built by the program's output; the full marker never appears in
  // the echoed command line.
  await command(page, `uname -m; echo linux | tr a-z A-Z; python3 -c 'print("PY_"+str(6*7));print("UNICODE_"+"café λ")'; node -e 'console.log("NODE_"+(7*7))'`);
  await expect(screen(page)).toContainText('aarch64', { timeout: 20000 });
  await expect(screen(page)).toContainText('LINUX');
  await expect(screen(page)).toContainText('PY_42');
  await expect(screen(page)).toContainText('UNICODE_café λ');
  await expect(screen(page)).toContainText('NODE_49', { timeout: 20000 });
  // Ctrl+C interrupts a running command and the shell keeps working.
  await command(page, `sleep 30; awk 'BEGIN{print "NEVER" "_RUN"}'`); // the marker never appears in the echoed line
  await expect(screen(page)).toContainText('sleep 30; awk');
  await page.getByRole('button', { name: 'Send Control C', exact: true }).click();
  await shellReady(page);
  await command(page, "awk 'BEGIN{print \"IN\" \"TER\" \"RU\" \"PTED\"}'");
  await expect(screen(page)).toContainText('INTERRUPTED');
  await expect(screen(page)).not.toContainText('NEVER_RUN');
  // Edit a file (the shell's home is on the data disk, so it persists).
  await command(page, 'printf "NOTE_%s\\n" KEPT > note.txt; sync; cat note.txt');
  await expect(screen(page)).toContainText('NOTE_KEPT', { timeout: 20000 });
  // A reload boots from the saved data disk: no template download, the file is still there.
  await page.reload();
  await ready(page);
  await command(page, 'cat note.txt');
  await expect(screen(page)).toContainText('NOTE_KEPT', { timeout: 20000 });
  expect(templates).toHaveLength(1, 'the 40 MB template is fetched only on first use, not after a reload');
  expect(external).toEqual([]);
});

test('the Terminal is lazy, fits a mobile window and renders in both themes', async ({ page }) => {
  skipUnlessEnabled(test, 'terminal');
  test.setTimeout(180000); page.on('dialog', dialog => dialog.accept());
  const lazy = [];
  page.on('request', request => { if (asset(request.url())) lazy.push(request.url()); });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/pc/apps/terminal/');
  await page.waitForTimeout(250);
  expect(lazy).toEqual([]);
  // The header chips carry the guest details on hover; the Help button opens the panel.
  await expect(page.locator('.linux-chip').first()).toHaveAttribute('title', expect.stringContaining('Alpine'));
  await page.getByRole('button', { name: 'Help', exact: true }).click();
  await expect(page.locator('#linux-help-panel')).toBeVisible();
  await expect(page.locator('#linux-help-panel')).toContainText('512 MB of RAM');
  await page.getByRole('button', { name: 'Help', exact: true }).click();
  await ready(page);
  await command(page, "awk 'BEGIN{print \"MO\" \"BILE_OK\"}'");
  await expect(screen(page)).toContainText('MOBILE_OK', { timeout: 20000 });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => window.postMessage({ type: 'pc:theme', theme: value }, location.origin), theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  expect(lazy).toHaveLength(3, 'the first boot downloads the kernel, the distro image and the template once');
});
