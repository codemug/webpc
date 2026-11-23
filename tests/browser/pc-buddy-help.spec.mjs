// The help pop-ups and the visual welcome (the lead runs this; the unit side is
// tests/ai-agent-help.test.mjs). Each trigger is opened in turn: hover, then the
// pointer grace onto the pop-up, then Esc, then focus at once. A help-dot is
// opened by tap.
import { test, expect } from '@playwright/test';
import { skipUnlessEnabled } from './catalog.mjs';

const button = page => page.locator('[data-buddy-toggle]');
const frame = page => page.frameLocator('#pc-buddy iframe');
const pop = page => frame(page).getByRole('tooltip');

async function openBuddy(page) {
  await page.goto('/pc/');
  await button(page).click();
  await expect(frame(page).locator('h1')).toHaveText('Buddy');
  // The heading is static HTML; data-theme arrives only after app.js has run (pc:ready
  // -> pc:theme), so the help pop-ups are wired by the time the first interaction happens.
  await expect(frame(page).locator('html')).toHaveAttribute('data-theme', /light|dark/);
  // The panel slides in (200 ms). Playwright's stability check measures elements inside
  // the iframe, which do not move relative to it, so wait for the slide to end before
  // hovering: otherwise the panel moves under a parked pointer onto the next control.
  await expect.poll(() => page.locator('#pc-buddy').evaluate(panel => panel.getAnimations().length)).toBe(0);
}

const TRIGGERS = [
  { name: 'Load model', loc: page => frame(page).locator('#load-model'), text: 'Downloads the model once. After that it runs on this device.' },
  { name: 'Settings', loc: page => frame(page).locator('#settings'), text: 'Cloud models, Files access and storage.' },
  { name: 'a starter', loc: page => frame(page).locator('.examples button', { hasText: 'Plan a budget' }), text: 'Open GridCraft and put Item, Price and Qty across row 1.' },
  { name: 'the keyboard help-dot', loc: page => frame(page).locator('#keys-help'), text: 'Ctrl or ⌘ + Enter sends. Shift + Enter adds a line.' },
];

for (const trigger of TRIGGERS) {
  test(`help pop-up on ${trigger.name}: hover, the grace, Esc and focus`, async ({ page }) => {
    skipUnlessEnabled(test, 'ai-agent');
    await page.setViewportSize({ width: 1440, height: 900 });
    await openBuddy(page);
    const target = trigger.loc(page);
    await expect(target).toBeEnabled();
    await target.hover();
    await expect(pop(page)).toBeVisible(); // after the 300 ms hover delay
    await expect(pop(page)).toHaveText(trigger.text);
    await pop(page).hover(); // moving the pointer onto the pop-up keeps it open (the 150 ms grace)
    await expect(pop(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(pop(page)).toBeHidden();
    await target.focus(); // focus opens at once
    await expect(pop(page)).toBeVisible();
    await expect(pop(page)).toHaveText(trigger.text);
    await page.keyboard.press('Escape');
    await expect(pop(page)).toBeHidden();
  });
}

test('a tap on a help-dot opens the pop-up', async ({ page }) => {
  skipUnlessEnabled(test, 'ai-agent');
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBuddy(page);
  await frame(page).locator('#keys-help').click();
  await expect(pop(page)).toBeVisible();
  await expect(pop(page)).toHaveText('Ctrl or ⌘ + Enter sends. Shift + Enter adds a line.');
  await page.keyboard.press('Escape');
  await expect(pop(page)).toBeHidden();
  await frame(page).locator('footer .help-dot').last().click();
  await expect(pop(page)).toBeVisible();
  await expect(pop(page)).toHaveText('Small models can make mistakes. Check important answers.');
});

test('a click on a control closes its help and the next control is reachable', async ({ page }) => {
  skipUnlessEnabled(test, 'ai-agent');
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBuddy(page);
  const chats = frame(page).locator('#chats');
  await chats.hover();
  await expect(pop(page)).toBeVisible();
  await chats.click();
  await expect(pop(page)).toBeHidden(); // the press dismisses the help
  await frame(page).locator('#chats-new').click(); // no pop-up intercepts the click
  await expect(frame(page).locator('#chats-panel')).toBeHidden(); // New chat ran: it closes the list
  await expect(frame(page).locator('#messages')).toBeEmpty();
});

test('keyboard activation closes the help', async ({ page }) => {
  skipUnlessEnabled(test, 'ai-agent');
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBuddy(page);
  // A keyboard action first, so the programmatic focus reads as keyboard focus
  // (:focus-visible), as it would when reaching the control with Tab.
  await frame(page).locator('#message').focus();
  await page.keyboard.press('Shift+Tab');
  await frame(page).locator('#chats').focus();
  await expect(pop(page)).toBeVisible(); // focus opens at once
  await page.keyboard.press('Enter');
  await expect(pop(page)).toBeHidden(); // Enter fires click on the focused control
});

test('the welcome is visual: no paragraph, at least 6 strip icons and the three starters', async ({ page }) => {
  skipUnlessEnabled(test, 'ai-agent');
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBuddy(page);
  await expect(frame(page).locator('#welcome p')).toHaveCount(0);
  // The strip icons are PNGs for the upstream apps and the desktop's inline-SVG
  // glyphs for the built-in ones (docs, files, terminal, media, nettools, packets).
  expect(await frame(page).locator('#app-strip img, #app-strip svg').count()).toBeGreaterThanOrEqual(6);
  await expect(frame(page).locator('.examples button')).toHaveCount(3);
  await expect(frame(page).locator('.examples button', { hasText: 'Plan a budget' }))
    .toHaveAttribute('data-prompt', 'Open GridCraft and put Item, Price and Qty across row 1.');
  // "Write a note" (docs) has no PNG; its icon is the desktop's inline-SVG glyph.
  await expect(frame(page).locator('.examples button', { hasText: 'Write a note' }).locator('svg')).toBeVisible();
});

test('every welcome icon renders', async ({ page }) => {
  skipUnlessEnabled(test, 'ai-agent');
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBuddy(page);
  // No broken image: every <img> inside the welcome loaded (naturalWidth > 0).
  const imgs = frame(page).locator('#welcome img');
  for (let i = 0; i < await imgs.count(); i++) {
    expect(await imgs.nth(i).evaluate(el => el.naturalWidth)).toBeGreaterThan(0);
  }
  // The built-in apps have no PNG; their icon is the desktop's inline SVG (cloned).
  await expect(frame(page).getByRole('button', { name: 'Docs' }).locator('svg')).toBeVisible();
  await expect(frame(page).locator('.examples button', { hasText: 'Write a note' }).locator('svg')).toBeVisible();
});

test('in a 390 px frame the pop-up stays inside the viewport', async ({ page }) => {
  skipUnlessEnabled(test, 'ai-agent');
  await page.setViewportSize({ width: 390, height: 844 });
  await openBuddy(page);
  await frame(page).locator('#settings').hover();
  await expect(pop(page)).toBeVisible();
  const box = await pop(page).boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
});
