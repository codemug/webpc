import { test, expect } from '@playwright/test';
import { skipUnlessEnabled } from './catalog.mjs';
// Two Terminal pages in one Playwright context share the origin's IndexedDB and its Web
// Locks, so this is the real two-tab case: the first tab boots the data disk persistent
// and holds the kwdisk lock, the second boots the SDK's snapshot mode (a chip is shown and
// its writes never reach IndexedDB), and when the owner closes a restart takes the lock
// back. The pty shell's prompt is busybox sh's "~ $" (measured), so an idle shell ends the
// screen at a trailing $; markers are built by program output only, never by the echoed
// command line.
const screen = page => page.locator('.xterm-rows');
const shellReady = page => expect.poll(async () => {
  const t = await screen(page).textContent();
  return /[$#⇒]$/.test(t.trimEnd());
}, { timeout: 120000 }).toBe(true);
const ready = async page => { await page.getByRole('button', { name: 'Start Linux', exact: true }).click(); await shellReady(page); };
const command = async (page, text) => { await page.locator('.xterm-helper-textarea').focus(); await page.keyboard.type(text); await page.keyboard.press('Enter'); };
const notSavedChip = page => page.getByText('Not saved: open in another tab', { exact: true });

test('one tab owns the saved disk: the second runs a not-saved snapshot, and a restart after the owner closes takes the lock back', async ({ page }) => {
  skipUnlessEnabled(test, 'terminal');
  test.setTimeout(900000);
  const ctx = page.context(); // two pages in this context share the origin's storage and Web Locks
  page.on('dialog', dialog => dialog.accept());
  await page.goto('/pc/apps/terminal/');

  // Tab A owns the disk (first use: the template is downloaded and the store seeded here).
  await ready(page);
  await expect(page.locator('[data-chip="saved"]')).toBeVisible();
  await command(page, `echo from-a > ~/two-a.txt && sync && awk 'BEGIN{print "A" "_OK"}'`);
  await expect(screen(page)).toContainText('A_OK', { timeout: 30000 });
  await page.waitForTimeout(3000); // let the save commit before the second tab reads it

  // Tab B cannot take the lock, so it boots the snapshot: the not-saved chip shows, the
  // "Saved in this browser" chip is hidden, and A's file is visible.
  const b = await ctx.newPage();
  b.on('dialog', dialog => dialog.accept());
  await b.goto('/pc/apps/terminal/');
  await ready(b);
  await expect(notSavedChip(b)).toBeVisible();
  await expect(b.locator('[data-chip="saved"]')).toBeHidden();
  await command(b, 'cat ~/two-a.txt | tr a-z A-Z');
  await expect(screen(b)).toContainText('FROM-A', { timeout: 30000 });
  await command(b, `echo from-b > ~/two-b.txt && sync && awk 'BEGIN{print "B" "_OK"}'`);
  await expect(screen(b)).toContainText('B_OK', { timeout: 30000 });

  // A closes: its kernel ends with the page, so the browser releases its lock.
  await page.close();
  await b.waitForTimeout(1000);

  // B restarts: the lock is free, so B takes it back and is saved again (chip gone, the
  // status line is the persistent one). B's snapshot writes were never saved, so after
  // the persistent restart only A's file is there.
  await b.getByRole('button', { name: 'Restart', exact: true }).click();
  await shellReady(b);
  await expect(notSavedChip(b)).toHaveCount(0);
  await expect(b.locator('[data-chip="saved"]')).toBeVisible();
  await expect(b.locator('#terminal-status')).toContainText('files are kept in this browser');
  await command(b, `test -f ~/two-a.txt && awk 'BEGIN{print "HAS" "_A"}'`);
  await expect(screen(b)).toContainText('HAS_A', { timeout: 30000 });
  await command(b, `test -f ~/two-b.txt && awk 'BEGIN{print "HAS" "_B"}' || awk 'BEGIN{print "NO" "_B"}'`);
  await expect(screen(b)).toContainText('NO_B', { timeout: 30000 });
  // Saved again for real: a write made after taking the lock back persists.
  await command(b, `echo from-b2 > ~/two-b2.txt && sync && awk 'BEGIN{print "B2" "_OK"}'`);
  await expect(screen(b)).toContainText('B2_OK', { timeout: 30000 });
  await b.waitForTimeout(3000);

  // Both tabs close; a fresh tab boots persistent: A's file and B's post-lock file are
  // there, B's snapshot file is not, and no not-saved chip shows.
  await b.close();
  const c = await ctx.newPage();
  c.on('dialog', dialog => dialog.accept());
  await c.goto('/pc/apps/terminal/');
  await ready(c);
  await expect(notSavedChip(c)).toHaveCount(0);
  await expect(c.locator('[data-chip="saved"]')).toBeVisible();
  await command(c, 'cat ~/two-a.txt | tr a-z A-Z');
  await expect(screen(c)).toContainText('FROM-A', { timeout: 30000 });
  await command(c, `test -f ~/two-b.txt && awk 'BEGIN{print "HAS" "_B"}' || awk 'BEGIN{print "NO" "_B"}'`);
  await expect(screen(c)).toContainText('NO_B', { timeout: 30000 });
  await command(c, `test -f ~/two-b2.txt && awk 'BEGIN{print "HAS" "_B2"}'`);
  await expect(screen(c)).toContainText('HAS_B2', { timeout: 30000 });
});
